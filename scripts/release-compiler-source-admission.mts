import { createHash } from "node:crypto";
import path from "node:path";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  inspectReleaseCompilerSourceClosure,
  inspectPreparedCompilerSource,
  compareCompilerClosure,
} from "./release-compiler-source.mts";
import type { PreparedCompilerSource } from "./release-compiler-source.mts";
const actualCompilerSource = new WeakMap<
  object,
  { candidate_tree: string; tools: object; closure_sha256: string }
>();
/** A raw JSON closure cannot appoint trusted source. The existing tool receiver
 * must have authenticated and retained the exact manifest-owned generated asset
 * in this process, including its full original artifact/Sigstore binding. */
export async function compareVerifiedReleaseCompilerSource(
  toolsReceipt: object,
  candidate: PreparedCompilerSource,
  controller: { source_commit: string; source_tree: string },
) {
  const tools = await verifiedControllerToolPaths(toolsReceipt);
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
  const directory = path.dirname(tools.compiler_source_closure);
  const runner = createGitHubRunner({
    cwd: directory,
    timeoutMs: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const api = new GitHubApiClient((args, input) =>
    runner([...args, "--hostname", "github.com"], input),
  );
  const preparation = inspectPreparedCompilerSource(api, candidate);
  const source = await compareCompilerClosure(closure, directory, candidate.source_tree, { api });
  const result = Object.freeze({
    ...source,
    evidence_scope: "github.com",
    candidate_tree: candidate.prepared_tree,
    preparation,
  });
  await verifiedControllerToolPaths(toolsReceipt);
  actualCompilerSource.set(result, {
    candidate_tree: candidate.prepared_tree,
    tools: toolsReceipt,
    closure_sha256: createHash("sha256").update(closureBytes).digest("hex"),
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
}
