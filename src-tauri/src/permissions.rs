use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PermissionStatus {
    pub screen_recording: bool,
    pub accessibility: bool,
    pub platform: String,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[cfg(target_os = "macos")]
pub fn check_permissions() -> PermissionStatus {
    let screen_recording = core_graphics::access::ScreenCaptureAccess.preflight();
    let accessibility = unsafe { AXIsProcessTrusted() };
    PermissionStatus {
        screen_recording,
        accessibility,
        platform: "macos".to_string(),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn check_permissions() -> PermissionStatus {
    PermissionStatus {
        screen_recording: true,
        accessibility: true,
        platform: std::env::consts::OS.to_string(),
    }
}

#[cfg(target_os = "macos")]
pub fn request_screen_recording_prompt() -> bool {
    core_graphics::access::ScreenCaptureAccess.request()
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_recording_prompt() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn open_permission_settings(kind: &str) -> Result<(), String> {
    let url = match kind {
        "accessibility" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    };
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| format!("Failed to open System Settings: {e}"))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn open_permission_settings(_kind: &str) -> Result<(), String> {
    Ok(())
}
