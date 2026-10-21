import { controlledAct as act } from "../../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { portDefinition, portStatus } from "../../test-fixtures";
import type { DesktopError, GameUpdatePlan, InstallRecord } from "../../types";
import { useOperationState, type Perform } from "../operations/use-operation-state";

vi.mock("../../desktop-events", () => ({ listenDesktopEvent: async () => () => undefined }));
import { GameUpdateControl, UpdatePolicyControl } from "../../components/GameUpdates";
import { UpdateCenter } from "../../components/UpdateCenter";
import { StatusLayer } from "../../components/Chrome";

const plan: GameUpdatePlan = {
  assessment: { action: "update", availability: "allowed", reason: "available" },
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
let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
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
  return document.body.querySelector("[data-game-update-review]");
}

it("leaves a running update with valid focus without cancelling or changing its reviewed target", async () => {
  const expected = { ...plan, activate: true, plan_sha256: "install-reviewed" };
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(expected);
  let finish!: (value: InstallRecord) => void;
  const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const cancel = vi.spyOn(desktopApi, "cancelOperation");
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
    />,
  );
  await click("Review game update");
  await click("Download and install update");
  await click("Continue browsing");
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(
    container.querySelector('section[aria-label="Review game update"]'),
  );
  expect(apply.mock.calls[0]?.slice(0, 4)).toEqual(["sample", true, expected.plan_sha256, 9]);
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => finish(stagedUpdate));
  expect(cancel).not.toHaveBeenCalled();
});
async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

// The retained cold-browser trace completed the UI save but spent >15s in browser
// attachment/transport. Keep every assertion and a finite budget; no test retries.
it("edits locally until Save and never reviews or runs an update when saving", async () => {
  const save = vi.fn().mockResolvedValue({ ...portStatus(), update_policy: "automatic" });
  const review = vi.spyOn(desktopApi, "planGameUpdate");
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  await root.rerender(<UpdatePolicyControl policy="notify" busy={false} save={save} />);
  await click("Game update behavior", true);
  await click("Install when I run updates");
  expect(save).not.toHaveBeenCalled();
  await click("Save update settings");
  expect(save).toHaveBeenCalledExactlyOnceWith("automatic");
  expect(review).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(container.textContent).toContain("No update was run");
}, 45_000);

it("does not report a settings save as successful after failure", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Library changed"));
  await root.rerender(<UpdatePolicyControl policy="notify" busy={false} save={save} />);
  await click("Game update behavior", true);
  await click("Keep update for later");
  await click("Save update settings");
  expect(container.textContent).toContain("Library changed");
  expect(container.textContent).not.toContain("settings saved");
});

it("reviews without execution and submits the exact download-only plan on confirmation", async () => {
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(plan);
  const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(stagedUpdate);
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
    />,
  );
  await click("What would you like to do?", true);
  await click("Download for later");
  await click("Review game update");
  expect(apply).not.toHaveBeenCalled();
  expect(desktopApi.planGameUpdate).toHaveBeenCalledExactlyOnceWith("sample", false, 9);
  expect(dialog()?.textContent).toContain("to download");
  expect(dialog()?.textContent).toContain("current version stays unchanged");
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
    "Update saved for later. Your current version is unchanged.",
  );
  expect(container.textContent).not.toContain("Update downloaded for later");
});

it("shows per-version sign-in limits in update review before confirmation", async () => {
  const notice = "Sign-in stays with each installed version and is excluded from backups.";
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue({
    ...plan,
    plan: { ...plan.plan, preservation_notices: [notice] },
  });
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
    />,
  );
  await click("Review game update");
  expect(dialog()?.textContent).toContain(notice);
  expect(apply).not.toHaveBeenCalled();
});

it("shows shared and local preference paths before an update without accepting them", async () => {
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue({
    ...plan,
    plan: {
      ...plan.plan,
      shared_preferences: {
        binding: {
          contract: "regaiden041-windows",
          account_sid_sha256: "a".repeat(64),
          path: "C:/Users/player/AppData/Roaming/gbrecompiled/runtime/runtime_prefs.ini",
        },
        local_fallback_path: "E:/Portcove/versions/regaiden/artifact/runtime_prefs.ini",
        shared_present: false,
        local_fallback_present: false,
      },
    },
  });
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
    />,
  );
  await click("Review game update");
  expect(dialog()?.textContent).toContain(
    "C:/Users/player/AppData/Roaming/gbrecompiled/runtime/runtime_prefs.ini",
  );
  expect(dialog()?.textContent).toContain(
    "E:/Portcove/versions/regaiden/artifact/runtime_prefs.ini",
  );
  expect(dialog()?.textContent).toContain("requires acceptance");
  expect(apply).not.toHaveBeenCalled();
});

