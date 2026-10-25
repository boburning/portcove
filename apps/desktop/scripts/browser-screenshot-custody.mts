import assert, { AssertionError } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserType } from "playwright";
import { createBrowserTraceRun } from "../../../scripts/browser-traces.ts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { resolvePhysicalPath } from "../../../scripts/dev-storage.mts";
import { createProbeArtifactReader } from "./browser-trace-probe.mts";

export const screenshotRoutes = ["fast", "full", "contributor"] as const;
export const screenshotFailure = "PORTCOVE_EXPECTED_SCREENSHOT_ONLY_FAILURE";
const actualTitle = "Portcove screenshot custody probe";
const expectedTitle = "Intentional different title";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function screenshotContext(env: NodeJS.ProcessEnv) {
  const source = env.GITHUB_SHA,
    run = env.GITHUB_RUN_ID,
    attempt = env.GITHUB_RUN_ATTEMPT;
  if (
    !source ||
    !/^[a-f0-9]{40}$/u.test(source) ||
    !run ||
    !/^[1-9][0-9]*$/u.test(run) ||
    !attempt ||
    !/^[1-9][0-9]*$/u.test(attempt)
  )
    throw new Error("Screenshot custody needs exact source, run and attempt");
  return { source, run, attempt };
}

/** A real rendered assertion fails without ever starting tracing. Publish only
 * after screenshot capture and acknowledged browser shutdown, then fail normally. */
