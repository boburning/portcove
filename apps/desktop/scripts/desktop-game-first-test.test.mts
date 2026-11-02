import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { captureGameFirstTarget, readGameFirstObservation } from "./desktop-game-first-test.mts";
import { failureReport, portStatus } from "../src/test-fixtures.ts";
import { transportValue } from "./transport-values.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import type { ScenarioInvoke } from "./desktop-scenario-context.mts";
import type {
  OutputDesktopBootstrapStatus,
  OutputDesktopLibraryOrganization,
  OutputDesktopWorkspaceSnapshot,
} from "../src/transport-types.generated.d.ts";

const bootstrap: OutputDesktopBootstrapStatus = {
  ready: true,
  generation: 7,
  library_root: "E:/owned-fixture/library",
  error: null,
  selection: null,
};
const organization: OutputDesktopLibraryOrganization = {
  revision: 0,
  collections: {},
  followed_port_ids: [],
  followed_release_acknowledgments: {},
  hidden_port_ids: [],
  saved_game_ids: [],
  setup_confirmations: [],
  update_notices: {},
};
const statuses = ["2ship2harkinian", "zelda64-recomp"].map((port_id) => ({
  ...transportValue("status", portStatus()),
  port_id,
}));
const workspace: OutputDesktopWorkspaceSnapshot = {
  catalog: { schema_version: 1, ports: [] },
  sources: [],
  statuses,
  activities: {
    records: [],
    active_and_actionable_complete: true,
    attention_required_activity_ids: [],
    current_activity_ids: [],
    recovery_required_activity_ids: [],
    terminal_history_complete: true,
    terminal_history_count: 0,
    terminal_history_limit: 50,
  },
};
const success = (value: unknown) => ({ ok: true, value });
function refusal() {
  return {
    ok: false,
    error: {
      ...transportValue("desktop_desktop_error", failureReport()),
      code: "conflict",
      message: "private-message-not-for-readbacks",
      details: {
        workspace_snapshot_stale: "true",
        retryable: "true",
        private_path: "private-path",
      },
    },
  };
}

function reads(
  snapshots: unknown[],
  bootstraps: OutputDesktopBootstrapStatus[] = [],
  statusReply: unknown = success(statuses),
) {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  let bootstrapReads = 0;
  let organizationReads = 0;
  let snapshotReads = 0;
  const invoke: ScenarioInvoke = async (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "get_bootstrap_status":
        return success(bootstraps[bootstrapReads++] ?? bootstrap);
      case "get_library_organization":
        return success({ ...organization, revision: ++organizationReads });
      case "get_workspace_snapshot":
        return snapshots[snapshotReads++];
      case "get_statuses":
        return statusReply;
      default:
        return assert.fail(`Observation must not invoke a mutation or UI action: ${command}`);
    }
  };
  return { invoke, calls };
}
const attemptCommands = [
  "get_bootstrap_status",
  "get_library_organization",
  "get_workspace_snapshot",
  "get_statuses",
  "get_bootstrap_status",
];

test("a stale workspace refusal retries the full read and returns fresh organization/status joins", async () => {
  const fixture = reads([refusal(), success(workspace)]);
  const readbacks: unknown[] = [];
  const result = await readGameFirstObservation(fixture.invoke, readbacks);
  assert.equal(result.organization.revision, 2, "Do not reuse the refused attempt's organization");
  assert.deepEqual(result.statuses, workspace.statuses);
  assert.deepEqual(
    fixture.calls.map((call) => call.command),
    [...attemptCommands, ...attemptCommands],
  );
  for (const call of fixture.calls)
    assert.deepEqual(
      call.args,
      ["get_library_organization", "get_workspace_snapshot"].includes(call.command)
        ? { generation: 7 }
        : undefined,
    );
  assert.deepEqual(readbacks, [
    {
      phase: "workspace-snapshot-refusal",
      attempt: 1,
      generation: 7,
      code: "conflict",
      workspace_snapshot_stale: "true",
      retryable: "true",
    },
  ]);
  assert.ok(!JSON.stringify(readbacks).includes("private-"));
});

test("sustained explicit workspace refusals remain fatal after exactly three full observations", async () => {
  const fixture = reads([refusal(), refusal(), refusal(), success(workspace)]);
  const readbacks: unknown[] = [];
  await assert.rejects(
    readGameFirstObservation(fixture.invoke, readbacks),
    /remained stale after 3 full read observations/u,
  );
  assert.deepEqual(
    fixture.calls.map((call) => call.command),
    Array.from({ length: 3 }, () => attemptCommands).flat(),
  );
  assert.deepEqual(
    readbacks.map((row) => (row as { attempt: number }).attempt),
    [1, 2, 3],
  );
  assert.ok(!JSON.stringify(readbacks).includes("private-"));
});

