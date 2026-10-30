import { captureParityState } from "../../../test/parity-capture";
import { controlledAct as act } from "../../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { browserFixture } from "../../../test/browser-fixture";
import { desktopApi } from "../../api";
import { portDefinition, portStatus } from "../../test-fixtures";
import type {
  DesktopError,
  GameUpdateAcquisition,
  GameUpdatePlan,
  InstallRecord,
  PortStatus,
} from "../../types";
import { OperationPresentationProvider } from "../operations/operation-presentation";
import type { InvocationRecord } from "../operations/invocation-state";
import { useOperationState, type Perform } from "../operations/use-operation-state";

vi.mock("../../desktop-events", () => ({ listenDesktopEvent: async () => () => undefined }));
import { GameUpdateControl, UpdatePolicyControl } from "../../components/GameUpdates";
import { UpdateCenter } from "../../components/UpdateCenter";
import { StatusLayer } from "../../components/Chrome";
import { DetailLayout } from "../../components/DetailLayout";
import "../../styles/index.css";

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
const acquisition: GameUpdateAcquisition = {
  id: "archive-2.0",
  port_id: "sample",
  platform: "windows-x86-64",
  release: plan.plan.release,
  phase: "acquired",
  created_at: 1,
  updated_at: 2,
};
const perform: Perform = async (_name, task) => task();
let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  await page.viewport(1280, 900);
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
    (item) =>
      !item.closest("[hidden]") &&
      (contains ? item.textContent?.includes(label) : item.textContent === label),
  );
  expect(control).toBeDefined();
  await act(async () => control?.click());
}
function dialog() {
  return document.body.querySelector("[data-game-update-review]");
}

it("keeps Download for later available across detail tabs and acquires only its reviewed target", async () => {
  vi.unstubAllGlobals();
  const review = vi.spyOn(desktopApi, "planGameUpdateAcquisition").mockResolvedValue(plan);
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  const acquire = vi.spyOn(desktopApi, "acquireGameUpdate").mockResolvedValue(acquisition);
  await root.rerender(
    <DetailLayout
      port={portDefinition()}
      initialSection="versions"
      readiness="Ready to play"
      installation="Managed installation · 1.0"
      action={() => null}
      close={vi.fn()}
    >
      {() => ({
        overview: null,
        files: <p>Game files</p>,
        saves: null,
        versions: (
          <GameUpdateControl
            portId="sample"
            generation={9}
            policy="notify"
            busy={false}
            perform={perform}
          />
        ),
      })}
    </DetailLayout>,
  );
  await page.getByRole("tab", { name: "Game files", exact: true }).click();
  await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Download for later", exact: true }))
    .toBeVisible();
  await click("Download for later");
  expect(review).toHaveBeenCalledExactlyOnceWith("sample", 9);
  expect(apply).not.toHaveBeenCalled();
  await click("Download archive for later");
  expect(acquire.mock.calls[0]?.slice(0, 3)).toEqual(["sample", plan.plan_sha256, 9]);
  expect(apply).not.toHaveBeenCalled();
});

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
  await click("Update now");
  await click("Download and install update");
  await click("Continue browsing");
  await expect.poll(dialog).toBeNull();
  await expect
    .poll(() => document.activeElement)
    .toBe(container.querySelector('section[aria-label="Review game update"]'));
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
  await page.getByRole("combobox", { name: /^Game update behavior/ }).click();
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
  await page.getByRole("combobox", { name: /^Game update behavior/ }).click();
  await click("Keep update for later");
  await click("Save update settings");
  expect(container.textContent).toContain("Library changed");
  expect(container.textContent).not.toContain("settings saved");
});

