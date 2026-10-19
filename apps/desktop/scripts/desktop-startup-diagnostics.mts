import type { WebDriver } from "selenium-webdriver";
import type { LinuxInspectorProtocol } from "./desktop-linux-webkit-inspector.mts";
import type { MainBoundaryBrowser } from "./desktop-main-webview-boundary.mts";
import { errorMessage } from "../../../scripts/runtime-values.mts";

/** Best-effort failure evidence; never turns a failed startup into a pass. */
export async function captureStartupDiagnostics(browser: WebDriver | LinuxInspectorProtocol) {
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
