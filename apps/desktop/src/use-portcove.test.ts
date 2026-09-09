import { portDefinition, portStatus } from "./test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "./api";
import type { PortDefinition } from "./types";
import { detailActions, type Perform } from "./use-portcove";

const port: PortDefinition = {
  ...portDefinition(),
  id: "lighthouse",
  name: "Lighthouse",
  summary: "Native port",
  project_url: "https://example.com",
  support_tier: "stable",
  channels: ["stable"],
  platforms: ["windows-x86-64"],
  automated_tested_platforms: ["windows-x86-64"],
  manually_validated_platforms: ["windows-x86-64"],
  adapter: "libultraship-portable",
  persistent_paths: ["saves"],
  upstream_status: "active",
  release: portDefinition().release,
  executable_hints: {},
};

describe("detail actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("binds channel saving and subsequent checks to the selected library", async () => {
    const saved = { ...portStatus(), channel: "beta" as const };
    vi.spyOn(desktopApi, "setChannel").mockResolvedValue(saved);
    vi.spyOn(desktopApi, "check").mockResolvedValue(undefined!);
    const perform: Perform = async (_name, task) => task();
    const actions = detailActions(port, saved, "", "", perform, vi.fn(), vi.fn(), async () => {}, 17);
    await actions.setChannel("beta"); await actions.check();
    expect(desktopApi.setChannel).toHaveBeenCalledExactlyOnceWith(port.id, "beta", 17);
    expect(desktopApi.check).toHaveBeenCalledExactlyOnceWith(port.id, 17);
  });

  it("saves policy in the selected library without invoking install or update", async () => {
    const saved = { ...portStatus(), update_policy: "automatic" as const };
    vi.spyOn(desktopApi, "setPolicy").mockResolvedValue(saved);
    const install = vi.spyOn(desktopApi, "install");
    const update = vi.spyOn(desktopApi, "applyGameUpdate");
    const perform: Perform = async (_name, task) => task();
    await detailActions(port, saved, "", "", perform, vi.fn(), vi.fn(), async () => {}, 12).setPolicy("automatic");
    expect(desktopApi.setPolicy).toHaveBeenCalledExactlyOnceWith(port.id, "automatic", 12);
    expect(install).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it("the explicit Install action does not silently stage because of saved policy", async () => {
    const install = vi.spyOn(desktopApi, "install").mockResolvedValue(undefined!);
    const perform: Perform = async (_name, task) => task();
    await detailActions(port, { ...portStatus(), update_policy: "stage" }, "source.z64", "", perform, vi.fn()).install();
    expect(install).toHaveBeenCalledExactlyOnceWith(port.id, "stable", "source.z64", "", false);
  });

  it("backs up through the shared operation boundary", async () => {
    vi.spyOn(desktopApi, "backup").mockResolvedValue({
      id: "backup-1", port_id: port.id, path: "library/backups/lighthouse/backup-1",
      created_at: 1, file_count: 2, size: 3, sha256: "a".repeat(64),
    });
    const perform = vi.fn(async (_name: string, task: () => Promise<unknown>) => task()) as unknown as Perform;

    await detailActions(port, undefined, "", "", perform, vi.fn()).backup();

    expect(perform).toHaveBeenCalledWith("back up data", expect.any(Function));
    expect(desktopApi.backup).toHaveBeenCalledWith(port.id);
  });

  it("does not close when reviewed removal fails in the shared operation boundary", async () => {
    vi.spyOn(desktopApi, "remove").mockRejectedValue(new Error("Installation changed"));
    const perform = vi.fn(async (_name: string, task: () => Promise<unknown>) => { try { return await task(); } catch { return undefined; } }) as unknown as Perform;
    const close = vi.fn();

    await detailActions(port, undefined, "", "", perform, close, undefined, undefined, 9).remove("reviewed-removal");

    expect(perform).toHaveBeenCalledWith("remove", expect.any(Function));
    expect(desktopApi.remove).toHaveBeenCalledWith(port.id, "reviewed-removal", 9);
    expect(close).not.toHaveBeenCalled();
  });

  it("refreshes backup history after the backend authorizes a restore", async () => {
    const backup = {
      id: "backup-1", port_id: port.id, path: "library/backups/lighthouse/backup-1",
      created_at: 1, file_count: 2, size: 3, sha256: "a".repeat(64),
    };
    vi.spyOn(desktopApi, "restoreBackup").mockResolvedValue({ restored_backup: backup, safety_backup: null });
    const perform = vi.fn(async (_name: string, task: () => Promise<unknown>) => task()) as unknown as Perform;
    const refresh = vi.fn().mockResolvedValue(undefined);

    await detailActions(port, undefined, "", "", perform, vi.fn(), undefined, refresh, 7).restoreBackup(backup, "reviewed-restore");

    expect(desktopApi.restoreBackup).toHaveBeenCalledWith(port.id, backup.id, "reviewed-restore", 7);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("deletes one backend-authorized backup", async () => {
    const backup = {
      id: "backup-1", port_id: port.id, path: "library/backups/lighthouse/backup-1",
      created_at: 1, file_count: 2, size: 3, sha256: "a".repeat(64),
    };
    vi.spyOn(desktopApi, "deleteBackup").mockResolvedValue(backup);
    const perform = vi.fn(async (_name: string, task: () => Promise<unknown>) => task()) as unknown as Perform;
    const refresh = vi.fn().mockResolvedValue(undefined);

    await detailActions(port, undefined, "", "", perform, vi.fn(), undefined, refresh, 8).deleteBackup(backup, "reviewed-delete");

    expect(desktopApi.deleteBackup).toHaveBeenCalledWith(port.id, backup.id, "reviewed-delete", 8);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("removes through the operation boundary and closes after success", async () => {
    vi.spyOn(desktopApi, "remove").mockResolvedValue(["managed/version"]);
    const perform = vi.fn(async (_name: string, task: () => Promise<unknown>) => task()) as unknown as Perform;
    const close = vi.fn();

    await detailActions(port, undefined, "", "", perform, close, undefined, undefined, 9).remove("reviewed-removal");

    expect(perform).toHaveBeenCalledWith("remove", expect.any(Function));
    expect(desktopApi.remove).toHaveBeenCalledWith(port.id, "reviewed-removal", 9);
    expect(close).toHaveBeenCalledOnce();
  });
});
