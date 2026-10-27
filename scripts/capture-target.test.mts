import assert from "node:assert/strict";
import test from "node:test";
import type { WebDriver, WebElement } from "selenium-webdriver";
import { captureKeyboardTarget } from "../apps/desktop/scripts/desktop-capture-target.mts";
import { observeVisibleTarget } from "../apps/desktop/scripts/browser-readiness.mts";
import {
  prepareCaptureTarget,
  requireCompleteCaptureTarget,
  requireUnchangedCaptureTarget,
} from "../apps/desktop/test/capture-target.ts";

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
