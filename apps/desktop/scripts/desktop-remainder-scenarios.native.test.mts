import assert from "node:assert/strict";
import test from "node:test";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
import { isRecord, errorMessage } from "../../../scripts/runtime-values.mts";
import { runTypeScriptInNewContext as runInNewContext } from "../../../scripts/test-source.mts";

function callable(value: unknown) {
  assert.equal(typeof value, "function");
  return (...args: unknown[]): unknown =>
    Reflect.apply(value as (...args: unknown[]) => unknown, undefined, args);
}

void test("game-first owner registers its exact scenario without native, source or installation effects", () => {
  const entry = new URL("./desktop-game-first-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      const {gameFirstScenarios}=await import(entry);
      const attempts=[];
      await gameFirstScenarios({scenario:async(id,action)=>{
        assert.equal(typeof action,'function');attempts.push(id);
      }});
      assert.deepEqual(attempts,['native-game-first-choice-and-restart']);
    `,
        variant === "original" ? undefined : { exportName: "gameFirstScenarios", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

void test("game-first serialized capture retains optional alerts while requiring fonts and actual interface size", () => {
  const entry = new URL("./desktop-game-first-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      const {runInNewContext}=await import('node:vm');
      const {observeGameFirstCaptureReadiness:observe}=await import(entry);
      const document={fonts:{status:'loaded'},body:{textContent:'Interface size 200%.'},
        documentElement:{scrollWidth:480,clientWidth:480},
        querySelectorAll:selector=>{
          assert.equal(selector,'[role="alert"]');
          return [{textContent:' Optional comparison evidence unavailable '}];
        }};
      const read=()=>JSON.parse(JSON.stringify(runInNewContext('('+String(observe)+')(200)',{
        document,innerWidth:480,innerHeight:320,devicePixelRatio:2
      })));
      const settled=read();
      assert.equal(settled.ready,true);
      assert.deepEqual(settled.alerts,['Optional comparison evidence unavailable']);
      assert.deepEqual(settled.viewport,{width:480,height:320,dpr:2});
      document.fonts.status='loading';assert.equal(read().ready,false);
      document.fonts.status='loaded';document.body.textContent='Applying interface size 200%.';
      assert.equal(read().ready,false);
      document.body.textContent='Interface size 100%.';assert.equal(read().ready,false);
    `,
        variant === "original"
          ? undefined
          : { exportName: "observeGameFirstCaptureReadiness", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

// Exercise the actual serialized probe with a deterministic frame consumer. The
// consumer models layout receivers, not production controller functionality.
async function controllerObservation(probeSource: string) {
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
    runInNewContext(`(${probeSource})`, {
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
    }),
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

function actualControllerObservation() {
  const output = runDesktopModuleFixture(
    new URL("./desktop-controller-test.mts", import.meta.url),
    `
      import {runInNewContext} from 'node:vm';
      import {isRecord} from ${JSON.stringify(new URL("../../../scripts/runtime-values.mts", import.meta.url).href)};
      const {observeInjectedController}=await import(entry);
      const callable=${callable.toString()};
      console.log(JSON.stringify(await (${controllerObservation.toString()})(observeInjectedController.toString())));
    `,
  );
  const report: unknown = JSON.parse(output);
  assert.ok(isRecord(report));
  return report;
}

void test("native remainder controller attributes unrelated layout reads and restores injected methods", async () => {
  const report = actualControllerObservation();
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
  const original = actualControllerObservation();
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        new URL("./desktop-controller-test.mts", import.meta.url),
        `
      import path from 'node:path';
      const {WebDriver}=await import('selenium-webdriver');
      const navigation=[],reports=[];
      const fileSystem=await import('node:fs/promises');
      mock.module('node:fs/promises',{namedExports:{...Object.fromEntries(Object.entries(fileSystem).filter(([name])=>name!=='default')),writeFile:async(file,bytes,options)=>{
        assert.ok(['controller-capability.json','controller-layout-profile.json'].includes(path.basename(file)));
        assert.equal(path.dirname(file),'owned-output');
        assert.deepEqual(options,{flag:'wx'});reports.push({file,value:JSON.parse(bytes)});
      }}});
      mock.module(new URL('./desktop-review-controls.mts',entry).href,{namedExports:{
        selectPrimaryNavigation:async(browser,label)=>{
          assert.ok(browser instanceof WebDriver);assert.equal(label,'Library');navigation.push(browser);
        },
      }});
      const {controllerScenario}=await import(entry);
      let profile=${JSON.stringify(original)};
      const original=profile;
      class ControlledBrowser extends WebDriver{
        executeScript(){return {outcome:'api-present-no-controller'};}
        executeAsyncScript(){
          assert.equal(navigation.at(-1),this,'Navigate before injecting the controller probe');return profile;
        }
      }
      const context={browser:new ControlledBrowser(),output:'owned-output',artifacts:[],
        scenario:async(name,work)=>{if(name==='native-controller-large-list')await work();}};
      await controllerScenario(context);
      assert.deepEqual(navigation,[context.browser]);
      const damaged=structuredClone(original),direction=damaged.samples[3];
      direction.fixture_controls.getBoundingClientRect=1003;
      direction.getBoundingClientRect=1006;profile=damaged;
      await assert.rejects(()=>controllerScenario(context),/1003 !== 1000/);
      direction.fixture_controls.getBoundingClientRect=1000;
      await assert.rejects(()=>controllerScenario(context),/Every layout read must retain its receiver attribution/);
      assert.deepEqual(navigation,[context.browser,context.browser,context.browser]);
      assert.deepEqual(context.artifacts,Array.from({length:3},()=>[
        path.join('owned-output','controller-capability.json'),
        path.join('owned-output','controller-layout-profile.json')]).flat());
      assert.equal(reports.length,6);
      `,
        variant === "original" ? undefined : { exportName: "controllerScenario", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

async function paletteBehavior(
  run: (context: unknown) => Promise<unknown>,
  prepare: (events: string[]) => void,
) {
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
    prepare(events);
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
}

void test("native remainder palette walks explicit commands and restores renderer after a failed assertion", () => {
  const entry = new URL("./desktop-accessibility-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      import path from 'node:path';import {runInNewContext} from 'node:vm';
      const {isRecord,errorMessage}=await import(new URL('../../../scripts/runtime-values.mts',entry));
      const callable=${String(callable)};
      let events=[];
      const files=await import('node:fs/promises');
      mock.module('node:fs/promises',{namedExports:{...Object.fromEntries(Object.entries(files).filter(([name])=>name!=='default')),writeFile:async(file,bytes,options)=>{
        assert.equal(path.dirname(file),'owned-output');assert.ok(path.basename(file).includes('expanded-navigation'));events.push('write');
      }}});
      mock.module('selenium-webdriver',{namedExports:{
        By:{css:value=>value},Key:{CONTROL:'Control',COMMAND:'Command',ARROW_DOWN:'ArrowDown',ESCAPE:'Escape'},until:{elementLocated:value=>value},
      }});
      mock.module(new URL('./desktop-review-controls.mts',entry).href,{namedExports:{
        assertCompactReview:async()=>{events.push('expanded');throw Error('retained expanded-layout assertion');},
        captureAccessibilityReport:()=>assert.fail('The failed layout must precede accessibility capture'),
        observeAccessibility:()=>assert.fail('The failed layout must precede accessibility observation'),
        assertNoAccessibilityViolations:()=>assert.fail('The failed layout must precede accessibility checks'),
      }});
      const {accessibleNavigationScenario}=await import(entry);
      await (${String(paletteBehavior)})(accessibleNavigationScenario,value=>events=value);
    `,
        variant === "original"
          ? undefined
          : { exportName: "accessibleNavigationScenario", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

async function settledRecoveryBehavior(subject: (browser: unknown) => Promise<unknown>) {
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
  const run = () =>
    subject({
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
  assert.equal(await completion, '[data-detail-origin="error:preparation-review"]');
  assert.equal(activityClicks, 1);
  assert.deepEqual(events, [
    "recovery action located",
    "overlay present",
    "overlay absent",
    "Activity click",
    "detail absent",
  ]);
}

void test("direct preparation recovery waits for modal settlement before its ordinary Activity click", () => {
  const entry = new URL("./desktop-preparation-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      const callable=${String(callable)};
      const forbiddenConstructor=class{constructor(){throw Error('Unexpected native driver construction');}};
      mock.module('selenium-webdriver',{namedExports:{By:{css:value=>value,xpath:value=>value},Key:{},until:{elementLocated:value=>value},WebDriver:forbiddenConstructor,Session:forbiddenConstructor,Capabilities:forbiddenConstructor}});
      const {settleDirectPreparationRecovery}=await import(entry);
      await (${String(settledRecoveryBehavior)})(settleDirectPreparationRecovery);
    `,
        variant === "original"
          ? undefined
          : { exportName: "settleDirectPreparationRecovery", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

async function stuckRecoveryBehavior(subject: (browser: unknown) => Promise<unknown>) {
  const timeoutFailure = new Error("retained modal-settlement timeout");
  let recoveryLocated = false;
  let overlayReads = 0;
  let activityClicks = 0;
  const run = () =>
    subject({
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
}

void test("direct preparation recovery propagates a stuck modal timeout without clicking Activity", () => {
  const entry = new URL("./desktop-preparation-test.mts", import.meta.url);
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        entry,
        `
      const callable=${String(callable)};
      const forbiddenConstructor=class{constructor(){throw Error('Unexpected native driver construction');}};
      mock.module('selenium-webdriver',{namedExports:{By:{css:value=>value,xpath:value=>value},Key:{},until:{elementLocated:value=>value},WebDriver:forbiddenConstructor,Session:forbiddenConstructor,Capabilities:forbiddenConstructor}});
      const {settleDirectPreparationRecovery}=await import(entry);
      await (${String(stuckRecoveryBehavior)})(settleDirectPreparationRecovery);
    `,
        variant === "original"
          ? undefined
          : { exportName: "settleDirectPreparationRecovery", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});
