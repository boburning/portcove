// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { portStatus } from "../test-fixtures";
import type { GameUpdatePlan, InstallRecord } from "../types";
import type { Perform } from "../features/operations/use-operation-state";
import { GameUpdateControl, UpdatePolicyControl } from "./GameUpdates";

const plan: GameUpdatePlan = {
  activate: false,
  plan_sha256: "reviewed-download",
  plan: {
    bundled_runtime: null,
    port_id: "sample",
    channel: "stable",
    platform: "windows-x86-64",
    action: "download",
    source_requirements: [],
    download_bytes: 1024,
    release: {
      published_at: null,
      version: "2.0",
      channel: "stable",
      asset: {
        name: "sample.zip",
        url: "https://example.com/sample.zip",
        size: 1024,
        sha256: "a".repeat(64),
      },
    },
    storage: {
      library_root: "E:/Portcove",
      volume_total_bytes: 1024 ** 4,
      volume_available_bytes: 512 * 1024 ** 3,
    },
    output_location: {
      configured_output_directory: null,
      port_id: "sample",
      library_root: "E:/Portcove",
      default_output_directory: "E:/Portcove/versions/sample",
      effective_output_directory: "E:/Portcove/versions/sample",
      selection_source: "library_default",
      user_data_root: "E:/Portcove/user/sample",
    },
  },
};
const stagedUpdate: InstallRecord = {
  id: "staged-2.0",
  port_id: "sample",
  version: "2.0",
  path: "E:/Portcove/versions/sample/2.0",
  channel: "stable",
  installed_at: 1,
  verified: true,
  staged: true,
  artifact: { asset_name: "sample.zip", sha256: "a".repeat(64), size: 1024 },
  manifest_sha256: "b".repeat(64),
  selected_executable: "sample.exe",
  runtime: null,
};
const perform: Perform = async (_name, task) => task();
let root: Root;
let container: HTMLDivElement;
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function click(label: string, contains = false) {
  const control = [...document.querySelectorAll<HTMLElement>('button, [role="option"]')].find(
    (item) => (contains ? item.textContent?.includes(label) : item.textContent === label),
  );
  expect(control).toBeDefined();
  await act(async () => control?.click());
}
function dialog() {
  return document.body.querySelector('[aria-labelledby="game-update-review-title"]');
}
async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

it("edits locally until Save and never reviews or runs an update when saving", async () => {
  const save = vi.fn().mockResolvedValue({ ...portStatus(), update_policy: "automatic" });
  const review = vi.spyOn(desktopApi, "planGameUpdate");
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  await act(async () =>
    root.render(<UpdatePolicyControl policy="notify" busy={false} save={save} />),
  );
  await click("Saved update policy", true);
  await click("Install when running updates");
  expect(save).not.toHaveBeenCalled();
  await click("Save update settings");
  expect(save).toHaveBeenCalledExactlyOnceWith("automatic");
  expect(review).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(container.textContent).toContain("No update was run");
});

it("does not report a settings save as successful after failure", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Library changed"));
  await act(async () =>
    root.render(<UpdatePolicyControl policy="notify" busy={false} save={save} />),
  );
  await click("Saved update policy", true);
  await click("Download for later");
  await click("Save update settings");
  expect(container.textContent).toContain("Library changed");
  expect(container.textContent).not.toContain("settings saved");
});

it("reviews without execution and submits the exact download-only plan on confirmation", async () => {
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(plan);
  const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(stagedUpdate);
  await act(async () =>
    root.render(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    ),
  );
  await click("Review game update");
  expect(apply).not.toHaveBeenCalled();
  expect(desktopApi.planGameUpdate).toHaveBeenCalledExactlyOnceWith("sample", false, 9);
  expect(dialog()?.textContent).toContain("to download");
  expect(dialog()?.textContent).toContain("active version stays unchanged");
  expect(document.activeElement?.textContent).toBe("Download update for later");
  await click("Download update for later");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    "sample",
    false,
    "reviewed-download",
    9,
    expect.any(Function),
  );
  expect(container.textContent).toContain("Review game update");
  expect(container.textContent).toContain(
    "Update staged for later. Your active version is unchanged.",
  );
  expect(container.textContent).not.toContain("Update downloaded for later");
});

it("requires another review when the chosen action changes and binds activation to that review", async () => {
  vi.spyOn(desktopApi, "planGameUpdate")
    .mockResolvedValueOnce(plan)
    .mockResolvedValueOnce({
      ...plan,
      activate: true,
      plan_sha256: "reviewed-activation",
    });
  const apply = vi
    .spyOn(desktopApi, "applyGameUpdate")
    .mockRejectedValue(new Error("Release changed"));
  await act(async () =>
    root.render(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    ),
  );
  await click("Review game update");
  await pressEscape();
  expect(dialog()).toBeNull();
  expect(document.activeElement?.textContent).toBe("Review game update");
  await click("This update", true);
  await click("Install update");
  expect(container.textContent).not.toContain("2.0");
  expect(apply).not.toHaveBeenCalled();
  await click("Review game update");
  await click("Download and install update");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    "sample",
    true,
    "reviewed-activation",
    9,
    expect.any(Function),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Release changed");
  expect(container.textContent).toContain("Review game update");
});

