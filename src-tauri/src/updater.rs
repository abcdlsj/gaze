//! Seamless auto-update manager for Gaze.
//!
//! Fetches signed `latest.json` + `latest.json.sig` directly from GitHub
//! Releases CDN (no API rate limit), verifies RFC 8032 Ed25519 signatures and
//! streamed SHA-256 digests, persists an atomic `update-handoff.json` before
//! exit, and hands off post-exit installation to a detached helper process
//! (atomic `.app` replacement with local macOS signing identity preservation,
//! or silent NSIS upgrade + relaunch on Windows).

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

pub const UPDATER_STATUS_EVENT: &str = "updater-status";

const APP_SLUG: &str = "gaze";
const REPO_SLUG: &str = "abcdlsj/gaze";
const EXPECTED_BUNDLE_ID: &str = "dev.abcdlsj.gaze";
const EXPECTED_BUNDLE_NAME: &str = "Gaze.app";
const UPDATE_PUBKEY_B64: &str = "V6yYjiAJ7CIV3qWkddkdb+IXfpRRgQaQo+1ufm926UM=";

const INITIAL_CHECK_DELAY: Duration = Duration::from_secs(18);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const MANUAL_CHECK_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_MANIFEST_BYTES: u64 = 1 << 20; // 1 MiB
const MAX_ASSET_BYTES: u64 = 512 << 20; // 512 MiB
const HANDOFF_TTL_MS: u64 = 120_000; // 2 minutes

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Verifying,
    ReadyToRestart,
    Flushing,
    Installing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    pub available: bool,
    pub state: UpdatePhase,
    pub progress: u8,
    pub can_apply: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub visible: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateHandoffPayload {
    pub schema_version: u32,
    pub from_version: String,
    pub to_version: String,
    pub created_at_ms: u64,
    pub ttl_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowGeometry>,
    pub app_state: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseManifest {
    schema_version: u32,
    app: String,
    version: String,
    #[serde(default)]
    release_url: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    platforms: HashMap<String, PlatformAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct PlatformAsset {
    url: String,
    signature: String,
    sha256: String,
    size: u64,
    #[serde(default)]
    format: String,
    #[serde(default)]
    bundle_name: Option<String>,
    #[serde(default)]
    bundle_id: Option<String>,
}

#[derive(Debug, Clone)]
struct SelectedRelease {
    version: String,
    platform_key: String,
    asset: PlatformAsset,
    #[allow(dead_code)]
    release_url: String,
    #[allow(dead_code)]
    notes: Option<String>,
}

#[derive(Debug, Clone)]
struct StagedUpdate {
    version: String,
    #[allow(dead_code)]
    format: String,
    stage_dir: PathBuf,
    staged_artifact: PathBuf,
}

struct Inner {
    status: UpdateStatus,
    etag: Option<String>,
    last_check: Option<Instant>,
    selected: Option<SelectedRelease>,
    staged: Option<StagedUpdate>,
    startup_handoff: Option<UpdateHandoffPayload>,
    started: bool,
    auto_restart_on_ready: bool,
}

pub struct UpdateManager {
    current_raw: String,
    current_ver: Option<Semver>,
    manifest_url: String,
    allow_localhost: bool,
    pubkey: VerifyingKey,
    cache_dir: PathBuf,
    handoff_path: PathBuf,
    target_path: Option<PathBuf>,
    self_updatable: bool,
    inner: Mutex<Inner>,
}

impl UpdateManager {
    pub fn new(app_version: &str, data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        let raw_ver = std::env::var("GAZE_UPDATE_TEST_VERSION")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| app_version.to_string());
        let current_ver = parse_semver(&raw_ver);
        let display_ver = current_ver
            .map(|v| v.to_string())
            .unwrap_or_else(|| raw_ver.clone());

        let (manifest_url, allow_localhost) = match std::env::var("GAZE_UPDATE_MANIFEST_URL") {
            Ok(custom) if !custom.trim().is_empty() => (custom.trim().to_string(), true),
            _ => (
                format!("https://github.com/{REPO_SLUG}/releases/latest/download/latest.json"),
                false,
            ),
        };

        let pubkey_b64 = std::env::var("GAZE_UPDATE_TEST_PUBKEY")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| UPDATE_PUBKEY_B64.to_string());
        let pubkey = decode_verifying_key(&pubkey_b64)
            .expect("embedded updater Ed25519 public key must be valid");

        let (target_path, self_updatable) = detect_self_target();
        let handoff_path = data_dir.join("update-handoff.json");
        let updates_cache = cache_dir.join("updates");

        // Consume any pending handoff file once on startup so a broken restore
        // can never cause a crash loop.
        let startup_handoff = consume_handoff_file(&handoff_path);
        cleanup_stale_staging(&updates_cache);

        Self {
            current_raw: raw_ver,
            current_ver,
            manifest_url,
            allow_localhost,
            pubkey,
            cache_dir: updates_cache,
            handoff_path,
            target_path,
            self_updatable,
            inner: Mutex::new(Inner {
                status: UpdateStatus {
                    current: display_ver,
                    latest: None,
                    available: false,
                    state: UpdatePhase::Idle,
                    progress: 0,
                    can_apply: false,
                    release_url: None,
                    notes: None,
                    error: None,
                },
                etag: None,
                last_check: None,
                selected: None,
                staged: None,
                startup_handoff,
                started: false,
                auto_restart_on_ready: false,
            }),
        }
    }

    pub fn peek_startup_handoff(&self) -> Option<UpdateHandoffPayload> {
        self.inner
            .lock()
            .expect("updater lock poisoned")
            .startup_handoff
            .clone()
    }

    pub fn take_startup_handoff(&self) -> Option<UpdateHandoffPayload> {
        self.inner
            .lock()
            .expect("updater lock poisoned")
            .startup_handoff
            .take()
    }

    pub fn status(&self) -> UpdateStatus {
        self.inner
            .lock()
            .expect("updater lock poisoned")
            .status
            .clone()
    }

    fn emit_status(&self, app: &AppHandle, snapshot: &UpdateStatus) {
        let _ = app.emit(UPDATER_STATUS_EVENT, snapshot);
        crate::sync_tray_for_update(app, snapshot);
    }

    /// Starts the non-blocking background update checker (delayed after cold start).
    pub fn start_background(self: &Arc<Self>, app: AppHandle) {
        if self.current_ver.is_none() {
            return;
        }
        if cfg!(debug_assertions)
            && std::env::var_os("GAZE_UPDATE_MANIFEST_URL").is_none()
            && std::env::var_os("GAZE_UPDATE_TEST_VERSION").is_none()
        {
            return;
        }
        {
            let mut inner = self.inner.lock().expect("updater lock poisoned");
            if inner.started {
                return;
            }
            inner.started = true;
        }

        let mgr = Arc::clone(self);
        std::thread::Builder::new()
            .name("gaze-updater".to_string())
            .spawn(move || {
                std::thread::sleep(INITIAL_CHECK_DELAY);
                loop {
                    let _ = mgr.check_sync(&app, false);
                    std::thread::sleep(CHECK_INTERVAL);
                }
            })
            .ok();
    }

    pub fn check_manual(&self, app: &AppHandle) -> UpdateStatus {
        {
            let inner = self.inner.lock().expect("updater lock poisoned");
            if let Some(last) = inner.last_check {
                if last.elapsed() < MANUAL_CHECK_COOLDOWN {
                    return inner.status.clone();
                }
            }
        }
        self.check_sync(app, true)
    }

    fn check_sync(&self, app: &AppHandle, manual: bool) -> UpdateStatus {
        let Some(current_ver) = self.current_ver else {
            return self.status();
        };

        let (prev_state, etag) = {
            let mut inner = self.inner.lock().expect("updater lock poisoned");
            if matches!(
                inner.status.state,
                UpdatePhase::Checking
                    | UpdatePhase::Downloading
                    | UpdatePhase::Verifying
                    | UpdatePhase::ReadyToRestart
                    | UpdatePhase::Flushing
                    | UpdatePhase::Installing
            ) {
                return inner.status.clone();
            }
            let prev = inner.status.state;
            let etag = if manual { None } else { inner.etag.clone() };
            inner.status.state = UpdatePhase::Checking;
            if manual {
                inner.status.error = None;
            }
            let snapshot = inner.status.clone();
            drop(inner);
            self.emit_status(app, &snapshot);
            (prev, etag)
        };

        let fetched = self.fetch_verified_manifest(etag.as_deref());

        let snapshot = {
            let mut inner = self.inner.lock().expect("updater lock poisoned");
            if inner.status.state != UpdatePhase::Checking {
                return inner.status.clone();
            }

            match fetched {
                Err(err) => {
                    // Silent on background checks; only restore previous state.
                    inner.status.state = prev_state;
                    if manual {
                        inner.status.error = Some(err);
                    }
                }
                Ok(None) => {
                    // 304 Not Modified
                    inner.last_check = Some(Instant::now());
                    inner.status.state = prev_state;
                }
                Ok(Some((manifest, new_etag))) => {
                    inner.last_check = Some(Instant::now());
                    if let Some(et) = new_etag {
                        inner.etag = Some(et);
                    }
                    match parse_semver(&manifest.version) {
                        Some(latest_ver) if latest_ver > current_ver => {
                            let release_url = manifest.release_url.clone().unwrap_or_else(|| {
                                format!("https://github.com/{REPO_SLUG}/releases/tag/v{latest_ver}")
                            });
                            let resolved = resolve_platform_asset(&manifest.platforms);
                            inner.status.latest = Some(latest_ver.to_string());
                            inner.status.available = true;
                            inner.status.release_url = Some(release_url.clone());
                            inner.status.notes = manifest.notes.clone();
                            inner.status.error = None;
                            inner.status.progress = 0;
                            inner.status.state = UpdatePhase::Available;

                            if let Some((platform_key, asset)) = resolved {
                                let format_supported = is_format_supported(&asset.format);
                                inner.selected = Some(SelectedRelease {
                                    version: latest_ver.to_string(),
                                    platform_key,
                                    asset,
                                    release_url,
                                    notes: manifest.notes,
                                });
                                inner.status.can_apply = self.self_updatable && format_supported;
                            } else {
                                inner.selected = None;
                                inner.status.can_apply = false;
                            }
                        }
                        _ => {
                            inner.selected = None;
                            inner.status.latest = Some(manifest.version);
                            inner.status.available = false;
                            inner.status.can_apply = false;
                            inner.status.error = None;
                            inner.status.state = UpdatePhase::Idle;
                        }
                    }
                }
            }
            inner.status.clone()
        };

        self.emit_status(app, &snapshot);
        snapshot
    }

    /// Starts background download + Ed25519/SHA-256 verification + extraction staging.
    pub fn start_download(self: &Arc<Self>, app: AppHandle) -> Result<UpdateStatus, String> {
        self.start_download_inner(app, false)
    }

    /// Starts background download triggered from the tray menu; automatically commits
    /// restart once staged if no capture session is active.
    pub fn start_download_from_tray(
        self: &Arc<Self>,
        app: AppHandle,
    ) -> Result<UpdateStatus, String> {
        self.start_download_inner(app, true)
    }

    fn start_download_inner(
        self: &Arc<Self>,
        app: AppHandle,
        auto_restart_on_ready: bool,
    ) -> Result<UpdateStatus, String> {
        let selected = {
            let mut inner = self.inner.lock().expect("updater lock poisoned");
            if matches!(
                inner.status.state,
                UpdatePhase::Downloading
                    | UpdatePhase::Verifying
                    | UpdatePhase::ReadyToRestart
                    | UpdatePhase::Flushing
                    | UpdatePhase::Installing
            ) {
                return Ok(inner.status.clone());
            }
            if !inner.status.available {
                return Err("No update available".to_string());
            }
            if !inner.status.can_apply {
                return Err("Automatic install is unavailable for this installation".to_string());
            }
            let Some(sel) = inner.selected.clone() else {
                return Err("No matching platform asset found".to_string());
            };
            inner.auto_restart_on_ready = auto_restart_on_ready;
            inner.status.state = UpdatePhase::Downloading;
            inner.status.progress = 0;
            inner.status.error = None;
            let snap = inner.status.clone();
            drop(inner);
            self.emit_status(&app, &snap);
            sel
        };

        let mgr = Arc::clone(self);
        std::thread::Builder::new()
            .name("gaze-updater-dl".to_string())
            .spawn(move || {
                if let Err(err) = mgr.run_download_and_stage(&app, &selected) {
                    let mut inner = mgr.inner.lock().expect("updater lock poisoned");
                    inner.auto_restart_on_ready = false;
                    inner.status.state = UpdatePhase::Error;
                    inner.status.progress = 0;
                    inner.status.error = Some(err);
                    let snap = inner.status.clone();
                    drop(inner);
                    mgr.emit_status(&app, &snap);
                }
            })
            .map_err(|e| format!("failed to spawn download thread: {e}"))?;

        Ok(self.status())
    }

    fn run_download_and_stage(
        &self,
        app: &AppHandle,
        selected: &SelectedRelease,
    ) -> Result<(), String> {
        validate_download_url(&selected.asset.url, self.allow_localhost)?;

        if selected.asset.size == 0 || selected.asset.size > MAX_ASSET_BYTES {
            return Err("Release asset size out of allowed bounds".to_string());
        }

        let stage_dir = self.cache_dir.join(&selected.version);
        let _ = fs::remove_dir_all(&stage_dir);
        fs::create_dir_all(&stage_dir).map_err(|e| format!("create update staging dir: {e}"))?;

        let archive_path = stage_dir.join("update.archive");
        let (got_sha256, got_size) =
            self.download_file(app, &selected.asset.url, &archive_path, selected.asset.size)?;

        // Enter verifying state
        {
            let mut inner = self.inner.lock().expect("updater lock poisoned");
            inner.status.state = UpdatePhase::Verifying;
            inner.status.progress = 100;
            let snap = inner.status.clone();
            drop(inner);
            self.emit_status(app, &snap);
        }

        if got_size != selected.asset.size {
            let _ = fs::remove_dir_all(&stage_dir);
            return Err(format!(
                "Archive size mismatch (got {got_size}, expected {})",
                selected.asset.size
            ));
        }

        if !got_sha256.eq_ignore_ascii_case(&selected.asset.sha256) {
            let _ = fs::remove_dir_all(&stage_dir);
            return Err("Archive SHA-256 checksum mismatch".to_string());
        }

        // Verify domain-separated Ed25519 signature over canonical asset payload.
        let canonical = canonical_asset_payload(
            APP_SLUG,
            &selected.version,
            &selected.platform_key,
            &got_sha256,
            got_size,
        );
        verify_ed25519_b64(
            &self.pubkey,
            canonical.as_bytes(),
            &selected.asset.signature,
        )
        .map_err(|e| {
            let _ = fs::remove_dir_all(&stage_dir);
            format!("Ed25519 signature verification failed: {e}")
        })?;

        let bundle_name = selected
            .asset
            .bundle_name
            .as_deref()
            .unwrap_or(EXPECTED_BUNDLE_NAME);
        let bundle_id = selected
            .asset
            .bundle_id
            .as_deref()
            .unwrap_or(EXPECTED_BUNDLE_ID);
        if selected.platform_key.starts_with("darwin-") && bundle_id != EXPECTED_BUNDLE_ID {
            let _ = fs::remove_dir_all(&stage_dir);
            return Err("Manifest bundle ID does not match Gaze".to_string());
        }

        let staged_artifact = extract_and_verify_artifact(
            &archive_path,
            &stage_dir,
            &selected.asset.format,
            bundle_name,
            bundle_id,
        )
        .inspect_err(|_| {
            let _ = fs::remove_dir_all(&stage_dir);
        })?;

        // Mark ready for clean handoff + commit restart.
        let (snapshot, should_auto_restart) = {
            let mut inner = self.inner.lock().expect("updater lock poisoned");
            inner.staged = Some(StagedUpdate {
                version: selected.version.clone(),
                format: selected.asset.format.clone(),
                stage_dir,
                staged_artifact,
            });
            inner.status.state = UpdatePhase::ReadyToRestart;
            inner.status.progress = 100;
            inner.status.error = None;
            let auto = std::mem::take(&mut inner.auto_restart_on_ready);
            (inner.status.clone(), auto)
        };
        self.emit_status(app, &snapshot);

        if should_auto_restart {
            crate::try_tray_commit_restart(app);
        }
        Ok(())
    }

    /// Writes `update-handoff.json` atomically, spawns the detached install
    /// helper, and returns `Ok(())` so the caller can exit cleanly.
    pub fn commit_restart(
        &self,
        app: &AppHandle,
        app_state: serde_json::Value,
        window_geom: Option<WindowGeometry>,
    ) -> Result<(), String> {
        let (staged, target_path, from_version) = {
            let mut inner = self.inner.lock().expect("updater lock poisoned");
            let Some(staged) = inner.staged.clone() else {
                return Err("No verified staged update ready to install".to_string());
            };
            let Some(target_path) = self.target_path.clone() else {
                return Err("Target installation path unavailable".to_string());
            };
            inner.status.state = UpdatePhase::Installing;
            inner.status.progress = 100;
            let snap = inner.status.clone();
            let from_ver = inner.status.current.clone();
            drop(inner);
            self.emit_status(app, &snap);
            (staged, target_path, from_ver)
        };

        let handoff = UpdateHandoffPayload {
            schema_version: 1,
            from_version,
            to_version: staged.version.clone(),
            created_at_ms: now_epoch_ms(),
            ttl_ms: HANDOFF_TTL_MS,
            window: window_geom,
            app_state,
        };
        write_handoff_file(&self.handoff_path, &handoff)?;

        spawn_detached_apply_helper(
            std::process::id(),
            &target_path,
            &staged.staged_artifact,
            &staged.stage_dir,
            EXPECTED_BUNDLE_ID,
        )?;
        Ok(())
    }

    fn http_agent(&self, timeout: Duration) -> ureq::Agent {
        ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .build()
            .into()
    }

    fn fetch_verified_manifest(
        &self,
        etag: Option<&str>,
    ) -> Result<Option<(ReleaseManifest, Option<String>)>, String> {
        validate_download_url(&self.manifest_url, self.allow_localhost)?;

        let agent = self.http_agent(Duration::from_secs(15));
        let mut req = agent
            .get(&self.manifest_url)
            .header("User-Agent", format!("Gaze/{}", self.current_raw))
            .header("Accept", "application/json");
        if let Some(et) = etag {
            req = req.header("If-None-Match", et);
        }

        let resp = req
            .call()
            .map_err(|e| format!("manifest fetch failed: {e}"))?;
        if resp.status() == 304 {
            return Ok(None);
        }
        if resp.status() != 200 {
            return Err(format!("manifest returned HTTP {}", resp.status()));
        }

        let new_etag = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let mut manifest_bytes = Vec::new();
        resp.into_body()
            .into_reader()
            .take(MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut manifest_bytes)
            .map_err(|e| format!("read manifest body: {e}"))?;
        if manifest_bytes.len() as u64 > MAX_MANIFEST_BYTES {
            return Err("manifest exceeds maximum allowed size".to_string());
        }

        // Fetch companion Ed25519 signature (`latest.json.sig`) and verify exact manifest bytes.
        let sig_url = format!("{}.sig", self.manifest_url);
        let sig_resp = agent
            .get(&sig_url)
            .header("User-Agent", format!("Gaze/{}", self.current_raw))
            .call()
            .map_err(|e| format!("manifest signature fetch failed: {e}"))?;
        if sig_resp.status() != 200 {
            return Err(format!(
                "manifest signature returned HTTP {}",
                sig_resp.status()
            ));
        }
        let mut sig_text = String::new();
        sig_resp
            .into_body()
            .into_reader()
            .take(4096)
            .read_to_string(&mut sig_text)
            .map_err(|e| format!("read manifest signature: {e}"))?;

        verify_ed25519_b64(&self.pubkey, &manifest_bytes, sig_text.trim())
            .map_err(|e| format!("manifest Ed25519 verification failed: {e}"))?;

        let manifest: ReleaseManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| format!("parse manifest JSON: {e}"))?;
        if manifest.schema_version != 1 {
            return Err(format!(
                "unsupported manifest schema_version {}",
                manifest.schema_version
            ));
        }
        if manifest.app != APP_SLUG {
            return Err(format!("manifest app mismatch: {}", manifest.app));
        }
        Ok(Some((manifest, new_etag)))
    }

    fn download_file(
        &self,
        app: &AppHandle,
        url: &str,
        dest_path: &Path,
        expected_size: u64,
    ) -> Result<(String, u64), String> {
        let agent = self.http_agent(Duration::from_secs(300));
        let resp = agent
            .get(url)
            .header("User-Agent", format!("Gaze/{}", self.current_raw))
            .call()
            .map_err(|e| format!("download failed: {e}"))?;
        if resp.status() != 200 {
            return Err(format!("download returned HTTP {}", resp.status()));
        }

        let total = resp
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|&n| n > 0)
            .unwrap_or(expected_size);

        let part_path = dest_path.with_extension("part");
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&part_path)
            .map_err(|e| format!("create download file: {e}"))?;

        let mut reader = resp.into_body().into_reader().take(MAX_ASSET_BYTES + 1);
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 32 * 1024];
        let mut written: u64 = 0;
        let mut last_pct: i16 = -1;

        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("read download stream: {e}"))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > MAX_ASSET_BYTES {
                drop(file);
                let _ = fs::remove_file(&part_path);
                return Err("download exceeds maximum allowed size".to_string());
            }
            file.write_all(&buf[..n])
                .map_err(|e| format!("write download file: {e}"))?;
            hasher.update(&buf[..n]);

            if let Some(pct_u64) = written.saturating_mul(100).checked_div(total) {
                let pct = pct_u64.min(99) as i16;
                if pct != last_pct {
                    last_pct = pct;
                    let snap = {
                        let mut inner = self.inner.lock().expect("updater lock poisoned");
                        if inner.status.state == UpdatePhase::Downloading {
                            inner.status.progress = pct as u8;
                        }
                        inner.status.clone()
                    };
                    self.emit_status(app, &snap);
                }
            }
        }

        file.sync_all()
            .map_err(|e| format!("fsync download file: {e}"))?;
        drop(file);
        fs::rename(&part_path, dest_path).map_err(|e| format!("finalize download file: {e}"))?;

        let digest = hex_encode(&hasher.finalize());
        Ok((digest, written))
    }
}

