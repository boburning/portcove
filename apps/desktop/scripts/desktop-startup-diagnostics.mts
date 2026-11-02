import type { WebDriver } from "selenium-webdriver";
import type { LinuxInspectorProtocol } from "./desktop-linux-webkit-inspector.mts";
import type { MainBoundaryBrowser } from "./desktop-main-webview-boundary.mts";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";

function startupTargetUrl(value: unknown) {
  if (typeof value !== "string") return { url: null, url_classification: "unavailable" };
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "about:" && parsed.pathname === "blank")
      return { url: "about:blank", url_classification: "blank" };
    if (parsed.protocol === "tauri:" && parsed.hostname === "localhost" && !parsed.port)
      return { url: "tauri://localhost", url_classification: "application-origin" };
    if (parsed.hostname === "tauri.localhost" && !parsed.port) {
      if (parsed.protocol === "http:")
        return { url: "http://tauri.localhost", url_classification: "application-origin" };
      if (parsed.protocol === "https:")
        return { url: "https://tauri.localhost", url_classification: "application-origin" };
    }
    if (parsed.protocol === "http:" && parsed.hostname === "localhost" && parsed.port === "1420")
      return { url: "http://localhost:1420", url_classification: "development-origin" };
    return { url: null, url_classification: "other-origin" };
  } catch {
    return { url: null, url_classification: "invalid" };
  }
}

