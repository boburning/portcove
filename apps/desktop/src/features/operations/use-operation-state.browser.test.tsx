import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useOperationState } from "./use-operation-state";
import { targetInvocationContext } from "./invocation-state";
import { failureReport } from "../../test-fixtures";
import { StatusLayer } from "../../components/Chrome";
import { InvocationOwnerProvider } from "./invocation-owner";
import type { ActivityRecord, OperationEvent } from "../../types";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));
let root: Root;
let host: HTMLDivElement;
let state!: ReturnType<typeof useOperationState>;
const refresh = vi.fn<() => Promise<unknown>>();
const invalidate = vi.fn();
const openActivity = vi.fn();
function Fixture({
  generation = 7,
  activities = [],
}: {
  generation?: number;
  activities?: ActivityRecord[];
}) {
  state = useOperationState({
    refresh,
    invalidateDiagnostics: invalidate,
    libraryGeneration: generation,
    activities,
  });
  return (
    <StatusLayer
      invocations={state.invocations}
      dismissInvocation={state.dismissInvocation}
      clearError={() => state.setError(undefined)}
      openActivity={openActivity}
    />
  );
}
function context(id: string, action = "Prepare") {
  return targetInvocationContext(action, { kind: "port", id, label: `Game ${id}` }, 7);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  refresh.mockReset().mockResolvedValue(undefined);
  invalidate.mockReset();
  openActivity.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("binds only an owned root event to the original invocation and ignores events after settlement", async () => {
  const done = deferred<string>();
  let report!: (event: OperationEvent) => void;
  let running!: Promise<unknown>;
  const started = (id: string, parent: string | null = null): OperationEvent => ({
    schema_version: 2,
    operation_id: id,
    parent_operation_id: parent,
    target: null,
    sequence: 1,
    timestamp_ms: 1,
    operation: "prepare",
    type: "started",
  });
  await act(async () => {
    running = state.perform(
      "prepare",
      (accept) => {
        report = accept!;
        return done.promise;
      },
      { context: context("A") },
    );
    report(started("child", "owned-root"));
  });
  expect([...state.invocations.values()][0]?.context.activityId).toBeUndefined();
  await act(async () => {
    report(started("owned-root"));
    report(started("unexpected-other-root"));
  });
  const record = [...state.invocations.values()][0]!;
  expect(record.context.target.id).toBe("A");
  expect(record.context.activityId).toBe("owned-root");
  await act(async () => {
    done.resolve("prepared");
    await running;
  });
  expect([...state.invocations.values()][0]?.phase).toBe("settled");
  await act(async () => report(started("late-root")));
  expect([...state.invocations.values()][0]?.context.activityId).toBe("owned-root");
  expect(state.operationEvents.has("late-root")).toBe(false);
});

it("does not revive completed work when durable terminal readback precedes the first owned event", async () => {
  const held = deferred<string>();
  let report!: (event: OperationEvent) => void;
  let running!: Promise<unknown>;
  await act(async () => {
    running = state.perform(
      "prepare",
      (accept) => {
        report = accept!;
        return held.promise;
      },
      { context: context("A") },
    );
  });
  const terminal: ActivityRecord = {
    id: "owned-root",
    target_id: "A",
    target_kind: "port",
    operation: "prepare",
    status: "succeeded",
    started_at: 1,
    finished_at: 2,
    cancellation: null,
    failure: null,
    message: null,
  };
  await act(async () => root.render(<Fixture activities={[terminal]} />));
  await act(async () =>
    report({
      schema_version: 2,
      operation_id: terminal.id,
      parent_operation_id: null,
      target: null,
      sequence: 1,
      timestamp_ms: 1,
      operation: "prepare",
      type: "started",
    }),
  );
  expect(state.operationEvents.has(terminal.id)).toBe(false);
  expect(state.operation).toBeUndefined();
  expect([...state.invocations.values()][0]?.context.activityId).toBe(terminal.id);
  await act(async () => {
    held.resolve("done");
    await running;
  });
  expect([...state.invocations.values()][0]?.phase).toBe("settled");
});

it("retains two independently attributed failures after out-of-order settlement", async () => {
  const a = deferred<string>(),
    b = deferred<string>();
  let first!: Promise<unknown>, second!: Promise<unknown>;
  await act(async () => {
    first = state.perform("prepare", () => a.promise, { context: context("A") });
    second = state.perform("prepare", () => b.promise, { context: context("B") });
  });
  expect(state.pendingOperations.size).toBe(2);
  const failedB = new Error("B failed before an event exists");
  await act(async () => {
    b.reject(failedB);
    await second;
  });
  expect([...state.pendingOperations.values()].map((record) => record.context.target.id)).toEqual([
    "A",
  ]);
  const failedA = new Error("A failed independently");
  await act(async () => {
    a.reject(failedA);
    await first;
  });
  const records = [...state.invocations.values()];
  expect(records.map((record) => [record.context.target.id, record.failure])).toEqual([
    ["A", failedA],
    ["B", failedB],
  ]);
  expect(records.every((record) => record.context.activityId === undefined)).toBe(true);
  const notices = host.querySelectorAll('[role="alert"]');
  expect(notices).toHaveLength(2);
  expect(notices[0]?.textContent).toContain("Prepare · Game A");
  expect(notices[1]?.textContent).toContain("Prepare · Game B");
  const general = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Open Activity",
  )!;
  await act(async () => general.click());
  expect(openActivity).toHaveBeenLastCalledWith(undefined);
  await act(async () => state.dismissInvocation(records[0]!.id));
  expect([...state.invocations.values()].map((record) => record.failure)).toEqual([failedB]);
});