it("reviews an immediate update in place and obtains new consent before keeping it for later", async () => {
  const review = vi
    .spyOn(desktopApi, "planGameUpdate")
    .mockResolvedValueOnce({ ...plan, activate: true, plan_sha256: "install-reviewed" })
    .mockResolvedValueOnce({ ...plan, plan_sha256: "later-reviewed" });
  const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(stagedUpdate);
  const savePolicy = vi.spyOn(desktopApi, "setPolicy");
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
      compact
      gameName="Original Game · Sample Project"
    />,
  );
  expect(container.textContent).not.toContain("This update");
  await click("Review game update");
  expect(review).toHaveBeenNthCalledWith(1, "sample", true, 9);
  expect(dialog()?.textContent).toContain("Original Game · Sample Project update");
  expect(dialog()?.textContent).toContain("current version remains available for rollback");
  expect(apply).not.toHaveBeenCalled();
  await click("Review download for later");
  expect(review).toHaveBeenNthCalledWith(2, "sample", false, 9);
  expect(dialog()?.textContent).toContain("current version stays unchanged");
  await click("Download update for later");
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    "sample",
    false,
    "later-reviewed",
    9,
    expect.any(Function),
  );
  expect(savePolicy).not.toHaveBeenCalled();
});

it("does not submit duplicate reviews or apply a stale plan after a failed change of action", async () => {
  let release!: (value: GameUpdatePlan) => void;
  let rejectChange!: (reason: Error) => void;
  const review = vi
    .spyOn(desktopApi, "planGameUpdate")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectChange = reject;
        }),
    );
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
      compact
    />,
  );
  const opener = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Review game update",
  )!;
  await act(async () => {
    opener.click();
    opener.click();
  });
  expect(review).toHaveBeenCalledTimes(1);
  await act(async () => release({ ...plan, activate: true }));
  await click("Review download for later");
  expect(dialog()?.textContent).toContain("Checking update…");
  expect(dialog()?.textContent).not.toContain("Updating…");
  expect(apply).not.toHaveBeenCalled();
  const confirmation = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Checking update…",
  );
  expect(confirmation?.disabled).toBe(true);
  await act(async () => rejectChange(new Error("Update service offline")));
  expect(dialog()).toBeNull();
  expect(container.textContent).toContain("Update service offline");
  expect(apply).not.toHaveBeenCalled();
});

it("plays the current version independently and reviews a saved update without opening details", async () => {
  const onLaunch = vi.fn();
  const onSelect = vi.fn();
  const review = vi
    .spyOn(desktopApi, "planGameUpdate")
    .mockResolvedValue({ ...plan, activate: true });
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  const port = { ...portDefinition(), source_profile: null };
  const status = {
    ...portStatus(),
    active: { ...stagedUpdate, id: "active-1.0", version: "1.0", staged: false },
    staged: stagedUpdate,
    readiness: { launchable: true, pending_setup: false, blockers: [] },
  };
  await root.rerender(
    <UpdateCenter
      section="updates"
      generation={9}
      ports={[port]}
      statuses={new Map([[port.id, status]])}
      activities={[]}
      outcomes={[]}
      checkAll={vi.fn()}
      onSelect={onSelect}
      onLaunch={onLaunch}
      onOpenSettings={vi.fn()}
      diagnosticsRefreshing={false}
      diagnosticsStale={false}
      refreshDiagnostics={vi.fn()}
      perform={perform}
    />,
  );
  await click("Play");
  expect(onLaunch).toHaveBeenCalledExactlyOnceWith(port.id);
  expect(review).not.toHaveBeenCalled();
  await click("Review game update");
  expect(review).toHaveBeenCalledExactlyOnceWith(port.id, true, 9);
  expect(onSelect).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  await click("Cancel review");
  expect(document.activeElement?.textContent).toBe("Review game update");
});