it("reviews without execution and submits the exact download-only plan on confirmation", async () => {
  vi.spyOn(desktopApi, "planGameUpdateAcquisition").mockResolvedValue(plan);
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  const acquire = vi.spyOn(desktopApi, "acquireGameUpdate").mockResolvedValue(acquisition);
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
    />,
  );
  await click("Download for later");
  expect(apply).not.toHaveBeenCalled();
  expect(desktopApi.planGameUpdateAcquisition).toHaveBeenCalledExactlyOnceWith("sample", 9);
  expect(dialog()?.textContent).toContain("to download");
  expect(dialog()?.textContent).toContain("Download only the immutable archive");
  expect(dialog()?.textContent).not.toContain(plan.plan.output_location.user_data_root);
  await expect
    .poll(() => document.activeElement)
    .toBe(dialog()?.querySelector('[data-slot="dialog-title"]'));
  await click("Download archive for later");
  expect(acquire).toHaveBeenCalledExactlyOnceWith(
    "sample",
    "reviewed-download",
    9,
    expect.any(Function),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Update now");
  expect(container.textContent).toContain(
    "Last command: Archive downloaded. Review again to prepare or install it. Your current version is unchanged.",
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
  await click("Update now");
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
  await click("Update now");
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
    .mockResolvedValueOnce({ ...plan, activate: true, plan_sha256: "install-reviewed" });
  const archiveReview = vi
    .spyOn(desktopApi, "planGameUpdateAcquisition")
    .mockResolvedValue({ ...plan, plan_sha256: "later-reviewed" });
  const acquire = vi.spyOn(desktopApi, "acquireGameUpdate").mockResolvedValue(acquisition);
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
  await click("Update now");
  expect(review).toHaveBeenNthCalledWith(1, "sample", true, 9);
  expect(dialog()?.textContent).toContain("Original Game · Sample Project update");
  expect(dialog()?.textContent).toContain("current version remains available for rollback");
  expect(apply).not.toHaveBeenCalled();
  await click("Download for later");
  expect(archiveReview).toHaveBeenCalledExactlyOnceWith("sample", 9);
  expect(dialog()?.textContent).toContain("Download only the immutable archive");
  await click("Download archive for later");
  expect(acquire).toHaveBeenCalledExactlyOnceWith(
    "sample",
    "later-reviewed",
    9,
    expect.any(Function),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(savePolicy).not.toHaveBeenCalled();
});

it("does not submit duplicate reviews or apply a stale plan after a failed change of action", async () => {
  let release!: (value: GameUpdatePlan) => void;
  let rejectChange!: (reason: Error) => void;
  const review = vi.spyOn(desktopApi, "planGameUpdate").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const archiveReview = vi.spyOn(desktopApi, "planGameUpdateAcquisition").mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectChange = reject;
      }),
  );
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  const acquire = vi.spyOn(desktopApi, "acquireGameUpdate");
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
    (button) => button.textContent === "Update now",
  )!;
  await act(async () => {
    opener.click();
    opener.click();
  });
  expect(review).toHaveBeenCalledTimes(1);
  await act(async () => release({ ...plan, activate: true }));
  await click("Download for later");
  expect(dialog()?.textContent).toContain("Checking update…");
  expect(dialog()?.textContent).not.toContain("Updating…");
  expect(dialog()?.textContent).toContain("current version remains available for rollback");
  expect(dialog()?.textContent).not.toContain("Download only the immutable archive");
  expect(apply).not.toHaveBeenCalled();
  expect(archiveReview).toHaveBeenCalledExactlyOnceWith("sample", 9);
  const confirmation = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Checking update…",
  );
  expect(confirmation?.disabled).toBe(true);
  await act(async () => rejectChange(new Error("Update service offline")));
  await expect.poll(dialog).toBeNull();
  expect(container.textContent).toContain("Update service offline");
  expect(apply).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
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
  await click("Update now");
  expect(review).toHaveBeenCalledExactlyOnceWith(port.id, true, 9);
  expect(onSelect).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  await click("Cancel review");
  await expect.poll(() => document.activeElement?.textContent).toBe("Update now");
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
    (button) => button.textContent === "Update now",
  );
  expect(reviewButtons).toHaveLength(2);
  await act(async () => reviewButtons[0]!.click());
  await act(async () => reviewButtons[1]!.click());
  expect(review).toHaveBeenCalledTimes(2);
  await act(async () => pending.get("sample")!({ ...plan, activate: true }));
  await expect.poll(dialog).toBeNull();
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
  await expect.poll(() => document.activeElement).toBe(reviewButtons[1]);
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
    expect(container.textContent).toContain("Update now");
    expect(container.textContent).toContain("Download for later");
    await expect.poll(dialog).toBeNull();
    await click("Update now");
    expect(review).toHaveBeenCalledExactlyOnceWith("sample", true, 9);
    expect(dialog()?.textContent).toContain("2.0");
    expect(apply).not.toHaveBeenCalled();
  },
);