it("offers an exact Activity link only for an explicitly supplied identity", async () => {
  await act(async () => {
    await state.perform("prepare", () => Promise.reject(new Error("Owned task failed")), {
      context: { ...context("A"), activityId: "owned-activity-record" },
    });
  });
  const exact = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "View task in Activity",
  )!;
  await act(async () => exact.click());
  expect(openActivity).toHaveBeenLastCalledWith("owned-activity-record");
});

it("refuses a same-target same-turn submission while allowing another explicit target", async () => {
  const held = deferred<void>();
  const duplicate = vi.fn().mockResolvedValue(undefined);
  const other = vi.fn().mockResolvedValue("other result");
  let running!: Promise<unknown>;
  await act(async () => {
    running = state.perform("prepare", () => held.promise, { context: context("A") });
    await state.perform("launch", duplicate, { context: context("A", "Launch") });
    expect(await state.perform("check", other, { context: context("B", "Check") })).toBe(
      "other result",
    );
  });
  expect(duplicate).not.toHaveBeenCalled();
  expect(other).toHaveBeenCalledOnce();
  const refusal = [...state.invocations.values()].find(
    (record) => record.name === "launch",
  )?.failure;
  expect(refusal).toBeInstanceOf(Error);
  if (!(refusal instanceof Error)) throw new Error("Expected an attributed local refusal");
  expect(refusal.message).toContain("Game A");
  await act(async () => {
    held.resolve();
    await running;
  });
});

it("keeps legacy library-wide work exclusive and never runs a blocked task", async () => {
  const held = deferred<void>();
  let running!: Promise<unknown>;
  const blocked = vi.fn();
  await act(async () => {
    running = state.perform("move library", () => held.promise);
    await state.perform("prepare", blocked, { context: context("B") });
  });
  expect(blocked).not.toHaveBeenCalled();
  await act(async () => {
    held.resolve();
    await running;
  });
});

it("separates a committed task result from failed refresh without retrying the mutation", async () => {
  const task = vi.fn().mockResolvedValue({ committed: true });
  const refreshError = new Error("Readback failed");
  refresh.mockRejectedValue(refreshError);
  await act(async () => {
    expect(await state.perform("prepare", task, { context: context("A") })).toEqual({
      committed: true,
    });
  });
  expect([...state.invocations.values()][0]).toMatchObject({
    outcome: "succeeded",
    refreshFailure: refreshError,
  });
  expect([...state.invocations.values()][0]?.failure).toBeUndefined();
  expect(task).toHaveBeenCalledOnce();
});

