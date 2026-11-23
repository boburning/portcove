import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { runDesktopModuleFixture } from "./fixtures/desktop-module-fixture.mts";
import type { WebDriver, WebElement } from "selenium-webdriver";
import { captureKeyboardTarget } from "../apps/desktop/scripts/desktop-capture-target.mts";
import { observeVisibleTarget } from "../apps/desktop/scripts/browser-readiness.mts";
import {
  prepareCaptureTarget,
  requireCompleteCaptureTarget,
  requireUnchangedCaptureTarget,
  type CaptureTargetObservation,
} from "../apps/desktop/test/capture-target.ts";
import { isRecord } from "./runtime-values.mts";

const target = "identified-actions";
const visible = () => ({
  target,
  target_count: 1,
  visible: true,
  rect: { x: 20, y: 20, width: 200, height: 100 },
  viewport: { width: 960, height: 640 },
});

void test("capture preflight scrolls the identified target and retains two settled complete observations", async () => {
  let scrolled = false;
  let reads = 0;
  const result = await prepareCaptureTarget({
    target,
    label: "actions",
    scroll: () => {
      scrolled = true;
    },
    settle: () => Promise.resolve(),
    observe: () => {
      assert.equal(scrolled, true);
      reads++;
      return visible();
    },
  });
  assert.equal(reads, 2);
  assert.equal(result.samples, 2);
  assert.deepEqual(result.observation, visible());
  requireUnchangedCaptureTarget(result.observation, visible());
  assert.throws(
    () =>
      requireUnchangedCaptureTarget(result.observation, {
        ...visible(),
        rect: { ...visible().rect, y: 21 },
      }),
    /changed during screenshot/,
  );
});

void test("missing, hidden, duplicate, zero, oversized and clipped targets never authorize capture", () => {
  for (const state of [
    { ...visible(), target: "other" },
    { ...visible(), target_count: 0 },
    { ...visible(), target_count: 2 },
    { ...visible(), visible: false },
    { ...visible(), rect: null },
    { ...visible(), rect: { x: 0, y: 0, width: 0, height: 1 } },
    { ...visible(), rect: { x: 0, y: 0, width: Infinity, height: 1 } },
    { ...visible(), rect: { x: 0, y: 0, width: 200, height: 641 } },
    { ...visible(), rect: { x: -1, y: 0, width: 200, height: 100 } },
    { ...visible(), rect: { x: 20, y: 600, width: 200, height: 100 } },
  ])
    assert.throws(() => requireCompleteCaptureTarget(state, target));
  assert.throws(
    () =>
      requireCompleteCaptureTarget(
        { ...visible(), rect: { x: 0, y: 0, width: 200, height: 641 } },
        target,
      ),
    /title\/actions instead/,
  );
});

void test("moving or hung target probes terminate within their finite preflight", async () => {
  let reads = 0;
  await assert.rejects(
    prepareCaptureTarget({
      target,
      label: "moving",
      scroll: () => {},
      settle: () => Promise.resolve(),
      observe: () => ({ ...visible(), rect: { ...visible().rect, y: 20 + (reads++ % 2) } }),
    }),
    /within 20 samples/,
  );
  await assert.rejects(
    prepareCaptureTarget({
      target,
      label: "hung",
      scroll: () => {},
      settle: () => new Promise(() => {}),
      observe: visible,
      timeoutMs: 5,
    }),
    /deadline/,
  );
  await assert.rejects(
    prepareCaptureTarget({
      target,
      label: "bad budget",
      scroll: () => {},
      observe: visible,
      timeoutMs: Infinity,
    }),
    /bounded identified/,
  );
});

