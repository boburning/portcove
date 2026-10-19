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
