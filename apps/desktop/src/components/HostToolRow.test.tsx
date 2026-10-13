// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostToolProbeResult, HostToolStatus } from "../types";
import { HostToolRow, type HostToolActions } from "./Chrome";

const initial: HostToolStatus = {
  id: "chdman",
  display_name: "chdman",
  state: "available",
  path: "C:/Tools/chdman.exe",
  source: "saved",
  configuration_variable: "PORTCOVE_CHDMAN",
  purpose: "Check compressed discs",
  official_url: "https://docs.mamedev.org/tools/chdman.html",
};
const result: HostToolProbeResult = {
  tool_id: initial.id,
  path: initial.path!,
  state: "success",
  message: "The selected executable passed its probe.",
  sha256: "a".repeat(64),
  persisted: false,
  retry_action: "",
  clear_action_available: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let actions: HostToolActions;

async function render(tool: HostToolStatus = initial) {
  await act(async () => root.render(<HostToolRow tool={tool} busy={false} actions={actions} />));
}

async function click(label: string) {
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  actions = {
    locate: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    recheck: vi.fn().mockResolvedValue(result),
    openOfficial: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("host-tool feedback identity", () => {
  it.each([
    { id: "dolphin-tool" },
    { path: "D:/Replacement/chdman.exe" },
    { source: "environment" as const },
    { state: "missing" as const },
  ])("withdraws an earlier success after observed facts change: %j", async (change) => {
    await render();
    await click("Recheck");
    expect(container.textContent).toContain(result.message);
    await render({ ...initial, ...change });
    expect(container.textContent).not.toContain(result.message);
  });

  it("withdraws an earlier error when the executable changes", async () => {
    vi.mocked(actions.recheck).mockRejectedValue(new Error("Old executable failed"));
    await render();
    await click("Recheck");
    expect(container.textContent).toContain("Old executable failed");
    await render({ ...initial, path: "D:/Replacement/chdman.exe" });
    expect(container.textContent).not.toContain("Old executable failed");
  });

  it.each(["success", "failure"] as const)(
    "ignores a late %s for replaced facts while retaining operation exclusion",
    async (outcome) => {
      const probe = deferred<HostToolProbeResult>();
      vi.mocked(actions.recheck).mockReturnValue(probe.promise);
      await render();
      await click("Recheck");
      await render({ ...initial, path: "D:/Replacement/chdman.exe" });
      expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(
        true,
      );
      await act(async () => {
        if (outcome === "success") probe.resolve(result);
        else probe.reject(new Error("Old executable failed"));
      });
      expect(container.textContent).not.toContain(result.message);
      expect(container.textContent).not.toContain("Old executable failed");
      await click("Recheck");
      expect(actions.recheck).toHaveBeenCalledTimes(2);
    },
  );

  it("retains ordinary feedback across equivalent diagnostic objects", async () => {
    await render();
    await click("Recheck");
    await render({ ...initial });
    expect(container.textContent).toContain(result.message);
  });

  it("does not revive old feedback when observed facts change away and back", async () => {
    await render();
    await click("Recheck");
    await render({ ...initial, path: "D:/Replacement/chdman.exe" });
    await render({ ...initial });
    expect(container.textContent).not.toContain(result.message);
  });

  it("rejects an old response even when the starting facts return before it settles", async () => {
    const probe = deferred<HostToolProbeResult>();
    vi.mocked(actions.recheck).mockReturnValue(probe.promise);
    await render();
    await click("Recheck");
    await render({ ...initial, state: "missing" });
    await render({ ...initial });
    await act(async () => probe.resolve(result));
    expect(container.textContent).not.toContain(result.message);
  });

  it("excludes repeated activation before pending state renders", async () => {
    const probe = deferred<HostToolProbeResult>();
    vi.mocked(actions.recheck).mockReturnValue(probe.promise);
    await render();
    const recheck = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Recheck",
    )!;
    await act(async () => {
      recheck.click();
      recheck.click();
    });
    expect(actions.recheck).toHaveBeenCalledExactlyOnceWith(initial.id);
    await act(async () => probe.resolve(result));
    expect(container.textContent).toContain(result.message);
  });

  it("retains ordinary Locate feedback when observed facts are unchanged", async () => {
    vi.mocked(actions.locate).mockResolvedValue(result);
    await render();
    await click("Locate chdman…");
    expect(container.textContent).toContain(result.message);
  });

  it("preserves committed Locate feedback after its full refresh and reinspection callback", async () => {
    const finish = deferred<HostToolProbeResult>();
    const reinspect = vi.fn();
    vi.mocked(actions.locate).mockImplementation(async () => {
      const located = await finish.promise;
      await reinspect();
      return located;
    });
    await render({ ...initial, path: null, state: "missing", source: null });
    await click("Locate chdman…");
    await render({ ...initial, path: result.path });
    await act(async () => finish.resolve({ ...result, persisted: true }));
    expect(reinspect).toHaveBeenCalledExactlyOnceWith();
    expect(container.textContent).toContain(result.message);
    expect(container.textContent).toContain(initial.path);
  });

  it("does not attach committed Locate feedback to an unrelated replacement path", async () => {
    const finish = deferred<HostToolProbeResult>();
    vi.mocked(actions.locate).mockReturnValue(finish.promise);
    await render({ ...initial, path: null, state: "missing", source: null });
    await click("Locate chdman…");
    await render({ ...initial, path: "D:/Unrelated/chdman.exe" });
    await act(async () => finish.resolve({ ...result, persisted: true }));
    expect(container.textContent).not.toContain(result.message);
  });
});
