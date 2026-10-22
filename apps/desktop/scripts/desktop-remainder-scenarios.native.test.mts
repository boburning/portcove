import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isRecord, errorMessage } from "../../../scripts/runtime-values.mts";
import { runTypeScriptInNewContext as runInNewContext } from "../../../scripts/test-source.mts";

async function source(name: string, start: string, end?: string) {
  const text = await readFile(new URL(name, import.meta.url), "utf8");
  const first = text.indexOf(start);
  assert.ok(first >= 0, start);
  const last = end ? text.indexOf(end, first + start.length) : text.length;
  assert.ok(last > first, end);
  return text.slice(first, last).replace("export async function", "async function");
}

function callable(value: unknown) {
  assert.equal(typeof value, "function");
  return (...args: unknown[]): unknown =>
    Reflect.apply(value as (...args: unknown[]) => unknown, undefined, args);
}

// Exercise the actual serialized probe with a deterministic frame consumer. The
// consumer models layout receivers, not production controller functionality.
async function controllerObservation() {
  const document = {
    activeElement: undefined as HTMLElement | undefined,
    documentElement: { dataset: { inputMode: "keyboard" } as Record<string, string> },
    body: {
      append: (element: HTMLElement) => {
        dialog = element;
      },
    },
    createElement: () => new HTMLElement(),
    hasFocus: () => true,
  };
  class HTMLElement {
    children: HTMLElement[] = [];
    style = { cssText: "" };
    textContent = "";
    isConnected = true;
    onclick?: () => void;
    setAttribute() {}
    append(element: HTMLElement) {
      this.children.push(element);
    }
    get firstElementChild() {
      return this.children[0];
    }
    getClientRects() {
      return [{}];
    }
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 1, height: 1 };
    }
    focus() {
      document.activeElement = this;
      document.documentElement.dataset.inputMode = "controller";
    }
    remove() {
      this.isConnected = false;
    }
  }
  let dialog: HTMLElement | undefined;
  const previousFocus = new HTMLElement();
  document.activeElement = previousFocus;
  const originalPads = () => [] as { buttons: { pressed: boolean }[] }[];
  const navigator = { getGamepads: originalPads };
  const originalRect = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  const originalClients = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getClientRects");
  let wasActive = false;
  const outside = new HTMLElement();
  let ticks = 0;
  const probe = callable(
    runInNewContext(
      `${await source("./desktop-controller-test.mts", "export async function observeInjectedController(")}\nobserveInjectedController;`,
      {
        HTMLElement,
        document,
        navigator,
        performance: { now: () => ++ticks },
        queueMicrotask,
        requestAnimationFrame: (callback: (tick: number) => void) =>
          queueMicrotask(() => {
            const [pad] = navigator.getGamepads();
            assert.ok(pad && dialog);
            const active = pad.buttons[0]?.pressed;
            if (active && !wasActive) {
              dialog.getClientRects();
              dialog.children[0]?.getClientRects();
              dialog.children[0]?.onclick?.();
            }
            wasActive = Boolean(active);
            if (pad.buttons[13]?.pressed) {
              dialog.getClientRects();
              for (const control of dialog.children) {
                control.getClientRects();
                control.getBoundingClientRect();
              }
              // Shell focus/reflow work remains in the global profile and gets its
              // own attribution; it must not turn 1000 controls into 1003 controls.
              for (let index = 0; index < 3; index++) outside.getBoundingClientRect();
            }
            callback(++ticks);
          }),
      },
    ),
  );
  let calls = 0;
  let report: unknown;
  await probe((value: unknown) => {
    calls++;
    report = value;
  });
  assert.equal(calls, 1);
  assert.ok(isRecord(report));
  assert.equal(report.error, undefined);
  assert.equal(report.control_count, 1000);
  assert.equal(navigator.getGamepads, originalPads);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect"),
    originalRect,
  );
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getClientRects"),
    originalClients,
  );
  assert.equal(document.activeElement, previousFocus);
  assert.equal(document.documentElement.dataset.inputMode, "keyboard");
  assert.equal(dialog?.isConnected, false);
  return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

void test("native remainder controller attributes unrelated layout reads and restores injected methods", async () => {
  const report = await controllerObservation();
  assert.ok(Array.isArray(report.samples));
  const direction: unknown = report.samples[3];
  assert.ok(isRecord(direction));
  assert.equal(direction.getBoundingClientRect, 1003);
  assert.deepEqual(direction.fixture_controls, {
    getClientRects: 1000,
    getBoundingClientRect: 1000,
  });
  assert.deepEqual(direction.fixture_container, { getClientRects: 1, getBoundingClientRect: 0 });
  assert.deepEqual(direction.outside_fixture, { getClientRects: 0, getBoundingClientRect: 3 });
});