it("shows only the newest game review when two row requests complete out of order", async () => {
  const pending = new Map<string, (value: GameUpdatePlan) => void>();
  const review = vi
    .spyOn(desktopApi, "planGameUpdate")
    .mockImplementation((id) => new Promise((resolve) => pending.set(id, resolve)));
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  const ports = [
    { ...portDefinition(), name: "First Game" },
    { ...portDefinition(), id: "other", name: "Second Game" },
  ];
  const statuses = new Map(
    ports.map((port) => [
      port.id,
      {
        ...portStatus(),
        port_id: port.id,
        active: { ...stagedUpdate, id: `active-${port.id}`, port_id: port.id, staged: false },
        staged: { ...stagedUpdate, id: `staged-${port.id}`, port_id: port.id },
      },
    ]),
  );
  await root.rerender(
    <UpdateCenter
      section="updates"
      generation={9}
      ports={ports}
      statuses={statuses}
      activities={[]}
      outcomes={[]}
      checkAll={vi.fn()}
      onSelect={vi.fn()}
      onOpenSettings={vi.fn()}
      diagnosticsRefreshing={false}
      diagnosticsStale={false}
      refreshDiagnostics={vi.fn()}
      perform={perform}
    />,
  );
  const reviewButtons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent === "Review game update",
  );
  expect(reviewButtons).toHaveLength(2);
  await act(async () => reviewButtons[0]!.click());
  await act(async () => reviewButtons[1]!.click());
  expect(review).toHaveBeenCalledTimes(2);
  await act(async () => pending.get("sample")!({ ...plan, activate: true }));
  expect(dialog()).toBeNull();
  await act(async () =>
    pending.get("other")!({
      ...plan,
      activate: true,
      plan: { ...plan.plan, port_id: "other" },
    }),
  );
  expect(document.querySelectorAll("[data-game-update-review]")).toHaveLength(1);
  expect(dialog()?.textContent).toContain("Second Game update");
  expect(dialog()?.textContent).not.toContain("First Game update");
  expect(apply).not.toHaveBeenCalled();
  await click("Cancel review");
  expect(document.activeElement).toBe(reviewButtons[1]);
});

it.each(["notify", "stage", "automatic"] as const)(
  "uses the explicit immediate choice independently of the %s future policy",
  async (policy) => {
    const review = vi
      .spyOn(desktopApi, "planGameUpdate")
      .mockResolvedValue({ ...plan, activate: true });
    const apply = vi.spyOn(desktopApi, "applyGameUpdate");
    await root.rerender(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy={policy}
        busy={false}
        perform={perform}
      />,
    );
    expect(container.textContent).toContain("What would you like to do?");
    expect(dialog()).toBeNull();
    await click("Review game update");
    expect(review).toHaveBeenCalledExactlyOnceWith("sample", true, 9);
    expect(dialog()?.textContent).toContain("2.0");
    expect(apply).not.toHaveBeenCalled();
  },
);

it("requires another review when the chosen action changes and binds activation to that review", async () => {
  const review = vi
    .spyOn(desktopApi, "planGameUpdate")
    .mockResolvedValueOnce(plan)
    .mockResolvedValueOnce({
      ...plan,
      activate: true,
      plan_sha256: "reviewed-activation",
    });
  const apply = vi
    .spyOn(desktopApi, "applyGameUpdate")
    .mockRejectedValue(new Error("Release changed"));
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
    />,
  );
  expect(container.textContent).not.toContain("This update");
  expect(document.body.textContent).not.toContain("Review install now");
  await click("What would you like to do?", true);
  await click("Download for later");
  await click("Review game update");
  expect(dialog()?.textContent).toContain("2.0");
  expect(dialog()?.textContent).toContain("Your current version stays unchanged");
  await click("Review install now");
  expect(review).toHaveBeenNthCalledWith(1, "sample", false, 9);
  expect(review).toHaveBeenNthCalledWith(2, "sample", true, 9);
  expect(apply).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain("current version remains available for rollback");
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
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
    />,
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
  await root.rerender(
    <GameUpdateControl
      key="old"
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
    />,
  );
  await click("Review game update");
  await root.rerender(
    <GameUpdateControl
      key="new"
      portId="sample"
      generation={10}
      policy="notify"
      busy={false}
      perform={perform}
    />,
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
    await root.rerender(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
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
      assessment:
        action === "already_active"
          ? { action: "update", availability: "not_offered", reason: "already_registered" }
          : { action: "update", availability: "held", reason: "invalid_installation" },
    });
    const apply = vi.spyOn(desktopApi, "applyGameUpdate");
    await root.rerender(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    );
    await click("Review game update");
    expect(dialog()?.querySelector(".install-plan button")).toBeNull();
    expect(dialog()?.querySelector('[role="status"]')?.textContent).toContain(
      action === "already_active" ? "already active" : "unverified local copy",
    );
    expect(apply).not.toHaveBeenCalled();
  },
);

