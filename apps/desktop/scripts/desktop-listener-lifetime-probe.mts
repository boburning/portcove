import type { ProbeNative } from "./desktop-owned-ipc-probe.mts";

interface ListenerEntry {
  handler: unknown;
  binding: ((value: unknown) => void) | undefined;
  held: boolean;
  event_id: unknown;
  unlistened: boolean;
  rejected?: boolean;
  rejection_response?: { http_ok: boolean; outcome: string | null; value: unknown };
  unlisten_count?: number;
  unlisten_response?: { http_ok: boolean; outcome: string | null; value: unknown };
}
interface ResponseEntry {
  command: string;
  ids: (number | null)[];
  completed: boolean;
  outcome: "ok" | "error" | null;
}
export interface ListenerSnapshot {
  rewrites: number;
  privileged_requests: number;
  mismatches: string[];
  released: boolean;
  responses: (ResponseEntry & { settled: boolean })[];
  listeners: (Omit<ListenerEntry, "binding"> & { callback_present: boolean })[];
  manual_refresh?: { received: boolean; generation: unknown; accepted: boolean; value: unknown };
}
interface ListenerCleanup extends ListenerSnapshot {
  restored: boolean;
  trustworthy: boolean;
}
export interface ListenerProbe {
  capture(): ListenerSnapshot;
  release(): void;
  armRefresh(): void;
  restore(): Promise<ListenerCleanup>;
}
// Serialized by Selenium; never unregisters or deletes arbitrary callbacks.
export function activateManualRefresh(key: string): boolean {
  const notices = [...document.querySelectorAll('[role="status"][aria-busy="false"]')].filter(
    (notice) =>
      [...notice.querySelectorAll("strong")].some(
        (heading) => heading.textContent === "Live workspace updates are unavailable",
      ),
  );
  if (notices.length !== 1) return false;
  const buttons = [...notices[0]!.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === "Refresh now",
  );
  const button = buttons[0];
  if (
    buttons.length !== 1 ||
    !(button instanceof HTMLButtonElement) ||
    !button.isConnected ||
    button.disabled ||
    button.closest('[inert], [hidden], [aria-hidden="true"]') ||
    button.getClientRects().length === 0
  )
    return false;
  const style = getComputedStyle(button);
  if (style.display === "none" || style.visibility !== "visible") return false;
  // Arm and activate the actual owner callback in one browser turn. A pending
  // automatic refresh cannot consume the held response between two RPCs.
  (Reflect.get(window, key) as ListenerProbe).armRefresh();
  button.click();
  return true;
}

