import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { parseAst } from "vite-plus";
import type { WebDriver } from "selenium-webdriver";
import { captureStartupDiagnostics } from "./desktop-startup-diagnostics.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";

test("startup failure retains bounded document evidence when browser logs are unsupported", async () => {
  const root = {
    childElementCount: 0,
    textContent: "x".repeat(9000),
    outerHTML: "h".repeat(70000),
  };
  const browser = {
    getCurrentUrl: async () => "tauri://localhost",
    executeScript: async (script: () => unknown) =>
      vm.runInNewContext(`(${script.toString()})()`, {
        document: {
          URL: "tauri://localhost",
          readyState: "complete",
          title: "Portcove",
          getElementById: () => root,
          documentElement: root,
          scripts: [],
          querySelectorAll: () => [],
        },
        performance: {
          getEntriesByType: (type: string) =>
            type === "resource"
              ? Array.from({ length: 120 }, () => ({
                  name: "app.js",
                  initiatorType: "script",
                  startTime: 1,
                  duration: 2,
                  responseEnd: 3,
                  transferSize: 4,
                }))
              : [{ name: "tauri://localhost", startTime: 0, duration: 5 }],
        },
      }) as unknown,
    manage: () => ({ logs: () => ({ getAvailableLogTypes: async () => [] }) }),
    getWindowHandle: () => assert.fail("Default capture must not observe targets"),
    getAllWindowHandles: () => assert.fail("Default capture must not enumerate targets"),
    getCapabilities: () => assert.fail("Default capture must not read capabilities"),
  } as unknown as WebDriver;
  const report = await captureStartupDiagnostics(browser);
  const document = report.document as {
    root_text: string;
    html: string;
    resources: unknown[];
    root_children: number;
  };
  assert.equal(document.root_children, 0);
  assert.equal(document.root_text.length, 8192);
  assert.equal(document.html.length, 65536);
  assert.equal(document.resources.length, 100);
  assert.equal(report.browser_logs_unavailable, true);
  assert.equal(Object.hasOwn(report, "startup_targets"), false);
});

test("unavailable window and failed logs retain independent diagnostic errors", async () => {
  const fail = async () => {
    throw new Error("window closed");
  };
  const browser = {
    getCurrentUrl: fail,
    executeScript: fail,
    manage: () => ({ logs: () => ({ getAvailableLogTypes: fail }) }),
  } as unknown as WebDriver;
  const report = await captureStartupDiagnostics(browser);
  assert.equal(report.url_error, "window closed");
  assert.equal(report.document_error, "window closed");
  assert.equal(report.browser_logs_error, "window closed");
});

test("optional initial startup observation bounds targets and driver logs without switching or exposing capabilities", async () => {
  const original = "h".repeat(300);
  const capabilityReads: string[] = [];
  const logReads: string[] = [];
  const capabilities = new Map<string, unknown>([
    ["browserName", "webview2"],
    ["browserVersion", "v".repeat(300)],
    ["platformName", "windows"],
    ["msedge", { msedgedriverVersion: "d".repeat(300), userDataDir: "private-profile" }],
    ["ms:edgeOptions", { debuggerAddress: "127.0.0.1:9222", args: ["private-argument"] }],
    ["proxy", { password: "private-password" }],
  ]);
  const browser = {
    getCurrentUrl: async () => "about:blank",
    executeScript: async () => ({ root_children: null }),
    getWindowHandle: async () => original,
    getAllWindowHandles: async () => [original, "other", "third", "fourth", "fifth"],
    getCapabilities: async () => ({
      get: (key: string) => {
        capabilityReads.push(key);
        return capabilities.get(key);
      },
    }),
    get switchTo(): never {
      return assert.fail("Uncancellable context switches are forbidden in failure capture");
    },
    get navigate(): never {
      return assert.fail("Failure capture must not navigate or refresh");
    },
    manage: () => ({
      logs: () => ({
        getAvailableLogTypes: async () => ["browser", "driver"],
        get: async (type: string) => {
          logReads.push(type);
          return Array.from({ length: type === "driver" ? 45 : 1 }, (_, index) => ({
            level: { name: type === "driver" && index === 0 ? "private-driver-level" : "INFO" },
            timestamp: 42,
            message:
              type === "driver"
                ? `${index === 0 ? "COMMAND InitSession" : "unclassified"} private-driver-profile private-driver-argument private-driver-password ${"m".repeat(5000)}`
                : "m".repeat(5000),
          }));
        },
      }),
    }),
  } as unknown as WebDriver;
  const report = await captureStartupDiagnostics(browser, { observeStartupTargets: true });
  const targets = report.startup_targets as {
    current_handle: string;
    current_handle_truncated: boolean;
    handle_count: number;
    handles_truncated: boolean;
    handles: { handle: string; selected: boolean; url: string | null; url_observation: string }[];
    capabilities: Record<string, string>;
    driver_log_count: number;
    driver_logs_truncated: boolean;
    driver_logs: {
      level: string;
      message_length: number;
      timestamp: number;
      category: string;
      protocol_method: string;
      payload: string;
    }[];
    context_switching: string;
    restoration: string;
  };
  assert.equal(targets.current_handle.length, 256);
  assert.equal(targets.current_handle_truncated, true);
  assert.equal(targets.handle_count, 5);
  assert.equal(targets.handles_truncated, true);
  assert.equal(targets.handles.length, 4);
  assert.equal(targets.handles[0]?.selected, true);
  assert.equal(targets.handles[0]?.url, "about:blank");
  assert.equal(targets.handles[1]?.url, null);
  assert.equal(targets.handles[1]?.url_observation, "unavailable-without-context-switch");
  assert.equal(targets.context_switching, "not-attempted-no-cancellable-switch");
  assert.equal(targets.restoration, "not-needed-no-context-switch");
  assert.deepEqual(Object.keys(targets.capabilities).sort(), [
    "browserName",
    "browserVersion",
    "debuggerAddress",
    "driverVersion",
    "platformName",
  ]);
  assert.equal(targets.capabilities.browserVersion?.length, 256);
  assert.equal(targets.capabilities.driverVersion?.length, 256);
  assert.equal(targets.capabilities.debuggerAddress, "127.0.0.1:9222");
  assert.deepEqual(capabilityReads, [
    "browserName",
    "browserVersion",
    "platformName",
    "driverVersion",
    "msedge",
    "ms:edgeOptions",
  ]);
  assert.ok(!JSON.stringify(report).includes("private-"));
  assert.equal(targets.driver_log_count, 45);
  assert.equal(targets.driver_logs_truncated, true);
  assert.equal(targets.driver_logs.length, 40);
  assert.equal(targets.driver_logs[0]?.level, "unclassified");
  assert.ok((targets.driver_logs[0]?.message_length ?? 0) > 5000);
  assert.equal(targets.driver_logs[0]?.category, "webdriver-command");
  assert.equal(targets.driver_logs[0]?.protocol_method, "init-session");
  assert.equal(targets.driver_logs[0]?.payload, "omitted");
  assert.equal(targets.driver_logs[1]?.category, "unclassified");
  assert.equal(targets.driver_logs[1]?.level, "INFO");
  assert.equal(Object.hasOwn(targets.driver_logs[0] ?? {}, "message"), false);
  assert.equal(targets.driver_logs[0]?.timestamp, 42);
  assert.deepEqual(logReads, ["driver", "browser"]);
  assert.equal((report.browser_logs as { message: string }[])[0]?.message.length, 4096);
});

