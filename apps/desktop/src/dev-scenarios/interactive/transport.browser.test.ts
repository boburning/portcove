import { fixtureValue } from "../../test-fixtures";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import type { OperationEvent } from "../../types";
import { preparation } from "./scenarios";
import { installInteractiveTransport, recoveryKey } from "./transport";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(() => {
  transport?.dispose();
  transport = undefined;
  sessionStorage.removeItem(recoveryKey);
});
it("refuses unknown and malformed commands visibly without forwarding IPC", async () => {
  const refuse = vi.fn();
  transport = installInteractiveTransport("library", refuse);
  await expect(desktopApi.launch("summit", "", 1)).rejects.toThrow("Unsupported fixture action");
  await expect(desktopApi.workspaceSnapshot(2)).rejects.toThrow("unexpected arguments");
  await expect(invoke("get_bootstrap_status", { extra: true })).rejects.toThrow(
    "unexpected arguments",
  );
  expect(refuse).toHaveBeenCalledTimes(3);
});

it("models metadata-only update queries while refusing consent or repository arguments", async () => {
  const refuse = vi.fn();
  transport = installInteractiveTransport("library", refuse);
  const before = await desktopApi.applicationUpdatePreferences();
  const phases: string[] = [];
  const checked = await desktopApi.checkApplicationUpdate((phase) => phases.push(phase), {
    channel: "stable",
  });
  expect(checked.checked_channel).toBe("stable");
  expect(checked.result.staged).toBe(false);
  expect(phases).toEqual(["checking", "complete"]);
  expect(await desktopApi.applicationUpdatePreferences()).toEqual(before);
  await expect(
    invoke("check_application_update", {
      request: { channel: "stable", url: "https://invalid.example" },
    }),
  ).rejects.toThrow("unexpected arguments");
  await expect(
    invoke("check_application_update", { request: { channel: "nightly" } }),
  ).rejects.toThrow("invalid channel");
  expect(refuse).toHaveBeenCalledTimes(2);
});
it("supports current read surfaces without hiding unsupported mutations", async () => {
  const refuse = vi.fn();
  transport = installInteractiveTransport("library", refuse);
  expect(await desktopApi.favoritePorts(1)).toEqual([]);
  await desktopApi.setPortFavorite("sample", true, 1);
  expect(await desktopApi.favoritePorts(1)).toEqual(["sample"]);
  expect(await desktopApi.outputLocation("sample", 1)).toMatchObject({
    effective_output_directory: "fixture/library/sample",
    configured_output_directory: null,
  });
  expect(await desktopApi.outputRelocationStatus("sample", 1)).toBeNull();
  expect(await desktopApi.previewOutputLocation("sample", null, 1)).toMatchObject({
    affected_installs: [{ install_id: "fixture-install", active: true }],
    moves_existing_install: false,
  });
  expect(await desktopApi.applicationUpdateStatus()).toMatchObject({
    install_eligibility: "not-configured",
    staged: null,
  });
  expect(await desktopApi.catalogStatus()).toMatchObject({
    provenance: { origin: "embedded" },
    trusted_keys: [],
  });
  expect(refuse).not.toHaveBeenCalled();
  await expect(desktopApi.resetOutputLocation("sample", "unreviewed", 1)).rejects.toThrow(
    "Unsupported fixture action",
  );
  await expect(desktopApi.setPortFavorite("foreign", true, 1)).rejects.toThrow(
    "Unsupported fixture action",
  );
  await expect(desktopApi.outputLocation("sample", 2)).rejects.toThrow("unexpected arguments");
});
it("models an eligible launch without claiming a native process and resets favorites", async () => {
  transport = installInteractiveTransport("library", vi.fn());
  await desktopApi.setPortFavorite("sample", true, 1);
  expect(await desktopApi.launch("sample", "", 1)).toEqual({
    processId: null,
    sessionId: "fixture-launch-sample",
  });
  await expect(desktopApi.launch("sample", "foreign.rom", 1)).rejects.toThrow(
    "Unsupported fixture action",
  );
  transport.dispose();
  transport = installInteractiveTransport("setup", vi.fn());
  expect(await desktopApi.favoritePorts(1)).toEqual([]);
  await expect(desktopApi.launch("sample", "", 1)).rejects.toThrow("Unsupported fixture action");
});
it("keeps preparation pending until explicitly completed and removes it on disposal", async () => {
  transport = installInteractiveTransport("setup", vi.fn());
  const event = vi.fn<(event: OperationEvent) => void>();
  const result = desktopApi.prepare("sample", preparation.plan_sha256, 1, event);
  expect(event.mock.calls.map(([value]) => value.type)).toEqual(["started", "message"]);
  transport.complete();
  await expect(result).resolves.toMatchObject({ port_id: "sample" });
  expect(
    fixtureValue(
      (await desktopApi.workspaceSnapshot(1)).statuses[0],
      "(await desktopApi.workspaceSnapshot(1)).statuses[0]",
    ).readiness?.pending_setup,
  ).toBe(false);
  transport.dispose();
  transport = undefined;
  expect("__TAURI_INTERNALS__" in window).toBe(false);
});
it.each([false, true])(
  "retains the chosen move-recovery fixture across reload: abort=%s",
  async (abort) => {
    transport = installInteractiveTransport("recovery", vi.fn());
    expect((await desktopApi.bootstrapStatus()).ready).toBe(false);
    const result = await desktopApi.recoverLibraryMove("fixture/original", abort);
    expect(result.active_root).toBe(abort ? "fixture/original" : "fixture/library");
    transport.dispose();
    transport = installInteractiveTransport("recovery", vi.fn());
    expect(await desktopApi.bootstrapStatus()).toMatchObject({
      ready: true,
      library_root: result.active_root,
    });
  },
);
it("does not install into an existing native host", () => {
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} });
  try {
    expect(() => installInteractiveTransport("library", vi.fn())).toThrow(
      "ordinary development browser",
    );
  } finally {
    Reflect.deleteProperty(window, "__TAURI__");
  }
});