/** Initial owned-startup observation only. Never switches the selected target. */
async function captureStartupTargets(
  browser: WebDriver | LinuxInspectorProtocol,
  currentUrl: unknown,
) {
  const observation: Record<string, unknown> = {
    context_switching: "not-attempted-no-cancellable-switch",
    restoration: "not-needed-no-context-switch",
  };
  let currentHandle: string | undefined;
  try {
    if (!("getWindowHandle" in browser) || typeof browser.getWindowHandle !== "function")
      observation.current_handle_unavailable = true;
    else {
      const handle: unknown = await browser.getWindowHandle();
      if (typeof handle !== "string") throw new Error("Current window handle is not a string");
      currentHandle = handle;
      observation.current_handle = handle.slice(0, 256);
      observation.current_handle_truncated = handle.length > 256;
    }
  } catch {
    observation.current_handle_error = "read-failed";
  }
  try {
    if (!("getAllWindowHandles" in browser) || typeof browser.getAllWindowHandles !== "function")
      observation.handles_unavailable = true;
    else {
      const handles: unknown = await browser.getAllWindowHandles();
      if (!Array.isArray(handles)) throw new Error("Window handles are not an array");
      observation.handle_count = handles.length;
      observation.handles_truncated = handles.length > 4;
      observation.handles = handles.slice(0, 4).map((handle: unknown) => {
        if (typeof handle !== "string") return { invalid_handle: true };
        const selected = handle === currentHandle;
        return {
          handle: handle.slice(0, 256),
          handle_truncated: handle.length > 256,
          selected,
          ...(selected
            ? startupTargetUrl(currentUrl)
            : { url: null, url_classification: "unavailable" }),
          url_observation:
            selected && typeof currentUrl === "string"
              ? "selected-origin-only-components-omitted"
              : "unavailable-without-context-switch",
        };
      });
    }
  } catch {
    observation.handles_error = "read-failed";
  }
  try {
    if (!("getCapabilities" in browser) || typeof browser.getCapabilities !== "function")
      observation.capabilities_unavailable = true;
    else {
      const capabilities: unknown = await browser.getCapabilities();
      if (!isRecord(capabilities)) throw new Error("Capabilities are unavailable");
      const getter = capabilities.get;
      const get = (name: string): unknown =>
        typeof getter === "function"
          ? Reflect.apply(getter, capabilities, [name])
          : capabilities[name];
      const allowed: Record<string, string> = {};
      const errors: Record<string, string> = {};
      for (const name of ["browserName", "browserVersion", "platformName", "driverVersion"]) {
        try {
          const value = get(name);
          if (typeof value === "string") allowed[name] = value.slice(0, 256);
        } catch {
          errors[name] = "read-failed";
        }
      }
      try {
        // Edge returns additional private fields beside this version. Read only
        // the version rather than retaining the vendor capability object.
        const edge = get("msedge");
        if (
          !allowed.driverVersion &&
          isRecord(edge) &&
          typeof edge.msedgedriverVersion === "string"
        )
          allowed.driverVersion = edge.msedgedriverVersion.slice(0, 256);
      } catch {
        errors.driverVersion = "read-failed";
      }
      try {
        const options = get("ms:edgeOptions");
        const address = isRecord(options) ? options.debuggerAddress : undefined;
        const match =
          typeof address === "string" && address.length <= 128
            ? /^(?:localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/iu.exec(address)
            : null;
        if (match && Number(match[1]) <= 65535 && typeof address === "string")
          allowed.debuggerAddress = address;
      } catch {
        errors.debuggerAddress = "read-failed";
      }
      observation.capabilities = allowed;
      if (Object.keys(errors).length) observation.capability_errors = errors;
    }
  } catch {
    observation.capabilities_error = "read-failed";
  }
  try {
    const manager = browser.manage();
    if (!("logs" in manager)) observation.driver_logs_unavailable = true;
    else {
      const logs = manager.logs();
      if (!(await logs.getAvailableLogTypes()).includes("driver"))
        observation.driver_logs_unavailable = true;
      else {
        const entries = await logs.get("driver");
        observation.driver_log_count = entries.length;
        observation.driver_logs_truncated = entries.length > 40;
        observation.driver_logs = entries.slice(0, 40).map((entry) => {
          // Driver text can echo InitSession profiles, args and credentials.
          // Retain only closed protocol markers and numeric/closed metadata.
          const marker =
            /\b(COMMAND|RESPONSE)\s+(InitSession|GetWindowHandles|GetWindow|GetCapabilities|Navigate|ExecuteScript|GetLog)\b/u.exec(
              entry.message.slice(0, 2048),
            );
          const methods: Record<string, string> = {
            InitSession: "init-session",
            GetWindowHandles: "get-window-handles",
            GetWindow: "get-window",
            GetCapabilities: "get-capabilities",
            Navigate: "navigate",
            ExecuteScript: "execute-script",
            GetLog: "get-log",
          };
          return {
            level: ["ALL", "DEBUG", "INFO", "WARNING", "SEVERE", "OFF"].includes(entry.level.name)
              ? entry.level.name
              : "unclassified",
            timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : null,
            message_length: entry.message.length,
            category: marker
              ? marker[1] === "COMMAND"
                ? "webdriver-command"
                : "webdriver-response"
              : "unclassified",
            protocol_method: methods[marker?.[2] ?? ""] ?? "unclassified",
            payload: "omitted",
          };
        });
      }
    }
  } catch {
    observation.driver_logs_error = "read-failed";
  }
  return observation;
}

/** Best-effort failure evidence; never turns a failed startup into a pass. */
export async function captureStartupDiagnostics(
  browser: WebDriver | LinuxInspectorProtocol,
  { observeStartupTargets = false }: { observeStartupTargets?: boolean } = {},
) {
  const diagnostics: Record<string, unknown> = {};
  try {
    diagnostics.url = (await browser.getCurrentUrl()).slice(0, 8192);
  } catch (error) {
    diagnostics.url_error = errorMessage(error).slice(0, 4096);
  }
  try {
    const observer: MainBoundaryBrowser = browser;
    diagnostics.document = await observer.executeScript(() => {
      const root = document.getElementById("root");
      return {
        url: document.URL.slice(0, 8192),
        ready_state: document.readyState,
        title: document.title.slice(0, 4096),
        root_children: root?.childElementCount ?? null,
        root_text: root?.textContent?.slice(0, 8192) ?? null,
        html: (root ?? document.documentElement).outerHTML.slice(0, 65536),
        scripts: Array.from(document.scripts)
          .slice(0, 100)
          .map((script) => ({
            src: script.src.slice(0, 8192),
            type: script.type.slice(0, 256),
          })),
        stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
          .slice(0, 100)
          .map((element) => element.getAttribute("href")?.slice(0, 8192)),
        navigation: performance
          .getEntriesByType("navigation")
          .slice(0, 1)
          .map((entry) => ({
            name: entry.name.slice(0, 8192),
            start: entry.startTime,
            duration: entry.duration,
          })),
        resources: performance
          .getEntriesByType("resource")
          .slice(0, 100)
          .map((entry) => {
            const resource = entry as PerformanceResourceTiming;
            return {
              name: resource.name.slice(0, 8192),
              initiator: resource.initiatorType.slice(0, 256),
              start: resource.startTime,
              duration: resource.duration,
              response_end: resource.responseEnd,
              transfer_size: resource.transferSize,
            };
          }),
      };
    });
  } catch (error) {
    diagnostics.document_error = errorMessage(error).slice(0, 4096);
  }
  if (observeStartupTargets)
    diagnostics.startup_targets = await captureStartupTargets(browser, diagnostics.url);
  try {
    const manager = browser.manage();
    if (!("logs" in manager)) {
      diagnostics.browser_logs_unavailable = true;
      return diagnostics;
    }
    const logs = manager.logs();
    const types = await logs.getAvailableLogTypes();
    diagnostics.log_types = types.slice(0, 100).map((type) => type.slice(0, 256));
    if (types.includes("browser")) {
      diagnostics.browser_logs = (await logs.get("browser")).slice(0, 100).map((entry) => ({
        level: entry.level.name,
        timestamp: entry.timestamp,
        message: entry.message.slice(0, 4096),
      }));
    } else {
      diagnostics.browser_logs_unavailable = true;
    }
  } catch (error) {
    diagnostics.browser_logs_error = errorMessage(error).slice(0, 4096);
  }
  return diagnostics;
}