it("keeps update cancellation inside the busy review and locks dismissal", async () => {
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(plan);
  let finish!: () => void;
  vi.spyOn(desktopApi, "applyGameUpdate").mockImplementation(
    (_portId, _activate, _expectedPlan, _generation, onEvent) => {
      onEvent({
        schema_version: 2,
        operation_id: "update-1",
        parent_operation_id: null,
        target: null,
        sequence: 0,
        timestamp_ms: 1,
        operation: "update",
        type: "started",
      });
      return new Promise((resolve) => {
        finish = () => resolve(undefined!);
      });
    },
  );
  const cancel = vi
    .spyOn(desktopApi, "cancelOperation")
    .mockResolvedValue({ phase: "preparing", requested: true });
  await act(async () =>
    root.render(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    ),
  );
  await click("Review game update");
  await click("Download update for later");
  expect(dialog()?.textContent).toContain("Cancel game update");
  await pressEscape();
  expect(dialog()).not.toBeNull();
  await click("Cancel game update");
  expect(cancel).toHaveBeenCalledExactlyOnceWith("update-1");
  expect(dialog()?.textContent).toContain("Cancellation requested");
  await act(async () => finish());
  expect(dialog()).toBeNull();
});

it("discards a late update review after switching the selected library", async () => {
  let complete!: (value: GameUpdatePlan) => void;
  vi.spyOn(desktopApi, "planGameUpdate").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () =>
    root.render(
      <GameUpdateControl
        key="old"
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    ),
  );
  await click("Review game update");
  await act(async () =>
    root.render(
      <GameUpdateControl
        key="new"
        portId="sample"
        generation={10}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    ),
  );
  await act(async () => complete(plan));
  expect(container.textContent).not.toContain("2.0");
});

it.each(["future_action", "constructor", "__proto__", "toString"])(
  "rejects an unfamiliar update action %s before execution and supports a fresh review",
  async (action) => {
    vi.spyOn(desktopApi, "planGameUpdate")
      .mockResolvedValueOnce({
        ...plan,
        plan: {
          ...plan.plan,
          action: action as GameUpdatePlan["plan"]["action"],
        },
      })
      .mockResolvedValueOnce(plan);
    const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(undefined!);
    await act(async () =>
      root.render(
        <GameUpdateControl
          portId="sample"
          generation={9}
          policy="notify"
          busy={false}
          perform={perform}
        />,
      ),
    );
    await click("Review game update");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      "cannot display this update plan",
    );
    expect(dialog()?.textContent).not.toContain("verified local release");
    expect(dialog()?.querySelector(".install-plan button")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    await click("Review game update again");
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
    await click("Download update for later");
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      "sample",
      false,
      "reviewed-download",
      9,
      expect.any(Function),
    );
  },
);

it.each(["already_active", "blocked_unverified"] as const)(
  "does not submit the recognized non-executable update action %s",
  async (action) => {
    vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue({
      ...plan,
      plan: { ...plan.plan, action },
    });
    const apply = vi.spyOn(desktopApi, "applyGameUpdate");
    await act(async () =>
      root.render(
        <GameUpdateControl
          portId="sample"
          generation={9}
          policy="notify"
          busy={false}
          perform={perform}
        />,
      ),
    );
    await click("Review game update");
    expect(dialog()?.querySelector(".install-plan button")).toBeNull();
    expect(dialog()?.querySelector('[role="status"]')?.textContent).toContain(
      action === "already_active" ? "already active" : "unverified local copy",
    );
    expect(apply).not.toHaveBeenCalled();
  },
);

it.each(["use_staged", "reuse_retained"] as const)(
  "retains exact confirmation for the verified local action %s",
  async (action) => {
    vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue({
      ...plan,
      plan_sha256: `reviewed-${action}`,
      plan: { ...plan.plan, action },
    });
    const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(stagedUpdate);
    await act(async () =>
      root.render(
        <GameUpdateControl
          portId="sample"
          generation={9}
          policy="notify"
          busy={false}
          perform={perform}
        />,
      ),
    );
    await click("Review game update");
    expect(apply).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("No download; use the verified local release.");
    expect(dialog()?.textContent).toContain("This will stage the verified update for later.");
    await click("Stage verified update for later");
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      "sample",
      false,
      `reviewed-${action}`,
      9,
      expect.any(Function),
    );
    expect(container.textContent).toContain(
      "Update staged for later. Your active version is unchanged.",
    );
    expect(container.textContent).not.toContain("Update downloaded for later");
  },
);
