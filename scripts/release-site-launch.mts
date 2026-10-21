/** Builtins-only entry into the fixed attested whole-site controller. */
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { currentSiteJobDeadline } from "./release-site-job-budget.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import { isRecord } from "./runtime-values.mts";
const started = performance.now();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function launchFixedSiteController(
  raw: unknown,
  parent: string,
  phaseDeadline?: number,
) {
  let deadline = Math.min(started + 290000, phaseDeadline ?? Infinity);
  const active = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("fixed site launcher deadline exhausted");
  };
  active();
  const input: unknown = structuredClone(raw);
  if (
    !isRecord(input) ||
    !(
      Object.keys(input).sort().join(",") === "context,identity,publication_result,roles,tools" ||
      (input.mode === "metadata" &&
        Object.keys(input).sort().join(",") === "context,identity,mode,roles,tools")
    ) ||
    !isRecord(input.tools) ||
    Object.keys(input.tools).sort().join(",") !== "artifact,bundle" ||
    !path.isAbsolute(parent)
  )
    throw new Error("fixed site launcher fields differ");
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH)
    throw new Error("site launcher forbids ambient Node hooks");
  deadline = currentSiteJobDeadline(
    inspectAssemblerIdentityExpectation(input.identity),
    parent,
    deadline,
  );
  const receipt = await receiveControllerTools(
    parent,
    input.tools.artifact as ControllerToolArtifactExpected,
    input.tools.bundle as { artifact_id: number; sha256: string },
    { deadline },
  );
  const tools = await verifiedControllerToolPaths(receipt);
  if (
    hash(await readControllerToolFile(process.execPath)) !==
    hash(await readControllerToolFile(tools.node))
  )
    throw new Error("running Node differs from authenticated site controller");
  const entry = tools.entries["release-site-controller"];
  if (typeof entry !== "string") throw new Error("authenticated fixed site entry unavailable");
  active();
  const worker = (await import(
    pathToFileURL(entry).href
  )) as typeof import("./release-site-controller.mts");
  await verifiedControllerToolPaths(receipt);
  active();
  if (typeof worker.runFixedSiteConfiguration !== "function")
    throw new Error("fixed site bundle interface unavailable");
  const result = await worker.runFixedSiteConfiguration(input, parent, deadline);
  active();
  return result;
}
if (
  process.argv[1] &&
  /^release-site-launch(?:[.]mts|(?:[.]bundle)?[.]mjs)$/u.test(path.basename(process.argv[1])) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3 || !process.env.RUNNER_TEMP)
      throw new Error("fixed site configuration and runner root required");
    const input: unknown = JSON.parse(
      (await readControllerToolFile(process.argv[2]!, 65536)).toString("utf8"),
    );
    console.log(JSON.stringify(await launchFixedSiteController(input, process.env.RUNNER_TEMP)));
  } catch {
    console.error(
      "fixed verified whole-site launcher refused; retain evidence and original pending intent",
    );
    process.exitCode = 1;
  }
}
