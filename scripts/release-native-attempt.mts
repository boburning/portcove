/** Durable duplicate/resource custody only. The existing coordinator owns
 * retry counters; these records cannot authorize a retry or native acceptance. */
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  requireActualNativeCandidate,
  reconcileActualNativeCheck,
  nativeInvocationIdentity,
} from "./release-native-candidate.mts";
import {
  prepareNativeStageRequest,
  serializeNativeStageCapture,
} from "./release-native-stage-capture.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";

const name = (id: string) => `native-attempt-${id}`;
const oid = (raw: unknown): raw is string => typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw);

export function inspectNativeAttemptInventory(
  rawAnchor: unknown,
  rawEntries: unknown,
  expectedGrant: string,
) {
  if (
    !oid(expectedGrant) ||
    typeof rawAnchor !== "string" ||
    Buffer.byteLength(rawAnchor) > 128 * 1024 ||
    !rawAnchor.endsWith("\n") ||
    !Array.isArray(rawEntries) ||
    rawEntries.length > 1024 ||
    rawEntries.some((value) => typeof value !== "string")
  )
    throw new Error("native capture custody is missing, oversized or incomplete");
  const lines = rawAnchor.slice(0, -1).split("\n");
  const header: unknown = JSON.parse(lines.shift()!);
  if (
    !isRecord(header) ||
    Object.keys(header).sort().join(",") !== "kind,schema_version,setup_grant_sha256" ||
    header.schema_version !== 1 ||
    header.kind !== "native-capture-custody" ||
    header.setup_grant_sha256 !== expectedGrant
  )
    throw new Error("native initial capture custody marker differs");
  if (lines.length > 1024 || lines.some((id) => !oid(id)) || new Set(lines).size !== lines.length)
    throw new Error("native invocation custody repeats or exceeds its bound");
  const expected = lines.map(name).sort();
  const observed: string[] = rawEntries
    .map((value: unknown) => {
      if (typeof value !== "string") throw new Error("native invocation entry is malformed");
      return value;
    })
    .sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed))
    throw new Error("native invocation custody missing or contradictory; never reset an attempt");
  return Object.freeze({ invocations: Object.freeze(lines), authority: "none" as const });
}

/** Technical settlement is deliberately independent of scenario success.
 * This never establishes a successful report or permits a counter advance. */
export function inspectNativeAttemptSettlement(
  raw: unknown,
  rawRequest: unknown,
  rawAuthorities: unknown,
) {
  if (
    !isRecord(rawRequest) ||
    !isRecord(rawRequest.request) ||
    !isRecord(raw) ||
    raw.authority !== "none" ||
    raw.scope !== "integrity-only" ||
    digest(rawRequest.request) !== rawRequest.request_sha256
  )
    throw new Error("native prior shared-group settlement is missing or ambiguous");
  const { scope: _scope, authority: _authority, ...capture } = raw;
  const request = rawRequest.request;
  const serialized = serializeNativeStageCapture(
    {
      schema_version: 1,
      stage: request.stage,
      platform_label: request.platform_label,
      candidate: request.candidate,
      journey: request.journey,
      invocation_id: request.invocation_id,
      setup_descriptor_sha256: request.setup_descriptor_sha256,
    },
    rawAuthorities,
    capture,
  );
  if (
    serialized.capture.request_sha256 !== rawRequest.request_sha256 ||
    serialized.capture.group?.empty !== true ||
    serialized.capture.group.remaining_pids.length !== 0
  )
    throw new Error("native prior shared-group settlement is missing or ambiguous");
  for (const root of serialized.capture.roots) {
    if (
      !root.teardown ||
      root.teardown.root_pid !== root.image.pid ||
      root.teardown.root_exited !== true ||
      root.teardown.job_empty !== true ||
      root.teardown.remaining_pids.length !== 0 ||
      root.teardown.exit_code === null
    )
      throw new Error("native prior root identity/settlement is not positively established");
  }
  return {
    capture: serialized.capture,
    authority: "none",
    scope: "technical teardown only; no native acceptance",
  } as const;
}

