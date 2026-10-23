import type { WebDriver } from "selenium-webdriver";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { executeBrowserScript } from "./browser-script.mts";

interface ViewportObservation {
  width: number;
  height: number;
  client: number;
  scroll: number;
  zoom: string | null;
  dpr: number;
  theme: string | undefined;
  userAgent: string;
  focus: string | undefined;
}
interface WindowRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface CaptureOptions {
  output: string;
  prefix: "selected-setup" | "source-removal";
  stage: string;
  baselineWidth: number;
}

export function requireNativeEnlargement(
  observed: ViewportObservation,
  nativeWindow: WindowRectangle,
  baselineWidth: number,
  stage: string,
) {
  assert.equal(nativeWindow.width, 960);
  assert.equal(nativeWindow.height, 640);
  assert.equal(observed.zoom, "400", `Enlargement lost at ${stage}`);
  assert.ok(
    Math.abs(observed.width - baselineWidth / 4) <= 2,
    `Native zoom ratio changed at ${stage}`,
  );
  assert.ok(observed.width <= 240, `Native effective width changed at ${stage}`);
  assert.ok(observed.scroll <= observed.client + 1, `Horizontal overflow at ${stage}`);
}

/** Observation and write-once retention only. Callers own zoom, baseline,
 * window restoration, stage selection and their artifact inventories. */
export async function captureNativeEnlargement(
  browser: Pick<WebDriver, "executeScript" | "manage">,
  options: CaptureOptions,
) {
  const observed = await executeBrowserScript(browser, () => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    client: globalThis.document.documentElement.clientWidth,
    scroll: globalThis.document.documentElement.scrollWidth,
    zoom: globalThis.localStorage.getItem("portcove.appearance.interface-size"),
    dpr: globalThis.devicePixelRatio,
    theme: globalThis.document.documentElement.dataset.theme,
    userAgent: globalThis.navigator.userAgent,
    focus: globalThis.document.activeElement?.textContent?.trim(),
  }));
  const nativeWindow = await browser.manage().window().getRect();
  return retainNativeEnlargement(observed, nativeWindow, options);
}

export async function retainNativeEnlargement(
  observed: ViewportObservation,
  nativeWindow: WindowRectangle,
  options: CaptureOptions,
) {
  const { output, prefix, stage, baselineWidth } = options;
  requireNativeEnlargement(observed, nativeWindow, baselineWidth, stage);
  const file = path.join(output, `${prefix}-400-${stage}.json`);
  await writeFile(file, JSON.stringify({ ...observed, nativeWindow, baselineWidth }, null, 2), {
    flag: "wx",
  });
  return file;
}
