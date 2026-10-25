import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertDesignCompatibility } from "./desktop-design-compatibility-assertions.mts";

void test("design assertions execute erased serialized callbacks and refuse missing required controls", async () => {
  for (const mode of ["ordinary", "embedded", "missing-root", "missing-select"]) {
    let theme = "dark",
      direction = "ltr",
      dialog = false,
      select = false,
      reduced = false;
    let omitted: string | undefined;
    let serialized = 0;
    let observingStyle = false;
    const clicks: string[] = [];
    class HTMLElement {
      isConnected = true;
      readonly id: string;
      constructor(id: string) {
        this.id = id;
      }
      get dataset() {
        return {
          theme,
          direction,
          dialogOpen: String(dialog),
          selectOpen: String(select),
          reducedMotion: String(reduced),
        };
      }
      getAttribute(name: string) {
        const attributes: Readonly<Record<string, string>> = {
          "data-theme": theme,
          "data-direction": direction,
          "data-dialog-open": String(dialog),
          "data-select-open": String(select),
          "data-reduced-motion": String(reduced),
        };
        return attributes[name] ?? null;
      }
      closest() {
        return null;
      }
      getBoundingClientRect() {
        return { left: 400, width: 200 };
      }
    }
    class HTMLImageElement extends HTMLElement {
      complete = true;
      naturalWidth = 10;
    }
    const root = new HTMLElement("root"),
      trigger = new HTMLElement("fixture-open-dialog"),
      channel = new HTMLElement("fixture-channel"),
      selectedOption = new HTMLElement("selected-option");
    const document = {
      readyState: "complete",
      activeElement: trigger,
      documentElement: { style: { getPropertyValue: () => theme }, getAttribute: () => direction },
      querySelector(selector: string) {
        if (selector === omitted && observingStyle) return null;
        if (selector === ".design-compatibility-fixture") return root;
        if (selector === "[data-offline-asset]") return new HTMLImageElement("asset");
        return new HTMLElement(selector);
      },
      querySelectorAll: () => (dialog ? [new HTMLElement("dialog")] : []),
    };
    function keyboard(key: string) {
      if (key === "ESCAPE") {
        if (select) {
          select = false;
          document.activeElement = channel;
        } else {
          dialog = false;
          document.activeElement = trigger;
        }
      } else {
        select = true;
        document.activeElement = selectedOption;
        if (mode === "missing-select") omitted = '[data-slot="select-content"]';
      }
    }
    const browser = {
      async executeScript(script: (...args: unknown[]) => unknown, ...args: unknown[]) {
        serialized++;
        observingStyle = script.toString().includes("getComputedStyle");
        const result: unknown = runInNewContext(`(${script.toString()})(...args)`, {
          args,
          document,
          HTMLElement,
          HTMLImageElement,
          location: { href: "tauri://localhost" },
          navigator: {
            platform: "fixture",
            userAgent: "fixture",
            userAgentData: { architecture: "x64" },
          },
          window: { innerWidth: 1000, matchMedia: () => ({ matches: false }) },
          CSS: { supports: () => true },
          performance: { getEntriesByType: () => [] },
          URL,
          getComputedStyle: () => ({
            backgroundColor: theme,
            opacity: theme === "dark" ? "0.5" : "1",
            direction,
            transitionDuration: reduced ? "0s" : "1s",
          }),
        });
        // WebDriver transports JSON values back into the caller's realm.
        return result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as unknown);
      },
      async wait(condition: unknown) {
        if (typeof condition === "function")
          assert.equal(await Reflect.apply(condition, undefined, []), true);
      },
      findElement(locator: { selector: string }) {
        return {
          getId: async () => "owned-fixture",
          getAttribute: async (name: string) => root.getAttribute(name),
          sendKeys: async (key: string) => {
            if (locator.selector === "fixture-channel") {
              // Base UI dismisses an aligned popup when element keys refocus its trigger.
              if (select && document.activeElement !== channel) select = false;
              document.activeElement = channel;
            }
            keyboard(key);
          },
          click: async () => {
            clicks.push(locator.selector);
            if (locator.selector === "fixture-theme-light") {
              theme = "light";
              if (mode === "missing-root") omitted = ".design-compatibility-fixture";
            } else if (locator.selector === "fixture-theme-dark") theme = "dark";
            else if (locator.selector === "fixture-direction") direction = "rtl";
            else if (locator.selector === "fixture-open-dialog") dialog = true;
            else if (locator.selector === "fixture-reduced-motion") reduced = true;
          },
        };
      },
      findElements: async () => (dialog ? [{}] : []),
      actions: () => ({ sendKeys: (key: string) => ({ perform: async () => keyboard(key) }) }),
    };
    const options = {
      browser,
      By: { css: (selector: string) => ({ selector }), id: (selector: string) => ({ selector }) },
      Key: { ESCAPE: "ESCAPE", ENTER: "ENTER", ARROW_DOWN: "ARROW_DOWN" },
      until: { elementLocated: (locator: unknown) => locator },
      embeddedMacKeyboard: mode === "embedded",
    };
    if (mode.startsWith("missing-")) {
      await assert.rejects(async () => {
        await Reflect.apply(assertDesignCompatibility, undefined, [options]);
      }, /required design fixture element missing/u);
    } else {
      const result: unknown = await Reflect.apply(assertDesignCompatibility, undefined, [options]);
      assert.deepEqual(result, {
        architecture: "x64",
        platform: "fixture",
        reducedMotion: false,
        supportsColorMix: true,
        supportsOklch: true,
        userAgent: "fixture",
      });
      assert.ok(serialized >= 15);
      assert.equal(select, false);
      assert.equal(dialog, false);
      assert.equal(reduced, true);
      assert.equal(document.activeElement, trigger);
      assert.deepEqual(clicks, [
        "fixture-theme-light",
        "fixture-theme-dark",
        "fixture-theme-light",
        "fixture-direction",
        "fixture-open-dialog",
        "fixture-reduced-motion",
      ]);
    }
  }
});
