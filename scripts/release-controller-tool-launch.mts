/** Dependency-free fixed bootstrap launcher. No install, imported authority,
 * arbitrary entry selection, role key or candidate program is accepted. */
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import type { ControllerToolArtifactExpected } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";
import { currentPayloadJobDeadline } from "./release-signing-job-budget.mts";

const started = performance.now();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function launchFixedPayloadController(raw: unknown, parent: string) {
  let deadline = started + 570000;
  const active = () => {
    if (performance.now() >= deadline)
      throw new Error("fixed tool launcher role deadline exhausted");
  };
  active();
  const input: unknown = structuredClone(raw);
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(",") !== "configuration,native_locators,signer_identity,tools" ||
    !isRecord(input.tools) ||
    Object.keys(input.tools).sort().join(",") !== "artifact,bundle" ||
    !isRecord(input.tools.artifact) ||
    !isRecord(input.tools.bundle) ||
    !path.isAbsolute(parent)
  )
    throw new Error("fixed payload launcher fields differ");
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH)
    throw new Error("fixed launcher forbids ambient Node hooks");
  deadline = currentPayloadJobDeadline(
    inspectAssemblerIdentityExpectation(input.signer_identity),
    parent,
    deadline,
  );
  const receipt = await receiveControllerTools(
    parent,
    input.tools.artifact as unknown as ControllerToolArtifactExpected,
    input.tools.bundle as unknown as { artifact_id: number; sha256: string },
    { deadline },
  );
  const tools = await verifiedControllerToolPaths(receipt);
  if (
    sha(await readControllerToolFile(process.execPath)) !==
    sha(await readControllerToolFile(tools.node))
  )
    throw new Error("running Node differs from authenticated controller executable");
  active();
  const entry = tools.entries["release-signing-controller"];
  if (typeof entry !== "string") throw new Error("authenticated fixed payload entry absent");
  // Only this manifest-owned fixed entry can execute. The bundle re-verifies
  // custody itself; its module-private tool brand is never imported from here.
  const worker = (await import(
    pathToFileURL(entry).href
  )) as typeof import("./release-signing-controller.mts");
  await verifiedControllerToolPaths(receipt);
  active();
  if (typeof worker.runFixedPayloadContextConfiguration !== "function")
    throw new Error("fixed bundled controller interface unavailable");
  const result = await worker.runFixedPayloadContextConfiguration(input, parent, deadline);
  active();
  return result;
}

if (
  process.argv[1] &&
  /^release-controller-tool-launch(?:\.mts|(?:\.bundle)?\.mjs)$/u.test(
    path.basename(process.argv[1]),
  ) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3) throw new Error("fixed payload configuration required");
    const raw: unknown = JSON.parse(
      (await readControllerToolFile(process.argv[2]!, 65536)).toString("utf8"),
    );
    const result = await launchFixedPayloadController(
      raw,
      fileURLToPath(new URL("..", import.meta.url)),
    );
    process.exitCode = result.decision === "payload-and-context-prepared" ? 0 : 2;
  } catch {
    console.error("fixed verified-tool payload launcher refused; retain public custody receipts");
    process.exitCode = 2;
  }
}