test("optional startup reads retain independent partial errors and reject nonloopback debugger addresses", async () => {
  for (const address of [
    "example.com:9222",
    "user:secret@localhost:9222",
    "127.0.0.1:65536",
    "localhost:0",
    "private-options-error",
  ]) {
    const browser = {
      getCurrentUrl: async () => "about:blank",
      executeScript: async () => ({ root_children: null }),
      getWindowHandle: async () => {
        throw new Error("private-current-handle-error");
      },
      getAllWindowHandles: async () => ["other"],
      getCapabilities: async () => ({
        get: (key: string) => {
          if (key === "browserVersion") throw new Error("private-capability-error");
          if (key === "msedge") throw new Error("private-vendor-profile-error");
          if (key === "browserName") return "webview2";
          if (key === "ms:edgeOptions") {
            if (address === "private-options-error") throw new Error("private-options-error");
            return { debuggerAddress: address };
          }
          return undefined;
        },
      }),
      manage: () => ({
        logs: () => ({
          getAvailableLogTypes: async () => ["browser", "driver"],
          get: async (type: string) => {
            if (type === "driver") throw new Error("private-driver-log-error");
            return [];
          },
        }),
      }),
    } as unknown as WebDriver;
    const report = await captureStartupDiagnostics(browser, { observeStartupTargets: true });
    const targets = report.startup_targets as {
      current_handle_error: string;
      handles: { url: string | null }[];
      capabilities: Record<string, string>;
      capability_errors: Record<string, string>;
      driver_logs_error: string;
    };
    assert.equal(targets.current_handle_error, "read-failed");
    assert.equal(targets.handles[0]?.url, null);
    assert.equal(targets.capabilities.browserName, "webview2");
    assert.equal(targets.capabilities.debuggerAddress, undefined);
    assert.equal(targets.capability_errors.browserVersion, "read-failed");
    assert.equal(targets.capability_errors.driverVersion, "read-failed");
    if (address === "private-options-error")
      assert.equal(targets.capability_errors.debuggerAddress, "read-failed");
    assert.equal(targets.driver_logs_error, "read-failed");
    assert.ok(!JSON.stringify(targets).includes("private-"));
    assert.deepEqual(report.browser_logs, []);
  }
});