async function libraryCaptureBehavior(
  captureLibraryAction: typeof import("../apps/desktop/scripts/desktop-preparation-test.mts").captureLibraryAction,
  installCapture: (capture: unknown) => void,
) {
  function assertObservation(value: unknown): asserts value is CaptureTargetObservation & {
    clipping: { edge: number; limit: number }[];
  } {
    assert.ok(isRecord(value));
    assert.equal(typeof value.target, "string");
    assert.equal(typeof value.target_count, "number");
    assert.equal(typeof value.visible, "boolean");
    assert.ok(value.rect === null || isRecord(value.rect));
    if (value.rect)
      for (const field of ["x", "y", "width", "height"])
        assert.equal(typeof value.rect[field], "number");
    assert.ok(isRecord(value.viewport));
    for (const field of ["width", "height"]) assert.equal(typeof value.viewport[field], "number");
    assert.ok(Array.isArray(value.clipping));
    const clipping: unknown[] = value.clipping;
    for (const edge of clipping) {
      assert.ok(isRecord(edge));
      assert.equal(typeof edge.edge, "number");
      assert.equal(typeof edge.limit, "number");
    }
  }
  for (const scrollable of [true, false]) {
    let y = 348.1171875;
    let captures = 0;
    let outlineWidth = "3px";
    const tabTransitions: string[] = [];
    const identity = "library:card-more:opengoal-jak1";
    const selector = `button[data-detail-origin=${JSON.stringify(identity)}]`;
    const primarySelector =
      '.library-entry-footer .library-card-action:not(:disabled):not([aria-disabled="true"])';
    const footerSelector = `.collection-entry:has(${selector}) ${primarySelector}`;
    const main = {
      tagName: "MAIN",
      className: "workspace-main",
      parentElement: null,
      clientWidth: 683,
      clientHeight: 384,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 683,
        bottom: 384,
        width: 683,
        height: 384,
      }),
    };
    class Button {
      tabIndex = 0;
      parentElement = main;
      readonly name: string;
      constructor(name: string) {
        this.name = name;
      }
      closest(query: string) {
        return query === ".collection-entry" ? card : null;
      }
      matches() {
        return false;
      }
      getClientRects() {
        return [this.getBoundingClientRect()];
      }
      getBoundingClientRect() {
        const top = y + (this.name === "more" ? 0 : this.name === "secondary" ? 40 : 80);
        return {
          x: 220,
          y: top,
          left: 220,
          top,
          right: 256,
          bottom: top + 36,
          width: 36,
          height: 36,
        };
      }
      getAttribute(name: string) {
        return name === "aria-label" ? `${this.name} action` : null;
      }
    }
    const more = Object.assign(new Button("more"), {
      getAttribute: (name: string) => {
        assert.equal(name, "data-detail-origin");
        return identity;
      },
      scrollIntoView: (options: unknown) => {
        assert.equal(
          JSON.stringify(options),
          JSON.stringify({ block: "center", inline: "nearest", behavior: "instant" }),
        );
        if (scrollable) y = 174;
      },
    });
    // An update-review button precedes the primary action in the actual footer.
    const secondary = new Button("secondary");
    const primary = new Button("primary");
    const tabOrder = [more, secondary, primary];
    const card = {
      tagName: "ARTICLE",
      className: "collection-entry",
      parentElement: main,
      clientWidth: 420,
      clientHeight: 132,
      getBoundingClientRect: () => ({
        left: 200,
        top: y - 8,
        right: 620,
        bottom: y + 124,
        width: 420,
        height: 132,
      }),
      contains: (element: unknown) => tabOrder.some((button) => button === element),
      querySelector: (query: string) =>
        query === primarySelector
          ? primary
          : query.includes(".library-entry-footer")
            ? secondary
            : null,
      querySelectorAll: () => tabOrder,
    };
    for (const button of tabOrder) Object.assign(button, { parentElement: card });
    const document = {
      activeElement: more as Button,
      hasFocus: () => true,
      readyState: "complete",
      documentElement: {},
      body: {},
      fonts: { status: "loaded" },
      images: [],
      querySelector: (query: string) =>
        query === selector ? more : query === 'main[data-focus-region="workspace"]' ? main : null,
      querySelectorAll: (query: string) =>
        query === selector ? [more] : query === footerSelector ? [primary] : [],
    };
    const execute = async (_browser: unknown, fn: unknown, ...args: unknown[]) => {
      assert.ok(typeof fn === "function");
      const result: unknown = runInNewContext(`(${fn.toString()})(...args)`, {
        args,
        document,
        HTMLButtonElement: Button,
        innerWidth: 683,
        innerHeight: 384,
        devicePixelRatio: 2,
        localStorage: { getItem: () => "200" },
        getComputedStyle: (element: unknown) => ({
          display: "block",
          visibility: "visible",
          opacity: "1",
          overflowX: element === main ? "auto" : "visible",
          overflowY: element === main ? "auto" : "visible",
          outlineStyle:
            element === primary && document.activeElement === primary ? "solid" : "none",
          outlineWidth,
          outlineOffset: "3px",
        }),
      });
      return result;
    };
    const browser = {
      executeScript: (fn: unknown, ...args: unknown[]) => execute(null, fn, ...args),
      wait: async (predicate: () => Promise<boolean>, milliseconds: number, message: string) => {
        assert.equal(milliseconds, 5_000);
        assert.equal(await predicate(), true, message);
      },
      actions: () => {
        let shift = false;
        let direction = 0;
        const actions = {
          keyDown: (key: unknown) => {
            assert.equal(key, "fixture-shift");
            shift = true;
            return actions;
          },
          sendKeys: (key: unknown) => {
            assert.equal(key, "fixture-tab");
            direction = shift ? -1 : 1;
            return actions;
          },
          keyUp: (key: unknown) => {
            assert.equal(key, "fixture-shift");
            shift = false;
            return actions;
          },
          perform: async () => {
            assert.notEqual(direction, 0);
            const next = tabOrder[tabOrder.indexOf(document.activeElement) + direction];
            assert.ok(next, "The controlled Tab path must remain in the owned card");
            document.activeElement = next;
            tabTransitions.push(next.name);
          },
        };
        return actions;
      },
    } as unknown as WebDriver;
    const clipped = await execute(null, observeVisibleTarget, selector, "visual");
    assertObservation(clipped);
    assert.equal(clipped.visible, false);
    const clippedEdge = clipped.clipping[0];
    assert.ok(clippedEdge);
    assert.equal(clippedEdge.edge, 384.1171875);
    assert.equal(clippedEdge.limit, 384);
    assert.throws(() => requireCompleteCaptureTarget(clipped, selector));
    const artifacts: string[] = [];
    let moveDuringCapture = false;
    const changedDuringCapture = new Error("owned target moved during capture");
    const captureVisual = async (options: {
      observeTarget: () => Promise<ReturnType<typeof observeVisibleTarget>>;
      readiness: () => Promise<{ ready: boolean }>;
      target: string;
      scenario: string;
      name: string;
    }) => {
      captures++;
      const footer = options.name.endsWith("-footer");
      const expectedTarget = footer ? footerSelector : selector;
      assert.equal(options.target, expectedTarget);
      assert.equal(options.scenario, "native-library-layout");
      assert.equal(
        options.name,
        footer ? "library-dark-covers-200-footer" : "library-dark-covers-200",
      );
      const readiness: unknown = await options.readiness();
      assert.ok(isRecord(readiness));
      assert.equal(readiness.ready, true);
      if (footer) {
        assert.equal(readiness.tabPresses, 2);
        assert.ok(isRecord(readiness.point));
        assert.equal(readiness.point.name, "primary action");
        assert.equal(readiness.point.ring, 6);
        assert.deepEqual(tabTransitions, ["secondary", "primary"]);
      }
      const before = await options.observeTarget();
      requireCompleteCaptureTarget(before, expectedTarget);
      if (moveDuringCapture) {
        y += 1;
        await assert.rejects(options.observeTarget(), /changed during screenshot/);
        throw changedDuringCapture;
      }
      assert.equal(JSON.stringify(await options.observeTarget()), JSON.stringify(before));
      assert.equal(document.activeElement, footer ? primary : more);
      return {
        image: { path: `owned-output/${footer ? "footer" : "more"}.png` },
        receipt: `owned-output/${footer ? "footer" : "more"}.json`,
      };
    };
    installCapture(captureVisual);
    const capture = captureLibraryAction(
      browser,
      more as unknown as WebElement,
      "owned-output",
      "dark",
      "Covers",
      artifacts,
    );
    if (scrollable) {
      await capture;
      assert.deepEqual(artifacts, [
        "owned-output/more.png",
        "owned-output/more.json",
        "owned-output/footer.png",
        "owned-output/footer.json",
      ]);
      assert.equal(captures, 2);
      assert.deepEqual(tabTransitions, ["secondary", "primary", "secondary", "more"]);
      assert.equal(document.activeElement, more);
      moveDuringCapture = true;
      const refusedArtifacts: string[] = [];
      await assert.rejects(
        captureLibraryAction(
          browser,
          more as unknown as WebElement,
          "owned-output",
          "dark",
          "Covers",
          refusedArtifacts,
        ),
        (error) => error === changedDuringCapture,
      );
      assert.deepEqual(refusedArtifacts, []);
      moveDuringCapture = false;
      outlineWidth = "0px";
      tabTransitions.length = 0;
      const ringRefusedArtifacts: string[] = [];
      await assert.rejects(
        captureLibraryAction(
          browser,
          more as unknown as WebElement,
          "owned-output",
          "dark",
          "Covers",
          ringRefusedArtifacts,
        ),
        /focus ring must fit/,
      );
      assert.deepEqual(ringRefusedArtifacts, ["owned-output/more.png", "owned-output/more.json"]);
      assert.equal(captures, 4);
    } else {
      await assert.rejects(Promise.resolve(capture), /one identified visible target/);
      assert.equal(captures, 0);
      assert.deepEqual(artifacts, []);
    }
  }
}