void test("native remainder controller retains exact control count and rejects unattributed reads", async () => {
  const original = await controllerObservation();
  const navigation: WebDriver[] = [];
  class WebDriver {
    executeScript() {
      return { outcome: "api-present-no-controller" };
    }
    executeAsyncScript() {
      assert.equal(navigation.at(-1), this, "Navigate before injecting the controller probe");
      return profile;
    }
  }
  let profile: unknown = original;
  const run = callable(
    runInNewContext(
      `${await source("./desktop-controller-test.mts", "export async function controllerScenario(", "export async function observeInjectedController(")}\ncontrollerScenario;`,
      {
        assert,
        isRecord,
        path,
        writeFile: async () => undefined,
        WebDriver,
        selectPrimaryNavigation: async (browser: WebDriver, label: string) => {
          assert.ok(browser instanceof WebDriver);
          assert.equal(label, "Library");
          navigation.push(browser);
        },
        observeGamepadCapability: () => undefined,
        observeInjectedController: () => undefined,
      },
    ),
  );
  const context = {
    browser: new WebDriver(),
    output: "owned-output",
    artifacts: [],
    scenario: async (name: string, work: () => Promise<void>) => {
      if (name === "native-controller-large-list") await work();
    },
  };
  await run(context);
  assert.deepEqual(navigation, [context.browser]);
  const damaged: unknown = JSON.parse(JSON.stringify(original));
  assert.ok(isRecord(damaged) && Array.isArray(damaged.samples));
  const direction: unknown = damaged.samples[3];
  assert.ok(isRecord(direction) && isRecord(direction.fixture_controls));
  direction.fixture_controls.getBoundingClientRect = 1003;
  direction.getBoundingClientRect = 1006;
  profile = damaged;
  await assert.rejects(async () => run(context), /1003 !== 1000/);
  direction.fixture_controls.getBoundingClientRect = 1000;
  await assert.rejects(
    async () => run(context),
    /Every layout read must retain its receiver attribution/,
  );
  assert.deepEqual(navigation, [context.browser, context.browser, context.browser]);
});

