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
    function fixture(failureStage, original, contextFailure) {
      const calls = [];
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
        async wait(condition) {
          const result = await (typeof condition === "function" ? condition() : condition.fn());
          assert.equal(result, true, "Every interaction gate must pass");
          return result;
        },
        async executeScript(script) {
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
          return true;
        },
      };
      return { calls, element, browser };
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
    for (const [original, type] of [
      [long, "Error"], [escaped, "Error"], ["primitive rejection", "string"],
      [{ get name() { throw Error("Unreadable name"); },
         get message() { throw Error("Unreadable message"); } }, "object"],
      [revoked.proxy, "object"],
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
