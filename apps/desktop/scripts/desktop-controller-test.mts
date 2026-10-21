import type { ScenarioContext } from "./desktop-scenario-context.mts";
import type { MainBoundaryBrowser } from "./desktop-main-webview-boundary.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { observeGamepadCapability } from "./browser-readiness.mts";
import { capabilityRequirement } from "../../../scripts/native-readiness.mts";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { By, WebDriver } from "selenium-webdriver";

interface LayoutCounts {
  getClientRects: number;
  getBoundingClientRect: number;
}
interface ControllerSample extends LayoutCounts {
  fixture_controls: LayoutCounts;
  fixture_container: LayoutCounts;
  outside_fixture: LayoutCounts;
  phase: string;
  presses: number;
  poll_milliseconds: number[];
}
interface ControllerProfile {
  method: string;
  control_count: number;
  capability_scope: string;
  focused: boolean;
  samples: ControllerSample[];
}

/** Native layout/input observations with an injected pad, not physical-controller evidence. */
export async function controllerScenario({
  browser: transport,
  scenario,
  output,
  artifacts,
}: Omit<ScenarioContext, "browser"> & { browser: MainBoundaryBrowser }) {
  const raw = await transport.executeScript(observeGamepadCapability);
  assert.ok(isRecord(raw) && typeof raw.outcome === "string");
  const capability = { ...raw, outcome: raw.outcome };
  const capabilityFile = path.join(output, "controller-capability.json");
  await writeFile(
    capabilityFile,
    JSON.stringify(
      { ...capability, physical_observation: "not-qualified", injected_observation: "not-run" },
      null,
      2,
    ),
    { flag: "wx" },
  );
  artifacts.push(capabilityFile);
  await scenario("native-controller-api-fallback", async () => {
    const outcome = capabilityRequirement(capability, "declared-api-fallback");
    assert.equal(
      outcome.outcome,
      "passed",
      "Declared absence fallback requires absence/restriction; devices need their applicable scenario",
    );
  });
  await scenario("native-controller-large-list", async () => {
    const browser = transport;
    assert.ok(browser instanceof WebDriver, "Controller input requires its WebDriver transport");
    assert.ok(
      !["api-absent", "api-access-failed-or-restricted"].includes(capability.outcome),
      "Controller injection prerequisite unmet; absence is not controller functionality",
    );
    // A newly restarted window may be behind the host. Establish native input
    // focus with an ordinary navigation click before injecting the pad fixture.
    await browser.findElement(By.css('nav[aria-label="Primary navigation"] button')).click();
    const result: unknown = await browser.executeAsyncScript<unknown>(observeInjectedController);
    const report = path.join(output, "controller-layout-profile.json");
    const serialized = JSON.stringify(result, null, 2);
    if (serialized === undefined) throw new Error("Controller probe returned no JSON result");
    await writeFile(report, serialized, { flag: "wx" });
    artifacts.push(report);
    assert(isRecord(result));
    assert.equal(result.error, undefined);
    assert.equal(result.focused, true);
    assert(Array.isArray(result.samples));
    const samples = result.samples.map((sample: unknown) => {
      assert(
        isRecord(sample) &&
          typeof sample.getClientRects === "number" &&
          typeof sample.getBoundingClientRect === "number" &&
          typeof sample.presses === "number",
      );
      const scoped = {} as Record<
        "fixture_controls" | "fixture_container" | "outside_fixture",
        LayoutCounts
      >;
      for (const scope of ["fixture_controls", "fixture_container", "outside_fixture"] as const) {
        const counts = sample[scope];
        assert(isRecord(counts));
        assert.ok(
          Number.isSafeInteger(counts.getClientRects) && Number(counts.getClientRects) >= 0,
        );
        assert.ok(
          Number.isSafeInteger(counts.getBoundingClientRect) &&
            Number(counts.getBoundingClientRect) >= 0,
        );
        scoped[scope] = {
          getClientRects: Number(counts.getClientRects),
          getBoundingClientRect: Number(counts.getBoundingClientRect),
        };
      }
      for (const method of ["getClientRects", "getBoundingClientRect"] as const)
        assert.equal(
          sample[method],
          Object.values(scoped).reduce((sum, counts) => sum + counts[method], 0),
          "Every layout read must retain its receiver attribution",
        );
      return {
        getClientRects: sample.getClientRects,
        getBoundingClientRect: sample.getBoundingClientRect,
        presses: sample.presses,
        ...scoped,
      };
    });
    const [idle, activate, held, direction] = samples;
    assert(idle && activate && held && direction, "All four controller phases must be observed");
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
    assert.equal(direction.fixture_controls.getBoundingClientRect, result.control_count);
    assert.equal(result.control_count, 1000);
    assert.equal(direction.fixture_container.getBoundingClientRect, 0);
  });
}

