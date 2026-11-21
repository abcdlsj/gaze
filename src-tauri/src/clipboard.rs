use arboard::{Clipboard, ImageData};
use image::RgbaImage;
use std::borrow::Cow;

pub fn copy_rgba_image(img: &RgbaImage) -> Result<(), String> {
    let mut clipboard =
        Clipboard::new().map_err(|e| format!("Failed to access system clipboard: {e}"))?;
    let data = ImageData {
        width: img.width() as usize,
        height: img.height() as usize,
        bytes: Cow::Borrowed(img.as_raw()),
    };
    clipboard
        .set_image(data)
        .map_err(|e| format!("Failed to write image to clipboard: {e}"))
}

pub fn copy_png_bytes(png_bytes: &[u8]) -> Result<(), String> {
    let dynamic = image::load_from_memory(png_bytes)
        .map_err(|e| format!("Failed to decode image bytes for clipboard: {e}"))?;
    let rgba = dynamic.to_rgba8();
    copy_rgba_image(&rgba)
}

pub fn copy_text(text: &str) -> Result<(), String> {
    let mut clipboard =
        Clipboard::new().map_err(|e| format!("Failed to access system clipboard: {e}"))?;
    clipboard
        .set_text(text.to_string())
        .map_err(|e| format!("Failed to write text to clipboard: {e}"))
}

pub fn read_image_from_clipboard() -> Result<RgbaImage, String> {
    let mut clipboard =
        Clipboard::new().map_err(|e| format!("Failed to access system clipboard: {e}"))?;
    let img = clipboard
        .get_image()
        .map_err(|e| format!("No image found in clipboard ({e})"))?;
    RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())
        .ok_or_else(|| "Clipboard image buffer had unexpected dimensions".to_string())
}
