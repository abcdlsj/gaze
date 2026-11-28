export type WindowBackground =
  | "wallpaper"
  | "transparent"
  | "solid_color"
  | "trim_shadow";

export type SaveFormat = "png" | "auto";

export type AfterAreaCrop = "thumbnail" | "editor";

export type ThumbnailAutoHide =
  | "manually"
  | "after5s"
  | "after10s"
  | "after30s";

export interface HotkeyConfig {
  capture_area: string;
  capture_fullscreen: string;
  capture_window: string;
  capture_scrolling: string;
  open_clipboard: string;
}

export interface EditorDefaults {
  default_color: string;
  stroke_width: number;
  font_size: number;
  blur_strength: number;
  copy_closes_editor: boolean;
  save_closes_editor: boolean;
}

export interface AppSettings {
  window_background: WindowBackground;
  solid_background_color: string;
  screenshots_folder: string;
  save_format: SaveFormat;
  resize_retina_1x: boolean;
  scrolling_max_height: number;
  scrolling_speed: number;
  autostart: boolean;
  after_screenshot_show: boolean;
  after_screenshot_copy: boolean;
  after_screenshot_save: boolean;
  after_area_crop: AfterAreaCrop;
  hide_preview_thumbnail: ThumbnailAutoHide;
  hotkeys: HotkeyConfig;
  editor: EditorDefaults;
}

export interface PermissionStatus {
  screen_recording: boolean;
  accessibility: boolean;
  platform: string;
}

export interface WindowRect {
  id: number;
  app_name: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureMeta {
  id: string;
  width: number;
  height: number;
  scale_factor: number;
  source: string;
}

export interface OverlaySessionInfo {
  seq: number;
  monitor_id: number;
  monitor_name: string;
  monitor_index: number;
  monitor_count: number;
  monitor_x: number;
  monitor_y: number;
  monitor_width: number;
  monitor_height: number;
  image_width: number;
  image_height: number;
  scale_factor: number;
  windows: WindowRect[];
  initial_mode: "area" | "window" | "scrolling";
  initial_cursor_x: number | null;
  initial_cursor_y: number | null;
  has_native_backdrop: boolean;
}

export interface ScrollProgressEvent {
  frames: number;
  height: number;
  max_height: number;
  status: "capturing" | "finishing" | "done" | "cancelled" | "error";
  message?: string;
}

// Editor annotation types
export type EditorTool =
  | "select"
  | "arrow"
  | "line"
  | "text"
  | "ruler"
  | "rect"
  | "ellipse"
  | "frame"
  | "pen"
  | "blur"
  | "pixelate"
  | "blackout"
  | "spotlight"
  | "counter"
  | "crop";

export type ShapeFillStyle = "outline" | "tinted" | "solid";

export type TextStyle = "plain" | "badge";

export type RedactMode = "blur" | "pixelate" | "blackout";

export type ResizeHandleId =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "start"
  | "end";

export interface Point {
  x: number;
  y: number;
}

export interface AnnotationBase {
  id: string;
  color: string;
  strokeWidth: number;
}

export interface ArrowAnnotation extends AnnotationBase {
  type: "arrow" | "line";
  start: Point;
  end: Point;
}

export interface ShapeAnnotation extends AnnotationBase {
  type: "rect" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  filled?: boolean;
  fillStyle?: ShapeFillStyle;
  cornerRadius?: number;
}

export interface TextAnnotation extends AnnotationBase {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
  textStyle?: TextStyle;
}

export interface RulerAnnotation extends AnnotationBase {
  type: "ruler";
  start: Point;
  end: Point;
}

export interface PenAnnotation extends AnnotationBase {
  type: "pen";
  points: Point[];
  highlighter?: boolean;
}

export interface RedactAnnotation extends AnnotationBase {
  type: "blur" | "pixelate" | "blackout";
  x: number;
  y: number;
  width: number;
  height: number;
  strength: number;
}

export interface SpotlightAnnotation extends AnnotationBase {
  type: "spotlight";
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
}

export interface CounterAnnotation extends AnnotationBase {
  type: "counter";
  x: number;
  y: number;
  number: number;
  radius: number;
}

export type Annotation =
  | ArrowAnnotation
  | ShapeAnnotation
  | TextAnnotation
  | RulerAnnotation
  | PenAnnotation
  | RedactAnnotation
  | SpotlightAnnotation
  | CounterAnnotation;

export interface BackdropConfig {
  enabled: boolean;
  padding: number;
  cornerRadius: number;
  shadow: boolean;
  background: string;
}

// In-place (Snipaste-style) editing session handed over from the native capture overlay.
// All geometry is in display-local points (CSS px of the full-display editor window).
export interface InplaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InplaceToolbarSide = "below" | "above" | "inside";

export type InplaceAction = "done" | "save" | "pin" | "editor" | "cancel";

export interface InplaceSession {
  label: string;
  capture_id: string;
  scale_factor: number;
  tool: EditorTool;
  view_width: number;
  view_height: number;
  selection: InplaceRect;
  toolbar: InplaceRect;
  toolbar_side: InplaceToolbarSide;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "verifying"
  | "ready_to_restart"
  | "flushing"
  | "installing"
  | "error";

export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  state: UpdatePhase;
  progress: number;
  can_apply: boolean;
  release_url?: string;
  notes?: string;
  error?: string;
}

export interface UpdateHandoffPayload {
  schema_version: number;
  from_version: string;
  to_version: string;
  created_at_ms: number;
  ttl_ms: number;
  app_state: Record<string, unknown>;
}
