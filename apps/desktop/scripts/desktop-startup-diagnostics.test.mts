import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import vm from "node:vm";
import type { WebDriver } from "selenium-webdriver";
import { captureStartupDiagnostics } from "./desktop-startup-diagnostics.mts";

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