async function absent(filename: string) {
  try {
    await lstat(filename);
    return false;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return true;
    throw error;
  }
}
async function json(directory: string, filename: string) {
  return JSON.parse(
    (await readBoundedPublicBuildInputFile(directory, filename, 128 * 1024)).toString("utf8"),
  ) as unknown;
}

export function inspectNativeAttemptMarker(
  raw: unknown,
  invocation: string,
  grant: string,
  authorities: unknown,
) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "authority,checkpoint,invocation_id,recovery,request,request_sha256,schema_version,setup_grant_sha256" ||
    raw.schema_version !== 1 ||
    raw.authority !== "none" ||
    raw.invocation_id !== invocation ||
    raw.setup_grant_sha256 !== grant ||
    !isRecord(raw.request) ||
    !isRecord(raw.request.request) ||
    typeof raw.checkpoint !== "string" ||
    !/^[a-f0-9]{40}$/u.test(raw.checkpoint)
  )
    throw new Error("native original invocation marker is missing or contradictory");
  const prior = raw.request.request;
  const prepared = prepareNativeStageRequest(
    {
      schema_version: 1,
      stage: prior.stage,
      platform_label: prior.platform_label,
      candidate: prior.candidate,
      journey: prior.journey,
      invocation_id: prior.invocation_id,
      setup_descriptor_sha256: prior.setup_descriptor_sha256,
    },
    authorities,
  );
  if (
    prior.invocation_id !== invocation ||
    prepared.request_sha256 !== raw.request_sha256 ||
    digest(prepared) !== digest(raw.request) ||
    nativeInvocationIdentity(prepared, raw.recovery).invocation_id !== invocation
  )
    throw new Error("native retained invocation tuple or bounded counter identity differs");
  return Object.freeze({
    request: prepared,
    checkpoint: raw.checkpoint,
    authority: "none" as const,
  });
}

const claims = new WeakMap<
  object,
  {
    selection: object;
    directory: string;
    invocation: string;
    requestSha256: string;
    markerSha256: string;
  }
>();

async function inventory(root: string, grant: string) {
  const anchor = await readBoundedPublicBuildInputFile(
    root,
    ".native-capture-custody.jsonl",
    128 * 1024,
  );
  const entries = (await readdir(root)).filter((entry) => entry.startsWith("native-attempt-"));
  return inspectNativeAttemptInventory(anchor.toString("utf8"), entries, grant);
}

async function readSettled(selection: object, directory: string, id: string) {
  const value = await requireActualNativeCandidate(selection);
  const marker = await json(directory, "claim.json");
  const original = inspectNativeAttemptMarker(
    marker,
    id,
    value.parent.descriptor.setup_grant_sha256,
    value.parent.authority_configuration,
  );
  const settled = inspectNativeAttemptSettlement(
    await json(directory, "capture.json"),
    original.request,
    value.parent.authority_configuration,
  );
  for (const stream of [
    settled.capture.harness.stdout,
    settled.capture.harness.stderr,
    ...settled.capture.roots.flatMap((root) => [root.stdout, root.stderr]),
  ]) {
    const bytes = await readBoundedPublicBuildInputFile(directory, stream.path, 4 * 1024 * 1024);
    if (
      bytes.byteLength !== stream.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== stream.sha256
    )
      throw new Error("native original retained stream differs; preserve partial effects");
  }
  // An attempted remote write is never treated as absent because its response
  // was lost. Reuse the original wire through GET-only, appointed-issuer reads.
  if (!(await absent(path.join(directory, "check-attempt.jsonl"))))
    await reconcileActualNativeCheck(
      selection,
      original.request,
      await json(directory, "expected-check.json"),
    );
  return marker;
}
const claiming = new Set<object>();
const claimingRoots = new Set<string>();

/** Requires the initial setup-created anchor. It never creates a replacement
 * marker after state loss, and never increments coordinator recovery counters. */
