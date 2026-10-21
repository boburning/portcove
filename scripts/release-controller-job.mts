/** Fixed complete-controller job entry. No arbitrary command, source, tool,
 * candidate program or credential is accepted through configuration. */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { prepareFixedControllerConfiguration } from "./release-controller-configuration.mts";
import { requireControllerReleaseAuthorities } from "./release-authority-configuration.mts";
import { isRecord } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { retainControllerAttestation } from "./release-controller-transport.mts";

function operation(raw: unknown) {
  if (
    raw !== "coordinator" &&
    raw !== "building" &&
    raw !== "payload" &&
    raw !== "release-publication" &&
    raw !== "site-publication" &&
    raw !== "tuf-releases" &&
    raw !== "tuf-preview" &&
    raw !== "tuf-stable" &&
    raw !== "tuf-snapshot" &&
    raw !== "tuf-timestamp"
  )
    throw new Error("fixed complete-controller job required");
  return raw;
}
const root = fileURLToPath(new URL("..", import.meta.url));
function temporary() {
  const value = process.env.RUNNER_TEMP;
  if (!value || !path.isAbsolute(value) || /[\r\n]/u.test(value))
    throw new Error("private fixed runner root unavailable");
  return value;
}
function configPath(role: ReturnType<typeof operation>) {
  return path.join(temporary(), `controller-${role}.json`);
}
async function authority(role: ReturnType<typeof operation>) {
  return requireControllerReleaseAuthorities(role === "building" ? "admission" : role);
}
export async function configureFixedControllerJob(rawRole: unknown) {
  const role = operation(rawRole),
    selected = await authority(role);
  const rawNeeds = process.env.PORTCOVE_FIXED_NEEDS,
    rawAdmission = process.env.PORTCOVE_COORDINATOR_CONFIGURATION;
  if (
    !rawNeeds ||
    Buffer.byteLength(rawNeeds) > 256 * 1024 ||
    !rawAdmission ||
    Buffer.byteLength(rawAdmission) > 65536
  )
    throw new Error("fixed needs and ratified admission configuration unavailable");
  const admission: unknown = JSON.parse(rawAdmission),
    needs: unknown = JSON.parse(rawNeeds);
  if (!isRecord(admission) || admission.namespace !== selected.namespace)
    throw new Error("ratified coordinator namespace differs");
  const commit = process.env.GITHUB_SHA;
  if (
    !commit ||
    !isRecord(needs) ||
    !isRecord(needs.tool_bootstrap) ||
    !isRecord(needs.tool_bootstrap.outputs) ||
    typeof needs.tool_bootstrap.outputs.source_tree !== "string"
  )
    throw new Error("fixed tool tree output unavailable");
  const configuration = prepareFixedControllerConfiguration({
    operation: role,
    fixed: {
      controller_revision: commit,
      source_tree: needs.tool_bootstrap.outputs.source_tree,
      controller_ref: process.env.GITHUB_REF ?? "",
      run_id: process.env.GITHUB_RUN_ID ?? "",
      run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      actor_id: selected.apps.dispatch.actor_id,
    },
    needs,
    admission_configuration: admission,
    native_locators: null,
    payload_public_key_sha256: process.env.PORTCOVE_PAYLOAD_PUBLIC_KEY_SHA256,
  });
  const encoded = JSON.stringify(configuration);
  if (Buffer.byteLength(encoded) > 65536) throw new Error("fixed job configuration exceeds bound");
  await writeFile(configPath(role), encoded, { flag: "wx", mode: 0o600 });
  return { operation: role, configuration: configPath(role), authority: "none" };
}
export async function runFixedControllerJob(rawRole: unknown, phaseDeadline?: number) {
  const role = operation(rawRole);
  await authority(role);
  const privateRoot = temporary(),
    filename = configPath(role);
  const configuration: unknown = JSON.parse(
    (await readControllerToolFile(filename, 65536)).toString("utf8"),
  );
  let result: unknown;
  if (role === "building") {
    const { currentBuildingJobDeadline } = await import("./release-signing-job-budget.mts");
    const deadline = currentBuildingJobDeadline(
      {
        run_id: process.env.GITHUB_RUN_ID ?? "",
        run_attempt: 1,
        controller_revision: process.env.GITHUB_SHA ?? "",
        controller_ref: process.env.GITHUB_REF ?? "",
      },
      root,
      Math.min(performance.now() + 405000, phaseDeadline ?? Infinity),
    );
    result = await (
      await import("./acquire-release-admission.mts")
    ).runFixedBuildingConfiguration(configuration, privateRoot, deadline);
  } else if (role === "payload")
    result = await (
      await import("./release-signing-controller.mts")
    ).runFixedPayloadContextConfiguration(
      configuration,
      privateRoot,
      phaseDeadline ?? performance.now() + 570000,
    );
  else if (role.startsWith("tuf-"))
    result = await (
      await import("./release-tuf-controller.mts")
    ).runFixedTufRoleConfiguration(configuration, privateRoot, phaseDeadline);
  else if (role === "site-publication")
    result = await (
      await import("./release-site-controller.mts")
    ).runFixedSiteConfiguration(configuration, privateRoot, phaseDeadline);
  else if (role === "release-publication")
    result = await (
      await import("./release-publication-controller.mts")
    ).runFixedPublicationEntry(filename, phaseDeadline);
  else {
    if (!isRecord(configuration)) throw new Error("fixed coordinator configuration unavailable");
    const work = path.join(root, "work");
    await mkdir(work, { mode: 0o700 });
    const driver = await import("./release-coordinator-driver.mts");
    // The fixed same-bundle factory is supplied by the genuine bootstrap join.
    const entry: unknown = driver;
    if (!isRecord(entry) || typeof entry.runFixedCoordinatorConfiguration !== "function")
      throw new Error("same-bundle coordinator factory unavailable");
    const worker = entry as {
      runFixedCoordinatorConfiguration(
        raw: unknown,
        parent: string,
        deadline?: number,
      ): Promise<unknown>;
    };
    result = await worker.runFixedCoordinatorConfiguration(configuration, work, phaseDeadline);
  }

  if (!isRecord(result) || typeof result.decision !== "string")
    throw new Error("actual fixed controller outcome unavailable");
  const positive =
    role === "coordinator" ||
    (role === "building"
      ? result.decision === "candidate-building-admitted"
      : role === "payload"
        ? result.decision === "payload-and-context-prepared"
        : role === "release-publication"
          ? result.decision === "immutable-release-and-result-prepared"
          : role === "site-publication"
            ? ["site-published", "metadata-site-published"].includes(result.decision)
            : result.decision === "role-output-prepared");
  await writeFile(
    path.join(privateRoot, `controller-${role}-result.json`),
    JSON.stringify(result),
    { flag: "wx", mode: 0o600 },
  );
  if (!positive) throw new Error("actual fixed job remained held");
  return result;
}

