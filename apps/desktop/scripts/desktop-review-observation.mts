import type { WebDriver } from "selenium-webdriver";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { executeBrowserScript } from "./browser-script.mts";

/** Observe one real interaction without changing its dispatch, assertions or deadline. */
export async function observeReviewSettlement(
  browser: WebDriver,
  selector: string,
  destination: string,
  artifacts: string[],
  interact: () => Promise<void>,
) {
  const key = `portcove-review-${randomUUID()}`;
  let installationFailure: string | undefined;
  try {
    await executeBrowserScript(
      browser,
      (key, selector) => {
        const records: unknown[] = [];
        let previous = "";
        let latest: unknown;
        let omitted = 0;
        const capture = (event?: Event) => {
          const dialog = document.querySelector(selector);
          const state = {
            connected: Boolean(dialog),
            text: dialog?.textContent?.slice(0, 3000),
            buttons: [...(dialog?.querySelectorAll("button") ?? [])].slice(0, 32).map((button) => ({
              label: button.textContent?.slice(0, 200),
              disabled: button.disabled,
              variant: button.getAttribute("data-variant"),
            })),
            failures: [...document.querySelectorAll(".error-banner")]
              .slice(0, 16)
              .map((element) => element.textContent?.slice(0, 3000)),
          };
          const serialized = JSON.stringify(state);
          latest = state;
          if (!event && serialized === previous) return;
          previous = serialized;
          if (records.length === 64) {
            omitted += 1;
            return;
          }
          records.push({
            milliseconds: performance.now(),
            event: event?.type ?? "state",
            trusted: event?.isTrusted,
            target:
              event?.target instanceof Element ? event.target.textContent?.slice(0, 200) : null,
            ...state,
          });
        };
        const click = (event: Event) => {
          if (event.target instanceof Element && event.target.closest(selector)) capture(event);
        };
        const observer = new MutationObserver(() => capture());
        Reflect.set(window, key, () => {
          observer.disconnect();
          document.removeEventListener("click", click, true);
          capture();
          return { available: true, records, omitted, latest };
        });
        document.addEventListener("click", click, true);
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
        capture();
      },
      key,
      selector,
    );
  } catch (error) {
    installationFailure = String(error).slice(0, 3000);
    console.error(`Could not start review settlement observations: ${installationFailure}`);
  }
  try {
    await interact();
  } finally {
    try {
      const observation = await executeBrowserScript(
        browser,
        (key) => {
          const finish: unknown = Reflect.get(window, key);
          if (typeof finish !== "function") return { available: false };
          Reflect.deleteProperty(window, key);
          const observed: unknown = Reflect.apply(finish, undefined, []);
          return observed;
        },
        key,
      );
      await writeFile(destination, JSON.stringify({ installationFailure, observation }, null, 2), {
        flag: "wx",
      });
      artifacts.push(destination);
    } catch (error) {
      // A vanished window or unavailable diagnostics cannot replace the original outcome.
      console.error(`Could not retain review settlement observations: ${String(error)}`);
    }
  }
}