void test("native remainder palette walks explicit commands and restores renderer after a failed assertion", async () => {
  const body = await source(
    "./desktop-accessibility-test.mts",
    "export async function accessibleNavigationScenario(",
  );
  for (const escapeFails of [false, true]) {
    const events: string[] = [];
    const ids = [
      "command-catalog",
      "command-search-library",
      "command-search",
      "command-updates",
      "command-game-updates",
      "command-adopt",
    ];
    let index = -1;
    let open = false;
    const original = {
      fontSize: "110%",
      fontPriority: "important",
      inputMode: "keyboard",
      nativeKeyboardInputMode: "prior",
    };
    const style = {
      fontSize: original.fontSize,
      getPropertyValue: () => original.fontSize,
      getPropertyPriority: () => original.fontPriority,
      setProperty: (...args: unknown[]) => {
        events.push(`style:${JSON.stringify(args)}`);
      },
      removeProperty: () => {
        throw new Error("Original font size must be preserved");
      },
    };
    const root = {
      style,
      dataset: {
        inputMode: original.inputMode,
        nativeKeyboardInputMode: original.nativeKeyboardInputMode,
      },
    };
    const search = {
      getAttribute: (name: string) => (name === "value" ? "" : ids[index]),
      sendKeys: async () => {
        index++;
        root.dataset.nativeKeyboardInputMode = "keyboard";
      },
    };
    const document = {
      documentElement: root,
      activeElement: search as unknown,
      querySelector: () => ({ closest: () => null }),
      querySelectorAll: (selector: string) =>
        selector.includes("controller-hint")
          ? (root.dataset.inputMode === "controller"
              ? ["D-pad or stick: Move", "Confirm button: Select", "Back button: Back"]
              : ["Arrow keys: Move", "Enter: Select", "Esc: Back"]
            ).map((textContent) => ({ textContent, getClientRects: () => [{}] }))
          : [],
    };
    class HTMLElement {
      focus() {
        document.activeElement = this;
      }
    }
    const trigger = new HTMLElement();
    const browser = {
      manage: () => ({
        window: () => ({
          getRect: async () => ({ width: 900, height: 700 }),
          setRect: async () => {
            events.push("window");
          },
        }),
      }),
      executeScript: (script: (...args: unknown[]) => unknown, ...args: unknown[]) => {
        const result = runInNewContext(`(${script.toString()})(...args)`, {
          args,
          document,
          HTMLElement,
          window: { addEventListener() {} },
          queueMicrotask,
        });
        // Selenium returns JSON observations in the caller's realm.
        const observation: unknown =
          typeof result === "object" && result !== null
            ? JSON.parse(JSON.stringify(result))
            : result;
        return observation;
      },
      findElement: async (selector: string) =>
        selector.includes("command-trigger")
          ? trigger
          : selector === ".palette-footer .controller-hint"
            ? {
                getAttribute: () => null,
                findElement: () => ({
                  click: async () => {
                    events.push("help-open");
                  },
                }),
              }
            : selector === "#command-check"
              ? { getAttribute: () => "", getText: () => "Install a port before checking" }
              : search,
      findElements: async () => (open ? [{}] : []),
      actions() {
        let escape = false;
        const actions = {
          keyDown: () => actions,
          keyUp: () => actions,
          sendKeys: (key: string) => {
            escape = key === "Escape";
            return actions;
          },
          perform: async () => {
            if (!escape) {
              open = true;
              document.activeElement = search;
            } else {
              events.push("escape");
              if (escapeFails) throw new Error("retained Escape transport failure");
              open = false;
            }
          },
        };
        return actions;
      },
      wait: async (condition: unknown) => {
        if (typeof condition === "function") assert.ok(await callable(condition)());
      },
      takeScreenshot: async () => {
        events.push("capture");
        return "owned-failure-image";
      },
      navigate: () => ({
        refresh: async () => {
          events.push("refresh");
          open = false;
        },
      }),
    };
    const run = callable(
      runInNewContext(`${body}\naccessibleNavigationScenario;`, {
        assert: {
          ...assert,
          deepEqual: (actual: unknown, expected: unknown, message?: string) =>
            assert.deepEqual(
              JSON.parse(JSON.stringify(actual)),
              JSON.parse(JSON.stringify(expected)),
              message,
            ),
        },
        path,
        process: { platform: "win32" },
        console,
        By: { css: (value: string) => value },
        Key: { CONTROL: "Control", COMMAND: "Command", ARROW_DOWN: "ArrowDown", ESCAPE: "Escape" },
        until: { elementLocated: (value: unknown) => value },
        writeFile: async () => {
          events.push("write");
        },
        assertCompactReview: async () => {
          events.push("expanded");
          throw new Error("retained expanded-layout assertion");
        },
      }),
    );
    let failure: unknown;
    try {
      await run({
        browser,
        output: "owned-output",
        artifacts: [],
        scenario: async (_name: string, work: () => Promise<void>) => work(),
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.match(errorMessage(failure), /retained expanded-layout assertion/);
    assert.equal(
      index,
      5,
      "The unavailable check must be skipped after every explicitly named preceding command",
    );
    assert.ok(events.indexOf("expanded") < events.indexOf("capture"));
    assert.ok(events.indexOf("help-open") < events.indexOf("expanded"));
    assert.ok(events.indexOf("capture") < events.indexOf("escape"));
    assert.ok(events.includes(`style:${JSON.stringify(["font-size", "110%", "important"])}`));
    assert.ok(events.includes("window"));
    assert.equal(events.at(-1), "refresh");
    assert.equal(open, false);
    assert.deepEqual(root.dataset, { inputMode: "keyboard", nativeKeyboardInputMode: "prior" });
    if (escapeFails) {
      assert.ok(isRecord(failure) && Array.isArray(failure.errors));
      assert.equal(failure.errors.length, 2);
      assert.match(errorMessage(failure.errors[1]), /retained Escape transport failure/);
    }
  }
});

// Execute the real direct-recovery observer and its surrounding caller order.
// The fake driver controls modal settlement, not preparation or Core authority.
async function directRecoveryNavigationSubject(browser: unknown) {
  const body = await source(
    "./desktop-preparation-test.mts",
    'await scenario("native-direct-preparation-recovery", async () => {',
    "  const livePreparationCancellation =",
  );
  const startMarker = "const action = By.css('[data-detail-origin=\"error:preparation-review\"]');";
  const first = body.indexOf(startMarker);
  assert.ok(first >= 0, "actual direct preparation recovery action");
  assert.equal(body.indexOf(startMarker, first + startMarker.length), -1);
  const last = body.indexOf("const inventory = await activities();", first);
  assert.ok(last > first, "actual navigation must precede the activity inventory");
  return callable(
    runInNewContext(`(async () => {\n${body.slice(first, last)}\n});`, {
      browser,
      By: { css: (value: string) => value, xpath: (value: string) => value },
      until: { elementLocated: (value: string) => value },
    }),
  );
}

void test("direct preparation recovery waits for modal settlement before its ordinary Activity click", async () => {
  const events: string[] = [];
  let overlayPresent = true;
  let activityClicks = 0;
  let observeOverlay!: () => void;
  const overlayObserved = new Promise<void>((resolve) => {
    observeOverlay = resolve;
  });
  let releaseOverlay!: () => void;
  const maySettle = new Promise<void>((resolve) => {
    releaseOverlay = resolve;
  });
  const run = await directRecoveryNavigationSubject({
    findElements: async (selector: string) => {
      if (selector === '[data-slot="dialog-overlay"]') {
        events.push(overlayPresent ? "overlay present" : "overlay absent");
        return overlayPresent ? [{}] : [];
      }
      assert.equal(selector, "section[data-detail-workspace]");
      assert.equal(activityClicks, 1);
      events.push("detail absent");
      return [];
    },
    findElement: (selector: string) => {
      assert.equal(selector, '//nav//button[./span[normalize-space(.)="Activity"]]');
      return {
        click: async () => {
          activityClicks += 1;
          assert.equal(overlayPresent, false, "ordinary navigation remains blocked by the modal");
          events.push("Activity click");
        },
      };
    },
    wait: async (condition: unknown, timeout: number, message?: string) => {
      assert.equal(timeout, 15_000);
      if (typeof condition !== "function") {
        assert.equal(condition, '[data-detail-origin="error:preparation-review"]');
        events.push("recovery action located");
        return;
      }
      if (message !== undefined) {
        assert.equal(
          message,
          "The settled preparation review must release its modal overlay before navigation",
        );
        assert.equal(await callable(condition)(), false);
        observeOverlay();
        await maySettle;
        assert.equal(await callable(condition)(), true);
        return;
      }
      assert.equal(await callable(condition)(), true);
    },
  });
  const completion = Promise.resolve(run());
  try {
    await Promise.race([
      overlayObserved,
      completion.then(() => assert.fail("Activity navigation finished before overlay observation")),
    ]);
    assert.equal(activityClicks, 0);
    assert.deepEqual(events, ["recovery action located", "overlay present"]);
  } finally {
    overlayPresent = false;
    releaseOverlay();
  }
  await completion;
  assert.equal(activityClicks, 1);
  assert.deepEqual(events, [
    "recovery action located",
    "overlay present",
    "overlay absent",
    "Activity click",
    "detail absent",
  ]);
});

void test("direct preparation recovery propagates a stuck modal timeout without clicking Activity", async () => {
  const timeoutFailure = new Error("retained modal-settlement timeout");
  let recoveryLocated = false;
  let overlayReads = 0;
  let activityClicks = 0;
  const run = await directRecoveryNavigationSubject({
    findElements: async (selector: string) => {
      assert.equal(selector, '[data-slot="dialog-overlay"]');
      overlayReads += 1;
      return [{}];
    },
    findElement: (selector: string) => {
      assert.equal(selector, '//nav//button[./span[normalize-space(.)="Activity"]]');
      return {
        click: async () => {
          activityClicks += 1;
        },
      };
    },
    wait: async (condition: unknown, timeout: number, message?: string) => {
      assert.equal(timeout, 15_000);
      if (typeof condition !== "function") {
        assert.equal(condition, '[data-detail-origin="error:preparation-review"]');
        recoveryLocated = true;
        return;
      }
      assert.equal(recoveryLocated, true);
      assert.equal(
        message,
        "The settled preparation review must release its modal overlay before navigation",
      );
      // Model finite WebDriver deadline exhaustion after two unsuccessful polls;
      // no wall-clock wait, retrying click or test-owned dialog dismissal occurs.
      assert.equal(await callable(condition)(), false);
      assert.equal(await callable(condition)(), false);
      throw timeoutFailure;
    },
  });
  await assert.rejects(Promise.resolve(run()), (error: unknown) => error === timeoutFailure);
  assert.equal(recoveryLocated, true);
  assert.equal(overlayReads, 2);
  assert.equal(activityClicks, 0);
});
