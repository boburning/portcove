import { executeBrowserScript } from "./browser-script.mts";
import assert from "node:assert/strict";
import type { WebDriver } from "selenium-webdriver";

export interface BoundaryReply {
  ok?: boolean;
  value?: unknown;
  error?: string;
  unavailable?: boolean;
}
interface BoundaryBridge {
  invoke(command: string, args?: object | null, options?: object): Promise<unknown>;
  transformCallback(callback: (value: unknown) => void): number;
}
export interface HeldReply {
  id: string;
  input: string;
}
export type BoundaryWindow = Window & {
  __TAURI_INTERNALS__?: BoundaryBridge;
  __boundaryDelivery?: string | null;
  __boundaryHeld?: HeldReply | null;
  __boundaryRelease?: () => void;
  __boundaryDisposedResult?: BoundaryReply | null;
  __boundaryOriginReply?: BoundaryReply | null;
};
export function parseBoundaryReply(value: unknown): BoundaryReply {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  const record: Record<string, unknown> = value as Record<string, unknown>;
  assert.ok(record.ok === undefined || typeof record.ok === "boolean");
  assert.ok(record.error === undefined || typeof record.error === "string");
  assert.ok(record.unavailable === undefined || typeof record.unavailable === "boolean");
  if (record.unavailable === true) return { ...record, unavailable: true };
  assert.ok(typeof record.ok === "boolean");
  if (!record.ok) {
    assert.ok(typeof record.error === "string");
    return { ...record, ok: false, error: record.error };
  }
  return { ...record, ok: true, value: record.value };
}
export async function invokeBoundary(
  browser: WebDriver,
  command: string,
  arguments_: object | null = {},
  options: object = {},
): Promise<BoundaryReply> {
  return parseBoundaryReply(
    await browser.executeAsyncScript<unknown>(
      (
        command_: string,
        arguments__: object | null,
        options_: object,
        done: (value: unknown) => void,
      ) => {
        const host = window as BoundaryWindow;
        const native = host.__TAURI_INTERNALS__;
        if (typeof native?.invoke !== "function") {
          done({ unavailable: true });
          return;
        }
        void native.invoke(command_, arguments__, options_).then(
          (value) => done({ ok: true, value }),
          (error: unknown) => done({ ok: false, error: String(error) }),
        );
      },
      command,
      arguments_,
      options,
    ),
  );
}

export async function armBoundaryOwner(browser: WebDriver) {
  await browser.switchTo().window("boundary-secondary");
  return executeBrowserScript(browser, () => {
    const host = window as BoundaryWindow;
    const native = host.__TAURI_INTERNALS__;
    if (!native) throw new Error("Boundary native bridge missing");
    host.__boundaryDelivery = null;
    host.__boundaryHeld = null;
    const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      const id = new Headers(options?.headers).get("Tauri-Channel-Id");
      if (id !== null && host.__boundaryHeld === null) {
        host.__boundaryHeld = {
          id,
          input: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        };
        return new Promise<Response>((resolve, reject) => {
          host.__boundaryRelease = () => {
            window.fetch = originalFetch;
            originalFetch(input, options).then(resolve, reject);
          };
        });
      }
      return originalFetch(input, options);
    };
    return native.transformCallback((value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "message" in value &&
        typeof value.message === "string" &&
        value.message
      )
        host.__boundaryDelivery = value.message;
    });
  });
}
