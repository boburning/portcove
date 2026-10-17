import type { WebDriver } from "selenium-webdriver";
import type { OutputOperationEvent1 } from "../src/transport-types.generated.d.ts";
export type ProbeSource = Pick<
  Extract<OutputOperationEvent1, { type: "source_candidate" }>,
  "profile_id" | "path" | "sha256" | "size"
>;
export interface UpdateProbeOptions {
  portId: string;
  generation: number;
  plan: { plan_sha256: string };
  failure: unknown;
}
export interface ScanProbeOptions {
  source: ProbeSource;
}
type ProbeOptions = UpdateProbeOptions | ScanProbeOptions;
type ProbeKey = `__portcoveOwnedIpcProbe_${string}`;
export interface CleanupObservation {
  attempted: boolean;
  completed: boolean | null;
  reason?: string;
  error?: string;
}
export interface ChannelObservation extends CleanupObservation {
  id: number | null;
  owned: boolean;
  index: number;
}
interface ResponseObservation extends CleanupObservation {
  owned: boolean;
  ids: (number | null)[];
  resolve: ((response: Response) => void) | null;
}
export interface ProbeSnapshot {
  plans: number;
  applies: number;
  injected: number;
  mismatches: string[];
  channels: number;
  callback_observation_error: string | null;
  channel_cleanup: ChannelObservation[];
  response_cleanup: Omit<ResponseObservation, "resolve" | "ids">[];
}
export interface ProbeCleanup extends Partial<ProbeSnapshot> {
  restored: boolean;
  trustworthy: boolean;
  terminal: boolean;
  fetch: CleanupObservation;
  channel_cleanup: ChannelObservation[];
  response_cleanup: Omit<ResponseObservation, "resolve" | "ids">[];
  error?: string;
}
interface ProbeState {
  capture(): ProbeSnapshot;
  restore(): Promise<ProbeCleanup>;
}
// Private pinned transport interoperability only; verified against retained Tauri
// sources by desktop-owned-ipc-probe-check. No ambient browser globals are added.
export interface ProbeNative {
  callbacks: Map<number, (value: unknown) => void>;
  convertFileSrc: typeof import("@tauri-apps/api/core").convertFileSrc;
  runCallback(id: number, value: unknown): void;
}

import { executeBrowserScript } from "./browser-script.mts";
import { randomUUID } from "node:crypto";
const untrustworthyErrors = new WeakSet<object>();
export const isUntrustworthyProbeError = (error: unknown) =>
  error !== null &&
  (typeof error === "object" || typeof error === "function") &&
  untrustworthyErrors.has(error);
export function requireTrustedProbeCleanup(
  report: { trustworthy: boolean },
  primaryError?: unknown,
) {
  if (report.trustworthy) return;
  if (
    primaryError !== null &&
    (typeof primaryError === "object" || typeof primaryError === "function")
  ) {
    untrustworthyErrors.add(primaryError);
    return;
  }
  // Primitive throws cannot carry the WeakSet marker. Force teardown with a
  // marked error and retain the original failure without mutating it.
  const error = new Error("Owned IPC probe cleanup did not establish a trustworthy session", {
    cause: primaryError,
  });
  untrustworthyErrors.add(error);
  throw error;
}

// Two fixed probes share interception custody and terminal cleanup, not scenario policy.
export const beginReviewedUpdateProbe = (
  browser: Pick<WebDriver, "executeScript">,
  options: UpdateProbeOptions,
) => begin(browser, "update", options);
export const beginProgressiveScanProbe = (
  browser: Pick<WebDriver, "executeScript">,
  options: ScanProbeOptions,
) => begin(browser, "scan", options);

