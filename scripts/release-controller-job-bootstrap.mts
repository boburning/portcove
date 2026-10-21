/** Builtins-only source entry into the one fixed attested complete-job bundle. */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { requireControllerReleaseAuthorities } from "./release-authority-configuration.mts";
import { currentControllerJobDeadline } from "./release-signing-job-budget.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { isRecord } from "./runtime-values.mts";
function positive(raw: unknown) {
  if (
    typeof raw !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(raw) ||
    !Number.isSafeInteger(Number(raw))
  )
    throw new Error("fixed tool artifact ID required");
  return Number(raw);
}
function hex(raw: unknown, length = 64) {
  if (typeof raw !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(raw))
    throw new Error("fixed tool digest required");
  return raw;
}
/** Keys belong only to the separate fixed socket client or observer step. */
export function assertControllerBootstrapEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  if (
    environment.NODE_OPTIONS ||
    environment.NODE_PATH ||
    Object.entries(environment).some(
      ([key, value]) =>
        value &&
        ([
          "PORTCOVE_CONTROL_APP_TOKEN",
          "PORTCOVE_ROLE_KEY",
          "PORTCOVE_ROLE_PASSWORD",
          "TAURI_SIGNING_PRIVATE_KEY",
          "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        ].includes(key) ||
          /^PORTCOVE_TUF_[A-Z]+_KEY$/u.test(key) ||
          /^PORTCOVE_[A-Z_]+_APP_(?:PRIVATE_)?KEY$/u.test(key)),
    )
  )
    throw new Error(
      "fixed controller bootstrap forbids inherited signing, observer or App credentials",
    );
}
export async function launchFixedControllerJob(rawOperation: unknown) {
  if (
    ![
      "coordinator",
      "building",
      "payload",
      "release-publication",
      "site-publication",
      "tuf-releases",
      "tuf-preview",
      "tuf-stable",
      "tuf-snapshot",
      "tuf-timestamp",
    ].includes(String(rawOperation)) ||
    typeof rawOperation !== "string"
  )
    throw new Error("fixed complete controller operation required");
  assertControllerBootstrapEnvironment();
  if (!process.env.RUNNER_TEMP || !path.isAbsolute(process.env.RUNNER_TEMP))
    throw new Error("clean fixed controller runtime required");
  await requireControllerReleaseAuthorities(
    rawOperation === "building" ? "admission" : rawOperation,
  );
  const rawNeeds = process.env.PORTCOVE_FIXED_NEEDS;
  if (!rawNeeds || Buffer.byteLength(rawNeeds) > 256 * 1024)
    throw new Error("bounded fixed producer outputs unavailable");
  const needs: unknown = JSON.parse(rawNeeds);
  if (
    !isRecord(needs) ||
    !isRecord(needs.tool_bootstrap) ||
    !isRecord(needs.tool_attest) ||
    needs.tool_bootstrap.result !== "success" ||
    needs.tool_attest.result !== "success" ||
    !isRecord(needs.tool_bootstrap.outputs) ||
    !isRecord(needs.tool_attest.outputs)
  )
    throw new Error("successful fixed tool producers required");
  const identity = {
    controller_revision: process.env.GITHUB_SHA ?? "",
    controller_ref: process.env.GITHUB_REF ?? "",
    run_id: process.env.GITHUB_RUN_ID ?? "",
    run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  const deadline = currentControllerJobDeadline(
    rawOperation,
    identity,
    fileURLToPath(new URL("..", import.meta.url)),
    performance.now() + 570000,
  );
  const artifact = {
      ...identity,
      source_tree: hex(needs.tool_bootstrap.outputs.source_tree, 40),
      artifact_id: positive(needs.tool_bootstrap.outputs.artifact_id),
      sha256: hex(needs.tool_bootstrap.outputs.artifact_sha256),
    },
    bundle = {
      artifact_id: positive(needs.tool_attest.outputs.bundle_artifact_id),
      sha256: hex(needs.tool_attest.outputs.bundle_artifact_sha256),
    },
    parent = process.env.RUNNER_TEMP;
  return withCoordinatorDeadline(deadline, async () => {
    const receipt = await receiveControllerTools(parent, artifact, bundle, { deadline });
    const tools = await verifiedControllerToolPaths(receipt);
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    if (
      sha(await readControllerToolFile(process.execPath)) !==
      sha(await readControllerToolFile(tools.node))
    )
      throw new Error("actual job Node differs from attested executable");
    const entry = tools.entries["release-controller-job"];
    if (typeof entry !== "string") throw new Error("fixed complete job bundle unavailable");
    const worker = (await import(pathToFileURL(entry).href)) as {
      runConfiguredFixedControllerJob(role: string, deadline: number): Promise<unknown>;
    };
    if (typeof worker.runConfiguredFixedControllerJob !== "function")
      throw new Error("fixed complete job ABI unavailable");
    await verifiedControllerToolPaths(receipt);
    return worker.runConfiguredFixedControllerJob(rawOperation, deadline);
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("fixed complete controller operation required");
    process.exitCode = 1;
  } else
    launchFixedControllerJob(process.argv[2]).catch(() => {
      console.error("fixed complete controller job refused; retain evidence and pending effects");
      process.exitCode = 1;
    });
}
