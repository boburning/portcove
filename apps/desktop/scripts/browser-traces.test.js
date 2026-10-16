import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createBrowserTraceRun } from "../../../scripts/browser-traces.ts";

const temporary = path.resolve(os.tmpdir());
const roots = [];
function fixture() {
  const root = mkdtempSync(path.join(temporary, "portcove-browser-traces-"));
  roots.push(root);
  return root;
}
function raw(run, name = "resources/frame.jpeg") {
  const file = path.join(run.directory, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "owned evidence");
  return file;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    assert.equal(path.dirname(root), temporary);
    assert.match(path.basename(root), /^portcove-browser-traces-/u);
    rmSync(root, { recursive: true });
  }
});

describe("browser trace invocation custody", () => {
  it("gives repeated invocations distinct names and cleans only successful raw resources", async () => {
    const root = fixture();
    const failed = createBrowserTraceRun(root);
    const succeeded = createBrowserTraceRun(root);
    expect(failed.directory).not.toBe(succeeded.directory);
    const retained = raw(failed, "same-test.trace.zip");
    raw(succeeded);
    await failed.reporter.onTestRunEnd([], [], "failed");
    await succeeded.reporter.onTestRunEnd([], [], "passed");
    expect(existsSync(retained)).toBe(true);
    expect(existsSync(succeeded.directory)).toBe(false);
  });
  it.each(["failed", "interrupted"])("preserves unfinalized %s evidence", async (reason) => {
    const run = createBrowserTraceRun(fixture());
    const file = raw(run);
    await run.reporter.onTestRunEnd([], [], reason);
    expect(existsSync(file)).toBe(true);
  });
  it("retains a failed retry trace even if the complete run passes", async () => {
    const run = createBrowserTraceRun(fixture());
    const file = raw(run, "retry.trace.zip");
    await run.reporter.onTestRunEnd([], [], "passed");
    expect(existsSync(file)).toBe(true);
  });
  it("retains captured screenshots even when no finalized trace is available", async () => {
    const run = createBrowserTraceRun(fixture());
    const file = raw(run, "screenshots/failure.png");
    await run.reporter.onTestRunEnd([], [], "passed");
    expect(existsSync(file)).toBe(true);
  });
  it("honors a probe's owned outer namespace without taking ownership of siblings", () => {
    const root = fixture();
    const parent = path.join(root, "work/bt/run-probe");
    const run = createBrowserTraceRun(root, parent);
    expect(path.dirname(run.directory)).toBe(parent);
    expect(() => createBrowserTraceRun(root, fixture())).toThrow("owned run");
    expect(() => createBrowserTraceRun(root, path.join(root, "work/bt/foreign"))).toThrow(
      "owned run",
    );
  });
  it("refuses cleanup after a directory is replaced by a link to another scope", async () => {
    const run = createBrowserTraceRun(fixture());
    mkdirSync(path.dirname(run.directory), { recursive: true });
    const outside = fixture();
    const retained = path.join(outside, "keep.txt");
    writeFileSync(retained, "keep");
    symlinkSync(outside, run.directory, "junction");
    expect(() => run.reporter.onTestRunEnd([], [], "passed")).toThrow("physical identity");
    expect(existsSync(retained)).toBe(true);
  });
});