async function begin(
  browser: Pick<WebDriver, "executeScript">,
  mode: "update" | "scan",
  options: ProbeOptions,
) {
  const key: ProbeKey = `__portcoveOwnedIpcProbe_${randomUUID()}`;
  await executeBrowserScript(browser, installProbe, key, mode, options);
  let restoration: Promise<ProbeCleanup> | undefined;
  return Object.freeze({
    capture: () =>
      executeBrowserScript(
        browser,
        (key) => (Reflect.get(window, key) as ProbeState | undefined)?.capture() ?? null,
        key,
      ),
    restore() {
      // Retain the same terminal report, including rejected browser execution.
      restoration ??= executeBrowserScript(
        browser,
        async (key) => {
          const probe = Reflect.get(window, key) as ProbeState | undefined;
          if (!probe)
            return {
              restored: false,
              trustworthy: false,
              terminal: true,
              fetch: { attempted: false, completed: false, reason: "Renderer probe state missing" },
              channel_cleanup: [],
              response_cleanup: [],
            };
          return probe.restore();
        },
        key,
      ).catch((error: unknown) => ({
        restored: false,
        trustworthy: false,
        terminal: true,
        fetch: { attempted: false, completed: false, reason: "Renderer cleanup unavailable" },
        channel_cleanup: [],
        response_cleanup: [],
        error: String(error),
      }));
      return restoration;
    },
  });
}

