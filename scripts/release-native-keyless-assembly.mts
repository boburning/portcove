/** Credential-free byte utility for the installed native parent. This utility
 * cannot mint native, hosted-controller or publication provenance. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  inspectTufAssemblyInputs,
  assembleIsolatedTufPublication,
} from "./release-tuf-publication.mts";
import { releasePathContains } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";

const root = fileURLToPath(new URL("..", import.meta.url));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function inspectNativeKeylessAssemblyPlan(raw: unknown, directory: string) {
  const input: unknown = structuredClone(raw);
  if (
    !isRecord(input) ||
    Object.keys(input).sort().join(",") !==
      "context_directory,output_parent,schema_version,signed_roles,tool" ||
    input.schema_version !== 1 ||
    !isRecord(input.tool) ||
    Object.keys(input.tool).sort().join(",") !== "path,sha256" ||
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    input.output_parent !== directory ||
    typeof input.context_directory !== "string" ||
    !releasePathContains(directory, input.context_directory) ||
    path.resolve(input.context_directory) !== input.context_directory ||
    typeof input.tool.path !== "string" ||
    !releasePathContains(root, input.tool.path) ||
    path.resolve(input.tool.path) !== input.tool.path ||
    path.basename(input.tool.path) !==
      (process.platform === "win32" ? "portcove-release-tools.exe" : "portcove-release-tools") ||
    typeof input.tool.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.tool.sha256)
  )
    throw new Error("fixed native keyless assembly plan differs");
  const roles = inspectTufAssemblyInputs(input.signed_roles);
  if (
    roles.some(
      (role) => !releasePathContains(directory, role.path) || path.resolve(role.path) !== role.path,
    )
  )
    throw new Error("native signed role escaped retained public inputs");
  return Object.freeze({
    context_directory: input.context_directory,
    output_parent: directory,
    tool: Object.freeze({ path: input.tool.path, sha256: input.tool.sha256 }),
    signed_roles: roles,
  });
}
export async function runNativeKeylessAssemblyPlan(filename: string, expectedSha256: string) {
  if (
    !path.isAbsolute(filename) ||
    path.basename(filename) !== "native-keyless-plan.json" ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    [
      "NODE_OPTIONS",
      "NODE_PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "TAURI_SIGNING_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY_PATH",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ].some((key) => process.env[key])
  )
    throw new Error("credential-free fixed native keyless invocation required");
  const directory = path.dirname(filename),
    bytes = await readBoundedPublicBuildInputFile(directory, path.basename(filename), 65536);
  if (hash(bytes) !== expectedSha256 || !Buffer.from(bytes.toString("utf8")).equals(bytes))
    throw new Error("native keyless plan bytes changed");
  const plan = inspectNativeKeylessAssemblyPlan(JSON.parse(bytes.toString("utf8")), directory);
  try {
    const assembled = await assembleIsolatedTufPublication(plan, performance.now() + 90000);
    await writeFile(
      path.join(directory, "native-keyless-result.json"),
      JSON.stringify({
        schema_version: 1,
        plan_sha256: expectedSha256,
        assembled,
        authority: "none",
        scope:
          "keyless public signature and repository verification only; native execution pending",
      }),
      { flag: "wx", mode: 0o600 },
    );
    return assembled;
  } catch {
    await writeFile(
      path.join(directory, "native-keyless-refusal.json"),
      JSON.stringify({
        schema_version: 1,
        plan_sha256: expectedSha256,
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("native keyless assembly refused; retain original inputs and partial output");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [filename, expected, ...rest] = process.argv.slice(2);
  if (!filename || !expected || rest.length)
    throw new Error("fixed native keyless plan and digest required");
  void runNativeKeylessAssemblyPlan(filename, expected).catch(() => {
    console.error("native keyless assembly refused; retain original input and partial output");
    process.exitCode = 1;
  });
}
