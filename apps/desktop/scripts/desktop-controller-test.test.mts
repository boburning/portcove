import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { it } from "vite-plus/test";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { observeInjectedController } from "./desktop-controller-test.mts";

for (const ownProperty of ["absent", "data", "accessor"] as const) {
  for (const fail of [false, true]) {
    it(`restores controller fixture ownership after ${fail ? "failure" : "success"}: ${ownProperty}`, async () => {
      let removed = false;
      let restoredFocus = 0;
      class FixtureBase {
        getClientRects() {
          return [];
        }
        getBoundingClientRect() {
          return { width: 1, height: 1 };
        }
      }
      // The browser inherits these methods from Element.prototype. Restoring
      // only their values would leave shadow properties on HTMLElement.
      class FixtureElement extends FixtureBase {
        isConnected = true;
        firstElementChild: FixtureElement | null = null;
        style = { cssText: "" };
        textContent = "";
        onclick: (() => void) | null = null;
        setAttribute() {}
        append(element: FixtureElement) {
          this.firstElementChild ??= element;
        }
        focus() {
          restoredFocus++;
        }
        remove() {
          removed = true;
        }
      }
      // These are VM doubles, not a physical device or native UI observation.
      const navigator = { __proto__: { getGamepads: () => [] } };
      if (ownProperty === "data") {
        Object.defineProperty(navigator, "getGamepads", {
          value: () => [],
          configurable: true,
          enumerable: false,
          writable: false,
        });
      } else if (ownProperty === "accessor") {
        Object.defineProperty(navigator, "getGamepads", {
          get: () => () => [],
          configurable: true,
          enumerable: false,
        });
      }
      const originalPads = Object.getOwnPropertyDescriptor(navigator, "getGamepads");
      const originalRects = Object.getOwnPropertyDescriptor(
        FixtureElement.prototype,
        "getClientRects",
      );
      const originalBounds = Object.getOwnPropertyDescriptor(
        FixtureElement.prototype,
        "getBoundingClientRect",
      );
      const dataset = { inputMode: "keyboard" };
      const result = await new Promise<unknown>((resolve, reject) => {
        const operation: unknown = runInNewContext(
          `(${observeInjectedController.toString()})(done)`,
          {
            navigator,
            HTMLElement: FixtureElement,
            document: {
              activeElement: new FixtureElement(),
              documentElement: { dataset },
              body: new FixtureElement(),
              createElement: () => new FixtureElement(),
              hasFocus: () => true,
            },
            performance,
            queueMicrotask,
            requestAnimationFrame: (callback: (timestamp: number) => void) => {
              if (fail) throw new Error("owned frame failure");
              callback(0);
            },
            done: resolve,
          },
        );
        // A rejected probe must fail this test instead of leaving it pending.
        Promise.resolve(operation).catch(reject);
      });
      assert(isRecord(result));
      if (fail) assert.match(String(result.error), /owned frame failure/u);
      else assert.equal(result.focused, true);
      assert.deepEqual(Object.getOwnPropertyDescriptor(navigator, "getGamepads"), originalPads);
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(FixtureElement.prototype, "getClientRects"),
        originalRects,
      );
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(FixtureElement.prototype, "getBoundingClientRect"),
        originalBounds,
      );
      assert.equal(dataset.inputMode, "keyboard");
      assert.equal(removed, true);
      assert.equal(restoredFocus, 2);
    });
  }
}
