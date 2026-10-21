/** Credential-free byte utility for the installed native parent. This utility
 * cannot mint native, hosted-controller or publication provenance. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  inspectTufAssemblyInputs,
  assembleIsolatedTufPublication,
} from "./release-tuf-publication.mts";
import { releasePathContains } from "./release-path-safety.mts";
import {
  assertSignedPayloadVersion,
  payloadSigningEnvironment,
} from "./release-payload-signing.mts";
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
export function inspectNativePayloadVerificationPlan(raw: unknown, directory: string) {
  const value: unknown = structuredClone(raw);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "artifact,bytes,output_parent,public_key,public_key_sha256,schema_version,sha256,signature,tool,version" ||
    value.schema_version !== 1 ||
    value.output_parent !== directory ||
    !isRecord(value.tool) ||
    Object.keys(value.tool).sort().join(",") !== "path,sha256" ||
    typeof value.tool.path !== "string" ||
    !releasePathContains(root, value.tool.path) ||
    path.resolve(value.tool.path) !== value.tool.path ||
    path.basename(value.tool.path) !==
      (process.platform === "win32" ? "portcove-release-tools.exe" : "portcove-release-tools") ||
    typeof value.tool.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.tool.sha256) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 512 * 1024 * 1024 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    typeof value.public_key_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.public_key_sha256) ||
    typeof value.version !== "string"
  )
    throw new Error("fixed native payload verification plan differs");
  for (const name of ["artifact", "signature", "public_key"] as const)
    if (
      typeof value[name] !== "string" ||
      !releasePathContains(directory, value[name]) ||
      path.resolve(value[name]) !== value[name]
    )
      throw new Error("native payload verification input escaped private source");
  return {
    artifact: String(value.artifact),
    signature: String(value.signature),
    public_key: String(value.public_key),
    bytes: value.bytes,
    sha256: value.sha256,
    public_key_sha256: value.public_key_sha256,
    version: value.version,
    tool: { path: value.tool.path, sha256: value.tool.sha256 },
  };
}
export async function runNativePayloadVerificationPlan(filename: string, expectedSha256: string) {
  if (
    !path.isAbsolute(filename) ||
    path.basename(filename) !== "native-payload-plan.json" ||
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
    ].some((name) => process.env[name])
  )
    throw new Error("credential-free fixed native payload verifier required");
  const directory = path.dirname(filename),
    planBytes = await readBoundedPublicBuildInputFile(directory, path.basename(filename), 65536);
  if (
    hash(planBytes) !== expectedSha256 ||
    !Buffer.from(planBytes.toString("utf8")).equals(planBytes)
  )
    throw new Error("native payload verification plan changed");
  const plan = inspectNativePayloadVerificationPlan(
    JSON.parse(planBytes.toString("utf8")),
    directory,
  );
  const toolBefore = await readBoundedPublicBuildInputFile(
    path.dirname(plan.tool.path),
    path.basename(plan.tool.path),
    128 * 1024 * 1024,
  );
  if (hash(toolBefore) !== plan.tool.sha256)
    throw new Error("native payload verifier bytes differ");
  const signature = await readBoundedPublicBuildInputFile(
    directory,
    path.relative(directory, plan.signature),
    16384,
  );
  assertSignedPayloadVersion(
    signature.toString("utf8").trim(),
    path.basename(plan.artifact),
    plan.version,
  );
  let captured = false;
  try {
    const result = await promisify(execFile)(
      plan.tool.path,
      ["verify", plan.artifact, plan.signature, plan.public_key, plan.sha256, String(plan.bytes)],
      {
        cwd: directory,
        env: payloadSigningEnvironment(directory),
        encoding: "buffer",
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        killSignal: "SIGKILL",
      },
    );
    await writeFile(path.join(directory, "native-payload.stdout.bin"), result.stdout, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "native-payload.stderr.bin"), result.stderr, {
      flag: "wx",
      mode: 0o600,
    });
    captured = true;
    const report: unknown = JSON.parse(result.stdout.toString("utf8"));
    if (
      !isRecord(report) ||
      Object.keys(report).sort().join(",") !==
        "bytes,public_key_sha256,schema_version,sha256,signature_verified" ||
      report.schema_version !== 1 ||
      report.bytes !== plan.bytes ||
      report.sha256 !== plan.sha256 ||
      report.public_key_sha256 !== plan.public_key_sha256 ||
      report.signature_verified !== true
    )
      throw new Error("actual native payload verifier result differs");
    const toolAfter = await readBoundedPublicBuildInputFile(
      path.dirname(plan.tool.path),
      path.basename(plan.tool.path),
      128 * 1024 * 1024,
    );
    if (hash(toolAfter) !== plan.tool.sha256)
      throw new Error("native payload verifier changed after execution");
    await writeFile(
      path.join(directory, "native-payload-result.json"),
      JSON.stringify({
        schema_version: 1,
        plan_sha256: expectedSha256,
        report,
        stdout_sha256: hash(result.stdout),
        stderr_sha256: hash(result.stderr),
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (!captured && isRecord(error)) {
      for (const name of ["stdout", "stderr"] as const) {
        const bytes = error[name];
        if (Buffer.isBuffer(bytes) && bytes.length <= 1024 * 1024)
          await writeFile(path.join(directory, `native-payload.${name}.bin`), bytes, {
            flag: "wx",
            mode: 0o600,
          });
      }
    }
    await writeFile(
      path.join(directory, "native-payload-refusal.json"),
      JSON.stringify({
        schema_version: 1,
        plan_sha256: expectedSha256,
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("native payload crypto refused; retain original input and partial output");
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [filename, expected, ...rest] = process.argv.slice(2);
  if (!filename || !expected || rest.length)
    throw new Error("fixed native keyless plan and digest required");
  const run =
    path.basename(filename) === "native-payload-plan.json"
      ? runNativePayloadVerificationPlan
      : runNativeKeylessAssemblyPlan;
  void run(filename, expected).catch(() => {
    console.error("native keyless assembly refused; retain original input and partial output");
    process.exitCode = 1;
  });
}
