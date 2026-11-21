import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  CaptureMeta,
  OverlaySessionInfo,
  PermissionStatus,
} from "../types";

export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_settings");
}

export async function updateSettings(
  newSettings: AppSettings,
): Promise<Record<string, string | null>> {
  return invoke<Record<string, string | null>>("update_settings", {
    newSettings,
  });
}

export async function resetSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("reset_settings");
}

export async function getHotkeyErrors(): Promise<Record<string, string | null>> {
  return invoke<Record<string, string | null>>("get_hotkey_errors");
}

export async function checkPermissions(): Promise<PermissionStatus> {
  return invoke<PermissionStatus>("check_permissions");
}

export async function requestScreenPermission(): Promise<boolean> {
  return invoke<boolean>("request_screen_permission");
}

export async function openPermissionSettings(
  kind: "screen_recording" | "accessibility",
): Promise<void> {
  return invoke("open_permission_settings", { kind });
}

export async function triggerCapture(
  mode: "area" | "window" | "scrolling" | "fullscreen" | "clipboard",
): Promise<void> {
  return invoke("trigger_capture", { mode });
}

export async function getOverlaySession(): Promise<OverlaySessionInfo> {
  return invoke<OverlaySessionInfo>("get_overlay_session");
}

export async function getOverlayImageBytes(): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("get_overlay_image_png");
  return new Uint8Array(buf);
}

export async function cancelOverlay(): Promise<void> {
  return invoke("cancel_overlay");
}

export async function completeAreaSelection(
  x: number,
  y: number,
  width: number,
  height: number,
  action: "default" | "editor" | "copy" | "save" | "pin",
): Promise<CaptureMeta> {
  return invoke<CaptureMeta>("complete_area_selection", {
    x,
    y,
    width,
    height,
    action,
  });
}

export async function completeWindowSelection(
  windowId: number,
): Promise<CaptureMeta> {
  return invoke<CaptureMeta>("complete_window_selection", { windowId });
}

export async function startScrollingCapture(
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke("start_scrolling_capture", { x, y, width, height });
}

export async function stopScrollingCapture(): Promise<void> {
  return invoke("stop_scrolling_capture");
}

export async function getCaptureMeta(id: string): Promise<CaptureMeta> {
  return invoke<CaptureMeta>("get_capture_meta", { id });
}

export async function getCaptureImageBytes(id: string): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("get_capture_image_png", { id });
  return new Uint8Array(buf);
}

export async function copyImageBytes(pngBytes: Uint8Array): Promise<void> {
  return invoke("copy_image_bytes", { pngBytes: Array.from(pngBytes) });
}

export async function copyCaptureById(id: string): Promise<void> {
  return invoke("copy_capture_by_id", { id });
}

export async function copyTextToClipboard(text: string): Promise<void> {
  return invoke("copy_text_to_clipboard", { text });
}

export async function saveImageBytes(
  pngBytes: Uint8Array,
  scaleFactor: number,
  path?: string,
): Promise<string> {
  return invoke<string>("save_image_bytes", {
    pngBytes: Array.from(pngBytes),
    scaleFactor,
    path: path ?? null,
  });
}

export async function saveCaptureById(
  id: string,
  path?: string,
): Promise<string> {
  return invoke<string>("save_capture_by_id", { id, path: path ?? null });
}

export async function pinImageBytes(
  pngBytes: Uint8Array,
  scaleFactor: number,
): Promise<CaptureMeta> {
  return invoke<CaptureMeta>("pin_image_bytes", {
    pngBytes: Array.from(pngBytes),
    scaleFactor,
  });
}

export async function openEditorForCapture(id: string): Promise<void> {
  return invoke("open_editor_for_capture", { id });
}

export async function openPreferencesWindow(): Promise<void> {
  return invoke("open_preferences_window");
}

export async function openScreenshotsFolder(): Promise<void> {
  return invoke("open_screenshots_folder");
}