export async function runScreenshotOnlyProbe(
  chromium: Pick<BrowserType, "launch">,
  root: string,
  route: string,
  env: NodeJS.ProcessEnv,
) {
  assert.ok(
    screenshotRoutes.some((value) => value === route),
    "Unknown screenshot custody route",
  );
  const context = screenshotContext(env);
  const checkout = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  }).trim();
  assert.equal(checkout, context.source);
  const run = createBrowserTraceRun(root);
  mkdirSync(run.screenshotDirectory, { recursive: true });
  const receiptDirectory = path.join(root, ".vitest/attachments/browser-artifact-custody");
  const relative = path.relative(resolvePhysicalPath(root), resolvePhysicalPath(receiptDirectory));
  assert.ok(
    !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`),
  );
  mkdirSync(receiptDirectory, { recursive: true });
  const receipt = path.join(receiptDirectory, `${route}.json`);
  assert.equal(existsSync(receipt), false, "Screenshot custody receipt must be fresh");
  const screenshot = path.join(run.screenshotDirectory, "failure.png");
  const browser = await chromium.launch({ headless: true });
  let original: AssertionError | undefined;
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    await page.setContent(
      `<title>${actualTitle}</title><h1>Screenshot-only failure</h1><p>Trace recording is deliberately never started.</p>`,
    );
    try {
      assert.equal(await page.title(), expectedTitle, screenshotFailure);
    } catch (error) {
      if (
        !(error instanceof AssertionError) ||
        error.actual !== actualTitle ||
        error.expected !== expectedTitle
      )
        throw error;
      original = error;
      await page.screenshot({ path: screenshot });
    }
  } finally {
    await browser.close();
  }
  assert.ok(original, "The diagnostic assertion unexpectedly passed");
  const png = createProbeArtifactReader(run.directory).read(screenshot, 16 * 1024 * 1024);
  writeFileSync(
    receipt,
    JSON.stringify({
      format_version: 1,
      ...context,
      checkout,
      route,
      browser_closed: true,
      trace_started: false,
      failure: {
        name: original.name,
        code: original.code,
        marker: screenshotFailure,
        actual: original.actual,
        expected: original.expected,
      },
      screenshot: {
        path: path.relative(root, screenshot).replaceAll("\\", "/"),
        sha256: digest(png),
        bytes: png.length,
      },
    }) + "\n",
    { flag: "wx" },
  );
  console.error(`Screenshot-only failure retained after browser close: ${receipt}`);
  throw original;
}

/** Verify downloaded bytes; fixture packets and real producer execution remain
 * distinct until the matching hosted job/step outcomes also pass below. */
export function verifyScreenshotPacket(
  directory: string,
  route: string,
  context: ReturnType<typeof screenshotContext>,
) {
  const reader = createProbeArtifactReader(directory);
  const entries = reader.list();
  assert.ok(
    entries.every((entry) => entry.isFile() || entry.isDirectory()),
    "Packet contains redirected or unsupported entries",
  );
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    )
    .sort();
  const receiptPath = `.vitest/attachments/browser-artifact-custody/${route}.json`;
  const value: unknown = JSON.parse(
    reader.read(path.join(directory, receiptPath), 16384).toString("utf8"),
  );
  assert.ok(isRecord(value) && isRecord(value.failure) && isRecord(value.screenshot));
  assert.deepEqual(
    {
      format_version: value.format_version,
      source: value.source,
      run: value.run,
      attempt: value.attempt,
      checkout: value.checkout,
      route: value.route,
      browser_closed: value.browser_closed,
      trace_started: value.trace_started,
      failure: value.failure,
    },
    {
      format_version: 1,
      ...context,
      checkout: context.source,
      route,
      browser_closed: true,
      trace_started: false,
      failure: {
        name: "AssertionError",
        code: "ERR_ASSERTION",
        marker: screenshotFailure,
        actual: actualTitle,
        expected: expectedTitle,
      },
    },
  );
  const screenshot = value.screenshot;
  assert.ok(
    typeof screenshot.path === "string" &&
      /^work\/bt\/run-[a-f0-9-]+\/screenshots\/failure\.png$/u.test(screenshot.path),
  );
  assert.deepEqual(
    files,
    [receiptPath, screenshot.path].sort(),
    "Packet must contain only its receipt and screenshot, without a trace ZIP",
  );
  const png = reader.read(path.join(directory, screenshot.path), 16 * 1024 * 1024);
  assert.equal(png.length, screenshot.bytes);
  assert.equal(digest(png), screenshot.sha256);
  assert.ok(png.length >= 24 && png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
  assert.equal(png.readUInt32BE(16), 640);
  assert.equal(png.readUInt32BE(20), 360);
  return { route, sha256: screenshot.sha256, bytes: png.length, screenshot: screenshot.path };
}

/** This fixed diagnostic has exactly four jobs and therefore fits one explicit
 * 100-row attempt page. Any larger, duplicate or partial inventory is refused. */
export function verifyScreenshotJobs(
  value: unknown,
  context: ReturnType<typeof screenshotContext>,
) {
  assert.ok(isRecord(value) && Array.isArray(value.jobs));
  assert.equal(value.total_count, 4);
  assert.equal(value.jobs.length, value.total_count);
  const ids = new Set<unknown>(),
    names = new Set<string>();
  for (const row of value.jobs) {
    assert.ok(isRecord(row) && Number.isSafeInteger(row.id));
    assert.ok(typeof row.name === "string");
    assert.ok(!ids.has(row.id) && !names.has(row.name));
    ids.add(row.id);
    names.add(row.name);
    assert.equal(String(row.run_id), context.run);
    assert.equal(row.head_sha, context.source);
  }
  assert.deepEqual(
    [...names].sort(),
    [
      "verify-screenshot-custody",
      ...screenshotRoutes.map((route) => `screenshot-only (${route})`),
    ].sort(),
  );
  for (const route of screenshotRoutes) {
    const job: unknown = value.jobs.find(
      (row: unknown) => isRecord(row) && row.name === `screenshot-only (${route})`,
    );
    assert.ok(isRecord(job) && Array.isArray(job.steps));
    assert.equal(job.status, "completed");
    assert.equal(job.conclusion, "failure");
    const steps: unknown[] = job.steps;
    for (const required of [
      "Install pinned dependencies",
      "Bootstrap Chromium",
      "Intentional screenshot-only failure",
      "Retain screenshot-only diagnostics",
    ])
      assert.equal(steps.filter((step) => isRecord(step) && step.name === required).length, 1);
    const numbers = new Set<unknown>();
    for (const step of steps) {
      assert.ok(isRecord(step) && Number.isSafeInteger(step.number) && !numbers.has(step.number));
      numbers.add(step.number);
      assert.equal(step.status, "completed");
      assert.equal(
        step.conclusion,
        step.name === "Intentional screenshot-only failure" ? "failure" : "success",
      );
    }
  }
}