pub fn capture_window_geometry(app: &AppHandle) -> Option<WindowGeometry> {
    let win = app.get_webview_window(crate::windows::LABEL_PREFERENCES)?;
    let pos = win.outer_position().ok()?;
    let size = win.inner_size().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0).max(0.5);
    Some(WindowGeometry {
        visible: win.is_visible().unwrap_or(false),
        x: (pos.x as f64 / scale).round() as i32,
        y: (pos.y as f64 / scale).round() as i32,
        width: (size.width as f64 / scale).round().max(420.0) as u32,
        height: (size.height as f64 / scale).round().max(260.0) as u32,
        maximized: win.is_maximized().unwrap_or(false),
        fullscreen: win.is_fullscreen().unwrap_or(false),
    })
}

pub fn apply_window_geometry(app: &AppHandle, geom: &WindowGeometry) {
    if let Some(win) = app.get_webview_window(crate::windows::LABEL_PREFERENCES) {
        let _ = win.set_position(tauri::LogicalPosition::new(geom.x as f64, geom.y as f64));
    }
}

fn canonical_asset_payload(
    app: &str,
    version: &str,
    platform: &str,
    sha256_hex: &str,
    size: u64,
) -> String {
    format!("v1:{app}:{version}:{platform}:{sha256_hex}:{size}")
}

