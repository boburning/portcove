/** Technical public-proof attempt framing. Parsing creates no native result. */
import assert from "node:assert/strict";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";

export const publicJourneyPhases = [
  "initial-v0-v1",
  "park-v0-with-v1",
  "continue-with-v2",
] as const;
export type PublicJourneyPhase = (typeof publicJourneyPhases)[number];

/** Selects local progress only after every historical marker and settlement has
 * independently passed retained-byte and actual-parent custody checks. */
export function inspectPublicJourneyProgress(
  history: readonly {
    phase: PublicJourneyPhase;
    cohort_sha256: string;
    proof_outcome: "completed" | "refused";
  }[],
  cohortSha256: string,
) {
  assert.match(cohortSha256, /^[a-f0-9]{64}$/u);
  assert.ok(history.length <= 3, "public proof phase history exceeds the finite cohort");
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]!;
    assert.equal(entry.cohort_sha256, cohortSha256, "retained public cohort differs");
    assert.equal(entry.phase, publicJourneyPhases[i], "public phase duplicated or out of order");
    assert.equal(
      entry.proof_outcome,
      "completed",
      "refused public attempt requires explicit recovery; never rerun",
    );
  }
  return history.length === 0
    ? "initial-v0-v1"
    : history.length === 1
      ? "park-v0-with-v1"
      : history.length === 2
        ? "await-published-v2"
        : "completed";
}
const hex = (raw: unknown, length = 64) => {
  assert.ok(typeof raw === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(raw));
  return raw;
};
const integer = (raw: unknown, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  assert.ok(typeof raw === "number" && Number.isSafeInteger(raw) && raw >= min && raw <= max);
  return raw;
};
function object(raw: unknown, keys?: string) {
  assert.ok(isRecord(raw));
  if (keys) assert.equal(Object.keys(raw).sort().join(","), keys);
  return raw;
}
export function inspectPublicJourneyAttemptMarker(
  raw: unknown,
  expected: { invocation_id: string; setup_grant_sha256: string; descriptor_sha256: string },
) {
  const marker = object(
    raw,
    "authority,descriptor_sha256,invocation_id,kind,request,request_sha256,schema_version,setup_grant_sha256",
  );
  assert.equal(marker.schema_version, 2);
  assert.equal(marker.kind, "ordinary-public-native-attempt");
  assert.equal(marker.authority, "none");
  assert.equal(hex(marker.invocation_id), hex(expected.invocation_id));
  assert.equal(hex(marker.setup_grant_sha256), hex(expected.setup_grant_sha256));
  assert.equal(hex(marker.descriptor_sha256), hex(expected.descriptor_sha256));
  const request = object(
    marker.request,
    "client,cohort_sha256,lineage,phase,platform_label,profile,proof_inputs,schema_version",
  );
  assert.equal(request.schema_version, 1);
  assert.equal(request.profile, "ordinary-public-initial-cohort-v1");
  assert.ok(
    request.platform_label === "windows-x86_64" || request.platform_label === "linux-x86_64",
  );
  assert.ok(publicJourneyPhases.some((phase) => phase === request.phase));
  const phase = request.phase as PublicJourneyPhase;
  assert.equal(request.client, phase === "initial-v0-v1" ? "client-a" : "client-b");
  hex(request.cohort_sha256);
  const lineage = object(request.lineage, "capacity_sha256,checkpoint,published_metadata_sha256");
  hex(lineage.checkpoint, 40);
  hex(lineage.published_metadata_sha256);
  hex(lineage.capacity_sha256);
  const proof = object(
    request.proof_inputs,
    "candidate_compiler_sha256,candidate_package_sha256,pair_sha256,prior_compiler_sha256,prior_package_sha256,source_directory",
  );
  for (const key of ["pair_sha256", "prior_package_sha256", "candidate_package_sha256"])
    hex(proof[key]);
  for (const key of ["prior_compiler_sha256", "candidate_compiler_sha256"])
    if (request.platform_label === "windows-x86_64") hex(proof[key]);
    else assert.equal(proof[key], null);
  assert.ok(
    typeof proof.source_directory === "string" &&
      /^native-public-source-[A-Za-z0-9]{6}$/u.test(proof.source_directory),
  );
  assert.equal(hex(marker.request_sha256), digest(request));
  assert.equal(
    marker.invocation_id,
    digest({
      kind: marker.kind,
      setup_grant_sha256: marker.setup_grant_sha256,
      descriptor_sha256: marker.descriptor_sha256,
      request,
    }),
  );
  return {
    phase,
    client: request.client,
    platform_label: request.platform_label,
    request: structuredClone(request),
    request_sha256: String(marker.request_sha256),
    invocation_id: String(marker.invocation_id),
    authority: "none" as const,
  };
}

