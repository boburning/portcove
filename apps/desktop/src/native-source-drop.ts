import { useEffect, useEffectEvent, useState } from "react";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";

export interface NativeSourceDropTarget {
  portId: string;
  profileId: string;
}

export interface NativeSourceDragState {
  active: boolean;
  pathCount: number;
  targetPortId?: string;
}

export type NativeSourceDrop = NativeSourceDropTarget & { paths: string[] };

const idleState: NativeSourceDragState = { active: false, pathCount: 0 };

export function sourceDropTargetAt(
  position: { x: number; y: number },
  elementAt = (x: number, y: number) => document.elementFromPoint(x, y),
  scale = window.devicePixelRatio || 1,
): NativeSourceDropTarget | undefined {
  const element = elementAt(position.x / scale, position.y / scale)?.closest<HTMLElement>(
    "[data-source-drop-profile-id]",
  );
  const portId = element?.dataset.sourceDropPortId;
  const profileId = element?.dataset.sourceDropProfileId;
  return portId && profileId ? { portId, profileId } : undefined;
}

export function createNativeSourceDropCoordinator(
  update: (state: NativeSourceDragState) => void,
  accept: (drop: NativeSourceDrop) => void,
  targetAt: (position: {
    x: number;
    y: number;
  }) => NativeSourceDropTarget | undefined = sourceDropTargetAt,
) {
  let pathCount = 0;
  return (event: DragDropEvent) => {
    if (event.type === "leave") {
      pathCount = 0;
      update(idleState);
      return;
    }
    const target = targetAt(event.position);
    if (event.type === "drop") {
      update(idleState);
      pathCount = 0;
      if (target) accept({ ...target, paths: [...event.paths] });
      return;
    }
    if (event.type === "enter") pathCount = event.paths.length;
    update({ active: true, pathCount, ...(target ? { targetPortId: target.portId } : {}) });
  };
}

type NativeSourceDropUnlisten = () => void | Promise<void>;

async function removeSourceDropListener(remove: NativeSourceDropUnlisten) {
  try {
    // Tauri's drag/drop cleanup is awaitable even when UnlistenFn is typed void.
    await remove();
  } catch {
    // The native webview may already be destroyed; cleanup cannot update React state.
  }
}

export function useNativeSourceDrop(accept: (drop: NativeSourceDrop) => void) {
  const [state, setState] = useState<NativeSourceDragState>(idleState);
  const acceptDrop = useEffectEvent(accept);
  useEffect(() => {
    let disposed = false;
    let unlisten: NativeSourceDropUnlisten | undefined;
    const coordinator = createNativeSourceDropCoordinator(setState, acceptDrop);
    void Promise.resolve()
      .then(() =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (!disposed) coordinator(event.payload);
        }),
      )
      .then((remove) => {
        if (disposed) void removeSourceDropListener(remove);
        else unlisten = remove;
      })
      .catch(() => {
        // Browser-only development and tests have no native webview event source.
      });
    return () => {
      disposed = true;
      if (unlisten) void removeSourceDropListener(unlisten);
    };
  }, []);
  return state;
}