export async function observeInjectedController(
  done: (value: ControllerProfile | { error: string }) => void,
) {
  const previousPads = Object.getOwnPropertyDescriptor(navigator, "getGamepads");
  const previousFocus = document.activeElement;
  const previousMode = document.documentElement.dataset.inputMode;
  // Retain methods with their receiver contract; wrappers call them on the
  // original element and cleanup restores exactly these functions.
  const snapshotLayoutMethod = <Key extends keyof LayoutCounts>(name: Key): HTMLElement[Key] =>
    HTMLElement.prototype[name];
  const originals = {
    getClientRects: snapshotLayoutMethod("getClientRects"),
    getBoundingClientRect: snapshotLayoutMethod("getBoundingClientRect"),
  };
  const originalLayoutDescriptors = {
    getClientRects: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getClientRects"),
    getBoundingClientRect: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "getBoundingClientRect",
    ),
  };
  const dialog = document.createElement("section");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.style.cssText =
    "position:fixed;inset:0;z-index:99999;overflow:auto;background:white;display:grid;grid-template-columns:1fr 1fr";
  let presses = 0;
  const controls = new Set<HTMLElement>();
  for (let index = 0; index < 1000; index++) {
    const button = document.createElement("button");
    button.textContent = `Owned navigation fixture ${index}`;
    button.style.cssText = "height:40px;min-height:40px";
    button.onclick = () => {
      presses++;
    };
    dialog.append(button);
    controls.add(button);
  }
  let pressed: number[] = [];
  let counts: LayoutCounts = { getClientRects: 0, getBoundingClientRect: 0 };
  let receiverCounts = {
    fixture_controls: { getClientRects: 0, getBoundingClientRect: 0 },
    fixture_container: { getClientRects: 0, getBoundingClientRect: 0 },
    outside_fixture: { getClientRects: 0, getBoundingClientRect: 0 },
  };
  let durations: number[] = [];
  const reset = () => {
    counts = { getClientRects: 0, getBoundingClientRect: 0 };
    receiverCounts = {
      fixture_controls: { getClientRects: 0, getBoundingClientRect: 0 },
      fixture_container: { getClientRects: 0, getBoundingClientRect: 0 },
      outside_fixture: { getClientRects: 0, getBoundingClientRect: 0 },
    };
    durations = [];
  };
  const frames = async (count: number) => {
    for (let index = 0; index < count; index++)
      await new Promise<number>((resolve) => requestAnimationFrame(resolve));
  };
  const samples: ControllerSample[] = [];
  let report: ControllerProfile | { error: string };
  try {
    document.body.append(dialog);
    const first = dialog.firstElementChild;
    if (!(first instanceof HTMLElement))
      throw new Error("Owned controller fixture has no HTML control");
    first.focus();
    reset();
    // Deliberately partial API double: only fields read by the controller
    // are exposed. This is injected behavior, never a physical pad claim.
    type InjectedPad = Pick<Gamepad, "index" | "id" | "axes"> & {
      buttons: Pick<GamepadButton, "pressed">[];
    };
    const fixturePads = (): InjectedPad[] => {
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
    Object.defineProperty(navigator, "getGamepads", {
      value: fixturePads,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    const counted = <Value,>(name: keyof LayoutCounts, original: (this: HTMLElement) => Value) =>
      function (this: HTMLElement): Value {
        counts[name]++;
        const receiver = controls.has(this)
          ? "fixture_controls"
          : this === dialog
            ? "fixture_container"
            : "outside_fixture";
        receiverCounts[receiver][name]++;
        return original.call(this);
      };
    HTMLElement.prototype.getClientRects = counted("getClientRects", originals.getClientRects);
    HTMLElement.prototype.getBoundingClientRect = counted(
      "getBoundingClientRect",
      originals.getBoundingClientRect,
    );
    const observe = async (phase: string, count: number) => {
      reset();
      await frames(count);
      samples.push({
        phase,
        ...counts,
        ...receiverCounts,
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
      capability_scope: "injected-controller behavior only; physical observations not qualified",
      focused: document.hasFocus(),
      samples,
    };
  } catch (error) {
    report = { error: String(error) };
  } finally {
    for (const name of ["getClientRects", "getBoundingClientRect"] as const) {
      const descriptor = originalLayoutDescriptors[name];
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
    if (previousPads) Object.defineProperty(navigator, "getGamepads", previousPads);
    else Reflect.deleteProperty(navigator, "getGamepads");
    dialog.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    if (previousMode === undefined) delete document.documentElement.dataset.inputMode;
    else document.documentElement.dataset.inputMode = previousMode;
  }
  done(report);
}
