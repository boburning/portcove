import assert from "node:assert/strict";
import test from "node:test";
import { decodeDiscoverPortIds } from "./desktop-review-presentation.mts";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { observeReviewSettlement } from "./desktop-review-observation.mts";
import type { WebDriver } from "selenium-webdriver";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { toolCachePaths } from "../../../scripts/tool-cache.mts";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";

void test("native Discover observations preserve separate exact ports without grouping by display title", () => {
  assert.deepEqual(decodeDiscoverPortIds('["render96ex","super-mario-64-sm64-co-op-dx"]'), [
    "render96ex",
    "super-mario-64-sm64-co-op-dx",
  ]);
  for (const invalid of [
    null,
    "{}",
    '"render96ex"',
    '["render96ex",null]',
    '["render96ex","render96ex"]',
    '[""]',
  ])
    assert.throws(() => decodeDiscoverPortIds(invalid));
});

void test("native Discover observation contracts run before desktop dependencies are installed", async (t) => {
  // Keep the consumer outside installed workspace ancestry, including when
  // storage guards redirect the process temporary directory into the checkout.
  const isolation = path.join(toolCachePaths().sharedRoot, "node-contracts");
  await mkdir(isolation, { recursive: true });
  const directory = await mkdtemp(path.join(isolation, "discover-observation-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of [
    "desktop-review-presentation.mts",
    "desktop-review-observation.mts",
    "browser-script.mts",
  ])
    await copyFile(new URL(name, import.meta.url), path.join(directory, name));
  const consumer = path.join(directory, "consumer.mjs");
  await writeFile(
    consumer,
    `import assert from "node:assert/strict";
    for (const name of ["axe-core", "selenium-webdriver"])
      assert.throws(() => import.meta.resolve(name), { code: "ERR_MODULE_NOT_FOUND" });
    const { decodeDiscoverPortIds } = await import("./desktop-review-presentation.mts");
    const { observeReviewSettlement } = await import("./desktop-review-observation.mts");
    assert.equal(typeof observeReviewSettlement, "function");
    assert.deepEqual(decodeDiscoverPortIds('["render96ex","super-mario-64-sm64-co-op-dx"]'),
      ["render96ex", "super-mario-64-sm64-co-op-dx"]);
    assert.throws(() => decodeDiscoverPortIds('["render96ex","render96ex"]'));
    console.log("Dependency-free native Discover observations passed");`,
  );
  const result = spawnSync(process.execPath, [consumer], {
    cwd: directory,
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dependency-free native Discover observations passed/);
});

function inertReviewBrowser({ failInstallation = false } = {}) {
  class Element {
    textContent = "Review again";
    disabled = false;
    getAttribute() {
      return "primary";
    }
    querySelectorAll() {
      return [this];
    }
    closest() {
      return this;
    }
    click() {
      throw new Error("The observer must never dispatch an interaction");
    }
  }
  const dialog = new Element();
  const listeners = new Map<string, (event: unknown) => void>();
  let changed = () => {};
  let disconnected = false;
  let observerCreated = false;
  class MutationObserver {
    constructor(callback: () => void) {
      observerCreated = true;
      changed = callback;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }
  const document = {
    body: {},
    querySelector: () => dialog,
    querySelectorAll: () => [],
    addEventListener: (name: string, callback: (event: unknown) => void) =>
      listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const window = {};
  let tick = 0;
  let calls = 0;
  const executeScript = async (script: (...args: unknown[]) => unknown, ...args: unknown[]) => {
    if (failInstallation && calls++ === 0)
      throw new Error("Controlled observer installation failure");
    const result: unknown = runInNewContext(`(${script.toString()})(...args)`, {
      document,
      window,
      Element,
      MutationObserver,
      args,
      performance: { now: () => ++tick },
    });
    return result;
  };
  return {
    browser: { executeScript } as unknown as WebDriver,
    clickObserved() {
      listeners.get("click")?.({ type: "click", target: dialog, isTrusted: true });
    },
    change(text: string) {
      dialog.textContent = text;
      changed();
    },
    isClosed: () =>
      listeners.size === 0 &&
      (!observerCreated || disconnected) &&
      Object.keys(window).length === 0,
  };
}

function observationRecord(value: unknown) {
  assert.ok(isRecord(value), "Expected a review observation record");
  return value;
}

async function readObservation(destination: string) {
  const value: unknown = JSON.parse(await readFile(destination, "utf8"));
  return observationRecord(value);
}

void test("review observations retain interaction, pending and final states without acting", async (t) => {
  const directory = await mkdtemp(path.join(toolCachePaths().sharedRoot, "review-observation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "observation.json");
  const artifacts: string[] = [];
  const fixture = inertReviewBrowser();
  await observeReviewSettlement(fixture.browser, "#review", destination, artifacts, async () => {
    fixture.clickObserved();
    fixture.change("Checking…");
    fixture.change("Reviewed retained folder");
  });
  const result = observationRecord((await readObservation(destination)).observation);
  const records = result.records;
  assert.ok(Array.isArray(records));
  assert.deepEqual(
    records.map((item: unknown) => observationRecord(item).event),
    ["state", "click", "state", "state"],
  );
  assert.equal(observationRecord(records[1]).trusted, true); // Inert fixture event, not native input evidence.
  assert.equal(observationRecord(result.latest).text, "Reviewed retained folder");
  assert.equal(result.omitted, 0);
  assert.deepEqual(artifacts, [destination]);
  assert.equal(fixture.isClosed(), true);
});

void test("bounded review observations preserve the original rejection and final state", async (t) => {
  const directory = await mkdtemp(path.join(toolCachePaths().sharedRoot, "review-observation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "observation.json");
  const fixture = inertReviewBrowser();
  const original = new Error("Original scenario assertion");
  await assert.rejects(
    observeReviewSettlement(fixture.browser, "#review", destination, [], async () => {
      for (let index = 0; index < 100; index += 1) fixture.change(`State ${index}`);
      throw original;
    }),
    (error) => error === original,
  );
  const result = observationRecord((await readObservation(destination)).observation);
  assert.ok(Array.isArray(result.records));
  assert.equal(result.records.length, 64);
  assert.equal(typeof result.omitted, "number");
  assert.ok(typeof result.omitted === "number");
  assert.ok(result.omitted > 0);
  assert.equal(observationRecord(result.latest).text, "State 99");
  assert.equal(fixture.isClosed(), true);
});

void test("unavailable diagnostic output never replaces a scenario failure or earlier evidence", async (t) => {
  const directory = await mkdtemp(path.join(toolCachePaths().sharedRoot, "review-observation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "observation.json");
  await writeFile(destination, "Earlier evidence", { flag: "wx" });
  const warnings = t.mock.method(console, "error", () => {});
  const original = new Error("Original scenario failure");
  const fixture = inertReviewBrowser();
  const artifacts: string[] = [];
  await assert.rejects(
    observeReviewSettlement(fixture.browser, "#review", destination, artifacts, async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(await readFile(destination, "utf8"), "Earlier evidence");
  assert.deepEqual(artifacts, []);
  assert.equal(warnings.mock.callCount(), 1);
  assert.equal(fixture.isClosed(), true);
});

void test("observer installation failure still runs the original interaction exactly once", async (t) => {
  const directory = await mkdtemp(path.join(toolCachePaths().sharedRoot, "review-observation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, "observation.json");
  const fixture = inertReviewBrowser({ failInstallation: true });
  const warnings = t.mock.method(console, "error", () => {});
  const original = new Error("Original interaction failure");
  let calls = 0;
  await assert.rejects(
    observeReviewSettlement(fixture.browser, "#review", destination, [], async () => {
      calls += 1;
      throw original;
    }),
    (error) => error === original,
  );
  const result = await readObservation(destination);
  assert.equal(calls, 1);
  assert.equal(warnings.mock.callCount(), 1);
  assert.ok(typeof result.installationFailure === "string");
  assert.match(result.installationFailure, /Controlled observer installation failure/);
  assert.equal(observationRecord(result.observation).available, false);
  assert.equal(fixture.isClosed(), true);
});

function clickDiagnosticFixture(program: string) {
  return runDesktopModuleFixture(
    new URL("./desktop-review-controls.mts", import.meta.url),
    `
    const {clickVisible} = await import(entry);
    const {runInNewContext} = await import("node:vm");
    function fixture(failureStage, original, contextFailure, obscured = false) {
      const calls = [];
      const hitPoints = [];
      const visit = (stage) => {
        calls.push(stage);
        if (stage === failureStage) throw original;
      };
      const element = {
        async isDisplayed() { visit("visible"); return true; },
        async isEnabled() { visit("enabled"); return true; },
        async click() { visit("webdriver-click"); },
      };
      const browser = {
        actions() { throw Error("Default dispatch must not substitute native Actions"); },
        async wait(condition) {
          const result = await (typeof condition === "function" ? condition() : condition.fn());
          assert.ok(result, "Every interaction gate must pass");
          return result;
        },
        async executeScript(script, ...args) {
          const source = String(script);
          if (source.includes("scrollContainers")) {
            calls.push("context");
            if (contextFailure) throw contextFailure;
            return { target: "owned button", focused: "owned button", hit: "owned button" };
          }
          const stage = source.includes("getAnimations") ? "entrance"
            : source.includes("focus(") ? "focus"
            : source.includes("elementFromPoint") ? "pointer-target"
            : source.includes(".click()") ? "dom-click" : "scroll";
          visit(stage);
          if (stage !== "pointer-target") return true;
          const target = {
            scrollIntoView() {},
            getBoundingClientRect() { return { x: 76.5, y: 61.75, width: 148.5, height: 37 }; },
            contains() { return false; },
          };
          return runInNewContext("(" + source + ")(...scriptArguments)", {
            scriptArguments: [target, ...args.slice(1)],
            document: { elementFromPoint(x, y) {
              hitPoints.push({ x, y });
              return obscured ? {} : target;
            }},
          });
        },
      };
      return { calls, hitPoints, element, browser };
    }
    function diagnostic(error) {
      assert(error instanceof Error);
      const line = error.message.split("\\n")[0];
      assert(line.startsWith("Review interaction failed: "));
      return JSON.parse(line.slice("Review interaction failed: ".length));
    }
    ${program}
  `,
  );
}

void test("native review clicks retain every gate and the requested dispatch without fallback", () => {
  clickDiagnosticFixture(`
    const gates = ["entrance", "focus", "scroll", "visible", "enabled", "pointer-target"];
    for (const dispatch of ["webdriver", "dom"]) {
      const f = fixture();
      await clickVisible(f.browser, f.element, { dispatch });
      assert.deepEqual(f.calls, [...gates, dispatch + "-click"]);
      assert.deepEqual(f.hitPoints, [{ x: 150.75, y: 80.25 }]);
    }
    const covered = fixture(undefined, undefined, undefined, true);
    await assert.rejects(
      clickVisible(covered.browser, covered.element),
      error => diagnostic(error).stage === "pointer-target",
    );
    assert.deepEqual(covered.calls, [...gates, "context"]);
  `);
});

void test("Linux GTK pointers convert page zoom once and refuse a misdelivered move before pressing", () => {
  clickDiagnosticFixture(`
    Object.defineProperty(process, "platform", {value:"linux"});
    function gtkFixture({ hovered = true, zoom = "400", width = 240, failPress = false,
      visible = true, enabled = true, obscured = false, multiple = false, reflow = false, persistent = false } = {}) {
      const calls = [];
      const hits = [];
      const observations = [];
      let recentered = false;
      let moves = 0;
      const element = {
        tagName: "BUTTON", id: "connect-folder", textContent: "Connect folder",
        getAttribute(name) {
          if (name.startsWith("data-discover-")) return JSON.stringify(multiple ? ["fixture","other"] : ["fixture"]);
          return null;
        },
        getClientRects() { return [{}]; },
        async findElement() { return element; },
        closest() { return null; },
        getAnimations() { return []; },
        focus() { calls.push("focus"); },
        scrollIntoView() {
          calls.push("scroll");
          if (reflow && moves > 0) recentered = true;
        },
        getBoundingClientRect() {
          return { x:76.5,y:recentered ? 73.75 : 61.75,width:148.5,height:37 };
        },
        contains(hit) { return hit === element; },
        matches(selector) { return selector === ":hover" && hovered; },
        async isDisplayed() { calls.push("visible"); return visible; },
        async isEnabled() { calls.push("enabled"); return enabled; },
        async click() { throw Error("Element Click is forbidden in explicit GTK mode"); },
      };
      const document = {
        elementFromPoint(x,y) {
          hits.push({x,y});
          const missesMovedTarget = reflow && moves > 0 && (!recentered || y !== 92.25);
          return obscured || missesMovedTarget || (persistent && moves >= 2) ? null : element;
        },
      };
      const browser = {
        async executeScript(script, ...args) {
          if (String(script).includes("scrollContainers")) return {};
          const result = runInNewContext(
            typeof script === "function" ? "("+script+")(...args)" : "(function(){"+script+"}).apply(null,args)",
            { args, document, innerWidth: width, innerHeight: 160,
              localStorage: { getItem: () => zoom }, getComputedStyle: () => ({visibility:"visible"}) },
          );
          return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        },
        async wait(condition, timeout, message) {
          if (condition?.using) return element;
          const result = await (typeof condition === "function" ? condition() : condition.fn());
          assert.ok(result, message ?? "Every GTK gate must pass");
          return result;
        },
        async findElements(locator) { return locator.value === ".navigation-sheet" ? [] : [element]; },
        actions() {
          const queued = [];
          return {
            move(point) { queued.push({ move: point }); return this; },
            press() { queued.push("press"); return this; },
            release() { queued.push("release"); return this; },
            async perform() {
              calls.push(queued);
              if (queued.some(step => typeof step === "object" && step.move)) moves++;
              if (failPress && queued.includes("press")) throw Error("Native press refused");
            },
          };
        },
      };
      const options = { dispatch: "webkit-window-pointer", pageZoom: 4,
        baselineViewport: { width: 960, height: 640 }, observe: value => observations.push(value) };
      return { browser, element, options, calls, hits, observations };
    }
    const f = gtkFixture();
    await clickVisible(f.browser, f.element, f.options);
    assert.deepEqual(f.calls.filter(Array.isArray), [
      [{ move: { x: 603, y: 321, duration: 0 } }], ["press", "release"],
    ]);
    assert.deepEqual(f.hits, [{ x: 150.75, y: 80.25 }, { x: 150.75, y: 80.25 }]);
    assert.deepEqual(f.observations, [{
      target: {tag:"BUTTON",id:"connect-folder",role:null,label:"Connect folder"},
      cssPoint: {x:150.75,y:80.25}, nativePoint: {x:603,y:321}, pageZoom:4,
      viewport:{width:240,height:160}, delivered:true,
    }]);
    const wrong = gtkFixture({ hovered: false });
    await assert.rejects(clickVisible(wrong.browser, wrong.element, wrong.options), error => {
      assert.equal(diagnostic(error).stage, "webkit-delivered-target");
      assert.equal(diagnostic(error).webkitPointer.delivered, false);
      return true;
    });
    assert.deepEqual(wrong.calls.filter(Array.isArray), [[{move:{x:603,y:321,duration:0}}]]);
    assert.equal(wrong.observations[0].delivered, false);
    const moved = gtkFixture({ reflow:true });
    await clickVisible(moved.browser, moved.element, moved.options);
    assert.deepEqual(moved.calls.filter(Array.isArray), [
      [{ move: { x:603,y:321,duration:0 } }],
      [{ move: { x:603,y:369,duration:0 } }],
      ["press", "release"],
    ]);
    assert.deepEqual(moved.observations.map(value => value.delivered), [false, true]);
    const noLongerReachable = gtkFixture({reflow:true,persistent:true});
    await assert.rejects(clickVisible(noLongerReachable.browser, noLongerReachable.element, noLongerReachable.options), error =>
      diagnostic(error).stage === "webkit-delivered-target");
    assert.equal(noLongerReachable.calls.filter(Array.isArray).length, 2);
    assert.deepEqual(noLongerReachable.observations.map(value => value.delivered), [false,false]);
    for (const shape of [{zoom:"100"}, {width:960}]) {
      const invalid = gtkFixture(shape);
      await assert.rejects(clickVisible(invalid.browser, invalid.element, invalid.options), error =>
        diagnostic(error).stage === "webkit-window-point");
      assert.deepEqual(invalid.calls.filter(Array.isArray), []);
    }
    for (const shape of [{visible:false}, {enabled:false}, {obscured:true}]) {
      const blocked = gtkFixture(shape);
      await assert.rejects(clickVisible(blocked.browser, blocked.element, blocked.options));
      assert.deepEqual(blocked.calls.filter(Array.isArray), []);
    }
    Object.defineProperty(process, "platform", {value:"win32"});
    const windows = gtkFixture();
    await assert.rejects(clickVisible(windows.browser, windows.element, windows.options), error =>
      diagnostic(error).stage === "webkit-window-point");
    assert.deepEqual(windows.calls.filter(Array.isArray), []);
    Object.defineProperty(process, "platform", {value:"linux"});
    const refused = gtkFixture({failPress:true});
    await assert.rejects(clickVisible(refused.browser, refused.element, refused.options), error => {
      assert.equal(diagnostic(error).stage, "webkit-pointer-click");
      assert.equal(error.cause.message, "Native press refused");
      return true;
    });
    assert.deepEqual(refused.calls.filter(Array.isArray), f.calls.filter(Array.isArray));
    const {reviewControls,selectPrimaryNavigation,selectGameFilesSettings,clearCatalogFilters,selectCatalogPort} = await import(entry);
    for (const [run, expectedPresses, multiple] of [
      [(value)=>reviewControls(value.browser,value.options).click({using:"css selector",value:"button"}),1,false],
      [(value)=>selectPrimaryNavigation(value.browser,"Settings",value.options),1,false],
      [(value)=>selectGameFilesSettings(value.browser,value.options),1,false],
      [(value)=>clearCatalogFilters(value.browser,value.options),3,false],
      [(value)=>selectCatalogPort(value.browser,"fixture",value.options),1,false],
      [(value)=>selectCatalogPort(value.browser,"fixture",value.options),2,true],
    ]) {
      const consumer = gtkFixture({multiple});
      await run(consumer);
      assert.equal(consumer.observations.length, expectedPresses);
      assert.equal(consumer.calls.filter(value=>Array.isArray(value)&&value.includes("press")).length,expectedPresses);
      for (const observation of consumer.observations) {
        assert.deepEqual(observation.nativePoint,{x:603,y:321});
        assert.equal(observation.delivered,true);
      }
    }
  `);
});

void test("empty native click messages retain their error class, stage and original cause", () => {
  clickDiagnosticFixture(`
    const original = new Error("");
    original.name = "ElementNotInteractableError";
    const f = fixture("webdriver-click", original);
    await assert.rejects(clickVisible(f.browser, f.element), error => {
      assert.equal(error.cause, original);
      assert.deepEqual(diagnostic(error), {
        stage: "webdriver-click",
        error: { type: "Error", name: "ElementNotInteractableError", name_truncated: false, message: "", message_truncated: false },
      });
      assert.match(error.message, /Review control: /);
      return true;
    });
    assert.equal(f.calls.filter(stage => stage === "webdriver-click").length, 1);
    assert.equal(f.calls.includes("dom-click"), false);
  `);
});

void test("native click context failures cannot replace the primary rejection or its stage", () => {
  clickDiagnosticFixture(`
    const original = new Error("");
    original.name = "ElementClickInterceptedError";
    const secondary = new Error("The window closed while collecting context");
    secondary.name = "NoSuchWindowError";
    const f = fixture("webdriver-click", original, secondary);
    await assert.rejects(clickVisible(f.browser, f.element), error => {
      assert.equal(error.cause, original);
      assert.equal(diagnostic(error).stage, "webdriver-click");
      assert.equal(diagnostic(error).error.name, "ElementClickInterceptedError");
      assert.match(error.message, /Review control unavailable: .*NoSuchWindowError/);
      return true;
    });
    assert.equal(f.calls.filter(stage => stage === "context").length, 1);
  `);
});

void test("native review failures identify each gate and never advance past a rejected gate", () => {
  clickDiagnosticFixture(`
    const gates = ["entrance", "focus", "scroll", "visible", "enabled", "pointer-target"];
    for (const dispatch of ["webdriver", "dom"]) {
      const stages = [...gates, dispatch + "-click"];
      for (const [index, stage] of stages.entries()) {
        const original = new Error("Controlled failure at " + stage);
        const f = fixture(stage, original);
        await assert.rejects(clickVisible(f.browser, f.element, { dispatch }), error => {
          assert.equal(error.cause, original);
          assert.equal(diagnostic(error).stage, stage);
          assert.equal(diagnostic(error).error.message, original.message);
          return true;
        });
        assert.deepEqual(f.calls, [...stages.slice(0, index + 1), "context"]);
      }
    }
  `);
});

void test("native review diagnostics bound encoded error fields and tolerate unreadable thrown values", () => {
  clickDiagnosticFixture(`
    const escaped = new Error((String.fromCharCode(0, 34, 92) + "😀").repeat(10000));
    escaped.name = escaped.message;
    const long = new Error("x".repeat(10000));
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    let nameReads = 0;
    let messageReads = 0;
    const changingGetters = {
      get name() { return ++nameReads === 1 ? "First error name" : null; },
      get message() { return ++messageReads === 1 ? "First error message" : null; },
    };
    for (const [original, type] of [
      [long, "Error"], [escaped, "Error"], ["primitive rejection", "string"],
      [{ get name() { throw Error("Unreadable name"); },
         get message() { throw Error("Unreadable message"); } }, "object"],
      [revoked.proxy, "object"], [changingGetters, "object"],
    ]) {
      const f = fixture("webdriver-click", original, escaped);
      await assert.rejects(clickVisible(f.browser, f.element), error => {
        assert.equal(error.cause, original);
        const d = diagnostic(error);
        assert.equal(d.stage, "webdriver-click");
        assert.equal(d.error.type, type);
        assert(Buffer.byteLength(JSON.stringify(d.error.name)) <= 128);
        assert(Buffer.byteLength(JSON.stringify(d.error.message)) <= 1024);
        if (type === "Error") {
          assert(original.message.startsWith(d.error.message));
          assert.equal(d.error.message_truncated, true);
          assert.equal(d.error.name_truncated, original === escaped);
        } else if (typeof original === "string") {
          assert.equal(d.error.message, original);
        } else if (original === changingGetters) {
          assert.equal(d.error.name, "First error name");
          assert.equal(d.error.message, "First error message");
          assert.equal(nameReads, 1);
          assert.equal(messageReads, 1);
        } else {
          assert.equal(d.error.message, "<unreadable error>");
        }
        const retained = error.message.slice(0, 4096);
        assert.equal(retained, error.message);
        assert.deepEqual(JSON.parse(retained.split("\\n")[0].slice("Review interaction failed: ".length)), d);
        const secondary = JSON.parse(retained.split("\\n")[1].slice("Review control unavailable: ".length));
        assert.equal(secondary.type, "Error");
        assert.equal(secondary.message_truncated, true);
        assert(Buffer.byteLength(JSON.stringify(secondary.name)) <= 128);
        assert(Buffer.byteLength(JSON.stringify(secondary.message)) <= 1024);
        assert(Buffer.byteLength(error.message) < 4096);
        return true;
      });
    }
  `);
});
