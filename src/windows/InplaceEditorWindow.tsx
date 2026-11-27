import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getInplaceSession } from "../lib/tauri";
import type { InplaceSession } from "../types";
import { EditorWindow } from "./EditorWindow";

/**
 * Hidden, display-sized transparent window that the native capture overlay prewarms. It
 * waits for the selection hand-off, then renders the editor in place over the frozen frame.
 */
export function InplaceEditorWindow() {
  const [session, setSession] = useState<InplaceSession | null>(null);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    void listen<InplaceSession>("inplace-session", (e) => {
      if (active) setSession((prev) => prev ?? e.payload);
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    });

    // The session may have been published before the listener existed; poll until it shows
    // up (the native overlay falls back to the standalone editor after a few seconds).
    const poll = () => {
      void getInplaceSession()
        .then((s) => {
          if (!active) return;
          if (s) setSession((prev) => prev ?? s);
          else timer = setTimeout(poll, 40);
        })
        .catch(() => {
          if (active) timer = setTimeout(poll, 120);
        });
    };
    poll();

    return () => {
      active = false;
      unlisten?.();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!session) return null;
  return (
    <EditorWindow
      key={`${session.label}:${session.capture_id}`}
      captureId={session.capture_id}
      inplace={session}
    />
  );
}
