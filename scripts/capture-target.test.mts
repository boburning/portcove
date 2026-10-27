import assert from "node:assert/strict";
import test from "node:test";
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

void test("Library native capture centers fractional clipping before strict settled capture and refuses unscrollable clipping", async () => {
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const { observeVisibleTarget } = await import("../apps/desktop/scripts/browser-readiness.mts");
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
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-preparation-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    'const exactTarget = await more.getAttribute("data-detail-origin");',
  );
  const endText = "artifacts.push(capture.image.path, capture.receipt);";
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start);
  const executable = stripTypeScriptTypes(source.slice(start, end + endText.length));
  for (const scrollable of [true, false]) {
    let y = 348.1171875;
    let captures = 0;
    const identity = "library:card-more:opengoal-jak1";
    const selector = `button[data-detail-origin=${JSON.stringify(identity)}]`;
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
    const more = {
      parentElement: main,
      closest: () => null,
      getAttribute: (name: string) => {
        assert.equal(name, "data-detail-origin");
        return identity;
      },
      getBoundingClientRect: () => ({
        x: 220,
        y,
        left: 220,
        top: y,
        right: 256,
        bottom: y + 36,
        width: 36,
        height: 36,
      }),
      scrollIntoView: (options: unknown) => {
        assert.equal(
          JSON.stringify(options),
          JSON.stringify({ block: "center", inline: "nearest", behavior: "instant" }),
        );
        if (scrollable) y = 174;
      },
    };
    const document = {
      activeElement: more,
      readyState: "complete",
      documentElement: {},
      body: {},
      fonts: { status: "loaded" },
      images: [],
      querySelectorAll: (query: string) => (query === selector ? [more] : []),
    };
    const execute = async (_browser: unknown, fn: unknown, ...args: unknown[]) => {
      assert.ok(typeof fn === "function");
      const result: unknown = runInNewContext(`(${fn.toString()})(...args)`, {
        args,
        document,
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
        }),
      });
      return result;
    };
    const clipped = await execute(null, observeVisibleTarget, selector, "visual");
    assertObservation(clipped);
    assert.equal(clipped.visible, false);
    const clippedEdge = clipped.clipping[0];
    assert.ok(clippedEdge);
    assert.equal(clippedEdge.edge, 384.1171875);
    assert.equal(clippedEdge.limit, 384);
    assert.throws(() => requireCompleteCaptureTarget(clipped, selector));
    const capture: unknown = runInNewContext(`(async () => { ${executable} })()`, {
      assert,
      more,
      browser: {},
      output: "owned-output",
      theme: "dark",
      layout: "Covers",
      artifacts: [],
      observeVisibleTarget,
      prepareCaptureTarget,
      requireUnchangedCaptureTarget,
      executeBrowserScript: execute,
      captureSettledVisual: async (options: {
        observeTarget: () => Promise<ReturnType<typeof observeVisibleTarget>>;
        readiness: () => Promise<{ ready: boolean }>;
      }) => {
        captures++;
        assert.equal((await options.readiness()).ready, true);
        const before = await options.observeTarget();
        requireCompleteCaptureTarget(before, selector);
        assert.equal(JSON.stringify(await options.observeTarget()), JSON.stringify(before));
        assert.equal(document.activeElement, more);
        return {
          image: { path: "owned-output/capture.png" },
          receipt: "owned-output/capture.json",
        };
      },
    });
    if (scrollable) {
      await capture;
      assert.equal(captures, 1);
    } else {
      await assert.rejects(Promise.resolve(capture), /one identified visible target/);
      assert.equal(captures, 0);
    }
  }
});

void test("native preflight retains the exact refused observation without another probe or overwriting evidence", async (t) => {
  const { readFile, writeFile, mkdtemp, lstat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const { errorMessage, isRecord } = await import("./runtime-values.mts");
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function captureKeyboardTarget(");
  const end = source.indexOf("\nasync function ", start + 1);
  assert.ok(start >= 0 && end > start);
  const executable = stripTypeScriptTypes(source.slice(start, end));
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
    const observer = () => {};
    const observation = {
      target: `[data-capture-target="native-${name}"]`,
      target_count: 1,
      visible: true,
      rect: { x: 0, y: 0, width: 200, height: 641 },
      viewport: { width: 640, height: 640 },
      ...(mode === "oversized-metadata" ? { diagnostic: "x".repeat(16384) } : {}),
    };
    const extracted: unknown = runInNewContext(`${executable}; captureKeyboardTarget`, {
      driverBrowser: () => ({}),
      assert,
      output,
      path,
      writeFile,
      lstat,
      errorMessage,
      TextEncoder,
      artifacts: [],
      observeVisibleTarget: observer,
      prepareCaptureTarget,
      requireUnchangedCaptureTarget,
      executeBrowserScript: async (
        _session: unknown,
        fn: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ) => {
        if (fn === observer) {
          probes++;
          return observation;
        }
        return fn(...args);
      },
      captureSettledVisual: async () => {
        captures++;
        throw new Error("Unexpected screenshot");
      },
    });
    assert.ok(typeof extracted === "function");
    const capture = extracted as (name: string, element: unknown) => Promise<void>;
    await assert.rejects(
      capture(name, element),
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