test("unrelated conflicts, malformed flags and invalid reply shapes never retry", async () => {
  const rejected = refusal();
  for (const snapshot of [
    { ...rejected, error: { ...rejected.error, code: "state" } },
    { ...rejected, error: { ...rejected.error, details: { retryable: "true" } } },
    {
      ...rejected,
      error: {
        ...rejected.error,
        details: { workspace_snapshot_stale: "true", retryable: "false" },
      },
    },
    {
      ...rejected,
      error: { ...rejected.error, details: { workspace_snapshot_stale: true, retryable: "true" } },
    },
    {
      ...rejected,
      error: { ...rejected.error, details: { workspace_snapshot_stale: "true", retryable: true } },
    },
    { ...rejected, error: { code: "conflict", details: rejected.error.details } },
    { ...rejected, ok: "false" },
    { ok: false, error: "invalid" },
    success({}),
  ]) {
    const fixture = reads([snapshot, success(workspace)]);
    const readbacks: unknown[] = [];
    await assert.rejects(readGameFirstObservation(fixture.invoke, readbacks));
    assert.deepEqual(
      fixture.calls.map((call) => call.command),
      attemptCommands.slice(0, 3),
    );
    assert.deepEqual(readbacks, []);
  }
});

test("generation and root changes fail both at the refusal boundary and before a retry", async () => {
  for (const changed of [
    { ...bootstrap, generation: 8 },
    { ...bootstrap, library_root: "E:/other-library" },
  ]) {
    for (const atRetryStart of [false, true]) {
      const fixture = reads(
        [refusal(), success(workspace)],
        atRetryStart ? [bootstrap, bootstrap, changed] : [bootstrap, changed],
      );
      const readbacks: unknown[] = [];
      await assert.rejects(readGameFirstObservation(fixture.invoke, readbacks));
      assert.deepEqual(
        fixture.calls.map((call) => call.command),
        atRetryStart ? [...attemptCommands, "get_bootstrap_status"] : attemptCommands,
      );
      assert.equal(readbacks.length, 1);
      assert.equal((readbacks[0] as { generation: number }).generation, 7);
    }
  }
});

test("status schema failures and workspace/status disagreement remain fatal without retries", async () => {
  for (const reply of [
    success([{}]),
    success(statuses.map((row) => ({ ...row, successful_launches: 1 }))),
  ]) {
    const fixture = reads([success(workspace)], [], reply);
    const readbacks: unknown[] = [];
    await assert.rejects(readGameFirstObservation(fixture.invoke, readbacks));
    assert.equal(
      fixture.calls.filter((call) => call.command === "get_workspace_snapshot").length,
      1,
    );
    assert.deepEqual(readbacks, []);
  }
});

test("game-first capture settles later complete geometry and still refuses movement during the screenshot", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { observeVisibleTarget } = await import("./browser-readiness.mts");
  type Driver = import("selenium-webdriver").WebDriver;
  type ElementHandle = import("selenium-webdriver").WebElement;
  const output = await mkdtemp(path.join(tmpdir(), "pcv-game-first-capture-"));
  try {
    for (const moveDuringScreenshot of [false, true]) {
      let observations = 0,
        screenshots = 0;
      const element = {} as ElementHandle;
      const browser = {
        executeScript: async (script: unknown, ...args: unknown[]) => {
          if (script !== observeVisibleTarget) {
            assert.equal(args[0], element, "Only the explicit preflight scroll is permitted");
            return;
          }
          const index = observations++;
          return {
            target: "#choice",
            target_count: 1,
            visible: true,
            clipping: [],
            rect: {
              x: 20,
              y: index < 2 ? 100 : screenshots && moveDuringScreenshot ? 140 : 120,
              width: 100,
              height: 40,
            },
            viewport: { width: 1280, height: 900, device_pixel_ratio: 1 },
            application_state: { document_ready: "complete", loading: 0 },
          };
        },
        takeScreenshot: async () => {
          assert.ok(
            observations >= 4,
            "Wait for two matching observations after the preflight geometry changed",
          );
          screenshots++;
          return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
        },
      } as unknown as Driver;
      const name = moveDuringScreenshot ? "changed" : "settled";
      const capture = captureGameFirstTarget({
        browser,
        output,
        name,
        scenario: "owned-game-first",
        target: "#choice",
        element,
        readiness: async () => ({ ready: true }),
      });
      if (moveDuringScreenshot) {
        await assert.rejects(capture, /Application state changed during capture/);
        await assert.rejects(readFile(path.join(output, name + "-capture.json")), {
          code: "ENOENT",
        });
        const failure: unknown = JSON.parse(
          await readFile(path.join(output, name + "-capture-failure.json"), "utf8"),
        );
        assert.ok(isRecord(failure));
        assert.equal(failure.acceptance, false);
      } else {
        const result = await capture;
        assert.equal(result.observation.state.rect?.y, 120);
        assert.equal(result.outcome, "captured");
      }
      assert.equal(screenshots, 1);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
