import { controlledAct as act } from "../../test/controlled-react-act";
import { cleanup, render as renderComponent, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import type { DefinitionRefresh, OperationEvent } from "../types";
import type { InvocationRecord } from "../features/operations/invocation-state";
import { useOperationState } from "../features/operations/use-operation-state";
import { OfficialDefinitionUpdates } from "./OfficialDefinitionUpdates";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const portId = "newly-listed-port";
const floor = {
  definitions_sha256: "a".repeat(64),
  definitions_version: 1,
  index_sha256: "b".repeat(64),
  root_sha256: "c".repeat(64),
  root_version: 1,
  snapshot_sha256: "d".repeat(64),
  snapshot_version: 1,
  targets_sha256: "e".repeat(64),
  targets_version: 1,
  timestamp_sha256: "f".repeat(64),
  timestamp_version: 1,
};
const selected: DefinitionRefresh = {
  refresh_schema: 1,
  namespace: "official",
  stable_id: portId,
  disposition: "selected",
  policy_changed: true,
  launch_assessment_changed: false,
  eligibility: { outcome: "eligible", reason: "mandatory_checks_passed" },
  selection: {
    revision: 1,
    can_rollback: false,
    replay_floor: floor,
    selected: {
      namespace: "official",
      stable_id: portId,
      definition_revision: 1,
      grant_id: "fixture-publisher",
      policy_revision: 1,
      repository_root_sha256: floor.root_sha256,
      provenance: { ...floor, earliest_expiration: "2030-01-01T00:00:00Z" },
    },
  },
};
const started: OperationEvent = {
  schema_version: 2,
  operation_id: "owned-definition-check",
  parent_operation_id: null,
  target: null,
  sequence: 1,
  timestamp_ms: 1,
  operation: "update_catalog",
  type: "started",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

let root: RenderResult;
let observedInvocations: InvocationRecord[];
const changed = vi.fn<() => Promise<unknown>>();
const settings = vi.fn();
const retryRefresh = vi.fn<() => Promise<unknown>>();
const noActivities = async () => {};

function Harness({
  generation,
  id,
  showControl,
}: {
  generation: number;
  id: string;
  showControl: boolean;
}) {
  const operations = useOperationState({
    // App's ambient retry callback suppresses readback errors. This action must
    // use its explicit propagating mutation callback through the same owner.
    refresh: retryRefresh,
    refreshActivities: noActivities,
    libraryGeneration: generation,
  });
  observedInvocations = [...operations.invocations.values()];
  return showControl ? (
    <OfficialDefinitionUpdates
      portId={id}
      portName="Fixture port"
      generation={generation}
      busy={Boolean(operations.busy)}
      perform={operations.perform}
      onChanged={changed}
      openSettings={settings}
    />
  ) : (
    <p>Current definition details</p>
  );
}

const checkButton = () =>
  page.getByRole("button", { name: "Check setup availability", exact: true });
async function render(generation = 7, id = portId, showControl = true) {
  await root.rerender(<Harness generation={generation} id={id} showControl={showControl} />);
}
async function click(target: Parameters<typeof userEvent.click>[0]) {
  await act(async () => userEvent.click(target));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observedInvocations = [];
  changed.mockReset().mockResolvedValue(undefined);
  settings.mockReset();
  retryRefresh.mockReset().mockResolvedValue(undefined);
  vi.spyOn(desktopApi, "refreshOfficialDefinition").mockResolvedValue(selected);
  vi.spyOn(desktopApi, "enableOfficialCatalog");
  vi.spyOn(desktopApi, "install");
  vi.spyOn(desktopApi, "importSource");
  vi.spyOn(desktopApi, "cancelOperation").mockResolvedValue({
    requested: true,
    phase: "preparing",
  });
  root = await renderComponent(null);
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("checks only the exact selected identity on explicit intent and reloads setup options", async () => {
  await render();
  expect(desktopApi.refreshOfficialDefinition).not.toHaveBeenCalled();
  await click(checkButton());
  expect(desktopApi.refreshOfficialDefinition).toHaveBeenCalledExactlyOnceWith(
    portId,
    7,
    expect.any(Function),
  );
  expect(changed).toHaveBeenCalledOnce();
  await expect
    .element(
      page.getByText(
        "Setup information checked. Review the current setup options before continuing.",
      ),
    )
    .toBeVisible();
  expect(desktopApi.enableOfficialCatalog).not.toHaveBeenCalled();
  expect(desktopApi.install).not.toHaveBeenCalled();
  expect(desktopApi.importSource).not.toHaveBeenCalled();
  await click(page.getByRole("button", { name: "Catalog update settings" }));
  expect(settings).toHaveBeenCalledOnce();
});

for (const [disposition, eligibility, message] of [
  [
    "ineligible",
    { outcome: "hold", reason: "engine_capability_required" },
    "The offered setup could not be selected.",
  ],
  ["revoked", null, "The publisher withdrew this setup."],
] as const) {
  it(`preserves ${disposition} as a checked outcome without claiming installation`, async () => {
    vi.mocked(desktopApi.refreshOfficialDefinition).mockResolvedValue({
      ...selected,
      disposition,
      eligibility,
    });
    await render();
    await click(checkButton());
    await expect.element(page.getByText(message, { exact: false })).toBeVisible();
    expect(changed).toHaveBeenCalledOnce();
    expect(desktopApi.install).not.toHaveBeenCalled();
  });
}

it("blocks same-turn duplicates and retains exclusion through authoritative readback", async () => {
  const pending = deferred<DefinitionRefresh>();
  const readback = deferred<unknown>();
  vi.mocked(desktopApi.refreshOfficialDefinition).mockReturnValue(pending.promise);
  changed.mockReturnValue(readback.promise);
  await render();
  const button = checkButton().element() as HTMLButtonElement;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(desktopApi.refreshOfficialDefinition).toHaveBeenCalledOnce();
  await act(async () => pending.resolve(selected));
  await expect.element(checkButton()).toBeDisabled();
  expect(changed).toHaveBeenCalledOnce();
  await act(async () => readback.resolve(undefined));
  await expect.element(checkButton()).toBeEnabled();
});

it("keeps original partial-commit details and an independent readback failure without replay", async () => {
  const failure = {
    code: "network",
    message: "Launch assessment unavailable",
    details: {
      definition_refresh_phase: "launch_assessment",
      definition_policy_changed: "true",
      definition_launch_assessment_changed: "false",
    },
  };
  const readbackFailure = new Error("Library readback unavailable");
  vi.mocked(desktopApi.refreshOfficialDefinition).mockRejectedValue(failure);
  changed.mockRejectedValue(readbackFailure);
  await render();
  await click(checkButton());
  await expect.element(page.getByRole("alert")).toHaveTextContent(failure.message);
  const settled = observedInvocations.find((record) => record.phase === "settled")!;
  expect(settled.failure).toBe(failure);
  expect(settled.refreshFailure).toBe(readbackFailure);
  expect(retryRefresh).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  expect(desktopApi.refreshOfficialDefinition).toHaveBeenCalledOnce();
});

it("settles the shared invocation when readback replaces listing details and unmounts the control", async () => {
  changed.mockImplementation(async () => {
    await render(7, portId, false);
  });
  await render();
  await click(checkButton());
  await expect.element(page.getByText("Current definition details")).toBeVisible();
  await expect
    .poll(() => observedInvocations.every((record) => record.phase === "settled"))
    .toBe(true);
  expect(observedInvocations).toHaveLength(1);
  expect(changed).toHaveBeenCalledOnce();
  expect(retryRefresh).not.toHaveBeenCalled();
});

it("drops outgoing-library events, results and reloads after a generation handoff", async () => {
  const pending = deferred<DefinitionRefresh>();
  let report!: (event: OperationEvent) => void;
  vi.mocked(desktopApi.refreshOfficialDefinition).mockImplementation((_id, _generation, accept) => {
    report = accept;
    return pending.promise;
  });
  await render();
  await click(checkButton());
  await render(8);
  await act(async () => {
    report(started);
    pending.reject(new Error("Old library response lost"));
  });
  expect(changed).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Old library response lost");
  expect(document.body.textContent).not.toContain("Setup information checked.");
  expect(document.body.textContent).not.toContain("Cancel setup check");
});

it("keeps a completed check attributed to its old port when another detail is selected", async () => {
  const pending = deferred<DefinitionRefresh>();
  vi.mocked(desktopApi.refreshOfficialDefinition).mockReturnValue(pending.promise);
  await render();
  await click(checkButton());
  await render(7, "other-listing");
  await act(async () => pending.resolve(selected));
  expect(changed).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain("Setup information checked.");
  expect(observedInvocations.find((record) => record.phase === "settled")?.context.target.id).toBe(
    portId,
  );
});

it("cancels only the owned root check and reloads instead of claiming no changes", async () => {
  const pending = deferred<DefinitionRefresh>();
  vi.mocked(desktopApi.refreshOfficialDefinition).mockImplementation((_id, _generation, report) => {
    report(started);
    return pending.promise;
  });
  await render();
  await click(checkButton());
  await click(page.getByRole("button", { name: "Cancel setup check" }));
  expect(desktopApi.cancelOperation).toHaveBeenCalledExactlyOnceWith(started.operation_id);
  await act(async () => pending.reject({ code: "cancelled" }));
  await expect
    .element(
      page.getByText("Setup check cancelled. Review current setup information before continuing."),
    )
    .toBeVisible();
  expect(changed).toHaveBeenCalledOnce();
  expect(desktopApi.refreshOfficialDefinition).toHaveBeenCalledOnce();
});

for (const malformed of [
  { refresh_schema: 2 },
  { namespace: "unappointed" },
  { stable_id: "other-listing" },
  { disposition: "future-outcome" },
]) {
  it(`refuses an unsupported response and still reloads: ${JSON.stringify(malformed)}`, async () => {
    vi.mocked(desktopApi.refreshOfficialDefinition).mockResolvedValue({
      ...selected,
      ...malformed,
    } as DefinitionRefresh);
    await render();
    await click(checkButton());
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "The setup check returned an unsupported result. Review current setup information.",
      );
    expect(changed).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Setup information checked.");
  });
}