fn decode_verifying_key(pubkey_b64: &str) -> Result<VerifyingKey, String> {
    let bytes = BASE64
        .decode(pubkey_b64.trim())
        .map_err(|e| format!("decode public key base64: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("invalid Ed25519 public key: {e}"))
}

fn verify_ed25519_b64(pubkey: &VerifyingKey, message: &[u8], sig_b64: &str) -> Result<(), String> {
    let sig_bytes = BASE64
        .decode(sig_b64.trim())
        .map_err(|e| format!("decode signature base64: {e}"))?;
    let arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "signature must be 64 bytes".to_string())?;
    let sig = Signature::from_bytes(&arr);
    pubkey
        .verify(message, &sig)
        .map_err(|_| "signature mismatch".to_string())
}

fn validate_download_url(url: &str, allow_localhost: bool) -> Result<(), String> {
    if allow_localhost
        && (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"))
    {
        return Ok(());
    }
    let allowed_prefixes = [
        format!("https://github.com/{REPO_SLUG}/"),
        "https://objects.githubusercontent.com/".to_string(),
        "https://release-assets.githubusercontent.com/".to_string(),
    ];
    if allowed_prefixes.iter().any(|p| url.starts_with(p)) {
        return Ok(());
    }
    Err(format!("refusing untrusted update URL: {url}"))
}

fn resolve_platform_asset(
    platforms: &HashMap<String, PlatformAsset>,
) -> Option<(String, PlatformAsset)> {
    let candidates: &[&str] = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        &["darwin-aarch64", "darwin-universal"]
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        &["darwin-x86_64", "darwin-universal"]
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        &["windows-x86_64"]
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        &["windows-aarch64", "windows-x86_64"]
    } else {
        &[]
    };
    for key in candidates {
        if let Some(asset) = platforms.get(*key) {
            return Some(((*key).to_string(), asset.clone()));
        }
    }
    None
}

fn is_format_supported(format: &str) -> bool {
    if cfg!(target_os = "macos") {
        matches!(format, "" | "app-zip" | "app-tar-gz")
    } else if cfg!(target_os = "windows") {
        format == "nsis-exe"
    } else {
        false
    }
}

fn write_handoff_file(path: &Path, payload: &UpdateHandoffPayload) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create handoff dir: {e}"))?;
    }
    let bytes = serde_json::to_vec_pretty(payload)
        .map_err(|e| format!("serialize handoff payload: {e}"))?;
    let tmp_path = path.with_extension("json.tmp");
    let mut f = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&tmp_path)
        .map_err(|e| format!("open handoff temp file: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = f.set_permissions(fs::Permissions::from_mode(0o600));
    }
    f.write_all(&bytes)
        .map_err(|e| format!("write handoff temp file: {e}"))?;
    f.sync_all()
        .map_err(|e| format!("fsync handoff temp file: {e}"))?;
    drop(f);
    fs::rename(&tmp_path, path).map_err(|e| format!("rename handoff file: {e}"))?;
    Ok(())
}

