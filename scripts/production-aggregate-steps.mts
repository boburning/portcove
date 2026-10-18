import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { recoverRemoteCoordinator } from "./release-coordinator-recovery.mts";
import { assembleReleaseArtifacts } from "./release-artifact-assembly.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { prepareAggregateAttestation } from "./trusted-aggregate-attestation.mts";
import { inspectAssemblerIdentityExpectation } from "./assembler-job-identity.mts";

/** Transport only. The held workflow has no producer for this descriptor until
 * independent candidate admission is implemented and ratified. Parsing it or
 * matching the journal does not authenticate its policy/file facts. */
export function inspectAggregateDescriptor(raw: string | undefined) {
  if (!raw || Buffer.byteLength(raw) > 64 * 1024)
    throw new Error("independently admitted aggregate descriptor is unavailable or oversized");
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "archives,assembly,checkpoint,coordinator,evidence,schema_version" ||
    value.schema_version !== 1 ||
    typeof value.checkpoint !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.checkpoint) ||
    !isRecord(value.coordinator) ||
    Object.keys(value.coordinator).sort().join(",") !== "namespace,schema_version" ||
    value.coordinator.schema_version !== 1 ||
    typeof value.coordinator.namespace !== "string" ||
    !/^portcove-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/u.test(value.coordinator.namespace) ||
    value.coordinator.namespace.length > 64 ||
    !isRecord(value.evidence)
  )
    throw new Error("aggregate descriptor schema or reservation identity is invalid");
  return value;
}

/** Association with the EXISTING reservation; never allocate or advance state.
 * Upstream acceptance and fresh policy/pause/capacity checks remain mandatory. */
export async function requireReservedAggregate(rawDescriptor: string, rawState: unknown) {
  const descriptor = inspectAggregateDescriptor(rawDescriptor);
  const { accepted } = await inspectTrustedAssemblyInput(descriptor.assembly);
  if (
    !isRecord(rawState) ||
    rawState.checkpoint !== descriptor.checkpoint ||
    !isRecord(rawState.input)
  )
    throw new Error("aggregate reservation checkpoint changed or is missing");
  const candidate = rawState.input.active_candidate;
  if (
    !isRecord(candidate) ||
    !["building", "publishing"].includes(String(candidate.phase)) ||
    candidate.prepared_commit !== accepted.source_commit ||
    candidate.prepared_tree !== accepted.source_tree ||
    candidate.version !== accepted.version ||
    !isRecord(candidate.release_run) ||
    String(candidate.release_run.run_id) !== accepted.run_id ||
    candidate.release_run.attempt !== accepted.run_attempt ||
    candidate.release_run.revision !== accepted.source_commit
  )
    throw new Error(
      "aggregate differs from the existing prepared candidate and frozen Release run",
    );
  return { descriptor, accepted };
}

export async function requestAssemblerToken(
  audience: string,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
) {
  // These are runner-issued control variables, never dispatch/candidate values.
  const endpoint = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
  const bearer = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    !endpoint.hostname.endsWith(".actions.githubusercontent.com") ||
    !bearer ||
    bearer.length > 16384
  )
    throw new Error("runner OIDC endpoint is unavailable");
  endpoint.searchParams.set("audience", audience);
  const response = await fetcher(endpoint, {
    headers: { Authorization: `Bearer ${bearer}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 200 || !response.body) throw new Error("runner OIDC request refused");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    length += chunk.byteLength;
    if (length > 32 * 1024) throw new Error("runner OIDC response exceeds bound");
    chunks.push(Buffer.from(chunk));
  }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(result) || typeof result.value !== "string" || result.value.length > 16384)
    throw new Error("runner OIDC response is invalid");
  return result.value;
}

async function output(values: Record<string, string>) {
  const filename = process.env.GITHUB_OUTPUT;
  if (!filename) throw new Error("workflow output channel is missing");
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/u.test(value) || Buffer.byteLength(value) > 64 * 1024)
      throw new Error("workflow output exceeds its single-line bound");
    await appendFile(filename, `${key}=${value}\n`);
  }
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["assemble", "bind"].includes(mode ?? ""))
    throw new Error("choose only assemble or bind from the held fixed workflow");
  // Both jobs remain literally held. This program cannot turn a descriptor into
  // authorization, write a reservation, sign, publish, or select another run.
  const raw = process.env.PORTCOVE_ACCEPTED_AGGREGATE;
  const descriptor = inspectAggregateDescriptor(raw);
  const temp = process.env.RUNNER_TEMP;
  if (!temp || /[\r\n]/u.test(temp) || !path.isAbsolute(temp))
    throw new Error("private runner temporary root is unavailable");
  if (mode === "assemble") {
    const root = await mkdtemp(path.join(temp, "portcove-aggregate-"));
    const recover = () =>
      recoverRemoteCoordinator(root, descriptor.coordinator, { transport: { cwd: root } });
    const before = await recover();
    await requireReservedAggregate(raw!, before);
    const result = await assembleReleaseArtifacts(
      root,
      descriptor.assembly,
      descriptor.archives,
      descriptor.evidence as Parameters<typeof assembleReleaseArtifacts>[3],
    );
    const after = await recover();
    await requireReservedAggregate(raw!, after);
    await writeFile(path.join(root, "assembly-receipt.json"), JSON.stringify(result), {
      flag: "wx",
      mode: 0o600,
    });
    await output({ assets: result.aggregate.assets });
  } else {
    const expected = inspectAssemblerIdentityExpectation({
      audience: process.env.PORTCOVE_AGGREGATE_AUDIENCE,
      subject: process.env.PORTCOVE_AGGREGATE_SUBJECT,
      controller_revision: process.env.PORTCOVE_CONTROLLER_REVISION,
      controller_ref: process.env.PORTCOVE_CONTROLLER_REF,
      actor_id: process.env.PORTCOVE_CONTROLLER_ACTOR_ID,
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    });
    if (!Array.isArray(descriptor.archives)) throw new Error("accepted artifact matrix is missing");
    const ids = descriptor.archives.map((archive) => {
      if (!isRecord(archive) || typeof archive.artifact_id !== "number")
        throw new Error("accepted artifact ID missing");
      return archive.artifact_id;
    });
    const root = await mkdtemp(path.join(temp, "portcove-binding-"));
    const recovered = await recoverRemoteCoordinator(root, descriptor.coordinator, {
      transport: { cwd: root },
    });
    await requireReservedAggregate(raw!, recovered);
    const token = await requestAssemblerToken(expected.audience);
    const binding = await prepareAggregateAttestation(
      token,
      expected,
      descriptor.assembly,
      ids,
      {
        artifact_id: Number(process.env.PORTCOVE_NEW_ARTIFACT_ID),
        sha256: process.env.PORTCOVE_NEW_ARTIFACT_SHA256 ?? "",
      },
      { cwd: root },
    );
    await output({
      subject_name: binding.subject_name,
      subject_digest: binding.subject_digest,
      predicate: JSON.stringify(binding.predicate),
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never print bearer tokens, provider response bodies or credential URLs.
    console.error(
      "held aggregate step refused; retain this run's private evidence and existing reservation",
    );
    process.exitCode = 1;
  });
}
