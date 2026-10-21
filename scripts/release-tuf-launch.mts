/** Builtins-only launcher; role jobs never resolve source dependencies/hooks. */
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
import { isRecord } from "./runtime-values.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import { currentTufJobDeadline } from "./release-tuf-job-budget.mts";
const started = performance.now(),
  hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function launchFixedTufController(
  raw: unknown,
  parent: string,
  phaseDeadline?: number,
) {
  let deadline = Math.min(started + 115000, phaseDeadline ?? Infinity);
  const active = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("fixed TUF launcher deadline exhausted");
  };
  active();
  const input: unknown = structuredClone(raw);
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(",") !== "context,dependencies,identity,role,tools" ||
    !["releases", "preview", "stable", "snapshot", "timestamp"].includes(String(input.role)) ||
    !isRecord(input.tools) ||
    Object.keys(input.tools).sort().join(",") !== "artifact,bundle" ||
    !isRecord(input.tools.artifact) ||
    !isRecord(input.tools.bundle) ||
    !path.isAbsolute(parent)
  )
    throw new Error("fixed TUF launcher fields differ");
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH)
    throw new Error("fixed TUF launcher forbids ambient Node hooks");
  deadline = currentTufJobDeadline(
    input.role,
    inspectAssemblerIdentityExpectation(input.identity),
    parent,
    deadline,
  );
  const receipt = await receiveControllerTools(
      parent,
      input.tools.artifact as unknown as ControllerToolArtifactExpected,
      input.tools.bundle as unknown as { artifact_id: number; sha256: string },
      { deadline },
    ),
    tools = await verifiedControllerToolPaths(receipt);
  if (
    hash(await readControllerToolFile(process.execPath)) !==
    hash(await readControllerToolFile(tools.node))
  )
    throw new Error("running Node differs from authenticated TUF controller executable");
  const entry = tools.entries["release-tuf-controller"];
  if (typeof entry !== "string") throw new Error("authenticated fixed TUF entry absent");
  active();
  const worker = (await import(
    pathToFileURL(entry).href
  )) as typeof import("./release-tuf-controller.mts");
  await verifiedControllerToolPaths(receipt);
  active();
  if (typeof worker.runFixedTufRoleConfiguration !== "function")
    throw new Error("fixed bundled TUF controller interface unavailable");
  const result = await worker.runFixedTufRoleConfiguration(input, parent, deadline);
  active();
  return result;
}
if (
  process.argv[1] &&
  /^release-tuf-launch(?:\.mts|(?:\.bundle)?\.mjs)$/u.test(path.basename(process.argv[1])) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3) throw new Error("fixed TUF configuration required");
    const input: unknown = JSON.parse(
        (await readControllerToolFile(process.argv[2]!, 65536)).toString("utf8"),
      ),
      parent = process.env.RUNNER_TEMP;
    if (!parent || !path.isAbsolute(parent)) throw new Error("private TUF runner root missing");
    console.log(JSON.stringify(await launchFixedTufController(input, parent)));
  } catch {
    console.error("fixed verified-tool TUF launcher refused; retain public custody receipts");
    process.exitCode = 1;
  }
}
