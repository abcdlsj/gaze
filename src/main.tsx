import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { isMacPlatform } from "./lib/hotkeys";
import { PreferencesWindow } from "./windows/PreferencesWindow";
import { EditorWindow } from "./windows/EditorWindow";
import { InplaceEditorWindow } from "./windows/InplaceEditorWindow";
import { OverlayWindow } from "./windows/OverlayWindow";
import { PinWindow } from "./windows/PinWindow";
import { ThumbnailWindow } from "./windows/ThumbnailWindow";
import { ScrollHudWindow } from "./windows/ScrollHudWindow";

document.documentElement.dataset.platform = isMacPlatform()
  ? "macos"
  : "windows";

function AppRouter() {
  const params = new URLSearchParams(window.location.search);
  const win = params.get("window") ?? "preferences";
  const id = params.get("id") ?? "";

  switch (win) {
    case "editor":
      return <EditorWindow captureId={id} />;
    case "inplace":
      return <InplaceEditorWindow />;
    case "overlay":
      return <OverlayWindow />;
    case "pin":
      return <PinWindow captureId={id} />;
    case "thumbnail":
      return <ThumbnailWindow captureId={id} />;
    case "scroll-hud":
      return <ScrollHudWindow />;
    case "preferences":
    default:
      return <PreferencesWindow />;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);
