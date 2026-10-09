import { randomUUID } from "node:crypto";
const untrustworthyErrors = new WeakSet();
export const isUntrustworthyProbeError = (error) => untrustworthyErrors.has(error);
export function requireTrustedProbeCleanup(report, primaryError) {
  if (report.trustworthy) return;
  const error =
    primaryError ?? new Error("Owned IPC probe cleanup did not establish a trustworthy session");
  untrustworthyErrors.add(error);
  if (!primaryError) throw error;
}

// Two fixed probes share interception custody and terminal cleanup, not scenario policy.
export const beginReviewedUpdateProbe = (browser, options) => begin(browser, "update", options);
export const beginProgressiveScanProbe = (browser, options) => begin(browser, "scan", options);

async function begin(browser, mode, options) {
  const key = `__portcoveOwnedIpcProbe_${randomUUID()}`;
  await browser.executeScript(installProbe, key, mode, options);
  let restoration;
  return Object.freeze({
    capture: () => browser.executeScript((key) => window[key]?.capture() ?? null, key),
    restore() {
      // Retain the same terminal report, including rejected browser execution.
      restoration ??= browser
        .executeScript(async (key) => {
          const probe = window[key];
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
        }, key)
        .catch((error) => ({
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
function installProbe(key, mode, options) {
  const native = window.__TAURI_INTERNALS__;
  const original = window.fetch;
  const targets =
    mode === "update"
      ? [
          native.convertFileSrc("plan_game_update", "ipc"),
          native.convertFileSrc("apply_game_update", "ipc"),
        ]
      : [native.convertFileSrc("scan_game_file_roots", "ipc")];
  const counts = { plans: 0, applies: 0, injected: 0 };
  const mismatches = [];
  const channels = [];
  const responses = [];
  let restoration;
  let active = true;
  const failure =
    mode === "update"
      ? options.failure
      : "Controlled scan observation ended; refresh or scan again.";
  const errorText = (error) => String(error?.message ?? error);
  const reply = (value, outcome) =>
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Tauri-Response": outcome },
    });
  let callbackObservationError;
  const callbackPresent = (id) => {
    try {
      return native.callbacks instanceof Map ? native.callbacks.has(id) : null;
    } catch (error) {
      callbackObservationError ??= errorText(error);
      return null;
    }
  };

  function channelFor(payload) {
    const token = payload?.onEvent;
    const id =
      typeof token === "string" && /^__CHANNEL__:\d+$/.test(token)
        ? Number(token.slice("__CHANNEL__:".length))
        : null;
    const owned =
      Number.isSafeInteger(id) &&
      id >= 0 &&
      callbackPresent(id) === true &&
      !channels.some((c) => c.id === id);
    const channel = { id, owned, index: 0, attempted: false, completed: null };
    channels.push(channel);
    if (!owned) mismatches.push("Controlled Channel identity unavailable or reused");
    return channel;
  }

  function close(channel) {
    if (channel.attempted || channel.completed === true) return;
    if (!channel.owned) {
      channel.reason = "No admitted owned Channel";
      return;
    }
    if (callbackPresent(channel.id) === false) {
      channel.completed = true;
      channel.reason = "Callback already observed absent";
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

  function responseFor(request) {
    const headers = new Headers(request?.headers);
    const ids = [headers.get("Tauri-Callback"), headers.get("Tauri-Error")].map((value) =>
      value !== null && /^\d+$/.test(value) ? Number(value) : null,
    );
    const response = {
      ids,
      owned: ids.every((id) => Number.isSafeInteger(id) && callbackPresent(id) === true),
      attempted: false,
      completed: null,
      resolve: null,
    };
    responses.push(response);
    return response;
  }

  function settle(response) {
    if (!response.resolve || response.attempted) return;
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
      for (const response of responses)
        if (response.attempted && response.completed !== false && response.owned)
          response.completed = response.ids.every((id) => callbackPresent(id) === false)
            ? true
            : null;
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

  const replacement = function (input, ...args) {
    const url = typeof input === "string" ? input : input.url;
    if (!targets.includes(url)) return original.call(window, input, ...args);
    const request = args[0];
    let response;
    let channel;
    try {
      response = responseFor(request);
      // Decode failures become Tauri application errors, never rejected fetches.
      const payload = JSON.parse(
        typeof request?.body === "string" ? request.body : new TextDecoder().decode(request?.body),
      );
      const object = payload !== null && typeof payload === "object" && !Array.isArray(payload);
      if (mode === "scan") {
        counts.injected++;
        channel = channelFor(object ? payload : null);
        if (!active || !object || !channel.owned)
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
        ]) {
          native.runCallback(channel.id, { index: channel.index, message });
          channel.index++;
        }
        return new Promise((resolve) => {
          response.resolve = resolve;
        });
      }
      if (url === targets[1]) {
        counts.applies++;
        channel = channelFor(object ? payload : null);
        close(channel);
      }
      const matches =
        active &&
        object &&
        payload.portId === options.portId &&
        payload.activate === false &&
        payload.generation === options.generation;
      if (!matches) throw new Error("Controlled port, activation, or generation mismatch");
      if (url === targets[0]) {
        counts.plans++;
        response.attempted = true;
        return Promise.resolve(reply(options.plan, "ok"));
      }
      if (payload.expectedPlan !== options.plan.plan_sha256)
        mismatches.push("Controlled review identity mismatch");
    } catch (error) {
      mismatches.push(errorText(error));
      if (channel) close(channel);
    }
    if (response) response.attempted = true;
    // All intercepted applies/scans, including malformed inputs, resolve a controlled error.
    return Promise.resolve(reply(failure, "error"));
  };

  window[key] = {
    capture: snapshot,
    restore() {
      restoration ??= (async () => {
        active = false;
        const fetch = { attempted: false, completed: false };
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
          restored: fetch.completed,
          trustworthy:
            fetch.completed &&
            channels.every((c) => c.completed === true) &&
            responses.every((r) => r.completed === true),
        };
      })();
      return restoration;
    },
  };
  window.fetch = replacement;
}