// Self-contained because Selenium serializes this function into the renderer.
function installProbe(key: ProbeKey, mode: "update" | "scan", options: ProbeOptions) {
  const rawNative: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
  if (
    rawNative === null ||
    typeof rawNative !== "object" ||
    !("callbacks" in rawNative) ||
    !(rawNative.callbacks instanceof Map) ||
    !("convertFileSrc" in rawNative) ||
    typeof rawNative.convertFileSrc !== "function" ||
    !("runCallback" in rawNative) ||
    typeof rawNative.runCallback !== "function"
  )
    throw new Error("Pinned Tauri probe transport unavailable");
  // The pinned transport fixture proves the callback registry calling convention.
  const native = rawNative as ProbeNative;
  const original = window.fetch;
  const targets =
    mode === "update"
      ? [
          native.convertFileSrc("plan_game_update", "ipc"),
          native.convertFileSrc("apply_game_update", "ipc"),
        ]
      : [native.convertFileSrc("scan_game_file_roots", "ipc")];
  const counts = { plans: 0, applies: 0, injected: 0 };
  const mismatches: string[] = [];
  const channels: ChannelObservation[] = [];
  const responses: ResponseObservation[] = [];
  // These fixed first-party actions allocate their Channel after installation.
  // Freshness is admission evidence for that bounded action window, not general ownership.
  const initialCallbacks = new Set(native.callbacks.keys());
  const channelBindings = new Map<ChannelObservation, ((value: unknown) => void) | undefined>();
  const responseBindings = new Map<
    ResponseObservation,
    (((value: unknown) => void) | undefined)[]
  >();
  let restoration: Promise<ProbeCleanup> | undefined;
  let active = true;
  const failure =
    mode === "update"
      ? "failure" in options
        ? options.failure
        : undefined
      : "Controlled scan observation ended; refresh or scan again.";
  const errorText = (error: unknown) =>
    String(
      error !== null && typeof error === "object" && "message" in error ? error.message : error,
    );
  const reply = (value: unknown, outcome: string) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Tauri-Response": outcome },
    });
  let callbackObservationError: string | undefined;
  const callbackPresent = (id: number | null) => {
    try {
      return native.callbacks instanceof Map ? id !== null && native.callbacks.has(id) : null;
    } catch (error) {
      callbackObservationError ??= errorText(error);
      return null;
    }
  };

  function channelFor(payload: Record<string, unknown> | null, response: ResponseObservation) {
    const token = payload?.onEvent;
    const id =
      typeof token === "string" && /^__CHANNEL__:\d+$/.test(token)
        ? Number(token.slice("__CHANNEL__:".length))
        : null;
    const owned =
      id !== null &&
      Number.isSafeInteger(id) &&
      id >= 0 &&
      callbackPresent(id) === true &&
      !initialCallbacks.has(id) &&
      !responses.some((r) => r.ids.includes(id)) &&
      !channels.some((c) => c.id === id);
    const channel: ChannelObservation = { id, owned, index: 0, attempted: false, completed: null };
    channels.push(channel);
    if (owned && response.owned && id !== null)
      channelBindings.set(channel, native.callbacks.get(id));
    else channel.owned = false;
    if (!channel.owned) mismatches.push("Controlled Channel identity unavailable or reused");
    return channel;
  }

  function ownsChannel(channel: ChannelObservation) {
    return (
      channel.id !== null &&
      channel.owned &&
      native.callbacks.get(channel.id) === channelBindings.get(channel)
    );
  }

  function emit(channel: ChannelObservation, message: unknown) {
    if (!ownsChannel(channel) || channel.id === null)
      throw new Error("Controlled Channel ownership lost");
    native.runCallback(channel.id, { index: channel.index, message });
    channel.index++;
  }

  function close(channel: ChannelObservation) {
    if (channel.attempted || channel.completed === true) return;
    if (!channel.owned) {
      channel.reason = "No admitted owned Channel";
      return;
    }
    if (!ownsChannel(channel) || channel.id === null) {
      channel.completed = null;
      channel.reason = "Channel ownership lost before close";
      return;
    }
    channel.attempted = true;
    try {
      native.runCallback(channel.id, { index: channel.index, end: true });
      channel.completed = callbackPresent(channel.id) === false ? true : null;
      if (channel.completed !== true) channel.reason = "Channel callback disappearance unobserved";
    } catch (error) {
      channel.completed = false;
      channel.error = errorText(error);
      mismatches.push("Controlled Channel did not close");
    }
  }

  function responseFor(request: RequestInit | undefined) {
    const headers = new Headers(request?.headers);
    const ids = [headers.get("Tauri-Callback"), headers.get("Tauri-Error")].map((value) =>
      value !== null && /^\d+$/.test(value) ? Number(value) : null,
    );
    const response: ResponseObservation = {
      ids,
      owned:
        ids[0] !== ids[1] &&
        ids.every(
          (id) =>
            id !== null &&
            Number.isSafeInteger(id) &&
            !initialCallbacks.has(id) &&
            callbackPresent(id) === true &&
            !responses.some((r) => r.ids.includes(id)) &&
            !channels.some((c) => c.id === id),
        ),
      attempted: false,
      completed: null,
      resolve: null,
    };
    responses.push(response);
    if (response.owned) {
      const bindings = ids.map((id) => {
        const originalCallback = id === null ? undefined : native.callbacks.get(id);
        const observer = (value: unknown) => {
          if (response.completed === true || !ownsResponse(response)) return;
          try {
            if (!originalCallback) throw new Error("Owned invoke callback disappeared");
            originalCallback(value);
            response.completed = true;
          } catch (error) {
            response.completed = false;
            response.error = errorText(error);
            throw error;
          }
        };
        if (id !== null) native.callbacks.set(id, observer);
        return observer;
      });
      responseBindings.set(response, bindings);
    }
    return response;
  }

  function ownsResponse(response: ResponseObservation) {
    return (
      response.owned &&
      response.ids.every(
        (id, index) =>
          id !== null && native.callbacks.get(id) === responseBindings.get(response)?.[index],
      )
    );
  }

  function settle(response: ResponseObservation) {
    if (!response.resolve || response.attempted) return;
    if (!ownsResponse(response)) {
      response.reason = "Invoke callback ownership lost before settlement";
      return;
    }
    response.attempted = true;
    try {
      response.resolve(reply(failure, "error"));
    } catch (error) {
      response.completed = false;
      response.error = errorText(error);
    }
  }

  async function observeResponses() {
    // Returning a Response proves delivery only; observe invoke callbacks separately.
    const deadline = Date.now() + 250;
    do {
      if (responses.every((response) => response.completed === true)) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    } while (Date.now() < deadline);
    for (const response of responses)
      if (response.completed !== true && !response.error)
        response.reason = "Invoke completion unobserved";
  }

  const snapshot = () => ({
    ...counts,
    mismatches: [...mismatches],
    channels: channels.filter((c) => c.completed === true).length,
    callback_observation_error: callbackObservationError ?? null,
    channel_cleanup: channels.map((c) => ({ ...c })),
    response_cleanup: responses.map(({ resolve: _resolve, ids: _ids, ...r }) => ({ ...r })),
  });

  function decode(request: RequestInit | undefined): Record<string, unknown> | null {
    const payload: unknown = JSON.parse(
      typeof request?.body === "string"
        ? request.body // Native TextDecoder validates unsupported BodyInit variants at runtime;
        : // malformed-input probes must retain that exception rather than dropping bytes.
          new TextDecoder().decode(request?.body as AllowSharedBufferSource | undefined),
    );
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? Object.fromEntries(Object.entries(payload))
      : null;
  }

  function scanResponse(payload: Record<string, unknown> | null, response: ResponseObservation) {
    counts.injected++;
    const channel = channelFor(payload, response);
    try {
      if (!active || !payload || !channel.owned || !("source" in options))
        throw new Error("Controlled scan request mismatch");
      const event = {
        schema_version: 3,
        operation_id: "owned-progressive-navigation-probe",
        parent_operation_id: null,
        target: null,
        operation: "discover_sources",
        timestamp_ms: Date.now(),
      };
      for (const message of [
        { ...event, type: "started", sequence: 1 },
        {
          ...event,
          type: "source_candidate",
          sequence: 2,
          profile_id: options.source.profile_id,
          path: options.source.path,
          sha256: options.source.sha256,
          size: options.source.size,
        },
      ])
        emit(channel, message);
      return new Promise<Response>((resolve) => {
        response.resolve = resolve;
      });
    } catch (error) {
      close(channel);
      throw error;
    }
  }

  function updateResponse(url: string, payload: Record<string, unknown> | null) {
    const matches =
      active &&
      "portId" in options &&
      payload !== null &&
      payload.portId === options.portId &&
      payload.activate === false &&
      payload.generation === options.generation;
    if (!matches || !("plan" in options) || payload === null)
      throw new Error("Controlled port, activation, or generation mismatch");
    if (url === targets[0]) {
      counts.plans++;
      return reply(options.plan, "ok");
    }
    if (payload.expectedPlan !== options.plan.plan_sha256)
      mismatches.push("Controlled review identity mismatch");
    return reply(failure, "error");
  }

  const replacement: typeof window.fetch = function (input, ...args) {
    const url = typeof input === "string" ? input : "url" in input ? input.url : undefined;
    if (typeof url !== "string" || !targets.includes(url))
      return original.call(window, input, ...args);
    let response;
    try {
      response = responseFor(args[0]);
      // Decode failures become Tauri application errors, never rejected fetches.
      const payload = decode(args[0]);
      if (mode === "scan") return scanResponse(payload, response);
      if (url === targets[1]) {
        counts.applies++;
        close(channelFor(payload, response));
      }
      const result = updateResponse(url, payload);
      response.attempted = true;
      return Promise.resolve(result);
    } catch (error) {
      mismatches.push(errorText(error));
    }
    if (response) response.attempted = true;
    // All intercepted applies/scans, including malformed inputs, resolve a controlled error.
    return Promise.resolve(reply(failure, "error"));
  };

  const state: ProbeState = {
    capture: snapshot,
    restore() {
      restoration ??= (async () => {
        active = false;
        const fetch: CleanupObservation = { attempted: false, completed: false };
        try {
          if (window.fetch !== replacement) fetch.reason = "Fetch ownership lost";
          else {
            fetch.attempted = true;
            window.fetch = original;
            fetch.completed = window.fetch === original;
          }
        } catch (error) {
          fetch.error = errorText(error);
        }
        // These owned actions are independent after fetch or Channel failure.
        for (const channel of channels) close(channel);
        for (const response of responses) settle(response);
        await observeResponses();
        return {
          ...snapshot(),
          terminal: true,
          fetch,
          restored: fetch.completed === true,
          trustworthy:
            fetch.completed === true &&
            channels.every((c) => c.completed === true) &&
            responses.every((r) => r.completed === true),
        };
      })();
      return restoration;
    },
  };
  Reflect.set(window, key, state);
  window.fetch = replacement;
}
