// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibrarySelectionCard } from "./Chrome";

let root: Root;
let container: HTMLDivElement;

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`missing button: ${label}`);
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
    const choose = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("F:/Other Portcove");
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
    expect(container.textContent).not.toContain(
      "Switch whole Portcove library",
    );
    expect(switchLibrary).not.toHaveBeenCalled();

    const trigger = button("Review library switch");
    await click("Review library switch");
    expect(container.textContent).toContain("Switch whole Portcove library");
    expect(container.textContent).toContain("F:/Other Portcove");
    expect(container.textContent).toContain(
      "per-game Export / install folders do not change",
    );
    expect(switchLibrary).not.toHaveBeenCalled();
    await click("Keep current library");
    expect(document.activeElement).toBe(trigger);

    choose.mockResolvedValueOnce("F:/Other Portcove");
    await click("Review library switch");
    await click("Switch whole library");
    expect(switchLibrary).toHaveBeenCalledWith("F:/Other Portcove");
    expect(reset).not.toHaveBeenCalled();
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
    expect(container.textContent).toContain("Use the platform-default library");
    expect(reset).not.toHaveBeenCalled();
    await click("Use platform default");
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
