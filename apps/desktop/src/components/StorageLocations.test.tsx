// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibrarySelectionCard } from "./Chrome";

let root: Root;
let container: HTMLDivElement;

function button(label: string) {
  const match = [...document.body.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`missing button: ${label}`);
  return match;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Storage locations", () => {
  it("keeps picker cancellation neutral and reviews a whole-library switch before applying it", async () => {
    const choose = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("F:/Other Portcove");
    const switchLibrary = vi.fn().mockResolvedValue(undefined);
    const reset = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        <LibrarySelectionCard
          selection={{ root: "E:/Portcove", source: "saved" }}
          choose={choose}
          switchLibrary={switchLibrary}
          reset={reset}
        />,
      );
    });

    await click("Review library switch");
    expect(container.textContent).not.toContain("Switch whole Portcove library");
    expect(switchLibrary).not.toHaveBeenCalled();

    const trigger = button("Review library switch");
    await click("Review library switch");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Switch whole Portcove library");
    expect(document.body.textContent).toContain("F:/Other Portcove");
    expect(document.body.textContent).toContain("per-game Export / install folders do not change");
    expect(switchLibrary).not.toHaveBeenCalled();
    await click("Keep current library");
    expect(document.activeElement).toBe(trigger);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    choose.mockResolvedValueOnce("F:/Other Portcove");
    await click("Review library switch");
    await click("Switch whole library");
    expect(switchLibrary).toHaveBeenCalledWith("F:/Other Portcove");
    expect(reset).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("uses a separately named review before selecting the platform default", async () => {
    const reset = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        <LibrarySelectionCard
          selection={{ root: "E:/Portcove", source: "saved" }}
          choose={vi.fn()}
          switchLibrary={vi.fn()}
          reset={reset}
        />,
      );
    });

    await click("Review platform default");
    expect(document.body.textContent).toContain("Use the platform-default library");
    expect(reset).not.toHaveBeenCalled();
    await click("Use platform default");
    expect(reset).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button("Review platform default"));
  });

  it("dismisses a reset review with Escape and returns focus without changing selection", async () => {
    const reset = vi.fn();
    await act(async () => {
      root.render(
        <LibrarySelectionCard
          selection={{ root: "E:/Portcove", source: "saved" }}
          choose={vi.fn()}
          switchLibrary={vi.fn()}
          reset={reset}
        />,
      );
    });
    const trigger = button("Review platform default");
    await click("Review platform default");
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(reset).not.toHaveBeenCalled();
  });

  it("keeps the review modal while switching and exposes failure before another review", async () => {
    let rejectSwitch!: (error: Error) => void;
    const switchLibrary = vi.fn().mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectSwitch = reject;
      }),
    );
    const choose = vi.fn().mockResolvedValue("F:/Other Portcove");
    await act(async () => {
      root.render(
        <LibrarySelectionCard
          selection={{ root: "E:/Portcove", source: "saved" }}
          choose={choose}
          switchLibrary={switchLibrary}
          reset={vi.fn()}
        />,
      );
    });
    const trigger = button("Review library switch");
    await click("Review library switch");
    await click("Switch whole library");
    expect(button("Switching…").disabled).toBe(true);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => rejectSwitch(new Error("selected library is unavailable")));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("selected library is unavailable");
    expect(document.activeElement).toBe(trigger);
    expect(switchLibrary).toHaveBeenCalledTimes(1);
    await click("Review library switch");
    expect(choose).toHaveBeenCalledTimes(2);
    expect(switchLibrary).toHaveBeenCalledTimes(1);
  });
});