it("requires another review when the chosen action changes and binds activation to that review", async () => {
  const archiveReview = vi.spyOn(desktopApi, "planGameUpdateAcquisition").mockResolvedValue(plan);
  const review = vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValueOnce({
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
  await expect.element(page.getByRole("button", { name: "Update now", exact: true })).toBeEnabled();
  expect(apply).not.toHaveBeenCalled();
  await click("Download for later");
  expect(dialog()?.textContent).toContain("2.0");
  expect(dialog()?.textContent).toContain("active version stay unchanged");
  await click("Update now");
  expect(archiveReview).toHaveBeenCalledExactlyOnceWith("sample", 9);
  expect(review).toHaveBeenCalledExactlyOnceWith("sample", true, 9);
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
  expect(container.textContent).toContain("Update now");
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
  await click("Update now");
  await click("Prepare update for later");
  expect(dialog()?.textContent).toContain("Cancel game update");
  await captureParityState("game-update-running-fixture");
  await pressEscape();
  expect(dialog()).not.toBeNull();
  await click("Cancel game update");
  expect(cancel).toHaveBeenCalledExactlyOnceWith("update-1");
  expect(dialog()?.textContent).toContain("Cancellation requested");
  await captureParityState("game-update-cancellation-requested-fixture");
  await act(async () => finish());
  await expect.poll(dialog).toBeNull();
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
  await click("Update now");
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
    await click("Update now");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      "cannot display this update plan",
    );
    expect(dialog()?.textContent).not.toContain("verified local release");
    expect(dialog()?.querySelector(".install-plan button")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    await click("Review game update again");
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
    await click("Prepare update for later");
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
    await click("Update now");
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
    await click("Update now");
    expect(dialog()?.textContent).toContain(
      reason === "missing_source" ? "required game files" : "required BIOS",
    );
    expect(
      Array.from(dialog()?.querySelectorAll("button") ?? []).some(
        (button) => button.textContent === "Prepare update for later",
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
    await click("Update now");
    expect(apply).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("No download; use the verified local release.");
    expect(dialog()?.textContent).toContain("This keeps the prepared update for later.");
    await click("Keep saved update for later");
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      "sample",
      false,
      `reviewed-${action}`,
      9,
      expect.any(Function),
    );
    expect(container.textContent).toContain(
      "Update kept for later. Your current version is unchanged.",
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
    await click("Update now");
    await click("Prepare update for later");
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
    await expect.poll(dialog).toBeNull();
    expect(outcome?.querySelector("details")?.open).toBe(false);
    expect(outcome?.querySelector("pre")?.textContent).toContain("[REDACTED]");
    await click("Update now");
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
  await click("Update now");
  await click("Prepare update for later");
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
  await click("Update now");
  await click("Prepare update for later");
  expect(container.textContent).toContain(
    "Update kept for later. Your current version is unchanged.",
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
  await click("Update now");
  await click("Prepare update for later");
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
      (button) => button.textContent === "Update now",
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

it("shows the reviewed data location and compatibility unknown for a saved update without inventing another download", async () => {
  const notice =
    "External settings at C:/Shared/settings.json are outside Portcove's backup scope.";
  const review = vi
    .spyOn(desktopApi, "planGameUpdate")
    .mockImplementation(async (_port, activate) => ({
      ...plan,
      activate,
      plan: {
        ...plan.plan,
        action: "use_staged",
        download_bytes: 0,
        preservation_notices: [notice],
      },
    }));
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  await root.rerender(
    <GameUpdateControl
      portId="sample"
      generation={9}
      policy="notify"
      busy={false}
      perform={perform}
      currentVersion="1.0"
    />,
  );
  await click("Update now");
  expect(dialog()?.textContent).toContain("Current version: 1.0");
  expect(dialog()?.textContent).toContain(plan.plan.output_location.user_data_root);
  expect(dialog()?.textContent).toContain(
    "Save compatibility between versions is not checked here",
  );
  expect(dialog()?.textContent).toContain(
    "Keeping the previous game version is separate from backing up saved data",
  );
  expect(dialog()?.textContent).toContain(notice);
  expect(dialog()?.textContent).toContain("No download; use the verified local release");
  expect(dialog()?.textContent).not.toContain("Download for later");
  await click("Keep for later");
  expect(review.mock.calls.map((call) => call.slice(0, 3))).toEqual([
    ["sample", true, 9],
    ["sample", false, 9],
  ]);
  expect(dialog()?.textContent).toContain("Your current version stays unchanged");
  expect(dialog()?.textContent).toContain("Keep saved update for later");
  expect(dialog()?.textContent).toContain(notice);
  expect(apply).not.toHaveBeenCalled();
});

it("Activity refuses Apply while the same port has file work, but keeps unrelated work independent", async () => {
  const port = portDefinition();
  const status = {
    ...portStatus(),
    active: { ...stagedUpdate, id: "active-v1", version: "1", staged: false },
    staged: stagedUpdate,
  };
  const reviewed = {
    ...plan,
    activate: true,
    plan: { ...plan.plan, action: "use_staged" as const, download_bytes: 0 },
  };
  const review = vi.spyOn(desktopApi, "planGameUpdate").mockResolvedValue(reviewed);
  const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(stagedUpdate);
  const work = (target: string): InvocationRecord => ({
    id: 1,
    name: "verify game files",
    phase: "pending",
    context: {
      action: "Verify files",
      target: { kind: "port", id: target, label: target },
      libraryGeneration: 9,
      exclusionScope: "target",
    },
  });
  const view = (pending: ReadonlyMap<number, InvocationRecord>) => (
    <OperationPresentationProvider generation={9} pending={pending}>
      <UpdateCenter
        section="updates"
        generation={9}
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        activities={[]}
        outcomes={[]}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        perform={perform}
      />
    </OperationPresentationProvider>
  );
  await root.rerender(view(new Map()));
  await click("Update now");
  const applyButton = () =>
    [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Use saved update",
    )!;
  expect(applyButton()).toBeDefined();
  expect(applyButton().disabled).toBe(false);
  await root.rerender(view(new Map([[1, work(port.id)]])));
  expect(applyButton().disabled).toBe(true);
  await act(async () => applyButton().click());
  expect(apply).not.toHaveBeenCalled();
  await root.rerender(view(new Map([[1, work("another-port")]])));
  expect(applyButton().disabled).toBe(false);
  await click("Cancel review");
  await click("Update now");
  expect(review).toHaveBeenCalledTimes(2);
  await act(async () => applyButton().click());
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    port.id,
    true,
    plan.plan_sha256,
    9,
    expect.any(Function),
  );
});

it("downloads an immutable archive during an explicit launch without granting Apply an exemption", async () => {
  const pending: InvocationRecord = {
    id: 91,
    name: "play",
    phase: "pending",
    context: {
      action: "Play",
      target: { kind: "port", id: "sample", label: "Sample" },
      libraryGeneration: 9,
      exclusionScope: "target",
      operation: "launch",
    },
  };
  const review = vi.spyOn(desktopApi, "planGameUpdateAcquisition").mockResolvedValue(plan);
  const acquire = vi.spyOn(desktopApi, "acquireGameUpdate").mockResolvedValue(acquisition);
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  const calls: Array<{
    name: string;
    context: import("../operations/invocation-state").InvocationContext | undefined;
  }> = [];
  const owned: Perform = async (name, task, options) => {
    calls.push({ name, context: options?.context });
    return task();
  };
  await root.rerender(
    <OperationPresentationProvider generation={9} pending={new Map([[91, pending]])}>
      <GameUpdateControl portId="sample" generation={9} policy="notify" busy perform={owned} />
    </OperationPresentationProvider>,
  );
  await click("Download for later");
  expect(review).toHaveBeenCalledExactlyOnceWith("sample", 9);
  await click("Download archive for later");
  expect(acquire).toHaveBeenCalledExactlyOnceWith(
    "sample",
    plan.plan_sha256,
    9,
    expect.any(Function),
  );
  expect(apply).not.toHaveBeenCalled();
  expect(calls).toEqual([
    {
      name: "acquire_game_update",
      context: {
        action: "Download update archive",
        target: { kind: "port", id: "sample", label: "sample" },
        libraryGeneration: 9,
        exclusionScope: "target",
        operation: "acquire_game_update",
      },
    },
  ]);
  expect(container.textContent).toContain("Archive downloaded");
  expect(container.textContent).not.toContain("Update saved for later");
  await expect
    .element(page.getByRole("button", { name: "Update now", exact: true }))
    .toBeDisabled();
});

it.each([false, true])(
  "uses a fresh exclusive review for an acquired archive (activate=%s)",
  async (activate) => {
    const review = vi
      .spyOn(desktopApi, "planGameUpdate")
      .mockImplementation(async (_port, useNow) => ({
        ...plan,
        activate: useNow,
        acquisition,
        plan_sha256: useNow ? "acquired-install" : "acquired-prepare",
      }));
    const acquire = vi.spyOn(desktopApi, "acquireGameUpdate");
    const archiveReview = vi.spyOn(desktopApi, "planGameUpdateAcquisition");
    const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(stagedUpdate);
    await root.rerender(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
        status={{ ...portStatus(), active: { ...stagedUpdate, staged: false }, acquisition }}
        currentVersion="1.0"
      />,
    );
    expect(container.textContent).toContain("Archive downloaded");
    expect(apply).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Download for later", exact: true }))
      .not.toBeInTheDocument();
    if (!activate) {
      await page.getByText("Advanced update choice", { exact: true }).click();
      await page.getByRole("button", { name: "Prepare for later", exact: true }).click();
    } else await click("Update now");
    expect(review).toHaveBeenCalledExactlyOnceWith("sample", activate, 9);
    expect(dialog()?.textContent).toContain("No new archive download is planned");
    expect(dialog()?.textContent).toContain(acquisition.id);
    expect(acquire).not.toHaveBeenCalled();
    expect(archiveReview).not.toHaveBeenCalled();
    await click(activate ? "Update now" : "Prepare update for later");
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      "sample",
      activate,
      activate ? "acquired-install" : "acquired-prepare",
      9,
      expect.any(Function),
    );
  },
);

it.each(["acquired", "attention_required"] as const)(
  "confirms discard against one exact %s archive and rejects replacement during review",
  async (phase) => {
    const discard = vi
      .spyOn(desktopApi, "discardGameUpdateAcquisition")
      .mockResolvedValue(undefined);
    const apply = vi.spyOn(desktopApi, "applyGameUpdate");
    const first = { ...acquisition, phase };
    const next = { ...first, id: "replacement-archive" };
    const show = (record: GameUpdateAcquisition) =>
      root.rerender(
        <GameUpdateControl
          portId="sample"
          generation={9}
          policy="notify"
          busy={false}
          perform={perform}
          status={{ ...portStatus(), acquisition: record }}
        />,
      );
    await show(first);
    await click("Discard archive…");
    expect(document.querySelector("[data-game-update-discard-review]")?.textContent).toContain(
      first.id,
    );
    expect(discard).not.toHaveBeenCalled();
    await show(next);
    await expect
      .element(page.getByRole("button", { name: "Discard archive", exact: true }))
      .toBeDisabled();
    await click("Discard archive");
    expect(discard).not.toHaveBeenCalled();
    await click("Keep archive");
    await click("Discard archive…");
    expect(document.querySelector("[data-game-update-discard-review]")?.textContent).toContain(
      next.id,
    );
    await click("Discard archive");
    expect(discard).toHaveBeenCalledExactlyOnceWith("sample", next.id, 9);
    expect(apply).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Retained update archive"]')).toBeNull();
    expect(container.textContent).toContain("Archive discarded");
  },
);

it("distinguishes acquired archives from prepared updates in Activity and keeps current Play available", async () => {
  const port = portDefinition();
  const status = {
    ...portStatus(),
    port_id: port.id,
    active: { ...stagedUpdate, id: "current-1", version: "1.0", staged: false },
    staged: null,
    acquisition,
    readiness: { ...portStatus().readiness, launchable: true, pending_setup: false, blockers: [] },
  };
  const launch = vi.fn();
  await root.rerender(
    <UpdateCenter
      section="updates"
      generation={9}
      ports={[port]}
      statuses={new Map([[port.id, status]])}
      activities={[]}
      outcomes={[]}
      diagnosticsRefreshing={false}
      diagnosticsStale={false}
      refreshDiagnostics={vi.fn()}
      checkAll={vi.fn()}
      onSelect={vi.fn()}
      onOpenSettings={vi.fn()}
      perform={perform}
      onLaunch={launch}
    />,
  );
  expect(
    container.querySelector(".update-state")?.textContent ??
      container.querySelector(".update-row")?.textContent,
  ).toContain("Archive downloaded");
  expect(container.querySelector('[aria-label="Retained update archive"]')?.textContent).toContain(
    "separate from a prepared update",
  );
  expect(container.textContent).not.toContain("Update saved for later");
  const prepared = [...container.querySelectorAll(".update-stat")].find((stat) =>
    stat.textContent?.includes("Prepared updates"),
  );
  expect(prepared?.querySelector("strong")?.textContent).toBe("0");
  await click("Play");
  expect(launch).toHaveBeenCalledExactlyOnceWith(port.id);
});

it("holds Apply during same-port immutable acquisition while keeping unrelated ports independent", async () => {
  const review = vi
    .spyOn(desktopApi, "planGameUpdate")
    .mockResolvedValue({ ...plan, activate: true, acquisition });
  const apply = vi.spyOn(desktopApi, "applyGameUpdate").mockResolvedValue(stagedUpdate);
  const work = (id: string): InvocationRecord => ({
    id: 1,
    name: "acquire_game_update",
    phase: "pending",
    context: {
      action: "Download update archive",
      target: { kind: "port", id, label: id },
      libraryGeneration: 9,
      exclusionScope: "target",
      operation: "acquire_game_update",
    },
  });
  const show = (pending: ReadonlyMap<number, InvocationRecord>) =>
    root.rerender(
      <OperationPresentationProvider generation={9} pending={pending}>
        <GameUpdateControl
          portId="sample"
          generation={9}
          policy="notify"
          busy={false}
          perform={perform}
          status={{ ...portStatus(), active: { ...stagedUpdate, staged: false }, acquisition }}
        />
      </OperationPresentationProvider>,
    );
  await show(new Map());
  await click("Update now");
  await show(new Map([[1, work("sample")]]));
  await expect
    .element(page.getByRole("button", { name: "Update now", exact: true }))
    .toBeDisabled();
  await click("Update now");
  expect(apply).not.toHaveBeenCalled();
  await show(new Map([[1, work("another-port")]]));
  await expect.element(page.getByRole("button", { name: "Update now", exact: true })).toBeEnabled();
  await click("Update now");
  expect(review).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    "sample",
    true,
    plan.plan_sha256,
    9,
    expect.any(Function),
  );
});

it("keeps acquisition completion as a receipt until a fresh status replaces it", async () => {
  vi.spyOn(desktopApi, "planGameUpdateAcquisition").mockResolvedValue(plan);
  vi.spyOn(desktopApi, "acquireGameUpdate").mockResolvedValue(acquisition);
  const original = { ...portStatus(), active: { ...stagedUpdate, staged: false } };
  const show = (status: ReturnType<typeof portStatus>) =>
    root.rerender(
      <GameUpdateControl
        portId="sample"
        generation={9}
        policy="notify"
        busy={false}
        perform={perform}
        status={status}
      />,
    );
  await show(original);
  await click("Download for later");
  await click("Download archive for later");
  expect(container.textContent).toContain("Last command: Archive downloaded");
  expect(container.textContent).toContain(
    "The operation finished, but library status could not be refreshed",
  );
  expect(container.querySelector('[aria-label="Retained update archive"]')).toBeNull();
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Discard archive…",
    ),
  ).toBe(false);
  // Another client may have discarded it. A successful fresh Core status owns
  // current absence even when the optional field is absent in both snapshots.
  await show({ ...original });
  expect(container.textContent).not.toContain(
    "The operation finished, but library status could not be refreshed",
  );
  await expect
    .element(page.getByRole("button", { name: "Download for later", exact: true }))
    .toBeVisible();
});

it.each([
  [1280, "100%"],
  [640, "100%"],
  [1280, "200%"],
  [640, "200%"],
] as const)(
  "keeps all pending archive actions reachable at %spx with %s text",
  async (width, fontSize) => {
    const environment = browserFixture({ styles: ["font-size"], viewport: true });
    let owner: ReturnType<typeof useOperationState> | undefined;
    const refresh = vi.fn(async () => undefined);
    let finish!: (value: GameUpdateAcquisition) => void;
    const transfer = new Promise<GameUpdateAcquisition>((resolve) => {
      finish = resolve;
    });
    const review = vi.spyOn(desktopApi, "planGameUpdateAcquisition").mockResolvedValue(plan);
    const acquire = vi
      .spyOn(desktopApi, "acquireGameUpdate")
      .mockImplementation((_port, _plan, _generation, receive) => {
        receive?.({
          schema_version: 2,
          operation_id: "pending-archive-transfer",
          parent_operation_id: null,
          target: null,
          sequence: 0,
          timestamp_ms: 1,
          operation: "update",
          type: "started",
        });
        return transfer;
      });
    const apply = vi.spyOn(desktopApi, "applyGameUpdate");
    const cancel = vi.spyOn(desktopApi, "cancelOperation");
    function Fixture() {
      owner = useOperationState({ refresh, libraryGeneration: 9 });
      return (
        <OperationPresentationProvider generation={9} pending={owner.pendingOperations}>
          <GameUpdateControl
            portId="sample"
            generation={9}
            policy="notify"
            busy={Boolean(owner.busy)}
            perform={owner.perform}
          />
        </OperationPresentationProvider>
      );
    }
    try {
      await page.viewport(width, 900);
      document.documentElement.style.fontSize = fontSize;
      await root.rerender(<Fixture />);
      await document.fonts.ready;
      await click("Download for later");
      await page.getByRole("button", { name: "Download archive for later", exact: true }).click();
      const pending = [...owner!.pendingOperations.values()].find(
        (record) => record.context.operation === "acquire_game_update",
      );
      expect(pending?.context.target).toEqual({ kind: "port", id: "sample", label: "sample" });
      expect(pending?.phase).toBe("pending");
      expect(acquire).toHaveBeenCalledExactlyOnceWith(
        "sample",
        plan.plan_sha256,
        9,
        expect.any(Function),
      );
      const surface = page.getByRole("dialog").element() as HTMLElement;
      const footer = surface.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
      const actions = [...footer.querySelectorAll<HTMLButtonElement>("button")];
      expect(actions.map((button) => button.textContent?.trim())).toEqual([
        "Continue browsing",
        "Downloading archive…",
        "Update now",
        "Prepare for later",
        "Cancel review",
      ]);
      expect(
        surface.scrollWidth,
        "review must reflow without horizontal scrolling",
      ).toBeLessThanOrEqual(surface.clientWidth + 1);
      for (const button of actions) {
        button.scrollIntoView({ block: "nearest", inline: "nearest" });
        const box = button.getBoundingClientRect(),
          dialogBox = surface.getBoundingClientRect(),
          left = dialogBox.left + surface.clientLeft,
          top = dialogBox.top + surface.clientTop;
        expect(box.left, button.textContent ?? "action").toBeGreaterThanOrEqual(left);
        expect(box.right, button.textContent ?? "action").toBeLessThanOrEqual(
          left + surface.clientWidth,
        );
        expect(box.top, button.textContent ?? "action").toBeGreaterThanOrEqual(top);
        expect(box.bottom, button.textContent ?? "action").toBeLessThanOrEqual(
          top + surface.clientHeight,
        );
      }
      const refreshesBeforeLeaving = refresh.mock.calls.length;
      await page.getByRole("button", { name: "Continue browsing", exact: true }).click();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(owner!.pendingOperations.get(pending!.id)).toEqual(pending);
      expect(review).toHaveBeenCalledExactlyOnceWith("sample", 9);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(apply).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledTimes(refreshesBeforeLeaving);
    } finally {
      await act(async () => finish(acquisition));
      await environment.dispose();
    }
  },
);

it("runs immutable acquisition alongside a pending launch through the actual invocation owner", async () => {
  let owner: ReturnType<typeof useOperationState> | undefined;
  const refresh = vi.fn(async () => undefined);
  function Fixture() {
    owner = useOperationState({ refresh, libraryGeneration: 9 });
    return (
      <OperationPresentationProvider generation={9} pending={owner.pendingOperations}>
        <GameUpdateControl
          portId="sample"
          generation={9}
          policy="notify"
          busy={Boolean(owner.busy)}
          perform={owner.perform}
        />
      </OperationPresentationProvider>
    );
  }
  vi.spyOn(desktopApi, "planGameUpdateAcquisition").mockResolvedValue(plan);
  const acquire = vi.spyOn(desktopApi, "acquireGameUpdate").mockResolvedValue(acquisition);
  const apply = vi.spyOn(desktopApi, "applyGameUpdate");
  await root.rerender(<Fixture />);
  if (!owner) throw new Error("Invocation fixture did not mount");
  let finish: (() => void) | undefined;
  let launched: Promise<void | undefined> | undefined;
  const mounted = owner;
  try {
    await act(async () => {
      launched = mounted.perform(
        "launch",
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        {
          context: {
            action: "Play",
            target: { kind: "port", id: "sample", label: "Sample" },
            libraryGeneration: 9,
            exclusionScope: "target",
            operation: "launch",
          },
        },
      );
    });
    await click("Download for later");
    await click("Download archive for later");
    expect(acquire).toHaveBeenCalledExactlyOnceWith(
      "sample",
      plan.plan_sha256,
      9,
      expect.any(Function),
    );
    expect(apply).not.toHaveBeenCalled();
    expect(
      [...owner.invocations.values()].some(
        (record) => record.context.operation === "launch" && record.phase === "pending",
      ),
    ).toBe(true);
    expect(
      [...owner.invocations.values()].some(
        (record) =>
          record.context.operation === "acquire_game_update" && record.outcome === "succeeded",
      ),
    ).toBe(true);
    expect(owner.error).toBeUndefined();
    await expect
      .element(page.getByRole("button", { name: "Update now", exact: true }))
      .toBeDisabled();
  } finally {
    await act(async () => {
      finish?.();
      await launched;
    });
  }
});

it.each([
  ["acquired", false],
  ["attention_required", false],
  ["acquired", true],
  ["attention_required", true],
] as const)(
  "keeps exact archive discard reachable after runtime removal (phase=%s, metadata=%s)",
  async (phase, hasMetadata) => {
    const retainedId = "removed-port";
    const archive = { ...acquisition, id: "retained-after-removal", port_id: retainedId, phase };
    let snapshot: PortStatus = {
      ...portStatus(),
      port_id: retainedId,
      active: null,
      acquisition: archive,
    };
    const discard = vi
      .spyOn(desktopApi, "discardGameUpdateAcquisition")
      .mockResolvedValue(undefined);
    const apply = vi.spyOn(desktopApi, "applyGameUpdate");
    const review = vi.spyOn(desktopApi, "planGameUpdate");
    const archiveReview = vi.spyOn(desktopApi, "planGameUpdateAcquisition");
    const onSelect = vi.fn();
    const show = () =>
      root.rerender(
        <UpdateCenter
          section="updates"
          generation={9}
          ports={[]}
          activityPorts={
            hasMetadata
              ? [
                  {
                    id: retainedId,
                    name: "Retained project",
                    summary: "Descriptive listing",
                    platforms: [],
                  },
                ]
              : []
          }
          statuses={new Map([[retainedId, snapshot]])}
          activities={[]}
          outcomes={[]}
          diagnosticsRefreshing={false}
          diagnosticsStale={false}
          refreshDiagnostics={vi.fn()}
          checkAll={vi.fn()}
          onSelect={onSelect}
          onOpenSettings={vi.fn()}
          perform={owned}
        />,
      );
    const owned: Perform = async (_name, task) => {
      const result = await task();
      // The shared operation owner refreshes an authoritative workspace snapshot;
      // no current catalog definition is fabricated to make cleanup available.
      snapshot = { ...snapshot, acquisition: null };
      await show();
      return result;
    };
    await show();
    const archives = page.getByRole("region", { name: "Retained update archives", exact: true });
    await expect.element(archives).toBeVisible();
    await expect
      .element(
        archives.getByRole("heading", {
          name: hasMetadata ? "Retained project" : retainedId,
          exact: true,
        }),
      )
      .toBeVisible();
    expect(
      document.querySelector(`[data-retained-update-archive-port-id="${retainedId}"]`),
    ).not.toBeNull();
    expect(document.querySelector('[aria-label="Review game update"]')).toBeNull();
    expect(document.querySelector('[role="combobox"]')).toBeNull();
    await archives.getByRole("button", { name: "Discard archive…", exact: true }).click();
    const confirmation = page.getByRole("dialog");
    await expect
      .element(confirmation.getByRole("heading", { name: "Discard update archive?", exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-game-update-discard-review]")?.textContent).toContain(
      archive.id,
    );
    expect(discard).not.toHaveBeenCalled();
    await confirmation.getByRole("button", { name: "Discard archive", exact: true }).click();
    expect(discard).toHaveBeenCalledExactlyOnceWith(retainedId, archive.id, 9);
    await expect.element(archives).not.toBeInTheDocument();
    expect(snapshot.acquisition).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(archiveReview).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  },
);
