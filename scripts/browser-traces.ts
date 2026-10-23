import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { isRecord } from "./runtime-values.mts";
import path from "node:path";
import type { Reporter } from "vite-plus/test/node";
import { resolvePhysicalPath } from "./dev-storage.mts";

/** One invocation owns one namespace; previous failures never share its names. */
export function createBrowserTraceRun(root: string, requestedNamespace?: string) {
  const traceRoot = path.resolve(root, "work/bt");
  const physicalRoot = resolvePhysicalPath(root);
  const physicalTraceRoot = resolvePhysicalPath(traceRoot);
  const relative = path.relative(physicalRoot, physicalTraceRoot);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("Browser trace root resolves outside the checkout");
  const parent = requestedNamespace ? path.resolve(requestedNamespace) : traceRoot;
  const physicalParent = resolvePhysicalPath(parent);
  if (
    requestedNamespace &&
    (path.dirname(physicalParent) !== physicalTraceRoot ||
      !/^run-[A-Za-z0-9-]+$/u.test(path.basename(parent)))
  )
    throw new Error("Browser trace namespace must be an owned run below the trace root");
  const directory = path.join(parent, `run-${randomUUID()}`);
  const screenshotDirectory = path.join(directory, "screenshots");
  const physicalDirectory = path.join(physicalParent, path.basename(directory));
  if (existsSync(directory)) throw new Error("Browser trace namespace already exists");
  const reporter = {
    onTestCaseAnnotate(_testCase, annotation) {
      if (annotation.type !== "capture-target") return;
      const attachment = annotation.attachment;
      if (attachment?.contentType !== "application/json" || attachment.body === undefined)
        throw new Error("Capture annotation requires inline JSON bytes");
      let body: Buffer;
      if (attachment.bodyEncoding === "base64") {
        if (
          typeof attachment.body !== "string" ||
          attachment.body.length > 4 * Math.ceil(16384 / 3)
        )
          throw new Error("Capture annotation exceeds16KiB");
        body = Buffer.from(attachment.body, "base64");
        if (body.toString("base64") !== attachment.body)
          throw new Error("Capture annotation has invalid base64");
      } else {
        if (Buffer.byteLength(attachment.body) > 16384)
          throw new Error("Capture annotation exceeds16KiB");
        body = Buffer.from(attachment.body);
      }
      if (body.byteLength > 16384) throw new Error("Capture annotation exceeds16KiB");
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      if (
        !isRecord(parsed) ||
        !isRecord(parsed.capture_target) ||
        !["captured", "refused"].includes(String(parsed.capture_target.outcome))
      )
        throw new Error("Capture annotation requires a capture outcome");
      const captures = path.join(root, ".vitest/attachments/capture-target");
      const physicalCaptures = resolvePhysicalPath(captures);
      const captureRelative = path.relative(physicalRoot, physicalCaptures);
      if (
        path.isAbsolute(captureRelative) ||
        captureRelative === ".." ||
        captureRelative.startsWith(`..${path.sep}`)
      )
        throw new Error("Capture annotation directory resolves outside the checkout");
      mkdirSync(captures, { recursive: true });
      if (resolvePhysicalPath(captures) !== physicalCaptures)
        throw new Error("Capture annotation directory changed physical identity");
      writeFileSync(path.join(captures, `${randomUUID()}.json`), body, { flag: "wx" });
    },
    onTestRunEnd(_modules, _errors, reason) {
      if (reason !== "passed" || !existsSync(directory)) return;
      // Recheck physical identity immediately before deleting this invocation's
      // successful raw resources. Keep failed retries even if the run passed.
      if (
        resolvePhysicalPath(parent) !== physicalParent ||
        resolvePhysicalPath(directory) !== physicalDirectory
      )
        throw new Error("Browser trace namespace changed physical identity");
      if (
        readdirSync(directory, { recursive: true, withFileTypes: true }).some(
          (file) =>
            file.isFile() &&
            (file.name.endsWith(".zip") ||
              path.relative(directory, file.parentPath).split(path.sep)[0] === "screenshots"),
        )
      )
        return;
      rmSync(directory, { recursive: true });
    },
  } satisfies Reporter;
  return { directory, screenshotDirectory, reporter };
}