it("retains the original failure and independent readback failure", async () => {
  const failure = failureReport();
  const readback = new Error("Snapshot unavailable");
  refresh.mockRejectedValue(readback);
  await act(async () => {
    await state.perform("prepare", () => Promise.reject(failure), { context: context("A") });
  });
  expect(state.error).toBe(failure);
  expect([...state.invocations.values()][0]).toMatchObject({ failure, refreshFailure: readback });
});

it("releases local exclusion when diagnostic invalidation fails after a committed task", async () => {
  const problem = new Error("Diagnostic invalidation unavailable");
  invalidate.mockImplementationOnce(() => {
    throw problem;
  });
  await act(async () => {
    expect(
      await state.perform("prepare", () => Promise.resolve("committed"), {
        context: context("A"),
      }),
    ).toBe("committed");
  });
  expect(state.pendingOperations.size).toBe(0);
  expect([...state.invocations.values()][0]).toMatchObject({
    outcome: "succeeded",
    refreshFailure: problem,
  });
  expect(host.textContent).toContain("current state could not be refreshed");
  await act(async () => {
    expect(
      await state.perform("check", () => Promise.resolve("new check"), {
        context: context("A", "Check"),
      }),
    ).toBe("new check");
  });
});

it("does not refresh or publish an outgoing result into a replacement library", async () => {
  const held = deferred<string>();
  let running!: Promise<unknown>;
  await act(async () => {
    running = state.perform("prepare", () => held.promise, { context: context("A") });
  });
  await act(async () => root.render(<Fixture generation={8} />));
  await act(async () => {
    held.resolve("old result");
    expect(await running).toBeUndefined();
  });
  expect(state.invocations.size).toBe(0);
  expect(refresh).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
});

it("suppresses continuation when the library changes during readback", async () => {
  const readback = deferred<void>();
  refresh.mockReturnValue(readback.promise);
  let running!: Promise<unknown>;
  await act(async () => {
    running = state.perform("prepare", () => Promise.resolve("committed"), {
      context: context("A"),
    });
  });
  await act(async () => root.render(<Fixture generation={8} />));
  await act(async () => {
    readback.resolve();
    expect(await running).toBeUndefined();
  });
  expect(state.invocations.size).toBe(0);
});

it("retains application exclusion across the keyed workspace remount and retires it on actual settlement", async () => {
  await act(async () =>
    root.render(
      <InvocationOwnerProvider>
        <Fixture key={7} generation={7} />
      </InvocationOwnerProvider>,
    ),
  );
  const held = deferred<string>();
  const nextTask = vi.fn().mockResolvedValue("current library result");
  let running!: Promise<unknown>;
  await act(async () => {
    running = state.perform("Repair application", () => held.promise, {
      context: {
        ...context("app", "Repair application"),
        target: { kind: "application", id: "portcove", label: "Portcove" },
        exclusionScope: "application",
      },
    });
  });
  await act(async () =>
    root.render(
      <InvocationOwnerProvider>
        <Fixture key={8} generation={8} />
      </InvocationOwnerProvider>,
    ),
  );
  expect(state.pendingOperations.size).toBe(1);
  const currentContext = { ...context("B", "Check"), libraryGeneration: 8 };
  await act(async () => {
    await state.perform("check", nextTask, { context: currentContext });
  });
  expect(nextTask).not.toHaveBeenCalled();
  await act(async () => {
    held.resolve("old continuation");
    expect(await running).toBeUndefined();
  });
  expect(state.pendingOperations.size).toBe(0);
  expect(refresh).not.toHaveBeenCalled();
  expect(
    [...state.invocations.values()].find((record) => record.name === "Repair application")?.outcome,
  ).toBe("succeeded");
  await act(async () => {
    expect(await state.perform("check", nextTask, { context: currentContext })).toBe(
      "current library result",
    );
  });
});