it("keeps task records and retained-file facts bound to their original operations through new work", async () => {
  transport = installInteractiveTransport("activity", vi.fn());
  const before = await desktopApi.previewPreparationCleanup("fixture-retained-orchard", 1);
  const result = desktopApi.prepare("sample", preparation.plan_sha256, 1, vi.fn());
  expect((await desktopApi.activities()).current_activity_ids).toEqual(["fixture-preparation"]);
  const record = (await desktopApi.activities()).records.find(
    (record) => record.id === "fixture-preparation",
  )!;
  expect(record.target_id).toBe("sample");
  await desktopApi.outputLocation("orchard", 1);
  await desktopApi.planPreparation("sample", 1);
  expect(await desktopApi.previewPreparationCleanup("fixture-retained-orchard", 1)).toEqual(before);
  transport.complete();
  await result;
  const feed = await desktopApi.activities();
  expect(feed.current_activity_ids).toEqual([]);
  expect(feed.records.find((record) => record.id === "fixture-preparation")).toMatchObject({
    target_id: "sample",
    status: "succeeded",
  });
  expect(feed.recovery_required_activity_ids).toEqual(
    expect.arrayContaining(["fixture-retained-harbor", "fixture-retained-orchard"]),
  );
  await expect(desktopApi.cleanupPreparation(before.operation_id, "unreviewed", 1)).rejects.toThrow(
    "unexpected arguments",
  );
  await desktopApi.cleanupPreparation(before.operation_id, before.preview_sha256, 1);
  expect((await desktopApi.activities()).recovery_required_activity_ids).not.toContain(
    before.operation_id,
  );
  expect((await desktopApi.previewPreparationCleanup("fixture-retained-harbor", 1)).port_id).toBe(
    "sample",
  );
});

it("distinguishes a cancellation request from settlement and records failed setup for recovery", async () => {
  transport = installInteractiveTransport("setup", vi.fn());
  const result = desktopApi.prepare("sample", preparation.plan_sha256, 1, vi.fn());
  const outcome = result.catch((error: unknown) => error);
  await desktopApi.cancelOperation("fixture-preparation");
  expect((await desktopApi.activities()).records[0]).toMatchObject({
    status: "running",
    cancellation: { requested: true },
  });
  expect(() => transport!.complete()).toThrow("cancellation requested");
  transport.settleCancellation();
  expect(await outcome).toMatchObject({ code: "cancelled" });
  expect((await desktopApi.activities()).records[0]).toMatchObject({
    status: "cancelled",
    target_id: "sample",
  });
  const next = desktopApi.prepare("sample", preparation.plan_sha256, 1, vi.fn());
  const failure = next.catch((error: unknown) => error);
  transport.fail();
  expect(await failure).toMatchObject({ presentation: { mutation_state: "recovery_required" } });
  const feed = await desktopApi.activities();
  expect(new Set(feed.records.map((record) => record.id)).size).toBe(2);
  expect(feed.recovery_required_activity_ids).toEqual(["fixture-preparation-2"]);
  const preview = await desktopApi.previewPreparationCleanup("fixture-preparation-2", 1);
  expect(preview.port_id).toBe("sample");
  expect(preview.retained_path).toContain("fixture-preparation-2");
});
