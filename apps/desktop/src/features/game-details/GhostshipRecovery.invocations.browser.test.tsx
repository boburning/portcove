import { controlledAct as act } from "../../../test/controlled-react-act";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { portDefinition } from "../../test-fixtures";
import type { BackupRecord, GhostshipRecoveryResult } from "../../types";
import { installRecord } from "../../components/rendered-test-fixtures";
import { useOperationState } from "../operations/use-operation-state";
import { detailActions } from "./detail-actions";

vi.mock("@tauri-apps/api/event", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));
const backup: BackupRecord = {
  id: "legacy-snapshot",
  port_id: "ghostship",
  path: "snapshots/legacy",
  created_at: 1,
  file_count: 1,
  size: 1,
  sha256: "a".repeat(64),
};
const result: GhostshipRecoveryResult = {
  install: installRecord({ port_id: "ghostship" }),
  restored_backup: backup,
  safety_backup: { ...backup, id: "safety" },
  runtime_safety_path: "snapshots/safety/runtime",
};
let root: Root, container: HTMLDivElement;
let operations!: ReturnType<typeof useOperationState>;
let actions!: ReturnType<typeof detailActions>;
const refresh = vi.fn().mockResolvedValue(undefined),
  refreshBackups = vi.fn().mockResolvedValue(undefined);
function Fixture({ generation = 7 }: { generation?: number }) {
  operations = useOperationState({ refresh, libraryGeneration: generation });
  actions = detailActions({
    port: { ...portDefinition(), id: "ghostship" },
    status: undefined,
    sourcePath: "",
    biosPath: "",
    perform: operations.perform,
    close: vi.fn(),
    backupsChanged: refreshBackups,
    libraryGeneration: generation,
  });
  return null;
}
beforeEach(async () => {
  refresh.mockClear();
  refreshBackups.mockReset().mockResolvedValue(undefined);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("attributes only the named native decline as cancellation without claiming recovery", async () => {
  const recover = vi.spyOn(desktopApi, "recoverGhostshipLegacyData").mockResolvedValue(null);
  let outcome: unknown;
  await act(async () => {
    outcome = await actions.recoverGhostshipLegacy!(backup, "reviewed");
  });
  expect(outcome).toBe("cancelled");
  expect(recover).toHaveBeenCalledExactlyOnceWith(backup.id, "reviewed", 7);
  expect([...operations.invocations.values()]).toMatchObject([
    {
      outcome: "cancelled",
      phase: "settled",
      context: { target: { id: "ghostship" }, libraryGeneration: 7 },
    },
  ]);
  expect(refreshBackups).not.toHaveBeenCalled();
  await act(async () => {
    await operations.perform("unrelated nullable result", async () => null);
  });
  expect([...operations.invocations.values()].at(-1)?.outcome).toBe("succeeded");
});

it("keeps committed recovery successful when independent backup readback fails", async () => {
  vi.spyOn(desktopApi, "recoverGhostshipLegacyData").mockResolvedValue(result);
  refreshBackups.mockRejectedValue(new Error("Backup inventory could not be read"));
  let outcome: unknown;
  await act(async () => {
    outcome = await actions.recoverGhostshipLegacy!(backup, "reviewed");
  });
  expect(outcome).toBe(true);
  expect([...operations.invocations.values()]).toMatchObject([
    { name: "recover legacy installation and data", outcome: "succeeded", phase: "settled" },
    { name: "refresh backup history", outcome: "failed", phase: "settled" },
  ]);
  expect(refresh).toHaveBeenCalledOnce();
  expect(refreshBackups).toHaveBeenCalledOnce();
});

it("retains a failed Core recovery separately from its successful inventory refresh", async () => {
  vi.spyOn(desktopApi, "recoverGhostshipLegacyData").mockRejectedValue(
    new Error("Changed plan: recovery held"),
  );
  let outcome: unknown;
  await act(async () => {
    outcome = await actions.recoverGhostshipLegacy!(backup, "reviewed");
  });
  expect(outcome).toBe(false);
  expect([...operations.invocations.values()][0]?.failure).toEqual(
    new Error("Changed plan: recovery held"),
  );
  expect([...operations.invocations.values()]).toMatchObject([
    {
      outcome: "failed",
    },
    { name: "refresh backup history", outcome: "succeeded" },
  ]);
});

it("does not refresh or publish an outgoing recovery into a replacement library", async () => {
  let finish!: (value: GhostshipRecoveryResult) => void;
  vi.spyOn(desktopApi, "recoverGhostshipLegacyData").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = actions.recoverGhostshipLegacy!(backup, "reviewed");
  });
  await act(async () => root.render(<Fixture generation={8} />));
  await act(async () => {
    finish(result);
    await pending;
  });
  expect(operations.invocations.size).toBe(0);
  expect(refreshBackups).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it("refuses a backup for another game before invoking the host", async () => {
  const recover = vi.spyOn(desktopApi, "recoverGhostshipLegacyData");
  await expect(
    actions.recoverGhostshipLegacy!({ ...backup, port_id: "other" }, "reviewed"),
  ).rejects.toThrow("another game");
  expect(recover).not.toHaveBeenCalled();
});