export function installListenerLifetimeProbe(
  key: string,
  reviewed: string,
  currentRoot: string,
  mode: "late" | "reject" = "late",
) {
  const rawNative: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
  if (
    rawNative === null ||
    typeof rawNative !== "object" ||
    !("callbacks" in rawNative) ||
    !(rawNative.callbacks instanceof Map) ||
    !("convertFileSrc" in rawNative) ||
    typeof rawNative.convertFileSrc !== "function"
  )
    throw new Error("Pinned Tauri probe transport unavailable");
  const native = rawNative as ProbeNative;
  const original = window.fetch;
  const url = (command: string) => native.convertFileSrc(command, "ipc");
  const listen = url("plugin:event|listen");
  const unlisten = url("plugin:event|unlisten");
  const select = url("set_default_library");
  const workspace = url("get_workspace_snapshot");
  const privileged = ["prepare_port", "install_port", "adopt_port"].map(url);
  const initial = new Set(native.callbacks.keys());
  const listeners: ListenerEntry[] = [];
  const responses: ResponseEntry[] = [];
  const mismatches: string[] = [];
  let rewrites = 0;
  let privilegedRequests = 0;
  let release: () => void = () => {
    throw new Error("Listener gate not initialized");
  };
  let released = false;
  let restored: Promise<ListenerCleanup> | undefined;
  let manualRefresh: ListenerSnapshot["manual_refresh"];
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const decode = (request: RequestInit | undefined): Record<string, unknown> => {
    const payload: unknown = JSON.parse(
      typeof request?.body === "string"
        ? request.body
        : new TextDecoder().decode(request?.body as AllowSharedBufferSource | undefined),
    );
    if (payload === null || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Native request body is not an object");
    return Object.fromEntries(Object.entries(payload));
  };
  const present = (entry: ListenerEntry) =>
    typeof entry.handler === "number" &&
    typeof entry.binding === "function" &&
    native.callbacks.get(entry.handler) === entry.binding;
  const responseSettled = (entry: ResponseEntry) =>
    entry.completed && entry.ids.every((id) => id !== null && !native.callbacks.has(id));
  function observeResponse(request: RequestInit | undefined, command: string) {
    const headers = new Headers(request?.headers);
    const ids = ["Tauri-Callback", "Tauri-Error"].map((name) => {
      const raw = headers.get(name);
      return raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
    });
    const entry: ResponseEntry = { command, ids, completed: false, outcome: null };
    responses.push(entry);
    if (
      ids[0] === ids[1] ||
      ids.some(
        (id) =>
          id === null ||
          !Number.isSafeInteger(id) ||
          initial.has(id) ||
          typeof native.callbacks.get(id) !== "function",
      )
    ) {
      mismatches.push("Invoke response callback identity unavailable");
      return;
    }
    ids.forEach((id, index) => {
      if (id === null) return;
      const callback = native.callbacks.get(id);
      if (typeof callback !== "function") return;
      const observer = (value: unknown) => {
        if (native.callbacks.get(id) !== observer)
          throw new Error("Owned invoke callback identity changed");
        callback(value);
        entry.completed = true;
        entry.outcome = index === 0 ? "ok" : "error";
      };
      native.callbacks.set(id, observer);
    });
  }
  const snapshot = () => ({
    rewrites,
    privileged_requests: privilegedRequests,
    mismatches: [...mismatches],
    released,
    ...(manualRefresh ? { manual_refresh: { ...manualRefresh } } : {}),
    responses: responses.map((entry) => ({ ...entry, settled: responseSettled(entry) })),
    listeners: listeners.map((entry) => {
      const { binding: _binding, ...observation } = entry;
      return { ...observation, callback_present: present(entry) };
    }),
  });
  const handleSelection: typeof fetch = async function (this: unknown, input, request) {
    const body = decode(request);
    if (body.path !== reviewed || Object.keys(body).length !== 1 || rewrites >= 2) {
      mismatches.push("Unexpected library-selection input");
      throw new Error("Controlled library-selection input mismatch");
    }
    rewrites++;
    return original.call(this, input, {
      ...request,
      body: JSON.stringify({ path: currentRoot }),
    });
  };
  const validateListenerBinding = (entry: ListenerEntry) => {
    if (
      !Number.isSafeInteger(entry.handler) ||
      (typeof entry.handler === "number" && initial.has(entry.handler)) ||
      typeof entry.binding !== "function"
    )
      mismatches.push("Listener callback identity unavailable");
  };
  const handleListen: typeof fetch = async function (this: unknown, input, request) {
    const body = decode(request);
    if (body.event === "portcove://operation") {
      const entry: ListenerEntry = {
        handler: body.handler,
        binding: typeof body.handler === "number" ? native.callbacks.get(body.handler) : undefined,
        held: mode === "late" && listeners.length === 0,
        event_id: null,
        unlistened: false,
      };
      validateListenerBinding(entry);
      listeners.push(entry);
      observeResponse(request, "listen");
      const reject = mode === "reject" && listeners.length === 1;
      if (
        reject &&
        (JSON.stringify(body.target) !== JSON.stringify({ kind: "Any" }) ||
          Object.keys(body).sort().join(",") !== "event,handler,target")
      ) {
        mismatches.push("Unexpected event registration target or fields");
        throw new Error("Controlled event input mismatch");
      }
      const response = await original.call(
        this,
        input,
        reject
          ? {
              ...request,
              body: JSON.stringify({ ...body, event: "portcove invalid registration" }),
            }
          : request,
      );
      if (reject) {
        entry.rejection_response = {
          http_ok: response.ok,
          outcome: response.headers.get("Tauri-Response"),
          value: await response.clone().json(),
        };
        entry.rejected =
          response.ok &&
          entry.rejection_response.outcome === "error" &&
          typeof entry.rejection_response.value === "string" &&
          entry.rejection_response.value.includes(
            "Event name must include only alphanumeric characters, `-`, `/`, `:` and `_`.",
          );
        if (!entry.rejected)
          mismatches.push("Actual native registration did not reject the invalid event");
        return response;
      }
      entry.event_id = await response.clone().json();
      if (
        !response.ok ||
        response.headers.get("Tauri-Response") !== "ok" ||
        !Number.isSafeInteger(entry.event_id)
      )
        mismatches.push("Actual event registration did not return an ID");
      if (entry.held) await gate;
      return response;
    }

    return original.call(this, input, request);
  };
  const handleUnlisten: typeof fetch = async function (this: unknown, input, request) {
    const body = decode(request);
    const entry = listeners.find((item) => item.event_id === body.eventId);
    if (entry) {
      entry.unlisten_count = (entry.unlisten_count ?? 0) + 1;
      if (body.event !== "portcove://operation" || entry.unlisten_count !== 1)
        mismatches.push("Unexpected owned unlisten identity/count");
      observeResponse(request, "unlisten");
    }
    const response = await original.call(this, input, request);
    if (entry) {
      entry.unlisten_response = {
        http_ok: response.ok,
        outcome: response.headers.get("Tauri-Response"),
        value: await response.clone().json(),
      };
      entry.unlistened =
        response.ok &&
        entry.unlisten_response.outcome === "ok" &&
        entry.unlisten_response.value === null;
      if (!entry.unlistened || present(entry))
        mismatches.push("Owned unlisten did not remove its callback");
    }
    return response;
  };
  const wrapper: typeof fetch = async function (this: unknown, input, request) {
    if (typeof input === "string" && privileged.includes(input)) privilegedRequests++;
    if (mode === "reject" && input === workspace && manualRefresh && !manualRefresh.received) {
      manualRefresh.received = true;
      manualRefresh.generation = decode(request).generation;
      observeResponse(request, "workspace-refresh");
      const response = await original.call(this, input, request);
      manualRefresh.value = await response.clone().json();
      manualRefresh.accepted = response.ok && response.headers.get("Tauri-Response") === "ok";
      await gate;
      return response;
    }
    if (input === select) return handleSelection.call(this, input, request);
    if (input === listen) return handleListen.call(this, input, request);
    if (input === unlisten) return handleUnlisten.call(this, input, request);
    return original.call(this, input, request);
  };
  window.fetch = wrapper;
  const releaseResponse = () => {
    released = true;
    release();
  };
  const trustworthyRestoration = (ownsFetch: boolean) => {
    const retired = listeners[0];
    const successor = listeners[1];
    return (
      ownsFetch &&
      mismatches.length === 0 &&
      listeners.length === 2 &&
      retired !== undefined &&
      retiredListenerReleased(retired) &&
      !present(retired) &&
      successor !== undefined &&
      present(successor) &&
      (mode === "late" || (manualRefresh?.accepted === true && released)) &&
      responses.length === 3 &&
      responses.every(
        (entry, index) =>
          responseSettled(entry) &&
          entry.outcome === (mode === "reject" && index === 0 ? "error" : "ok"),
      )
    );
  };
  const retiredListenerReleased = (entry: ListenerEntry) =>
    mode === "late"
      ? entry.unlistened === true && entry.unlisten_count === 1
      : entry.rejected === true && entry.event_id === null && !entry.unlisten_count;
  const probe: ListenerProbe = {
    capture: snapshot,
    release: releaseResponse,
    armRefresh() {
      if (mode !== "reject" || manualRefresh)
        throw new Error("Manual refresh control already armed or unavailable");
      manualRefresh = { received: false, generation: null, accepted: false, value: null };
    },
    restore() {
      restored ??= (async () => {
        releaseResponse();
        const deadline = Date.now() + 5_000;
        while (
          Date.now() < deadline &&
          (!(mode === "late"
            ? listeners[0]?.unlistened
            : listeners[0]?.rejected && !present(listeners[0])) ||
            !responses.every(responseSettled))
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        const ownsFetch = window.fetch === wrapper;
        if (ownsFetch) window.fetch = original;
        const report = snapshot();
        return {
          ...report,
          restored: ownsFetch,
          trustworthy: trustworthyRestoration(ownsFetch),
        };
      })();
      return restored;
    },
  };
  Reflect.set(window, key, probe);
}
