import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, lstat } from "node:fs/promises";
import type { WebDriver, WebElement } from "selenium-webdriver";
import { executeBrowserScript } from "./browser-script.mts";
import { observeVisibleTarget } from "./browser-readiness.mts";
import { errorMessage } from "../../../scripts/runtime-values.mts";
import { captureSettledVisual } from "../../../scripts/native-readiness.mts";
import { prepareCaptureTarget, requireUnchangedCaptureTarget } from "../test/capture-target.ts";

export async function captureKeyboardTarget(
  context: {
    browser: Pick<WebDriver, "executeScript" | "takeScreenshot">;
    output: string;
    artifacts: string[];
  },
  name: string,
  element: WebElement,
  scenarioId = "keyboard-layout",
) {
  const { browser: session, output, artifacts } = context;
  assert.match(name, /^[a-z0-9-]+$/u);
  const label = `native-${name}`;
  const target = `[data-capture-target="${label}"]`;
  const previous = await executeBrowserScript(
    session,
    (target, label) => {
      const previous = target.getAttribute("data-capture-target");
      target.setAttribute("data-capture-target", label);
      return previous;
    },
    element,
    label,
  );
  let lastObservation: ReturnType<typeof observeVisibleTarget> | undefined;
  let preflightComplete = false;
  try {
    const metadata = await prepareCaptureTarget({
      target,
      label,
      scroll: () =>
        executeBrowserScript(
          session,
          (element) =>
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
          element,
        ),
      observe: async () => {
        lastObservation = await executeBrowserScript(
          session,
          observeVisibleTarget,
          target,
          "visual" as const,
        );
        return lastObservation;
      },
    });
    preflightComplete = true;
    const capture = await captureSettledVisual({
      browser: session,
      output,
      name,
      scenario: scenarioId,
      target,
      observeTarget: async () => {
        const state = await executeBrowserScript(
          session,
          observeVisibleTarget,
          target,
          "visual" as const,
        );
        requireUnchangedCaptureTarget(metadata.observation, state);
        return { ...state, capture_target_preflight: metadata };
      },
      readiness: async () => ({ ready: true }),
    });
    artifacts.push(capture.image.path, capture.receipt);
  } catch (error) {
    if (!preflightComplete) {
      try {
        const body = `${JSON.stringify({
          format_version: 1,
          outcome: "failed",
          scenario: scenarioId,
          target,
          label,
          message: errorMessage(error),
          preflight_complete: preflightComplete,
          preflight_observation: lastObservation ?? null,
          acceptance: false,
        })}\n`;
        if (new TextEncoder().encode(body).byteLength > 16 * 1024)
          throw new Error("Capture failure metadata exceeds16KiB");
        await writeFile(path.join(output, `${name}-capture-failure.json`), body, { flag: "wx" });
      } catch {
        /* Preserve the original failure and any existing settled-capture receipt. */
      }
    }
    for (const suffix of [".png", "-capture-failure.json"]) {
      const file = path.join(output, name + suffix);
      try {
        if ((await lstat(file)).isFile()) artifacts.push(file);
      } catch {
        /* no capture file was written */
      }
    }
    throw error;
  } finally {
    await executeBrowserScript(
      session,
      (element, previous) => {
        if (previous === null) element.removeAttribute("data-capture-target");
        else element.setAttribute("data-capture-target", previous);
      },
      element,
      previous,
    ).catch(() => {
      /* Preserve an original capture/route failure. */
    });
  }
}
