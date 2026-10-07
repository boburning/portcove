// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
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
  await expect(desktopApi.launch("sample", "")).rejects.toThrow("Unsupported fixture action");
  await expect(desktopApi.workspaceSnapshot(2)).rejects.toThrow("unexpected arguments");
  await expect(invoke("get_bootstrap_status", { extra: true })).rejects.toThrow(
    "unexpected arguments",
  );
  expect(refuse).toHaveBeenCalledTimes(3);
});
it("keeps preparation pending until explicitly completed and removes it on disposal", async () => {
  transport = installInteractiveTransport("setup", vi.fn());
  const event = vi.fn<(event: OperationEvent) => void>();
  const result = desktopApi.prepare("sample", preparation.plan_sha256, 1, event);
  expect(event.mock.calls.map(([value]) => value.type)).toEqual(["started", "message"]);
  transport.complete();
  await expect(result).resolves.toMatchObject({ port_id: "sample" });
  expect((await desktopApi.workspaceSnapshot(1)).statuses[0].readiness?.pending_setup).toBe(false);
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