/** A positive empty group permits resource reuse only. It is not a scenario,
 * physical host, public-source, semantic, native Check or publication receipt. */
export function inspectPublicJourneySettlement(
  raw: unknown,
  marker: ReturnType<typeof inspectPublicJourneyAttemptMarker>,
) {
  const value = object(
    raw,
    "authority,files,group,invocation_id,kind,phase,platform_label,proof_outcome,request_sha256,roots,schema_version,wire",
  );
  assert.equal(value.schema_version, 1);
  assert.equal(value.kind, "ordinary-public-native-settlement");
  assert.equal(value.authority, "none");
  assert.equal(value.invocation_id, marker.invocation_id);
  assert.equal(value.request_sha256, marker.request_sha256);
  assert.equal(value.phase, marker.phase);
  assert.equal(value.platform_label, marker.platform_label);
  assert.ok(value.proof_outcome === "completed" || value.proof_outcome === "refused");
  const proofOutcome: "completed" | "refused" = value.proof_outcome;
  const group = object(value.group, "empty,observed_at,remaining_pids");
  assert.equal(group.empty, true);
  assert.deepEqual(group.remaining_pids, []);
  assert.ok(
    typeof group.observed_at === "string" && Number.isFinite(Date.parse(group.observed_at)),
  );
  assert.ok(Array.isArray(value.roots) && value.roots.length > 0 && value.roots.length <= 64);
  const seen = new Set<number>();
  const roots = value.roots.map((raw: unknown) => {
    const root = object(raw, "creation,exit_code,job_empty,remaining_pids,root_exited,root_pid");
    const pid = integer(root.root_pid);
    assert.ok(!seen.has(pid));
    seen.add(pid);
    const creation = object(root.creation, "kind,value");
    assert.equal(
      creation.kind,
      marker.platform_label === "windows-x86_64" ? "windows-filetime" : "linux-starttime-ticks",
    );
    assert.ok(typeof creation.value === "string" && /^[1-9][0-9]{0,19}$/u.test(creation.value));
    assert.equal(root.root_exited, true);
    assert.equal(root.job_empty, true);
    assert.deepEqual(root.remaining_pids, []);
    integer(root.exit_code, -2147483648, 4294967295);
    return structuredClone(root);
  });
  assert.ok(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 512);
  let total = 0;
  const names = new Set<string>();
  const files = value.files.map((raw: unknown) => {
    const file = object(raw, "bytes,path,sha256");
    assert.ok(
      typeof file.path === "string" &&
        file.path.length <= 128 &&
        file.path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part)),
    );
    assert.ok(!names.has(file.path));
    names.add(file.path);
    const bytes = integer(file.bytes, 0, 4 * 1024 * 1024);
    total += bytes;
    assert.ok(total <= 512 * 1024 * 1024);
    return { path: file.path, bytes, sha256: hex(file.sha256) };
  });
  let wire: { path: string; bytes: number; sha256: string } | null = null;
  if (marker.platform_label === "linux-x86_64") {
    const rawWire = object(value.wire, "bytes,path,sha256");
    assert.equal(rawWire.path, "public-capture.stdout.bin");
    wire = {
      path: rawWire.path,
      bytes: integer(rawWire.bytes, 1, 272 * 1024 * 1024),
      sha256: hex(rawWire.sha256),
    };
  } else assert.equal(value.wire, null);
  return {
    phase: marker.phase,
    client: marker.client,
    cohort_sha256: String(marker.request.cohort_sha256),
    proof_outcome: proofOutcome,
    roots,
    files,
    wire,
    authority: "none" as const,
    scope: "technical empty-group/retained-byte framing only" as const,
  };
}