void test("Library native capture centers fractional clipping before strict settled capture and refuses unscrollable clipping", async () => {
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        new URL("../apps/desktop/scripts/desktop-preparation-test.mts", import.meta.url),
        `
        import {runInNewContext} from 'node:vm';
        import {isRecord} from ${JSON.stringify(new URL("./runtime-values.mts", import.meta.url).href)};
        import {observeVisibleTarget} from ${JSON.stringify(new URL("../apps/desktop/scripts/browser-readiness.mts", import.meta.url).href)};
        import {requireCompleteCaptureTarget} from ${JSON.stringify(new URL("../apps/desktop/test/capture-target.ts", import.meta.url).href)};
        mock.module('selenium-webdriver',{namedExports:{
          WebDriver:class{},Session:class{},Capabilities:class{},
          By:{css:value=>({using:'css selector',value})},Key:{TAB:'fixture-tab',SHIFT:'fixture-shift'},until:{},
        }});
        let captureVisual;
        mock.module(new URL('../../../scripts/native-readiness.mts',entry).href, {namedExports:{
          captureSettledVisual:(...args)=>captureVisual(...args),
        }});
        const {captureLibraryAction}=await import(entry);
        await (${libraryCaptureBehavior.toString()})(captureLibraryAction, callback=>{captureVisual=callback;});
      `,
        variant === "original" ? undefined : { exportName: "captureLibraryAction", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

void test("native preflight retains the exact refused observation without another probe or overwriting evidence", async (t) => {
  const { readFile, writeFile, mkdtemp, lstat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { isRecord } = await import("./runtime-values.mts");
  const output = await mkdtemp(path.join(tmpdir(), "portcove-native-capture-"));
  t.after(async () => {
    assert.equal(path.dirname(output), tmpdir());
    await rm(output, { recursive: true });
  });
  for (const mode of ["recorded", "existing", "oversized-metadata"]) {
    const name = `about-${mode}`;
    const file = path.join(output, `${name}-capture-failure.json`);
    if (mode === "existing") await writeFile(file, "original evidence");
    let probes = 0;
    let captures = 0;
    let restored = false;
    const attributes = new Map<string, string>();
    const element = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => {
        attributes.delete(name);
        restored = true;
      },
      scrollIntoView() {},
    };
    const observation = {
      target: `[data-capture-target="native-${name}"]`,
      target_count: 1,
      visible: true,
      rect: { x: 0, y: 0, width: 200, height: 641 },
      viewport: { width: 640, height: 640 },
      ...(mode === "oversized-metadata" ? { diagnostic: "x".repeat(16384) } : {}),
    };
    const browser: Pick<WebDriver, "executeScript" | "takeScreenshot"> = {
      async executeScript<Result>(
        script: Parameters<WebDriver["executeScript"]>[0],
        ...args: unknown[]
      ): Promise<Result> {
        if (script === observeVisibleTarget) {
          probes++;
          return observation as Result;
        }
        assert.equal(typeof script, "function");
        assert.ok(typeof script === "function");
        const callback = script as (...args: unknown[]) => unknown;
        const value: unknown = await callback(...args);
        return value as Result;
      },
      async takeScreenshot() {
        captures++;
        throw new Error("Unexpected screenshot");
      },
    };
    const artifacts: string[] = [];
    await assert.rejects(
      captureKeyboardTarget({ browser, output, artifacts }, name, element as unknown as WebElement),
      /exceeds viewport; capture identified title\/actions instead/,
    );
    assert.equal(probes, 1);
    assert.equal(captures, 0);
    assert.equal(restored, true);
    if (mode === "recorded") {
      const body = await readFile(file);
      assert.ok(body.byteLength <= 16384);
      const receipt: unknown = JSON.parse(body.toString("utf8"));
      assert.ok(isRecord(receipt));
      assert.equal(receipt.outcome, "failed");
      assert.equal(receipt.target, observation.target);
      assert.equal(receipt.preflight_complete, false);
      assert.equal(receipt.acceptance, false);
      assert.deepEqual(receipt.preflight_observation, observation);
    } else if (mode === "existing") assert.equal(await readFile(file, "utf8"), "original evidence");
    else await assert.rejects(lstat(file), { code: "ENOENT" });
  }
});

void test("the real native entrypoint delegates capture context and arguments to the imported helper", async () => {
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  // Policy wiring, not a behavioral surrogate: the real native journey still
  // checks refused capture; imported-helper tests exercise the decisions here.
  function delegation(input: string) {
    const code = stripTypeScriptTypes(input, { mode: "strip" });
    const imported =
      /import\s*\{\s*captureKeyboardTarget(?:\s+as\s+(\w+))?\s*\}\s*from\s*["']\.\/desktop-capture-target\.mts["']/u.exec(
        code,
      );
    assert.ok(imported, "Native entrypoint must import the capture helper");
    const alias = imported[1] ?? "captureKeyboardTarget";
    const wrapper = new RegExp(
      String.raw`async\s+function\s+captureKeyboardTarget\s*\(\s*(?<name>\w+)\s*,\s*(?<element>\w+)\s*,\s*(?<scenario>\w+)\s*=\s*["']keyboard-layout["']\s*,?\s*\)\s*\{\s*return[ \t]+(?:await\s+)?${alias}\s*\(\s*\{(?<context>[^{}]*)\}\s*,\s*\k<name>\s*,\s*\k<element>\s*,\s*\k<scenario>\s*,?\s*\)\s*;?\s*\}`,
      "u",
    ).exec(code);
    assert.ok(wrapper?.groups, "Native capture wrapper must forward all three arguments");
    const properties = wrapper.groups
      .context!.split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    assert.equal(properties.length, 3);
    assert(properties.some((value) => /^browser\s*:\s*driverBrowser\s*\(\s*\)$/u.test(value)));
    assert(properties.some((value) => /^output(?:\s*:\s*output)?$/u.test(value)));
    assert(properties.some((value) => /^artifacts(?:\s*:\s*artifacts)?$/u.test(value)));
    return wrapper[0];
  }
  const erased = stripTypeScriptTypes(source, { mode: "strip" });
  const wrapper = delegation(erased);
  assert.throws(
    () => delegation(erased.replace(wrapper, "async function removedCapture() {}")),
    /must forward/,
  );
  assert.throws(
    () =>
      delegation(
        erased.replace(
          /captureNativeKeyboardTarget\s*\(\s*\{/u,
          "captureNativeKeyboardTarget({}, {",
        ),
      ),
    /must forward/,
  );
  for (const [from, to] of [
    [/\boutput\b/u, "output: anotherDirectory"],
    [/\bartifacts\b/u, "artifacts: anotherArray"],
    [/driverBrowser\(\)/u, "unrelatedBrowser()"],
  ] as const)
    assert.throws(() => delegation(erased.replace(wrapper, wrapper.replace(from, to))));
  assert.throws(
    () =>
      delegation(
        erased.replace(
          wrapper,
          wrapper.replace("function captureKeyboardTarget", "function decoyCapture"),
        ),
      ),
    /must forward/,
  );
  delegation(
    erased.replace(
      wrapper,
      wrapper
        .replace(/\boutput\b/u, "output: output")
        .replace(/\bartifacts\b/u, "artifacts: artifacts"),
    ),
  );
  delegation(
    source
      .replaceAll("captureNativeKeyboardTarget", "renamedCaptureHelper")
      .replaceAll("scenarioId", "renamedScenario")
      .replace(/renamedCaptureHelper\s*\(/u, "renamedCaptureHelper(\n"),
  );
});