/// Atomically consumes `update-handoff.json` once on startup.
/// Renames and deletes before returning so a restore bug can never crash-loop.
fn consume_handoff_file(path: &Path) -> Option<UpdateHandoffPayload> {
    if !path.is_file() {
        return None;
    }
    let consuming = path.with_extension("consuming.json");
    if fs::rename(path, &consuming).is_err() {
        let _ = fs::remove_file(path);
        return None;
    }
    let raw = fs::read(&consuming).ok();
    let _ = fs::remove_file(&consuming);
    let parsed: UpdateHandoffPayload = serde_json::from_slice(&raw?).ok()?;
    let now = now_epoch_ms();
    if parsed.schema_version != 1 || now.saturating_sub(parsed.created_at_ms) > parsed.ttl_ms {
        return None;
    }
    Some(parsed)
}

fn cleanup_stale_staging(cache_dir: &Path) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(3600))
        .unwrap_or(UNIX_EPOCH);
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if let Ok(modified) = meta.modified() {
            if modified < cutoff {
                let p = entry.path();
                if p.is_dir() {
                    let _ = fs::remove_dir_all(p);
                } else {
                    let _ = fs::remove_file(p);
                }
            }
        }
    }
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Semver {
    major: u64,
    minor: u64,
    patch: u64,
}

