import { StrictMode } from "react";
import { controlledAct as act } from "../../../test/controlled-react-act";
import { cleanup, render, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import type { GameFileQuerySnapshot, OperationEvent } from "../../types";
import { useGameFileObservation } from "./use-game-file-observation";
import { acceptedGameFileQuery } from "./game-file-query-context";

vi.mock("../../api", () => ({
  desktopApi: { libraryIdentity: vi.fn(), refreshGameFileQuery: vi.fn() },
}));
const library = { id: "library", root: "private-root" };
const route = {
  port_id: "port",
  route: "managed_install",
  platform: "windows-x86-64",
  channel: "stable",
} as const;
const request = {
  routes: [route],
  maximum_age_seconds: 300,
  limits: { max_file_bytes: 2147483648, max_hash_bytes: 34359738368, max_elapsed_ms: 30000 },
};
function snapshot(): GameFileQuerySnapshot {
  return {
    schema_version: 1,
    library,
    observed_at: Math.floor(Date.now() / 1000) - 10,
    expires_at: Math.floor(Date.now() / 1000) + 290,
    catalog_binding_sha256: "a".repeat(64),
    registration_sha256: "b".repeat(64),
    selection_sha256: "c".repeat(64),
    routes: [
      {
        ...route,
        state: "files_missing",
        reason: "no_connected_registration",
        contract_id: null,
        identity: null,
        source_instance_sha256: null,
        route_definition_sha256: "d".repeat(64),
        route_instance_sha256: null,
      },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const started = (id: string): OperationEvent => ({
  schema_version: 3,
  operation_id: id,
  parent_operation_id: null,
  operation: "verify_source",
  sequence: 0,
  timestamp_ms: Date.now(),
  target: null,
  type: "started",
});
let state: ReturnType<typeof useGameFileObservation<GameFileQuerySnapshot>>;
let root: RenderResult;
function Fixture({ context = "A" }: { context?: string }) {
  state = useGameFileObservation({
    contextKey: context,
    generation: 1,
    request: () => request,
    accept: (value, _request, identity, now) => {
      if (!acceptedGameFileQuery(value, route, identity, now))
        throw new Error("Rejected observation");
      return value;
    },
  });
  return null;
}
const show = async (context = "A") =>
  root.rerender(
    <StrictMode>
      <Fixture context={context} />
    </StrictMode>,
  );
const refresh = async () =>
  act(async () => {
    void state.refresh();
  });
beforeEach(async () => {
  vi.mocked(desktopApi.libraryIdentity).mockResolvedValue(library);
  vi.mocked(desktopApi.refreshGameFileQuery).mockImplementation(async () => snapshot());
  root = await render(null);
});
afterEach(async () => {
  await cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("retains only immutable Core time and requested scope through retry, failure, actual cancellation and replacement", async () => {
  await show();
  await refresh();
  const accepted = state.presentation.lastAccepted!;
  expect(accepted.observedAt).toBe(state.current!.observed_at);
  expect(Object.keys(accepted).sort()).toEqual(["deadline", "expiresAt", "observedAt", "routes"]);
  expect(Object.isFrozen(accepted)).toBe(true);
  expect(Object.isFrozen(accepted.routes)).toBe(true);
  expect(Object.isFrozen(accepted.routes[0])).toBe(true);
  const retry = deferred<GameFileQuerySnapshot>();
  vi.mocked(desktopApi.refreshGameFileQuery).mockReturnValueOnce(retry.promise);
  await refresh();
  expect(state.current).toBeUndefined();
  expect(state.presentation.lastAccepted).toBe(accepted);
  expect(state.presentation.outcome).toBe("checking");
  await act(async () => retry.reject(new Error("offline")));
  expect(state.presentation.outcome).toBe("failed");
  expect(state.presentation.lastAccepted).toBe(accepted);
  vi.mocked(desktopApi.refreshGameFileQuery).mockRejectedValueOnce({
    code: "cancelled",
    message: "Inspection canceled",
  });
  await refresh();
  expect(state.presentation.outcome).toBe("cancelled");
  expect(state.current).toBeUndefined();
  expect(state.presentation.lastAccepted).toBe(accepted);
  await refresh();
  expect(state.current).toBeDefined();
  expect(state.presentation.lastAccepted).not.toBe(accepted);
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(4);
});

it.each([
  ["files_missing", "no_connected_registration"],
  ["needs_checking", "storage_absence_unconfirmed"],
  ["no_files_required", "explicit_empty_requirements"],
  ["unavailable_context", "observation_unavailable"],
] as const)(
  "records an accepted %s observation without claiming a positive match",
  async (classification, reason) => {
    const value = snapshot();
    value.routes[0] = {
      ...value.routes[0]!,
      state: classification,
      reason,
      route_definition_sha256: classification === "unavailable_context" ? null : "d".repeat(64),
    };
    vi.mocked(desktopApi.refreshGameFileQuery).mockResolvedValue(value);
    await show();
    await refresh();
    expect(state.current?.routes[0]?.state).toBe(classification);
    expect(state.presentation.lastAccepted?.observedAt).toBe(value.observed_at);
  },
);

it("does not create metadata for a rejected first response or restore usability on a rejected retry", async () => {
  await show();
  vi.mocked(desktopApi.refreshGameFileQuery).mockResolvedValueOnce({ ...snapshot(), routes: [] });
  await refresh();
  expect(state.presentation.lastAccepted).toBeUndefined();
  expect(state.presentation.outcome).toBe("failed");
  await refresh();
  const accepted = state.presentation.lastAccepted;
  vi.mocked(desktopApi.refreshGameFileQuery).mockResolvedValueOnce({ ...snapshot(), routes: [] });
  await refresh();
  expect(state.current).toBeUndefined();
  expect(state.presentation.lastAccepted).toBe(accepted);
});

it("keeps the original sticky expiry after expiry, retry, failure and wall-clock rewind", async () => {
  vi.useFakeTimers();
  await show();
  await refresh();
  const accepted = state.presentation.lastAccepted;
  const originalTime = Date.now();
  await act(async () => vi.advanceTimersByTime(300001));
  expect(state.presentation.expired).toBe(true);
  vi.mocked(desktopApi.refreshGameFileQuery).mockRejectedValueOnce(new Error("offline"));
  await refresh();
  vi.setSystemTime(originalTime);
  await show();
  expect(state.presentation.lastAccepted).toBe(accepted);
  expect(state.presentation.expired).toBe(true);
  expect(state.current).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("retains the original monotonic deadline through an unexpired failed retry", async () => {
  const monotonic = vi.spyOn(performance, "now").mockReturnValue(1000);
  await show();
  await refresh();
  const accepted = state.presentation.lastAccepted!;
  monotonic.mockReturnValue(100000);
  vi.mocked(desktopApi.refreshGameFileQuery).mockRejectedValueOnce(new Error("offline"));
  await refresh();
  expect(state.presentation.lastAccepted).toBe(accepted);
  monotonic.mockReturnValue(accepted.deadline + 1);
  await show();
  expect(state.presentation.expired).toBe(true);
  expect(state.current).toBeUndefined();
  monotonic.mockRestore();
});

it("ignores callbacks from settled A during B in the same context", async () => {
  await show();
  await refresh();
  const oldEvent = vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[0]![2]!;
  const held = deferred<GameFileQuerySnapshot>();
  vi.mocked(desktopApi.refreshGameFileQuery).mockReturnValueOnce(held.promise);
  await refresh();
  const newEvent = vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[1]![2]!;
  await act(async () => {
    newEvent(started("B"));
    oldEvent(started("late-A"));
  });
  expect(state.operationId).toBe("B");
  await act(async () => held.resolve(snapshot()));
  await act(async () => newEvent(started("settled-B")));
  expect(state.operationId).toBeUndefined();
});

it("holds exclusion through an obsolete identity read and refuses Core work after A-to-B-to-A", async () => {
  const identity = deferred<typeof library>();
  vi.mocked(desktopApi.libraryIdentity).mockReturnValueOnce(identity.promise);
  await show();
  await refresh();
  await show("B");
  await show("A");
  await refresh();
  expect(desktopApi.libraryIdentity).toHaveBeenCalledTimes(1);
  expect(state.presentation.lastAccepted).toBeUndefined();
  expect(state.presentation.outcome).toBe("waiting");
  await act(async () => identity.resolve(library));
  expect(desktopApi.refreshGameFileQuery).not.toHaveBeenCalled();
  expect(state.pending).toBe(false);
  await refresh();
  expect(state.current).toBeDefined();
});

it("clears accepted history on context changes and remount, without implicit requests", async () => {
  await show();
  await refresh();
  await show("B");
  await show("A");
  expect(state.presentation.lastAccepted).toBeUndefined();
  expect(state.current).toBeUndefined();
  await refresh();
  await root.rerender(null);
  await show();
  expect(state.presentation.lastAccepted).toBeUndefined();
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(2);
});

it("ignores callbacks and settlement after unmount and cleans its expiry timers", async () => {
  vi.useFakeTimers();
  await show();
  await refresh();
  const held = deferred<GameFileQuerySnapshot>();
  vi.mocked(desktopApi.refreshGameFileQuery).mockReturnValueOnce(held.promise);
  await refresh();
  const event = vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[1]![2]!;
  await root.rerender(null);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    event(started("unmounted"));
    held.resolve(snapshot());
  });
  await show();
  expect(state.current).toBeUndefined();
  expect(state.presentation.lastAccepted).toBeUndefined();
  expect(state.operationId).toBeUndefined();
});