it.each(["missing_source", "missing_bios"] as const)(
  "presents Core update prerequisite %s without execution",
  async (reason) => {
    vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue({
      ...plan,
      assessment: { action: "update", availability: "waiting", reason },
    });
    const apply = vi.spyOn(desktopApi, "applyGameUpdate");
    await root.rerender(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    );
    await click("Review game update");
    expect(dialog()?.textContent).toContain(
      reason === "missing_source" ? "required game files" : "required BIOS",
    );
    expect(
      Array.from(dialog()?.querySelectorAll("button") ?? []).some(
        (button) => button.textContent === "Download update for later",
      ),
    ).toBe(false);
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
    await root.rerender(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
      />,
    );
    await click("Review game update");
    expect(apply).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("No download; use the verified local release.");
    expect(dialog()?.textContent).toContain("This keeps the verified update for later.");
    await click("Keep saved update for later");
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      "sample",
      false,
      `reviewed-${action}`,
      9,
      expect.any(Function),
    );
    expect(container.textContent).toContain(
      "Update saved for later. Your current version is unchanged.",
    );
    expect(container.textContent).not.toContain("Update downloaded for later");
  },
);

const refreshOperation = vi.fn(async () => undefined);
let actualOperation: ReturnType<typeof useOperationState>;
function ActualOperationFixture({ generation = 9 }: { generation?: number }) {
  actualOperation = useOperationState({ refresh: refreshOperation, libraryGeneration: generation });
  return (
    <>
      <StatusLayer
        invocations={actualOperation.invocations}
        dismissInvocation={actualOperation.dismissInvocation}
        clearError={() => actualOperation.setError(undefined)}
      />
      <GameUpdateControl
        key={generation}
        portId="sample"
        generation={generation}
        policy="notify"
        busy={Boolean(actualOperation.busy)}
        perform={actualOperation.perform}
      />
    </>
  );
}
function updateFailure(
  mutation: DesktopError["presentation"]["mutation_state"],
  cancelled = false,
): DesktopError {
  return {
    code: cancelled ? "cancelled" : "state",
    message: "Private adapter detail should stay folded.",
    details: {},
    presentation: {
      presentation_key: "owned.update.fixture",
      summary: cancelled ? "The update was cancelled." : "Review the supplied update outcome.",
      tone: cancelled ? "neutral" : "error",
      mutation_state: mutation,
      phase: "update",
      recovery_actions: ["review_current_state", "view_technical_details"],
      technical_message: "Owned fixture diagnostic; token=[REDACTED].",
      technical_context: { fixture: "controlled update presentation" },
    },
  };
}
it.each([
  ["committed", false, "The change was saved. Check the result before trying again."],
  ["unknown", false, "Portcove couldn't confirm whether anything changed."],
  ["no_changes", false, "No files were changed by this operation."],
  ["no_changes", true, "No files were changed by this operation."],
] as const)(
  "preserves supplied %s outcome through the real operation wrapper (cancelled=%s)",
  async (mutation, cancelled, consequence) => {
    const failure = updateFailure(mutation, cancelled);
    vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(plan);
    const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockRejectedValue(failure);
    await root.rerender(<ActualOperationFixture />);
    await click("Review game update");
    await click("Download update for later");
    expect(container.textContent).toContain(failure.presentation.summary);
    const outcome = container.querySelector(
      cancelled ? "[data-game-update-outcome]" : "[data-invocation-id] [role=alert]",
    );
    expect(outcome?.textContent).toContain(failure.presentation.summary);
    expect(outcome?.textContent).toContain(consequence);
    expect(outcome?.getAttribute("role")).toBe(cancelled ? "status" : "alert");
    expect(container.querySelectorAll('[role="alert"], [data-game-update-outcome]')).toHaveLength(
      1,
    );
    expect(container.textContent).not.toContain("Update did not complete");
    expect(actualOperation.error).toBe(cancelled ? undefined : failure);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(outcome?.querySelector("details")?.open).toBe(false);
    expect(outcome?.querySelector("pre")?.textContent).toContain("[REDACTED]");
    await click("Review game update");
    expect(container.querySelector("[data-game-update-outcome]")).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
    await pressEscape();
    expect(apply).toHaveBeenCalledTimes(1);
  },
);
it("does not attach an old supplied failure to the newly selected library's update", async () => {
  let reject!: (value: unknown) => void;
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(plan);
  vi.spyOn(desktopApi, "applyGameUpdate").mockImplementation(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  await root.rerender(<ActualOperationFixture />);
  await click("Review game update");
  await click("Download update for later");
  await root.rerender(<ActualOperationFixture generation={10} />);
  await act(async () => reject(updateFailure("committed")));
  expect(container.querySelector("[data-game-update-outcome]")).toBeNull();
  expect(container.textContent).not.toContain("Review the supplied update outcome");
});

it("retains authoritative success through the real wrapper when only display refresh fails", async () => {
  const refreshFailure = { code: "state", message: "Current view read failed" };
  refreshOperation.mockRejectedValueOnce(refreshFailure);
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(plan);
  const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(stagedUpdate);
  await root.rerender(<ActualOperationFixture />);
  await click("Review game update");
  await click("Download update for later");
  expect(container.textContent).toContain(
    "Update saved for later. Your current version is unchanged.",
  );
  expect(container.querySelector("[data-game-update-outcome]")).toBeNull();
  expect(actualOperation.error).toBe(refreshFailure);
  expect(apply).toHaveBeenCalledTimes(1);
});

it("ignores retained task events during shared refresh and after terminal failure", async () => {
  let finishRefresh!: () => void;
  refreshOperation.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        finishRefresh = () => resolve(undefined);
      }),
  );
  let emit!: Parameters<typeof desktopApi.applyGameUpdate>[4];
  const failure = updateFailure("unknown");
  vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(plan);
  vi.spyOn(desktopApi, "applyGameUpdate").mockImplementation(
    (_port, _activate, _plan, _generation, onEvent) => {
      emit = onEvent;
      return Promise.reject(failure);
    },
  );
  await root.rerender(<ActualOperationFixture />);
  await click("Review game update");
  await click("Download update for later");
  const sendLateEvents = () => {
    const common = {
      schema_version: 3 as const,
      operation_id: "settled-update",
      parent_operation_id: null,
      target: null,
      timestamp_ms: 1,
      operation: "update" as const,
    };
    emit({ ...common, sequence: 1, type: "message", level: "info", message: "Late task progress" });
    emit({ ...common, sequence: 2, type: "started" });
  };
  await act(async () => sendLateEvents());
  expect(dialog()?.textContent).not.toContain("Late task progress");
  expect(dialog()?.textContent).not.toContain("Cancel game update");
  expect(actualOperation.error).toBe(failure);
  await act(async () => finishRefresh());
  await act(async () => sendLateEvents());
  expect(container.textContent).toContain(failure.presentation.summary);
  expect(container.textContent).not.toContain("Late task progress");
  expect(container.textContent).not.toContain("Cancel game update");
});