impl std::fmt::Display for Semver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

fn parse_semver(raw: &str) -> Option<Semver> {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix('v') {
        s = rest;
    }
    if let Some(idx) = s.find(['-', '+']) {
        s = &s[..idx];
    }
    if s.is_empty() {
        return None;
    }
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let major = parts[0].parse::<u64>().ok()?;
    let minor = parts[1].parse::<u64>().ok()?;
    let patch = if parts.len() == 3 {
        parts[2].parse::<u64>().ok()?
    } else {
        0
    };
    Some(Semver {
        major,
        minor,
        patch,
    })
}

#[cfg(target_os = "macos")]
fn detect_self_target() -> (Option<PathBuf>, bool) {
    let Ok(exe) = std::env::current_exe() else {
        return (None, false);
    };
    inspect_app_bundle_path(&exe)
}

#[cfg(target_os = "windows")]
fn detect_self_target() -> (Option<PathBuf>, bool) {
    let Ok(exe) = std::env::current_exe() else {
        return (None, false);
    };
    inspect_windows_exe_path(&exe)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn detect_self_target() -> (Option<PathBuf>, bool) {
    (None, false)
}

#[allow(dead_code)]
fn inspect_app_bundle_path(exe_path: &Path) -> (Option<PathBuf>, bool) {
    let resolved = fs::canonicalize(exe_path).unwrap_or_else(|_| exe_path.to_path_buf());
    // Expected layout: <parent>/<Name>.app/Contents/MacOS/<binary>
    let Some(macos_dir) = resolved.parent() else {
        return (None, false);
    };
    let Some(contents_dir) = macos_dir.parent() else {
        return (None, false);
    };
    let Some(app_dir) = contents_dir.parent() else {
        return (None, false);
    };
    let is_layout = macos_dir.file_name().and_then(|s| s.to_str()) == Some("MacOS")
        && contents_dir.file_name().and_then(|s| s.to_str()) == Some("Contents")
        && app_dir
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|n| n.ends_with(".app"));
    if !is_layout {
        return (None, false);
    }
    let app_str = app_dir.to_string_lossy();
    if app_str.starts_with("/Volumes/") || app_str.contains("AppTranslocation") {
        return (None, false);
    }
    let Some(parent) = app_dir.parent() else {
        return (None, false);
    };
    // Probe parent directory writability without leaving artifacts.
    let probe = parent.join(format!(".gaze-update-probe-{}", std::process::id()));
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            (Some(app_dir.to_path_buf()), true)
        }
        Err(_) => (Some(app_dir.to_path_buf()), false),
    }
}