test("new selected target URLs retain only known origins and omit credentials, paths, query and fragment", async () => {
  for (const [url, expected, classification] of [
    [
      "http://private-user:private-password@tauri.localhost/private-path?token=private-query#private-fragment",
      "http://tauri.localhost",
      "application-origin",
    ],
    [
      "https://tauri.localhost/private-path?token=private-query#private-fragment",
      "https://tauri.localhost",
      "application-origin",
    ],
    [
      "tauri://localhost/private-path?token=private-query#private-fragment",
      "tauri://localhost",
      "application-origin",
    ],
    [
      "http://private-user:private-password@localhost:1420/private-path?token=private-query#private-fragment",
      "http://localhost:1420",
      "development-origin",
    ],
    ["about:blank?private-query#private-fragment", "about:blank", "blank"],
    [
      "https://private-host.invalid/private-path?token=private-query#private-fragment",
      null,
      "other-origin",
    ],
    ["file:///C:/private-player-path/save?private-query#private-fragment", null, "other-origin"],
    ["private-invalid-url", null, "invalid"],
  ] as const) {
    const browser = {
      getCurrentUrl: async () => url,
      executeScript: async () => ({ root_children: null }),
      getWindowHandle: async () => "current",
      getAllWindowHandles: async () => ["current", "other"],
      manage: () => ({}),
    } as unknown as WebDriver;
    const report = await captureStartupDiagnostics(browser, { observeStartupTargets: true });
    const targets = report.startup_targets as {
      handles: { url: string | null; url_classification: string }[];
    };
    assert.equal(targets.handles[0]?.url, expected);
    assert.equal(targets.handles[0]?.url_classification, classification);
    assert.equal(targets.handles[1]?.url, null);
    assert.ok(!JSON.stringify(targets).includes("private-"));
    assert.equal(report.url, url, "Legacy URL observation is unchanged");
  }
});

test("new target collection errors never retain provider text from handles, capability queries or log types", async () => {
  const fail = async () => {
    throw new Error("private-profile private-argument private-password");
  };
  const browser = {
    getCurrentUrl: async () => "about:blank",
    executeScript: async () => ({ root_children: null }),
    getWindowHandle: fail,
    getAllWindowHandles: fail,
    getCapabilities: fail,
    manage: () => ({ logs: () => ({ getAvailableLogTypes: fail }) }),
  } as unknown as WebDriver;
  const report = await captureStartupDiagnostics(browser, { observeStartupTargets: true });
  const targets = report.startup_targets as Record<string, unknown>;
  for (const key of [
    "current_handle_error",
    "handles_error",
    "capabilities_error",
    "driver_logs_error",
  ])
    assert.equal(targets[key], "read-failed");
  assert.ok(!JSON.stringify(targets).includes("private-"));
  assert.equal(
    report.browser_logs_error,
    "private-profile private-argument private-password",
    "Legacy browser-log errors are unchanged",
  );
});

test("optional startup observation is best effort for unsupported inspector methods", async () => {
  const browser = {
    getCurrentUrl: async () => "about:blank",
    executeScript: async () => ({ root_children: null }),
    manage: () => ({}),
  } as unknown as WebDriver;
  const report = await captureStartupDiagnostics(browser, { observeStartupTargets: true });
  const targets = report.startup_targets as Record<string, unknown>;
  for (const field of [
    "current_handle_unavailable",
    "handles_unavailable",
    "capabilities_unavailable",
    "driver_logs_unavailable",
  ])
    assert.equal(targets[field], true);
  assert.equal(targets.restoration, "not-needed-no-context-switch");
  assert.equal(report.browser_logs_unavailable, true);
  assert.equal(report.url, "about:blank");
});

test("the actual harness enables startup targets only for its initial exact A1 failure", () => {
  const source = stripTypeScriptTypes(
    readFileSync(new URL("./desktop-test.mts", import.meta.url), "utf8"),
    { mode: "strip" },
  );
  function* nodes(value: unknown): Generator<Record<string, unknown>> {
    if (Array.isArray(value)) {
      for (const child of value) yield* nodes(child);
    } else if (isRecord(value)) {
      if (typeof value.type === "string") yield value;
      for (const child of Object.values(value)) yield* nodes(child);
    }
  }
  const calls = [...nodes(parseAst(source))].filter(
    (node) =>
      node.type === "CallExpression" &&
      isRecord(node.callee) &&
      node.callee.name === "captureStartupDiagnostics",
  );
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call && Array.isArray(call.arguments));
  const options: unknown = call.arguments[1];
  assert.ok(isRecord(options) && Array.isArray(options.properties));
  const option: unknown = options.properties.find(
    (node) => isRecord(node) && isRecord(node.key) && node.key.name === "observeStartupTargets",
  );
  assert.ok(isRecord(option) && isRecord(option.value));
  assert.ok(typeof option.value.start === "number" && typeof option.value.end === "number");
  const expression = source.slice(option.value.start, option.value.end);
  const evaluate = (selected_scenarios: string[], connectedLaunches: number): unknown =>
    vm.runInNewContext(`(${expression})`, { selection: { selected_scenarios }, connectedLaunches });
  const id = "native-game-first-choice-and-restart";
  assert.equal(evaluate([id], 0), true);
  assert.equal(evaluate([id], 1), false);
  assert.equal(evaluate([id, "empty-library"], 0), false);
  assert.equal(evaluate(["native-reviewed-existing-install-copy"], 0), false);
  assert.equal(evaluate([], 0), false);
});