/** This is a projection of an actual returned controller result, not an
 * admission API. The transport rechecks the retained bytes and fixed basenames. */
export function fixedControllerResultAttestation(rawRole: unknown, raw: unknown) {
  const role = operation(rawRole);
  if (!isRecord(raw)) throw new Error("actual controller result required");
  if (role === "building" || role === "site-publication") return null;
  const contextType = "https://portcove.dev/attestations/release-signing-context/v1";
  if (role === "coordinator") {
    if (raw.decision !== "metadata-context-prepared" || raw.attestation_required === false)
      return null;
    if (
      typeof raw.subject_path !== "string" ||
      typeof raw.predicate_path !== "string" ||
      raw.predicate_type !== contextType
    )
      throw new Error("actual coordinator attestation paths unavailable");
    return {
      subject_path: raw.subject_path,
      predicate_path: raw.predicate_path,
      predicate_type: contextType,
    };
  }
  if (role.startsWith("tuf-")) {
    const type = "https://portcove.dev/attestations/tuf-role-output/v1";
    if (
      raw.decision !== "role-output-prepared" ||
      typeof raw.subject_path !== "string" ||
      typeof raw.predicate_path !== "string" ||
      raw.predicate_type !== type
    )
      throw new Error("actual TUF attestation paths unavailable");
    return {
      subject_path: raw.subject_path,
      predicate_path: raw.predicate_path,
      predicate_type: type,
    };
  }
  const handoff = role === "payload" ? raw.context_upload : raw.artifact;
  if (
    !isRecord(handoff) ||
    typeof handoff.directory !== "string" ||
    handoff.attestation !== "pending"
  )
    throw new Error("actual handoff attestation unavailable");
  if (role === "payload")
    return {
      subject_path: path.join(handoff.directory, "signing-context-manifest.json"),
      predicate_path: path.join(handoff.directory, "signing-context-predicate.json"),
      predicate_type: contextType,
    };
  return {
    subject_path: path.join(handoff.directory, "upload", "immutable-release-result.json"),
    predicate_path: path.join(handoff.directory, "immutable-release-result-predicate.json"),
    predicate_type: "https://portcove.dev/attestations/immutable-release-result/v1",
  };
}

/** Called only by the verified source bootstrap's fixed bundle entry. This
 * bundle owns its own deadline context; a source-module ALS is not shared. */
export async function runConfiguredFixedControllerJob(rawRole: unknown, deadline: number) {
  const role = operation(rawRole),
    phase = role === "building" ? "admission" : role;
  let exitCode = 1,
    requiresAttestation = false;
  try {
    const completed = await withCoordinatorDeadline(deadline, async () => {
      await configureFixedControllerJob(role);
      const result = await runFixedControllerJob(role, deadline);
      // Set before retaining the locator: a retention failure must not erase
      // the fact that the actual result needs independent attestation.
      requiresAttestation =
        role !== "building" &&
        role !== "site-publication" &&
        (role !== "coordinator" ||
          (isRecord(result) &&
            result.decision === "metadata-context-prepared" &&
            result.attestation_required !== false));
      const attestation = fixedControllerResultAttestation(role, result);
      if (attestation) {
        await retainControllerAttestation(temporary(), phase, attestation);
      }
      return result;
    });
    exitCode = 0;
    return completed;
  } finally {
    await writeFile(
      path.join(temporary(), `release-control-${phase}-process-ended.json`),
      JSON.stringify({ exit_code: exitCode }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      path.join(temporary(), `controller-job-settlement-${phase}.json`),
      JSON.stringify({ exit_code: exitCode, requires_attestation: requiresAttestation }),
      { flag: "wx", mode: 0o600 },
    );
  }
}
async function main() {
  if (process.argv.length !== 4 || !["configure", "run"].includes(process.argv[2] ?? ""))
    throw new Error("fixed job configure/run operation required");
  const role = operation(process.argv[3]);
  if (process.argv[2] === "configure") return configureFixedControllerJob(role);
  let exitCode = 1;
  try {
    const result = await runFixedControllerJob(role);
    exitCode = 0;
    return result;
  } finally {
    await writeFile(
      path.join(
        temporary(),
        `release-control-${role === "building" ? "admission" : role}-process-ended.json`,
      ),
      JSON.stringify({ exit_code: exitCode }),
      { flag: "wx", mode: 0o600 },
    );
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      "fixed controller job refused; retain original result, pending effects and evidence",
    );
    process.exitCode = 1;
  });