#[allow(dead_code)]
fn inspect_windows_exe_path(exe_path: &Path) -> (Option<PathBuf>, bool) {
    let resolved = fs::canonicalize(exe_path).unwrap_or_else(|_| exe_path.to_path_buf());
    let is_exe = resolved
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    if !is_exe || !resolved.is_file() {
        return (None, false);
    }
    (Some(resolved), true)
}

#[allow(dead_code)]
fn verify_pe_header(path: &Path) -> Result<(), String> {
    let mut f = fs::File::open(path).map_err(|e| format!("open installer: {e}"))?;
    let mut magic = [0u8; 2];
    f.read_exact(&mut magic)
        .map_err(|e| format!("read installer header: {e}"))?;
    if &magic != b"MZ" {
        return Err("downloaded Windows installer is not a valid PE executable".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn extract_and_verify_artifact(
    archive_path: &Path,
    stage_dir: &Path,
    format: &str,
    bundle_name: &str,
    expected_bundle_id: &str,
) -> Result<PathBuf, String> {
    use std::process::Command;

    let extract_dir = stage_dir.join("extracted");
    fs::create_dir_all(&extract_dir).map_err(|e| format!("create extract dir: {e}"))?;

    let status = if format == "app-tar-gz" {
        Command::new("/usr/bin/tar")
            .args(["-xzf"])
            .arg(archive_path)
            .arg("-C")
            .arg(&extract_dir)
            .output()
            .map_err(|e| format!("run tar: {e}"))?
    } else {
        Command::new("/usr/bin/ditto")
            .args(["-x", "-k"])
            .arg(archive_path)
            .arg(&extract_dir)
            .output()
            .map_err(|e| format!("run ditto: {e}"))?
    };
    if !status.status.success() {
        return Err(format!(
            "extract archive failed: {}",
            String::from_utf8_lossy(&status.stderr).trim()
        ));
    }

    let staged_app = extract_dir.join(bundle_name);
    if !staged_app.is_dir() {
        return Err(format!("extracted archive missing {bundle_name}"));
    }

    let plist_path = staged_app.join("Contents").join("Info.plist");
    let plist_out = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleIdentifier"])
        .arg(&plist_path)
        .output()
        .map_err(|e| format!("read staged Info.plist: {e}"))?;
    let actual_id = String::from_utf8_lossy(&plist_out.stdout)
        .trim()
        .to_string();
    if actual_id != expected_bundle_id {
        return Err(format!(
            "staged bundle ID mismatch (got '{actual_id}', expected '{expected_bundle_id}')"
        ));
    }

    let cs_out = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&staged_app)
        .output()
        .map_err(|e| format!("run codesign verify: {e}"))?;
    if !cs_out.status.success() {
        return Err(format!(
            "staged bundle signature verification failed: {}",
            String::from_utf8_lossy(&cs_out.stderr).trim()
        ));
    }

    Ok(staged_app)
}

#[cfg(target_os = "windows")]
fn extract_and_verify_artifact(
    archive_path: &Path,
    stage_dir: &Path,
    format: &str,
    _bundle_name: &str,
    _expected_bundle_id: &str,
) -> Result<PathBuf, String> {
    if format != "nsis-exe" {
        return Err(format!("Unsupported Windows update format: {format}"));
    }
    verify_pe_header(archive_path)?;
    let installer_path = stage_dir.join("gaze-setup.exe");
    fs::rename(archive_path, &installer_path)
        .map_err(|e| format!("stage Windows installer: {e}"))?;
    Ok(installer_path)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn extract_and_verify_artifact(
    _archive_path: &Path,
    _stage_dir: &Path,
    _format: &str,
    _bundle_name: &str,
    _expected_bundle_id: &str,
) -> Result<PathBuf, String> {
    Err("Automatic self-update is only supported on macOS and Windows".to_string())
}

#[cfg(target_os = "macos")]
const MACOS_APPLY_SCRIPT: &str = r#"#!/bin/sh
set -eu

OLD_PID="$1"
TARGET_APP="$2"
STAGED_APP="$3"
STAGE_DIR="$4"
EXPECTED_BUNDLE_ID="$5"
LOG_FILE="$STAGE_DIR/apply.log"
exec >>"$LOG_FILE" 2>&1

echo "[updater] start pid=$OLD_PID target=$TARGET_APP"

KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
PRESERVE_ID=""
CUR_AUTH=$(/usr/bin/codesign -dvv "$TARGET_APP" 2>&1 | /usr/bin/sed -n 's/^Authority=//p' | /usr/bin/head -n 1 || true)
NEW_SIG_INFO=$(/usr/bin/codesign -dvv "$STAGED_APP" 2>&1 || true)
if [ -n "$CUR_AUTH" ] && printf '%s\n' "$NEW_SIG_INFO" | /usr/bin/grep -q '^Signature=adhoc'; then
  if /usr/bin/security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | /usr/bin/grep -Fq "\"${CUR_AUTH}\""; then
    PRESERVE_ID="$CUR_AUTH"
  fi
fi

STAGED_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$STAGED_APP/Contents/Info.plist" 2>/dev/null || true)
if [ "$STAGED_ID" != "$EXPECTED_BUNDLE_ID" ]; then
  echo "[updater] bundle id mismatch: got=$STAGED_ID want=$EXPECTED_BUNDLE_ID"
  exit 1
fi

i=0
while /bin/kill -0 "$OLD_PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 150 ]; then
    echo "[updater] timed out waiting for old pid $OLD_PID"
    exit 1
  fi
  /bin/sleep 0.1
done

/usr/bin/xattr -dr com.apple.quarantine "$STAGED_APP" 2>/dev/null || true
if [ -n "$PRESERVE_ID" ]; then
  echo "[updater] preserving local signing identity: $PRESERVE_ID"
  if [ -d "$STAGED_APP/Contents/Frameworks" ]; then
    /usr/bin/find "$STAGED_APP/Contents/Frameworks" -maxdepth 1 -name '*.dylib' -print0 \
      | /usr/bin/xargs -0 -I{} /usr/bin/codesign --force --keychain "$KEYCHAIN" --sign "$PRESERVE_ID" "{}"
  fi
  /usr/bin/codesign --force --deep --keychain "$KEYCHAIN" --sign "$PRESERVE_ID" "$STAGED_APP"
fi
/usr/bin/codesign --verify --deep --strict "$STAGED_APP"

PARENT_DIR=$(/usr/bin/dirname "$TARGET_APP")
APP_NAME=$(/usr/bin/basename "$TARGET_APP")
NEW_TMP="$PARENT_DIR/.${APP_NAME}.new.$$"
OLD_TMP="$PARENT_DIR/.${APP_NAME}.old.$$"

/usr/bin/ditto "$STAGED_APP" "$NEW_TMP"

if ! /bin/mv "$TARGET_APP" "$OLD_TMP"; then
  /bin/rm -rf "$NEW_TMP"
  exit 1
fi

if ! /bin/mv "$NEW_TMP" "$TARGET_APP"; then
  /bin/mv "$OLD_TMP" "$TARGET_APP" || true
  /bin/rm -rf "$NEW_TMP"
  exit 1
fi

/bin/rm -rf "$OLD_TMP" "$STAGE_DIR" || true
/usr/bin/open "$TARGET_APP"
"#;

#[cfg(target_os = "macos")]
fn spawn_detached_apply_helper(
    old_pid: u32,
    target_app: &Path,
    staged_app: &Path,
    stage_dir: &Path,
    expected_bundle_id: &str,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let script_path = stage_dir.join("apply.sh");
    fs::write(&script_path, MACOS_APPLY_SCRIPT).map_err(|e| format!("write apply helper: {e}"))?;
    fs::set_permissions(&script_path, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("chmod apply helper: {e}"))?;

    Command::new("/bin/sh")
        .arg(&script_path)
        .arg(old_pid.to_string())
        .arg(target_app)
        .arg(staged_app)
        .arg(stage_dir)
        .arg(expected_bundle_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("spawn apply helper: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
const WINDOWS_APPLY_SCRIPT: &str = r#"param(
  [int]$OldPid,
  [string]$Installer,
  [string]$TargetExe,
  [string]$StageDir
)
$ErrorActionPreference = 'SilentlyContinue'
try { Wait-Process -Id $OldPid -Timeout 30 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 300
if (Test-Path -LiteralPath $Installer) {
  Start-Process -FilePath $Installer -ArgumentList '/S' -Wait
}
if (Test-Path -LiteralPath $TargetExe) {
  Start-Process -FilePath $TargetExe
}
if ($StageDir -and (Test-Path -LiteralPath $StageDir)) {
  Remove-Item -LiteralPath $StageDir -Recurse -Force -ErrorAction SilentlyContinue
}
"#;

#[cfg(target_os = "windows")]
fn spawn_detached_apply_helper(
    old_pid: u32,
    target_exe: &Path,
    installer_exe: &Path,
    stage_dir: &Path,
    _expected_bundle_id: &str,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let script_path = stage_dir.join("apply.ps1");
    fs::write(&script_path, WINDOWS_APPLY_SCRIPT)
        .map_err(|e| format!("write Windows apply helper: {e}"))?;

    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script_path)
        .args(["-OldPid", &old_pid.to_string()])
        .arg("-Installer")
        .arg(installer_exe)
        .arg("-TargetExe")
        .arg(target_exe)
        .arg("-StageDir")
        .arg(stage_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("spawn Windows apply helper: {e}"))?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn spawn_detached_apply_helper(
    _old_pid: u32,
    _target_path: &Path,
    _staged_artifact: &Path,
    _stage_dir: &Path,
    _expected_bundle_id: &str,
) -> Result<(), String> {
    Err("Automatic self-update is only supported on macOS and Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn semver_parsing_and_ordering() {
        assert_eq!(
            parse_semver("v0.2.6"),
            Some(Semver {
                major: 0,
                minor: 2,
                patch: 6
            })
        );
        assert_eq!(
            parse_semver("0.3.0-rc.1"),
            Some(Semver {
                major: 0,
                minor: 3,
                patch: 0
            })
        );
        assert!(parse_semver("0.2.7") > parse_semver("0.2.6"));
        assert!(parse_semver("1.0.0") > parse_semver("0.99.99"));
        assert_eq!(parse_semver("dev"), None);
    }

    #[test]
    fn ed25519_verify_accepts_valid_and_rejects_tampered() {
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let pub_b64 = BASE64.encode(signing_key.verifying_key().to_bytes());
        let verifying_key = decode_verifying_key(&pub_b64).expect("valid pubkey");

        let payload = canonical_asset_payload("gaze", "0.2.7", "darwin-universal", "abc123", 42);
        let sig = signing_key.sign(payload.as_bytes());
        let sig_b64 = BASE64.encode(sig.to_bytes());

        assert!(verify_ed25519_b64(&verifying_key, payload.as_bytes(), &sig_b64).is_ok());
        assert!(verify_ed25519_b64(&verifying_key, b"tampered", &sig_b64).is_err());
    }

    #[test]
    fn embedded_public_key_decodes_cleanly() {
        assert!(decode_verifying_key(UPDATE_PUBKEY_B64).is_ok());
    }

    #[test]
    fn url_allowlist_blocks_untrusted_hosts() {
        assert!(validate_download_url(
            "https://github.com/abcdlsj/gaze/releases/latest/download/latest.json",
            false
        )
        .is_ok());
        assert!(validate_download_url(
            "https://github.com/abcdlsj/quiet/releases/latest/download/latest.json",
            false
        )
        .is_err());
        assert!(validate_download_url("https://evil.example.com/latest.json", false).is_err());
        assert!(validate_download_url("http://127.0.0.1:8080/latest.json", false).is_err());
        assert!(validate_download_url("http://127.0.0.1:8080/latest.json", true).is_ok());
    }

    #[test]
    fn handoff_roundtrip_is_one_shot_and_respects_ttl() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("update-handoff.json");
        let payload = UpdateHandoffPayload {
            schema_version: 1,
            from_version: "0.2.6".to_string(),
            to_version: "0.2.7".to_string(),
            created_at_ms: now_epoch_ms(),
            ttl_ms: 60_000,
            window: None,
            app_state: serde_json::json!({ "preferences_open": true, "active_tab": "about" }),
        };
        write_handoff_file(&path, &payload).expect("write handoff");
        let consumed = consume_handoff_file(&path).expect("consume handoff");
        assert_eq!(consumed.to_version, "0.2.7");
        assert_eq!(consumed.app_state["active_tab"], "about");
        assert!(consume_handoff_file(&path).is_none());

        // Expired handoff is discarded.
        let expired = UpdateHandoffPayload {
            created_at_ms: 1,
            ttl_ms: 100,
            ..payload
        };
        write_handoff_file(&path, &expired).expect("write expired");
        assert!(consume_handoff_file(&path).is_none());
    }

    #[test]
    fn inspect_bundle_path_rejects_dmg_and_accepts_writable_app() {
        let dmg_exe = Path::new("/Volumes/Gaze/Gaze.app/Contents/MacOS/gaze");
        assert_eq!(inspect_app_bundle_path(dmg_exe), (None, false));

        let dir = tempfile::tempdir().expect("tempdir");
        let exe = dir
            .path()
            .join("Gaze.app")
            .join("Contents")
            .join("MacOS")
            .join("gaze");
        fs::create_dir_all(exe.parent().unwrap()).expect("create dirs");
        fs::write(&exe, b"bin").expect("write exe");
        let (app_dir, writable) = inspect_app_bundle_path(&exe);
        assert!(writable);
        assert_eq!(
            app_dir.unwrap().file_name().and_then(|s| s.to_str()),
            Some("Gaze.app")
        );
    }

    #[test]
    fn inspect_windows_exe_and_pe_header() {
        let dir = tempfile::tempdir().expect("tempdir");
        let exe = dir.path().join("Gaze.exe");
        fs::write(&exe, b"MZ\x90\x00").expect("write pe");
        let (found, ok) = inspect_windows_exe_path(&exe);
        assert!(ok);
        assert!(found.is_some());
        assert!(verify_pe_header(&exe).is_ok());

        let bad = dir.path().join("not-pe.exe");
        fs::write(&bad, b"PK\x03\x04").expect("write zip");
        assert!(verify_pe_header(&bad).is_err());

        let non_exe = dir.path().join("readme.txt");
        fs::write(&non_exe, b"hi").expect("write txt");
        assert_eq!(inspect_windows_exe_path(&non_exe), (None, false));
    }

    #[test]
    fn resolve_platform_asset_matches_current_host() {
        let mut platforms = HashMap::new();
        platforms.insert(
            "darwin-universal".to_string(),
            PlatformAsset {
                url: "https://github.com/abcdlsj/gaze/releases/download/v0.2.7/gaze_0.2.7_darwin_universal.zip".to_string(),
                signature: "sig".to_string(),
                sha256: "abc".to_string(),
                size: 123,
                format: "app-zip".to_string(),
                bundle_name: Some("Gaze.app".to_string()),
                bundle_id: Some("dev.abcdlsj.gaze".to_string()),
            },
        );
        platforms.insert(
            "windows-x86_64".to_string(),
            PlatformAsset {
                url: "https://github.com/abcdlsj/gaze/releases/download/v0.2.7/gaze_0.2.7_windows_amd64_setup.exe".to_string(),
                signature: "sig".to_string(),
                sha256: "def".to_string(),
                size: 456,
                format: "nsis-exe".to_string(),
                bundle_name: None,
                bundle_id: None,
            },
        );
        let resolved = resolve_platform_asset(&platforms);
        #[cfg(target_os = "macos")]
        assert_eq!(resolved.unwrap().0, "darwin-universal");
        #[cfg(target_os = "windows")]
        assert_eq!(resolved.unwrap().0, "windows-x86_64");
    }
}
