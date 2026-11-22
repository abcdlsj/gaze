use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowBackground {
    Wallpaper,
    Transparent,
    SolidColor,
    TrimShadow,
}

impl Default for WindowBackground {
    fn default() -> Self {
        Self::Transparent
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SaveFormat {
    Png,
    Auto,
}

impl Default for SaveFormat {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AfterAreaCrop {
    Thumbnail,
    Editor,
}

impl Default for AfterAreaCrop {
    fn default() -> Self {
        Self::Editor
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThumbnailAutoHide {
    Manually,
    After5s,
    After10s,
    After30s,
}

impl Default for ThumbnailAutoHide {
    fn default() -> Self {
        Self::Manually
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct HotkeyConfig {
    pub capture_area: String,
    pub capture_fullscreen: String,
    pub capture_window: String,
    pub capture_scrolling: String,
    pub open_clipboard: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            capture_area: "F1".to_string(),
            capture_fullscreen: String::new(),
            capture_window: String::new(),
            capture_scrolling: "Shift+F1".to_string(),
            open_clipboard: "CommandOrControl+Shift+V".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct EditorDefaults {
    pub default_color: String,
    pub stroke_width: u32,
    pub font_size: u32,
    pub blur_strength: u32,
    pub copy_closes_editor: bool,
    pub save_closes_editor: bool,
}

impl Default for EditorDefaults {
    fn default() -> Self {
        Self {
            default_color: "#EF4444".to_string(),
            stroke_width: 3,
            font_size: 16,
            blur_strength: 12,
            copy_closes_editor: false,
            save_closes_editor: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct AppSettings {
    pub window_background: WindowBackground,
    pub solid_background_color: String,
    pub screenshots_folder: String,
    pub save_format: SaveFormat,
    pub resize_retina_1x: bool,
    pub scrolling_max_height: u32,
    pub scrolling_speed: u8,
    pub autostart: bool,
    pub after_screenshot_show: bool,
    pub after_screenshot_copy: bool,
    pub after_screenshot_save: bool,
    pub after_area_crop: AfterAreaCrop,
    pub hide_preview_thumbnail: ThumbnailAutoHide,
    pub hotkeys: HotkeyConfig,
    pub editor: EditorDefaults,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            window_background: WindowBackground::Transparent,
            solid_background_color: "#2C3036".to_string(),
            screenshots_folder: default_screenshots_folder()
                .to_string_lossy()
                .to_string(),
            save_format: SaveFormat::Auto,
            resize_retina_1x: false,
            scrolling_max_height: 20_000,
            scrolling_speed: 70,
            autostart: false,
            after_screenshot_show: true,
            after_screenshot_copy: false,
            after_screenshot_save: false,
            after_area_crop: AfterAreaCrop::Editor,
            hide_preview_thumbnail: ThumbnailAutoHide::Manually,
            hotkeys: HotkeyConfig::default(),
            editor: EditorDefaults::default(),
        }
    }
}

pub fn default_screenshots_folder() -> PathBuf {
    if let Some(desktop) = dirs::desktop_dir() {
        return desktop.join("Gaze");
    }
    if let Some(pictures) = dirs::picture_dir() {
        return pictures.join("Gaze");
    }
    if let Some(home) = dirs::home_dir() {
        return home.join("Gaze");
    }
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("/"))
        .join("Gaze")
}

pub fn settings_file_path() -> PathBuf {
    let base = dirs::config_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("gaze").join("settings.json")
}

impl AppSettings {
    pub fn load() -> Self {
        let path = settings_file_path();
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(mut parsed) = serde_json::from_str::<AppSettings>(&raw) {
                parsed.clamp();
                return parsed;
            }
        }
        let defaults = Self::default();
        let _ = defaults.save();
        defaults
    }

    pub fn clamp(&mut self) {
        self.scrolling_max_height = self.scrolling_max_height.clamp(1_000, 50_000);
        self.scrolling_speed = self.scrolling_speed.clamp(1, 100);
        if self.screenshots_folder.trim().is_empty() {
            self.screenshots_folder = default_screenshots_folder().to_string_lossy().to_string();
        } else {
            let p = PathBuf::from(self.screenshots_folder.trim());
            if !p.is_absolute() {
                if let Ok(cwd) = std::env::current_dir() {
                    self.screenshots_folder = cwd.join(p).to_string_lossy().to_string();
                }
            }
        }
        self.editor.stroke_width = self.editor.stroke_width.clamp(1, 24);
        self.editor.font_size = self.editor.font_size.clamp(10, 72);
        self.editor.blur_strength = self.editor.blur_strength.clamp(4, 32);
    }

    pub fn save(&self) -> Result<(), String> {
        let path = settings_file_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize settings: {e}"))?;
        let tmp_path = path.with_extension("json.tmp");
        fs::write(&tmp_path, json).map_err(|e| format!("Failed to write settings: {e}"))?;
        fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to commit settings: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_expected_f1_and_preferences() {
        let s = AppSettings::default();
        assert_eq!(s.hotkeys.capture_area, "F1");
        assert_eq!(s.window_background, WindowBackground::Transparent);
        assert_eq!(s.save_format, SaveFormat::Auto);
        assert_eq!(s.scrolling_max_height, 20_000);
        assert_eq!(s.after_area_crop, AfterAreaCrop::Editor);
        assert!(s.after_screenshot_show);
    }

    #[test]
    fn roundtrip_serialization_and_clamp() {
        let mut s = AppSettings::default();
        s.scrolling_max_height = 999_999;
        s.scrolling_speed = 250;
        s.clamp();
        assert_eq!(s.scrolling_max_height, 50_000);
        assert_eq!(s.scrolling_speed, 100);

        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }
}
