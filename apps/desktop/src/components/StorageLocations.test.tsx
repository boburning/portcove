// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibrarySelectionCard } from "./Chrome";
import { desktopApi } from "../api";
import {
  useLibrarySelectionLanding,
  useLibrarySelectionReturn,
} from "../features/app-shell/use-library-selection-return";

let root: Root;
let container: HTMLDivElement;

function RemountedWorkspace({
  generation,
  trigger,
  consume,
  switchLibrary,
  resetLibrary,
}: {
  generation: number;
  trigger?: "switch" | "reset";
  consume: () => void;
  switchLibrary: (path: string) => Promise<void>;
  resetLibrary: () => Promise<void>;
}) {
  const workspace = useRef<HTMLElement>(null);
  useLibrarySelectionLanding(trigger, workspace, consume);
  return (
    <main ref={workspace} data-focus-region="workspace" tabIndex={-1}>
      <LibrarySelectionCard
        selection={{
          root: generation === 1 ? "E:/Portcove" : "F:/Other Portcove",
          source: "saved",
        }}
        choose={async () => "F:/Other Portcove"}
        switchLibrary={switchLibrary}
        reset={resetLibrary}
      />
    </main>
  );
}

function RemountFixture() {
  const [generation, setGeneration] = useState(1);
  const { switchFromSettings, resetFromSettings, returnToSelection, consume } =
    useLibrarySelectionReturn(
      generation,
      async () => setGeneration((current) => current + 1),
      async () => setGeneration((current) => current + 1),
    );
  return (
    <RemountedWorkspace
      key={generation}
      generation={generation}
      trigger={returnToSelection}
      consume={consume}
      switchLibrary={switchFromSettings}
      resetLibrary={resetFromSettings}
    />
  );
}

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
  vi.spyOn(desktopApi, "defaultLibraryRoot").mockResolvedValue("C:/Users/test/Portcove");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Storage locations", () => {
  it("hands focus to the new workspace after a real generation-key remount", async () => {
    await act(async () => root.render(<RemountFixture />));
    const oldSwitchTrigger = button("Choose another library");
    await click("Choose another library");
    await click("Switch whole library");
    const newSwitchTrigger = button("Choose another library");
    expect(newSwitchTrigger).not.toBe(oldSwitchTrigger);
    expect(document.activeElement).toBe(newSwitchTrigger);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    const oldResetTrigger = button("Use default library");
    await click("Use default library");
    await click("Open default library");
    const newResetTrigger = button("Use default library");
    expect(newResetTrigger).not.toBe(oldResetTrigger);
    expect(document.activeElement).toBe(newResetTrigger);
  });

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

    await click("Choose another library");
    expect(container.textContent).not.toContain("Switch whole Portcove library");
    expect(switchLibrary).not.toHaveBeenCalled();

    const trigger = button("Choose another library");
    await click("Choose another library");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Switch whole Portcove library");
    expect(document.body.textContent).toContain("F:/Other Portcove");
    expect(document.body.textContent).toContain("game install folders stay where they are");
    expect(switchLibrary).not.toHaveBeenCalled();
    await click("Keep current library");
    expect(document.activeElement).toBe(trigger);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    choose.mockResolvedValueOnce("F:/Other Portcove");
    await click("Choose another library");
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

    await click("Use default library");
    expect(desktopApi.defaultLibraryRoot).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Open the default library?");
    expect(document.body.textContent).toContain("C:/Users/test/Portcove");
    expect(document.body.textContent).toContain(
      "Files in the current library will stay where they are",
    );
    expect(reset).not.toHaveBeenCalled();
    await click("Open default library");
    expect(reset).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button("Use default library"));
  });

  it("refuses default reset when the real destination cannot be resolved", async () => {
    vi.mocked(desktopApi.defaultLibraryRoot).mockRejectedValueOnce(
      new Error("Default location unavailable"),
    );
    const reset = vi.fn();
    await act(async () =>
      root.render(
        <LibrarySelectionCard
          selection={{ root: "E:/Portcove", source: "saved" }}
          choose={vi.fn()}
          switchLibrary={vi.fn()}
          reset={reset}
        />,
      ),
    );
    await click("Use default library");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("Default location unavailable");
    expect(reset).not.toHaveBeenCalled();
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
    const trigger = button("Use default library");
    await click("Use default library");
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
    const trigger = button("Choose another library");
    await click("Choose another library");
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
    await click("Choose another library");
    expect(choose).toHaveBeenCalledTimes(2);
    expect(switchLibrary).toHaveBeenCalledTimes(1);
  });
});