it.each([false, true])(
  "settles update A after leaving it for review B (cancelled=%s)",
  async (cancelled) => {
    const ports = [
      { ...portDefinition(), name: "First Game" },
      { ...portDefinition(), id: "other", name: "Second Game" },
    ];
    const statuses = new Map(
      ports.map((port) => [
        port.id,
        {
          ...portStatus(),
          port_id: port.id,
          active: { ...stagedUpdate, id: `active-${port.id}`, port_id: port.id, staged: false },
          staged: { ...stagedUpdate, port_id: port.id },
        },
      ]),
    );
    const review = vi.spyOn(desktopApi, "planGameUpdate").mockImplementation(async (id) => ({
      ...plan,
      activate: true,
      plan: { ...plan.plan, port_id: id },
    }));
    let reject!: (error: unknown) => void;
    const apply = vi
      .spyOn(desktopApi, "applyGameUpdate")
      .mockImplementation((_id, _activate, _plan, _generation, onEvent) => {
        onEvent?.({
          schema_version: 2,
          operation_id: "update-A",
          parent_operation_id: null,
          target: null,
          sequence: 0,
          timestamp_ms: 1,
          operation: "update",
          type: "started",
        });
        return new Promise((_resolve, rejectTask) => {
          reject = rejectTask;
        });
      });
    await root.rerender(
      <UpdateCenter
        section="updates"
        generation={9}
        ports={ports}
        statuses={statuses}
        activities={[]}
        outcomes={[]}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        perform={perform}
      />,
    );
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
      (button) => button.textContent === "Review game update",
    );
    await act(async () => buttons[0]!.click());
    await click("Download and install update");
    await click("Continue browsing");
    await act(async () => buttons[1]!.click());
    expect(dialog()?.textContent).toContain("Second Game update");
    const currentDialog = dialog();
    await act(async () => reject(updateFailure("no_changes", cancelled)));
    expect(dialog()).toBe(currentDialog);
    expect(dialog()?.textContent).toContain("Second Game update");
    await click("Cancel review");
    await act(async () => buttons[0]!.click());
    expect(review.mock.calls.map((call) => call[0])).toEqual(["sample", "other", "sample"]);
    expect(dialog()?.textContent).toContain("First Game update");
    expect(dialog()?.textContent).not.toContain("Continue browsing");
    expect(dialog()?.textContent).not.toContain("Cancel game update");
    expect(
      [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Download and install update",
      )?.disabled,
    ).toBe(false);
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      "sample",
      true,
      plan.plan_sha256,
      9,
      expect.any(Function),
    );
  },
);
