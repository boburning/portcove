import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { failureReport, portDefinition, portStatus } from "../test-fixtures";
import { preparationRecoveryPort } from "../view-model";
import { StatusLayer } from "./Chrome";
import { useOperationState } from "../features/operations/use-operation-state";
import { useDetailWorkspaceNavigation } from "../features/app-shell/use-detail-workspace-navigation";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));
const port = portDefinition();
const status = { ...portStatus(), port_id: port.id };
const refresh = vi.fn().mockResolvedValue(undefined);
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  refresh.mockClear();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const report = () => ({
  ...failureReport(),
  presentation: {
    ...failureReport().presentation,
    recovery_actions: ["review_preparation", "review_current_state", "view_technical_details"],
    recovery_target: { kind: "preparation", port_id: port.id },
  },
});

it("only resolves known current targets without interpreting diagnostic text", () => {
  const error = report();
  expect(preparationRecoveryPort(error, [port], [status])).toBe(port.id);
  for (const target of [
    undefined,
    null,
    [],
    { kind: "future", port_id: port.id },
    { kind: "preparation", port_id: 3 },
    { kind: "preparation", port_id: "missing" },
    { kind: "preparation", port_id: "port\nother" },
  ]) {
    const invalid = {
      ...error,
      presentation: {
        ...error.presentation,
        recovery_target: target,
        technical_context: { port_id: port.id },
        summary: `Review ${port.id}`,
      },
    };
    expect(preparationRecoveryPort(invalid, [port], [status])).toBeUndefined();
  }
  for (const [ports, statuses] of [
    [[], [status]],
    [[port], []],
    [[port, port], [status]],
    [[port], [status, status]],
  ] as const)
    expect(preparationRecoveryPort(error, ports, statuses)).toBeUndefined();
  expect(
    preparationRecoveryPort(
      { ...error, presentation: { ...error.presentation, recovery_actions: [] } },
      [port],
      [status],
    ),
  ).toBeUndefined();
});

function Workspace({ task }: { task: () => Promise<never> }) {
  const operations = useOperationState({ refresh });
  const workspace = useRef<HTMLElement | null>(null);
  const [selected, setSelected] = useState<string | undefined>("other-port");
  const navigation = useDetailWorkspaceNavigation(workspace, setSelected);
  const id = preparationRecoveryPort(operations.error, [port], [status]);
  return (
    <main ref={workspace}>
      <button onClick={() => void operations.perform("prepare", task)}>Start owned attempt</button>
      <StatusLayer
        error={operations.error}
        clearError={() => operations.setError(undefined)}
        reviewCurrentState={refresh}
        reviewPreparation={id ? () => navigation.open(id, "error:preparation-review") : undefined}
      />
      <section data-detail-workspace>
        <h1>{selected}</h1>
        <button className="detail-back" onClick={navigation.close}>
          Back
        </button>
      </section>
    </main>
  );
}

it("opens the reported game from another detail without repeating the failed mutation", async () => {
  const failure = report();
  const original = structuredClone(failure);
  const task = vi.fn().mockRejectedValue(failure);
  await act(async () => root.render(<Workspace task={task} />));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.querySelector("h1")?.textContent).toBe("other-port");
  const read = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Review current state",
  )!;
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => read.click());
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(task).toHaveBeenCalledOnce();
  const review = host.querySelector<HTMLButtonElement>(
    '[data-detail-origin="error:preparation-review"]',
  )!;
  expect(review.textContent).toBe("Review setup");
  await act(async () => review.click());
  expect(host.querySelector("h1")?.textContent).toBe(port.id);
  expect(task).toHaveBeenCalledOnce();
  expect(failure).toEqual(original);
});

it("a late failure from the ended workspace cannot add recovery to its replacement", async () => {
  let reject!: (error: unknown) => void;
  const task = vi.fn(
    () =>
      new Promise<never>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  await act(async () => root.render(<Workspace key={1} task={task} />));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => root.render(<Workspace key={2} task={task} />));
  await act(async () => {
    reject(report());
    await Promise.resolve();
  });
  expect(host.querySelector('[data-detail-origin="error:preparation-review"]')).toBeNull();
  expect(host.querySelector("h1")?.textContent).toBe("other-port");
  expect(task).toHaveBeenCalledOnce();
});
