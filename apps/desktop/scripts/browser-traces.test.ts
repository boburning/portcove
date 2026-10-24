import { Buffer } from "node:buffer";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createBrowserTraceRun } from "../../../scripts/browser-traces.ts";

const temporary = path.resolve(os.tmpdir());
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(temporary, "portcove-browser-traces-"));
  roots.push(root);
  return root;
}
function raw(run: ReturnType<typeof createBrowserTraceRun>, name = "resources/frame.jpeg") {
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
  it("gives repeated invocations distinct names and retains raw resources for shutdown", () => {
    const root = fixture();
    const failed = createBrowserTraceRun(root);
    const succeeded = createBrowserTraceRun(root);
    expect(failed.directory).not.toBe(succeeded.directory);
    const retained = raw(failed, "same-test.trace.zip");
    raw(succeeded);
    failed.reporter.onTestRunEnd?.([], [], "failed");
    succeeded.reporter.onTestRunEnd?.([], [], "passed");
    expect(existsSync(retained)).toBe(true);
    expect(existsSync(succeeded.directory)).toBe(true);
  });
  it.each(["failed", "interrupted"] as const)("preserves unfinalized %s evidence", (reason) => {
    const run = createBrowserTraceRun(fixture());
    const file = raw(run);
    run.reporter.onTestRunEnd?.([], [], reason);
    expect(existsSync(file)).toBe(true);
  });
  it("retains a failed retry trace even if the complete run passes", () => {
    const run = createBrowserTraceRun(fixture());
    const file = raw(run, "retry.trace.zip");
    run.reporter.onTestRunEnd?.([], [], "passed");
    expect(existsSync(file)).toBe(true);
  });
  it("retains captured screenshots even when no finalized trace is available", () => {
    const run = createBrowserTraceRun(fixture());
    const file = raw(run, "screenshots/failure.png");
    run.reporter.onTestRunEnd?.([], [], "passed");
    expect(existsSync(file)).toBe(true);
  });
  it("materializes exact bounded capture annotations on success and refusal", () => {
    const root = fixture();
    const run = createBrowserTraceRun(root);
    for (const outcome of ["captured", "refused"]) {
      const body = Buffer.from(
        JSON.stringify({ capture_target: { label: "portrait 漢字", outcome } }) + "\n",
      );
      run.reporter.onTestCaseAnnotate?.({} as never, {
        message: "Capture target geometry",
        type: "capture-target",
        attachment: {
          contentType: "application/json",
          body: body.toString("base64"),
          bodyEncoding: "base64",
        },
      });
      const directory = path.join(root, ".vitest/attachments/capture-target");
      const files = readdirSync(directory);
      expect(files).toHaveLength(outcome === "captured" ? 1 : 2);
      expect(files.some((file) => readFileSync(path.join(directory, file)).equals(body))).toBe(
        true,
      );
    }
    raw(run);
    run.reporter.onTestRunEnd?.([], [], "passed");
    expect(existsSync(run.directory)).toBe(true);
    expect(readdirSync(path.join(root, ".vitest/attachments/capture-target"))).toHaveLength(2);
  });
  it("refuses malformed, oversized or redirected capture annotations without writing", () => {
    const root = fixture();
    const run = createBrowserTraceRun(root);
    const annotate = (body: string) =>
      run.reporter.onTestCaseAnnotate?.({} as never, {
        message: "Capture target geometry",
        type: "capture-target",
        attachment: { contentType: "application/json", body, bodyEncoding: "base64" },
      });
    expect(() => annotate("not base64!")).toThrow("invalid base64");
    expect(() => annotate(Buffer.alloc(16385).toString("base64"))).toThrow("exceeds16KiB");
    expect(() => annotate(Buffer.from("{}").toString("base64"))).toThrow("capture outcome");
    expect(existsSync(path.join(root, ".vitest"))).toBe(false);
    mkdirSync(path.join(root, ".vitest"));
    const outside = fixture();
    symlinkSync(outside, path.join(root, ".vitest/attachments"), "junction");
    expect(() =>
      annotate(
        Buffer.from(JSON.stringify({ capture_target: { outcome: "captured" } })).toString("base64"),
      ),
    ).toThrow("outside the checkout");
    expect(readdirSync(outside)).toHaveLength(0);
  });
  it("retains bounded accessibility rule and incomplete-finding packets on passing runs", () => {
    const root = fixture(),
      run = createBrowserTraceRun(root);
    const annotate = (packet: unknown) =>
      run.reporter.onTestCaseAnnotate?.({} as never, {
        message: "Accessibility state",
        type: "accessibility-audit",
        attachment: { contentType: "application/json", body: JSON.stringify(packet) },
      });
    const packet = {
      accessibility_audit: {
        format_version: 1,
        state: "library/rtl",
        rule_selection: "all default axe rules",
        passed_rules: ["button-name"],
        inapplicable_rules: ["image-alt"],
        violations: [],
        incomplete: [
          { id: "color-contrast", nodes: [{ target: ["h1"], failureSummary: "Needs review" }] },
        ],
      },
    };
    annotate(packet);
    run.reporter.onTestRunEnd?.([], [], "passed");
    const directory = path.join(root, ".vitest/attachments/accessibility-audit"),
      files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(directory, files[0]!), "utf8"))).toEqual(packet);
    expect(() => annotate({ accessibility_audit: { format_version: 1 } })).toThrow(
      "explicit audit state",
    );
    expect(() =>
      annotate({
        accessibility_audit: { ...packet.accessibility_audit, state: "x".repeat(20_000) },
      }),
    ).toThrow("exceeds16KiB");
    expect(readdirSync(directory)).toEqual(files);
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
  it("leaves a redirected trace directory and its external target untouched on completion", () => {
    const run = createBrowserTraceRun(fixture());
    mkdirSync(path.dirname(run.directory), { recursive: true });
    const outside = fixture();
    const retained = path.join(outside, "keep.txt");
    writeFileSync(retained, "keep");
    symlinkSync(outside, run.directory, "junction");
    expect(() => run.reporter.onTestRunEnd?.([], [], "passed")).not.toThrow();
    expect(readFileSync(retained, "utf8")).toBe("keep");
    expect(existsSync(retained)).toBe(true);
  });
});
