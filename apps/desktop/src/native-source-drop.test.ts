// @vitest-environment jsdom
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { describe, expect, it, vi } from "vitest";
import { createNativeSourceDropCoordinator, sourceDropTargetAt } from "./native-source-drop";

const position = { x: 20, y: 40 };
const native = (event: object) => event as DragDropEvent;

describe("native source drag coordination", () => {
  it("reveals targets only for native enter/over and clears them on leave", () => {
    const states: object[] = [];
    const accept = vi.fn();
    const handle = createNativeSourceDropCoordinator(state => states.push(state), accept, () => ({ portId: "port", profileId: "source" }));

    handle(native({ type: "enter", paths: ["D:/Game.z64"], position }));
    handle(native({ type: "over", position }));
    handle(native({ type: "leave" }));

    expect(states).toEqual([
      { active: true, pathCount: 1, targetPortId: "port" },
      { active: true, pathCount: 1, targetPortId: "port" },
      { active: false, pathCount: 0 },
    ]);
    expect(accept).not.toHaveBeenCalled();
  });

  it("passes the exact external paths only after a native drop over an eligible card", () => {
    const accept = vi.fn();
    const handle = createNativeSourceDropCoordinator(vi.fn(), accept, point => point.x === 20 ? ({ portId: "port", profileId: "source" }) : undefined);

    handle(native({ type: "drop", paths: ["D:/Disc 1.chd", "D:/Disc 2.chd"], position }));
    handle(native({ type: "drop", paths: ["D:/Ignored.z64"], position: { x: 0, y: 0 } }));

    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith({ portId: "port", profileId: "source", paths: ["D:/Disc 1.chd", "D:/Disc 2.chd"] });
  });

  it("maps physical native coordinates to the card data contract", () => {
    const card = document.createElement("button");
    card.dataset.sourceDropPortId = "port";
    card.dataset.sourceDropProfileId = "source";
    const child = document.createElement("span");
    card.append(child);
    const elementAt = vi.fn(() => child);

    expect(sourceDropTargetAt(position, elementAt, 2)).toEqual({ portId: "port", profileId: "source" });
    expect(elementAt).toHaveBeenCalledWith(10, 20);
  });
});