export async function claimActualNativeInvocation(selection: object) {
  if (claiming.has(selection)) throw new Error("native invocation claim is already in progress");
  claiming.add(selection);
  let ownedRoot: string | undefined;
  try {
    const value = await requireActualNativeCandidate(selection);
    const root = value.parent.descriptor.capture_root;
    if (claimingRoots.has(root))
      throw new Error("native capture-root claim is already in progress");
    claimingRoots.add(root);
    ownedRoot = root;
    const anchorName = ".native-capture-custody.jsonl";
    const current = await inventory(root, value.parent.descriptor.setup_grant_sha256);
    const invocation = value.request.request.invocation_id;
    const directory = path.join(root, name(invocation));
    if (current.invocations.includes(invocation)) {
      await readSettled(selection, directory, invocation);
      return Object.freeze({
        kind: "retained-native-invocation",
        directory,
        invocation_id: invocation,
        decision: "readback-only",
        authority: "none",
      });
    }
    if (current.invocations.length >= 1024)
      throw new Error("native capture inventory bound exhausted; preserve all records");
    for (const id of current.invocations) {
      const previous = path.join(root, name(id));
      await readSettled(selection, previous, id);
    }
    await value.parent.recheck();
    // Anchor first, fsync, then CreateNew directory. A crash between these writes
    // remains contradictory on restart instead of silently becoming attempt zero.
    const handle = await open(path.join(root, anchorName), "r+");
    try {
      const original = await readBoundedPublicBuildInputFile(root, anchorName, 128 * 1024);
      const currentAnchor = await handle.stat();
      if (
        !currentAnchor.isFile() ||
        currentAnchor.nlink !== 1 ||
        currentAnchor.size !== original.byteLength ||
        digest((await inventory(root, value.parent.descriptor.setup_grant_sha256)).invocations) !==
          digest(current.invocations)
      )
        throw new Error("native capture custody changed before claim");
      const appended = `${invocation}\n`;
      const written = await handle.write(appended, currentAnchor.size, "utf8");
      if (written.bytesWritten !== Buffer.byteLength(appended))
        throw new Error("native custody append was incomplete; preserve partial state");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await mkdir(directory, { mode: 0o700 });
    const markerValue = {
      schema_version: 1,
      invocation_id: invocation,
      setup_grant_sha256: value.parent.descriptor.setup_grant_sha256,
      request_sha256: value.request.request_sha256,
      request: value.request,
      recovery: value.recovery,
      checkpoint: value.checkpoint,
      authority: "none",
    };
    const marker = await open(path.join(directory, "claim.json"), "wx", 0o600);
    try {
      await marker.writeFile(JSON.stringify(markerValue));
      await marker.sync();
    } finally {
      await marker.close();
    }
    const receipt = Object.freeze({
      kind: "claimed-native-invocation",
      directory,
      invocation_id: invocation,
      decision: "prepared-only",
      authority: "none",
    });
    claims.set(receipt, {
      selection,
      directory,
      invocation,
      requestSha256: value.request.request_sha256,
      markerSha256: digest(markerValue),
    });
    return receipt;
  } finally {
    claiming.delete(selection);
    if (ownedRoot) claimingRoots.delete(ownedRoot);
  }
}

export async function requireActualNativeInvocation(receipt: object) {
  const value = claims.get(receipt);
  if (!value) throw new Error("actual freshly claimed native invocation required");
  const selected = await requireActualNativeCandidate(value.selection);
  const current = await inventory(
    selected.parent.descriptor.capture_root,
    selected.parent.descriptor.setup_grant_sha256,
  );
  const marker = await json(value.directory, "claim.json");
  if (
    !current.invocations.includes(value.invocation) ||
    !isRecord(marker) ||
    digest(marker) !== value.markerSha256 ||
    marker.invocation_id !== value.invocation ||
    marker.request_sha256 !== value.requestSha256 ||
    selected.request.request.invocation_id !== value.invocation
  )
    throw new Error("native invocation claim changed");
  return { ...selected, capture_directory: value.directory, authority: "none" as const };
}
