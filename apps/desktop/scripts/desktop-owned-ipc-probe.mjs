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
  // These fixed first-party actions allocate their Channel after installation.
  // Freshness is admission evidence for that bounded action window, not general ownership.
  const initialCallbacks = new Set(native.callbacks.keys());
  const channelBindings = new Map();
  const responseBindings = new Map();
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

  function channelFor(payload, response) {
    const token = payload?.onEvent;
    const id =
      typeof token === "string" && /^__CHANNEL__:\d+$/.test(token)
        ? Number(token.slice("__CHANNEL__:".length))
        : null;
    const owned =
      Number.isSafeInteger(id) &&
      id >= 0 &&
      callbackPresent(id) === true &&
      !initialCallbacks.has(id) &&
      !responses.some((r) => r.ids.includes(id)) &&
      !channels.some((c) => c.id === id);
    const channel = { id, owned, index: 0, attempted: false, completed: null };
    channels.push(channel);
    if (owned && response.owned) channelBindings.set(channel, native.callbacks.get(id));
    else channel.owned = false;
    if (!channel.owned) mismatches.push("Controlled Channel identity unavailable or reused");
    return channel;
  }

  function ownsChannel(channel) {
    return channel.owned && native.callbacks.get(channel.id) === channelBindings.get(channel);
  }

  function emit(channel, message) {
    if (!ownsChannel(channel)) throw new Error("Controlled Channel ownership lost");
    native.runCallback(channel.id, { index: channel.index, message });
    channel.index++;
  }

  function close(channel) {
    if (channel.attempted || channel.completed === true) return;
    if (!channel.owned) {
      channel.reason = "No admitted owned Channel";
      return;
    }
    if (!ownsChannel(channel)) {
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

  function responseFor(request) {
    const headers = new Headers(request?.headers);
    const ids = [headers.get("Tauri-Callback"), headers.get("Tauri-Error")].map((value) =>
      value !== null && /^\d+$/.test(value) ? Number(value) : null,
    );
    const response = {
      ids,
      owned:
        ids[0] !== ids[1] &&
        ids.every(
          (id) =>
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
        const originalCallback = native.callbacks.get(id);
        const observer = (value) => {
          if (response.completed === true || !ownsResponse(response)) return;
          try {
            originalCallback(value);
            response.completed = true;
          } catch (error) {
            response.completed = false;
            response.error = errorText(error);
            throw error;
          }
        };
        native.callbacks.set(id, observer);
        return observer;
      });
      responseBindings.set(response, bindings);
    }
    return response;
  }

  function ownsResponse(response) {
    return (
      response.owned &&
      response.ids.every(
        (id, index) => native.callbacks.get(id) === responseBindings.get(response)?.[index],
      )
    );
  }

  function settle(response) {
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

  function decode(request) {
    const payload = JSON.parse(
      typeof request?.body === "string" ? request.body : new TextDecoder().decode(request?.body),
    );
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : null;
  }

  function scanResponse(payload, response) {
    counts.injected++;
    const channel = channelFor(payload, response);
    try {
      if (!active || !payload || !channel.owned)
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
      return new Promise((resolve) => {
        response.resolve = resolve;
      });
    } catch (error) {
      close(channel);
      throw error;
    }
  }

  function updateResponse(url, payload) {
    const matches =
      active &&
      payload !== null &&
      payload.portId === options.portId &&
      payload.activate === false &&
      payload.generation === options.generation;
    if (!matches) throw new Error("Controlled port, activation, or generation mismatch");
    if (url === targets[0]) {
      counts.plans++;
      return reply(options.plan, "ok");
    }
    if (payload.expectedPlan !== options.plan.plan_sha256)
      mismatches.push("Controlled review identity mismatch");
    return reply(failure, "error");
  }

  const replacement = function (input, ...args) {
    const url = typeof input === "string" ? input : input.url;
    if (!targets.includes(url)) return original.call(window, input, ...args);
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
