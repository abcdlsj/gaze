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

export async function setHotkeysSuspended(
  suspended: boolean,
): Promise<Record<string, string | null>> {
  return invoke<Record<string, string | null>>("set_hotkeys_suspended", {
    suspended,
  });
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

export interface RawRgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function unpackRawRgba(buf: ArrayBuffer): RawRgbaImage {
  const view = new DataView(buf);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const data = new Uint8ClampedArray(buf, 8, width * height * 4);
  return { width, height, data };
}

export async function getOverlayImageRaw(): Promise<RawRgbaImage> {
  const buf = await invoke<ArrayBuffer>("get_overlay_image_raw");
  return unpackRawRgba(buf);
}

export async function getOverlayWindows(): Promise<
  import("../types").WindowRect[]
> {
  return invoke("get_overlay_windows");
}

export async function showOverlayWindow(): Promise<void> {
  return invoke("show_overlay_window");
}

export async function revealWindow(focus = true): Promise<void> {
  return invoke("reveal_window", { focus });
}

export async function switchOverlayMonitor(
  mode: "area" | "window" | "scrolling",
): Promise<void> {
  return invoke("switch_overlay_monitor", { mode });
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

export async function getCaptureImageRaw(id: string): Promise<RawRgbaImage> {
  const buf = await invoke<ArrayBuffer>("get_capture_image_raw", { id });
  return unpackRawRgba(buf);
}

async function uint8ToBase64(bytes: Uint8Array): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Base64 encode failed"));
    reader.readAsDataURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }),
    );
  });
}

export async function copyImageBytes(pngBytes: Uint8Array): Promise<void> {
  const pngBase64 = await uint8ToBase64(pngBytes);
  return invoke("copy_image_bytes", { pngBase64 });
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
  const pngBase64 = await uint8ToBase64(pngBytes);
  return invoke<string>("save_image_bytes", {
    pngBase64,
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
  const pngBase64 = await uint8ToBase64(pngBytes);
  return invoke<CaptureMeta>("pin_image_bytes", {
    pngBase64,
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

export async function openExternalUrl(url: string): Promise<void> {
  return invoke("open_external_url", { url });
}
