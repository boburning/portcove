import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By } from "selenium-webdriver";

/** Native layout/input observations with an injected pad, not physical-controller evidence. */
export async function controllerScenario({
  browser,
  scenario,
  output,
  artifacts,
}) {
  await scenario("native-controller-large-list", async () => {
    // A newly restarted window may be behind the host. Establish native input
    // focus with an ordinary navigation click before injecting the pad fixture.
    await browser
      .findElement(By.css('nav[aria-label="Primary navigation"] button'))
      .click();
    const result = await browser.executeAsyncScript(async (done) => {
      const physical = Array.from(navigator.getGamepads())
        .filter(Boolean)
        .map((pad) => ({ id: pad.id, mapping: pad.mapping }));
      const previousPads = navigator.getGamepads;
      const previousFocus = document.activeElement;
      const previousMode = document.documentElement.dataset.inputMode;
      const methods = ["getClientRects", "getBoundingClientRect"];
      const originals = Object.fromEntries(
        methods.map((name) => [name, HTMLElement.prototype[name]]),
      );
      const dialog = document.createElement("section");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.style.cssText =
        "position:fixed;inset:0;z-index:99999;overflow:auto;background:white;display:grid;grid-template-columns:1fr 1fr";
      let presses = 0;
      for (let index = 0; index < 1000; index++) {
        const button = document.createElement("button");
        button.textContent = `Owned navigation fixture ${index}`;
        button.style.cssText = "height:40px;min-height:40px";
        button.onclick = () => {
          presses++;
        };
        dialog.append(button);
      }
      let pressed = [];
      let counts;
      let durations = [];
      const reset = () => {
        counts = { getClientRects: 0, getBoundingClientRect: 0 };
        durations = [];
      };
      const frames = async (count) => {
        for (let index = 0; index < count; index++)
          await new Promise(requestAnimationFrame);
      };
      const samples = [];
      let report;
      try {
        document.body.append(dialog);
        dialog.firstElementChild.focus();
        reset();
        navigator.getGamepads = () => {
          const start = performance.now();
          queueMicrotask(() => durations.push(performance.now() - start));
          return [
            {
              index: 0,
              id: "Owned injected navigation fixture",
              axes: [0, 0],
              buttons: Array.from({ length: 16 }, (_, index) => ({
                pressed: pressed.includes(index),
              })),
            },
          ];
        };
        for (const name of methods)
          HTMLElement.prototype[name] = function (...args) {
            counts[name]++;
            return originals[name].apply(this, args);
          };
        const observe = async (phase, count) => {
          reset();
          await frames(count);
          samples.push({
            phase,
            ...counts,
            presses,
            poll_milliseconds: [...durations],
          });
        };
        await frames(2);
        await observe("idle", 30);
        pressed = [0];
        await observe("activate", 1);
        await observe("held-activate", 12);
        pressed = [];
        await frames(1);
        pressed = [13];
        await observe("direction", 1);
        report = {
          method: "native injected-controller layout profile",
          control_count: 1000,
          physical_devices_exposed: physical,
          focused: document.hasFocus(),
          samples,
        };
      } catch (error) {
        report = { error: String(error) };
      } finally {
        for (const name of methods)
          HTMLElement.prototype[name] = originals[name];
        navigator.getGamepads = previousPads;
        dialog.remove();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
          previousFocus.focus();
        if (previousMode === undefined)
          delete document.documentElement.dataset.inputMode;
        else document.documentElement.dataset.inputMode = previousMode;
      }
      done(report);
    });
    const report = path.join(output, "controller-layout-profile.json");
    await writeFile(report, JSON.stringify(result, null, 2), { flag: "wx" });
    artifacts.push(report);
    assert.equal(result.error, undefined);
    assert.equal(result.focused, true);
    const [idle, activate, held, direction] = result.samples;
    for (const sample of [idle, held]) {
      assert.equal(sample.getClientRects, 0);
      assert.equal(sample.getBoundingClientRect, 0);
    }
    assert.equal(activate.presses, 1);
    assert.equal(held.presses, 1);
    assert.ok(
      activate.getClientRects <= 2,
      "Activation measures only the top modal and focused control",
    );
    assert.equal(activate.getBoundingClientRect, 0);
    assert.ok(direction.getClientRects <= 1001);
    assert.equal(direction.getBoundingClientRect, 1000);
  });
}
