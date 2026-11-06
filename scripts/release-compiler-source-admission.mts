import { createHash } from "node:crypto";
import { localDeveloperCredential } from "./github-cli.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import {
  checkCoordinatorDeadline,
  coordinatorCommandDeadline,
} from "./release-coordinator-deadline.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  inspectReleaseCompilerSourceClosure,
  inspectPreparedCompilerSourceAsync,
  createCompilerSourceReader,
  compareCompilerClosure,
} from "./release-compiler-source.mts";
import type { PreparedCompilerSource } from "./release-compiler-source.mts";
const actualCompilerSource = new WeakMap<
  object,
  {
    candidate_tree: string;
    tools: object;
    closure_sha256: string;
    preparation: PreparedCompilerSource;
    controller: { source_commit: string; source_tree: string };
  }
>();
/** A raw JSON closure cannot appoint trusted source. The existing tool receiver
 * must have authenticated and retained the exact manifest-owned generated asset
 * in this process, including its full original artifact/Sigstore binding. */
export async function compareVerifiedReleaseCompilerSource(
  toolsReceipt: object,
  rawCandidate: PreparedCompilerSource,
  rawController: { source_commit: string; source_tree: string },
  readToken?: string,
) {
  const candidate = structuredClone(rawCandidate);
  const controller = structuredClone(rawController);
  const scopedEnvironment = readOnlyReleaseChildEnvironment();
  const environment = { ...process.env };
  const deadline = coordinatorCommandDeadline() ?? performance.now() + 32 * 15_000;
  const tools = await verifiedControllerToolPaths(toolsReceipt);
  checkCoordinatorDeadline();
  if (!("compiler_source_closure" in tools) || typeof tools.compiler_source_closure !== "string")
    throw new Error("authenticated controller tools lack generated compiler source closure");
  const closureBytes = await readControllerToolFile(tools.compiler_source_closure, 64 * 1024);
  const raw: unknown = JSON.parse(closureBytes.toString("utf8"));
  const closure = inspectReleaseCompilerSourceClosure(raw);
  if (
    closure.source_commit !== controller.source_commit ||
    closure.source_tree !== controller.source_tree
  )
    throw new Error("compiler closure belongs to a different fixed controller source/tree");
  const fixedReader = readToken !== undefined || scopedEnvironment !== undefined;
  const treeToken = readToken ?? scopedEnvironment?.GH_TOKEN;
  if (fixedReader && (!treeToken || treeToken.length > 16384 || /\s/u.test(treeToken)))
    throw new Error("fixed compiler source job-reader token malformed");
  const read = await createCompilerSourceReader({
    credential:
      treeToken === undefined
        ? localDeveloperCredential({ deadline, environment })
        : { kind: "explicit", token: treeToken },
    fixedReader,
    deadline,
    maxBytes: 4 * 1024 * 1024,
  });
  const preparation = await inspectPreparedCompilerSourceAsync(read, candidate, deadline);
  checkCoordinatorDeadline();
  const source = await compareCompilerClosure(closure, candidate.source_tree, {
    readTree: async (sha) =>
      (await read(`repos/boburning/portcove/git/trees/${sha}`, deadline)).body,
  });
  const result = Object.freeze({
    ...source,
    evidence_scope: "github.com",
    candidate_tree: candidate.prepared_tree,
    preparation,
  });
  await verifiedControllerToolPaths(toolsReceipt);
  checkCoordinatorDeadline();
  actualCompilerSource.set(result, {
    candidate_tree: candidate.prepared_tree,
    tools: toolsReceipt,
    closure_sha256: createHash("sha256").update(closureBytes).digest("hex"),
    preparation: candidate,
    controller,
  });
  return result;
}
export async function requireVerifiedReleaseCompilerSource(value: object, candidateTree: string) {
  const retained = actualCompilerSource.get(value);
  if (!retained || retained.candidate_tree !== candidateTree)
    throw new Error("actual same-process exact compiler source closure verification required");
  const tools = await verifiedControllerToolPaths(retained.tools);
  if (
    !("compiler_source_closure" in tools) ||
    typeof tools.compiler_source_closure !== "string" ||
    createHash("sha256")
      .update(await readControllerToolFile(tools.compiler_source_closure, 64 * 1024))
      .digest("hex") !== retained.closure_sha256
  )
    throw new Error("retained compiler source closure changed before use");
  return {
    preparation: structuredClone(retained.preparation),
    controller: structuredClone(retained.controller),
    tools: retained.tools,
  };
}
