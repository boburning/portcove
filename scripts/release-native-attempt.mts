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
import {
  remainingNativeParentBudget,
  requireActualNativeParent,
} from "./release-native-parent.mts";
import {
  requireActualPublicJourneySource,
  requireActualPublicJourneyPackage,
} from "./release-native-public-pair.mts";
import { requireActualPublicWindowsCompilerIdentity } from "./release-native-public-compiler.mts";
import {
  inspectPublicJourneyAttemptMarker,
  inspectPublicJourneySettlement,
  inspectPublicJourneyProgress,
  inspectLinuxPublicRetainedInventory,
  inspectLinuxPublicProofOutcome,
} from "./release-native-public-attempt-contract.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

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
  if (isRecord(marker) && marker.kind === "ordinary-public-native-attempt") {
    await readPublicSettlement(value.parent, directory, id);
    return marker;
  }
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
  if (!(await absent(path.join(directory, "check-attempt.jsonl")))) {
    const { inspectNativeCheckAttempt } = await import("./release-native-check-broker.mts");
    const wire = await json(directory, "expected-check.json");
    if (!isRecord(wire)) throw new Error("native original Check wire missing");
    const phase = inspectNativeCheckAttempt(
      (await readBoundedPublicBuildInputFile(directory, "check-attempt.jsonl", 32768)).toString(
        "utf8",
      ),
      { invocation_id: id, body_sha256: digest(wire.body) },
    );
    if (phase.post_attempted) await reconcileActualNativeCheck(selection, original.request, wire);
  }
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
  return {
    ...selected,
    source_selection: value.selection,
    capture_directory: value.directory,
    authority: "none" as const,
  };
}

type PublicParent = Awaited<ReturnType<typeof requireActualNativeParent>>;
async function publicJson(directory: string, filename: string) {
  remainingNativeParentBudget();
  const value: unknown = JSON.parse(
    (await readBoundedPublicBuildInputFile(directory, filename, 256 * 1024)).toString("utf8"),
  );
  remainingNativeParentBudget();
  return value;
}

async function retainedPublicFile(
  directory: string,
  file: { path: string; bytes: number; sha256: string },
) {
  remainingNativeParentBudget();
  const filename = await assertOwnedUnlinkedPath(
    directory,
    path.join(directory, file.path),
    "public native retained proof",
  );
  const before = await lstat(filename);
  if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes)
    throw new Error("public retained proof identity differs");
  // The original Linux wire is independently bounded; individual exported files
  // keep their smaller existing bound. No parser reads the wire during reuse.
  const handle = await open(filename, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      remainingNativeParentBudget();
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, file.bytes - total + 1),
        null,
      );
      if (!result.bytesRead) break;
      total += result.bytesRead;
      if (total > file.bytes) throw new Error("public retained proof grew");
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    if (total !== file.bytes || hash.digest("hex") !== file.sha256)
      throw new Error("public retained proof bytes differ");
    for (const actual of [await handle.stat(), await lstat(filename)])
      for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
        if (actual[key] !== before[key])
          throw new Error("public retained proof changed during read");
  } finally {
    await handle.close();
  }
  remainingNativeParentBudget();
}

async function readPublicSettlement(parent: PublicParent, directory: string, id: string) {
  const marker = inspectPublicJourneyAttemptMarker(await publicJson(directory, "claim.json"), {
    invocation_id: id,
    setup_grant_sha256: parent.descriptor.setup_grant_sha256,
    descriptor_sha256: parent.descriptor_sha256,
  });
  if (marker.platform_label !== parent.descriptor.platform_label)
    throw new Error("public retained platform differs");
  const settled = inspectPublicJourneySettlement(
    await publicJson(directory, "public-settlement.json"),
    marker,
  );
  for (const file of settled.files) await retainedPublicFile(directory, file);
  if (settled.wire) await retainedPublicFile(directory, settled.wire);
  return { marker, settled, directory };
}

/** Passive history permits only local resource reuse. An old Check write can
 * remain ambiguous: this route never resolves it, replays it or claims native
 * acceptance. Missing positive local root/group settlement still refuses. */
async function readPassiveNativeSettlement(parent: PublicParent, directory: string, id: string) {
  remainingNativeParentBudget();
  const original = inspectNativeAttemptMarker(
    await json(directory, "claim.json"),
    id,
    parent.descriptor.setup_grant_sha256,
    parent.authority_configuration,
  );
  const settled = inspectNativeAttemptSettlement(
    await json(directory, "capture.json"),
    original.request,
    parent.authority_configuration,
  );
  const { readNativeCapturedStream } = await import("./release-native-capture-files.mts");
  for (const stream of [
    settled.capture.harness.stdout,
    settled.capture.harness.stderr,
    ...settled.capture.roots.flatMap((root) => [root.stdout, root.stderr]),
  ]) {
    const bytes = await readNativeCapturedStream(directory, stream.path);
    if (
      bytes.length !== stream.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== stream.sha256
    )
      throw new Error("prior native retained stream differs");
    remainingNativeParentBudget();
  }
}

type PublicHistory = Awaited<ReturnType<typeof readPublicSettlement>>;
async function readParentPublicHistory(parent: PublicParent, originalPrefix?: readonly string[]) {
  const current = await inventory(
    parent.descriptor.capture_root,
    parent.descriptor.setup_grant_sha256,
  );
  const history: PublicHistory[] = [];
  if (
    originalPrefix &&
    digest(current.invocations.slice(0, originalPrefix.length)) !== digest(originalPrefix)
  )
    throw new Error("original public custody prefix changed");
  for (const id of originalPrefix ?? current.invocations) {
    const directory = path.join(parent.descriptor.capture_root, name(id)),
      marker = await json(directory, "claim.json");
    if (isRecord(marker) && marker.kind === "ordinary-public-native-attempt")
      history.push(await readPublicSettlement(parent, directory, id));
    else await readPassiveNativeSettlement(parent, directory, id);
  }
  remainingNativeParentBudget();
  return { current, history };
}

const retainedPublicCohorts = new WeakMap<
  object,
  { parent: object; originalPrefix: readonly string[]; cohort: string; parked_id: string }
>();

/** Historical local admission is recovered only from the setup-owned anchor and
 * original positive A/B captures. Current remote policy is not evaluated here. */
export async function readActualRetainedPublicCohort(parentReceipt: object) {
  const parent = await requireActualNativeParent(parentReceipt);
  if (parent.descriptor.public_journey?.profile !== "ordinary-public-initial-cohort-v1")
    throw new Error("actual protected initial public profile required");
  const { current, history } = await readParentPublicHistory(parent);
  if (history.length !== 2 && history.length !== 3)
    throw new Error("exact original completed A and parked B captures required");
  const cohort = history[0]!.settled.cohort_sha256;
  const phase = inspectPublicJourneyProgress(
    history.map((item) => item.settled),
    cohort,
  );
  if (phase !== "await-published-v2" && phase !== "completed")
    throw new Error("retained public phase is not awaiting V2");
  await parent.recheck();
  const receipt = Object.freeze({
    kind: "actual-retained-public-cohort",
    authority: "none" as const,
  });
  retainedPublicCohorts.set(receipt, {
    parent: parentReceipt,
    originalPrefix: Object.freeze(
      current.invocations.slice(
        0,
        current.invocations.indexOf(history[1]!.marker.invocation_id) + 1,
      ),
    ),
    cohort,
    parked_id: history[1]!.marker.invocation_id,
  });
  return receipt;
}

export async function requireActualRetainedPublicCohort(receipt: object) {
  const retained = retainedPublicCohorts.get(receipt);
  if (!retained) throw new Error("actual retained public cohort custody required");
  const parent = await requireActualNativeParent(retained.parent),
    { history } = await readParentPublicHistory(parent, retained.originalPrefix);
  if (
    history.length !== 2 ||
    history[1]!.marker.invocation_id !== retained.parked_id ||
    inspectPublicJourneyProgress(
      history.map((item) => item.settled),
      retained.cohort,
    ) !== "await-published-v2"
  )
    throw new Error("original public custody changed before continuation");
  remainingNativeParentBudget();
  return {
    parent,
    parent_receipt: retained.parent,
    cohort_sha256: retained.cohort,
    initial: history[0]!,
    parked: history[1]!,
    authority: "none" as const,
    scope:
      "historically admitted local public input/capture custody only; current public policy and V2 claim required" as const,
  };
}

/** Routing only, after the complete setup-owned anchor is validated. Missing or
 * contradictory retained attempts throw; callers must never exception-fallback
 * to a fresh initial pair. The eventual claim repeats current policy/history. */
export async function readActualPublicJourneyParentPhase(parentReceipt: object) {
  const parent = await requireActualNativeParent(parentReceipt);
  if (parent.descriptor.public_journey?.profile !== "ordinary-public-initial-cohort-v1")
    throw new Error("actual protected initial public profile required");
  const { history } = await readParentPublicHistory(parent);
  const cohort = history[0]?.settled.cohort_sha256;
  const phase = cohort
    ? inspectPublicJourneyProgress(
        history.map((item) => item.settled),
        cohort,
      )
    : "initial-v0-v1";
  const historical =
    phase === "await-published-v2"
      ? await readActualRetainedPublicCohort(parentReceipt)
      : undefined;
  await parent.recheck();
  remainingNativeParentBudget();
  return Object.freeze({
    phase,
    cohort_sha256: cohort ?? null,
    ...(historical ? { historical_cohort_receipt: historical } : {}),
    authority: "none" as const,
    scope:
      "actual protected local routing only; fresh public source and execution claim required" as const,
  });
}

const publicProgress = new WeakMap<
  object,
  {
    parent: object;
    inventory: string;
    history: PublicHistory[];
    phase: ReturnType<typeof inspectPublicJourneyProgress> | "continue-with-v2";
    cohort: string;
  }
>();

/** Uses the setup-created anchor shared with ordinary native stages. It cannot
 * mint a candidate, coordinator retry, native report or public proof result. */
export async function readActualPublicJourneyProgress(pairReceipt: object) {
  const selected = await requireActualPublicJourneySource(pairReceipt),
    parent = selected.parent;
  const journal = await selected.source.recover();
  if (journal.input.active_candidate !== null)
    throw new Error("active native candidate must settle before public proof");
  const { current, history } = await readParentPublicHistory(parent);
  const historical = selected.historical_cohort_receipt
    ? await requireActualRetainedPublicCohort(selected.historical_cohort_receipt)
    : undefined;
  if (historical && historical.parent_receipt !== selected.parent_receipt)
    throw new Error("public continuation historical parent differs");
  const cohort = historical ? historical.cohort_sha256 : digest(selected.pair);
  const observedPhase = inspectPublicJourneyProgress(
    history.map((item) => item.settled),
    cohort,
  );
  const phase =
    observedPhase === "await-published-v2" && historical ? "continue-with-v2" : observedPhase;
  await parent.recheck();
  const receipt = Object.freeze({
    kind: "actual-public-journey-progress",
    phase,
    authority: "none" as const,
  });
  publicProgress.set(receipt, {
    parent: selected.parent_receipt,
    inventory: digest(current.invocations),
    history,
    phase,
    cohort,
  });
  return receipt;
}

const publicClaims = new WeakMap<
  object,
  {
    pair: object;
    parent: object;
    prior_package: object;
    candidate_package: object;
    parked_package?: object;
    compiler?: { prior: object; candidate: object; parked?: object };
    directory: string;
    marker: Parameters<typeof inspectPublicJourneyAttemptMarker>[1];
    previous: PublicHistory | undefined;
    deadline: number;
  }
>();

export async function claimActualPublicJourneyInvocation(
  progressReceipt: object,
  inputs: {
    pair: object;
    prior_package: object;
    candidate_package: object;
    parked_package?: object;
    compiler?: { prior: object; candidate: object; parked?: object };
  },
) {
  inputs = { ...inputs, ...(inputs.compiler ? { compiler: { ...inputs.compiler } } : {}) };
  const progress = publicProgress.get(progressReceipt);
  if (!progress) throw new Error("actual public progress custody required");
  if (
    progress.phase !== "initial-v0-v1" &&
    progress.phase !== "park-v0-with-v1" &&
    progress.phase !== "continue-with-v2"
  )
    throw new Error(
      "public cohort requires authenticated continuation or is already complete; no replay",
    );
  const selected = await requireActualPublicJourneySource(inputs.pair);
  const continuation = progress.phase === "continue-with-v2";
  const historical =
    continuation && selected.historical_cohort_receipt
      ? await requireActualRetainedPublicCohort(selected.historical_cohort_receipt)
      : undefined;
  if (
    continuation !== Boolean(historical) ||
    selected.parent_receipt !== progress.parent ||
    (historical ? historical.cohort_sha256 : digest(selected.pair)) !== progress.cohort
  )
    throw new Error("public pair parent/cohort differs");
  const root = selected.parent.descriptor.capture_root;
  if (claimingRoots.has(root)) throw new Error("native capture-root claim is already in progress");
  claimingRoots.add(root);
  try {
    // Revalidate every old proof immediately before latching the shared anchor.
    const refreshed = await readActualPublicJourneyProgress(inputs.pair),
      fresh = publicProgress.get(refreshed)!;
    if (fresh.inventory !== progress.inventory || fresh.phase !== progress.phase)
      throw new Error("public progress changed before claim");
    const prior = await requireActualPublicJourneyPackage(inputs.prior_package),
      candidate = await requireActualPublicJourneyPackage(inputs.candidate_package);
    if (
      prior.pair_receipt !== inputs.pair ||
      candidate.pair_receipt !== inputs.pair ||
      prior.slot !== "prior" ||
      candidate.slot !== "candidate"
    )
      throw new Error("actual public package slots differ");
    const parked = inputs.parked_package
      ? await requireActualPublicJourneyPackage(inputs.parked_package)
      : undefined;
    if (
      continuation
        ? !parked || parked.pair_receipt !== inputs.pair || parked.slot !== "parked"
        : Boolean(parked)
    )
      throw new Error("actual parked V1 package custody differs");
    let compiler;
    if (selected.parent.descriptor.platform_label === "windows-x86_64") {
      if (!inputs.compiler) throw new Error("actual Windows compiler inputs required");
      const before = await requireActualPublicWindowsCompilerIdentity(inputs.compiler.prior),
        after = await requireActualPublicWindowsCompilerIdentity(inputs.compiler.candidate);
      if (
        before.pair_receipt !== inputs.pair ||
        after.pair_receipt !== inputs.pair ||
        before.slot !== "prior" ||
        after.slot !== "candidate"
      )
        throw new Error("public compiler slots differ");
      const old = inputs.compiler.parked
        ? await requireActualPublicWindowsCompilerIdentity(inputs.compiler.parked)
        : undefined;
      if (
        continuation
          ? !old || old.pair_receipt !== inputs.pair || old.slot !== "parked"
          : Boolean(old)
      )
        throw new Error("actual parked V1 compiler custody differs");
      compiler = {
        prior: digest(before.identity),
        candidate: digest(after.identity),
        ...(old ? { parked: digest(old.identity) } : {}),
      };
    } else if (inputs.compiler) throw new Error("Windows compiler inputs cannot qualify Linux");
    const journal = await selected.source.recover();
    if (journal.input.active_candidate !== null)
      throw new Error("active candidate appeared before public claim");
    const request = {
      schema_version: 1,
      profile: "ordinary-public-initial-cohort-v1",
      platform_label: selected.parent.descriptor.platform_label,
      phase: progress.phase,
      client: progress.phase === "initial-v0-v1" ? "client-a" : "client-b",
      cohort_sha256: progress.cohort,
      lineage: {
        checkpoint: journal.checkpoint,
        published_metadata_sha256: digest(journal.input.published_metadata),
        capacity_sha256: digest(journal.input.capacity),
      },
      proof_inputs: {
        candidate_compiler_sha256: compiler?.candidate ?? null,
        prior_compiler_sha256: compiler?.prior ?? null,
        candidate_package_sha256: candidate.identity.package.sha256,
        prior_package_sha256: prior.identity.package.sha256,
        pair_sha256: digest(selected.pair),
        source_directory: path.basename(selected.directory),
        ...(continuation
          ? {
              parked_package_sha256: parked!.identity.package.sha256,
              parked_compiler_sha256: compiler?.parked ?? null,
              previous_parked_invocation_id: historical!.parked.marker.invocation_id,
            }
          : {}),
      },
    };
    const marker = {
      schema_version: 2,
      kind: "ordinary-public-native-attempt",
      authority: "none",
      descriptor_sha256: selected.parent.descriptor_sha256,
      setup_grant_sha256: selected.parent.descriptor.setup_grant_sha256,
      request,
      request_sha256: digest(request),
      invocation_id: digest({
        kind: "ordinary-public-native-attempt",
        setup_grant_sha256: selected.parent.descriptor.setup_grant_sha256,
        descriptor_sha256: selected.parent.descriptor_sha256,
        request,
      }),
    };
    inspectPublicJourneyAttemptMarker(marker, marker);
    const current = await inventory(root, marker.setup_grant_sha256);
    if (digest(current.invocations) !== progress.inventory || current.invocations.length >= 1024)
      throw new Error("public anchor changed or bound exhausted");
    await selected.parent.recheck();
    const handle = await open(path.join(root, ".native-capture-custody.jsonl"), "r+");
    try {
      const original = await readBoundedPublicBuildInputFile(
          root,
          ".native-capture-custody.jsonl",
          128 * 1024,
        ),
        info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== original.length ||
        digest((await inventory(root, marker.setup_grant_sha256)).invocations) !==
          progress.inventory
      )
        throw new Error("public anchor changed before append");
      const appended = `${marker.invocation_id}\n`,
        written = await handle.write(appended, info.size, "utf8");
      if (written.bytesWritten !== Buffer.byteLength(appended))
        throw new Error("public anchor append incomplete");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = path.join(root, name(marker.invocation_id));
    await mkdir(directory, { mode: 0o700 });
    const file = await open(path.join(directory, "claim.json"), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(marker));
      await file.sync();
    } finally {
      await file.close();
    }
    remainingNativeParentBudget();
    const receipt = Object.freeze({
      kind: "actual-public-native-invocation",
      invocation_id: marker.invocation_id,
      authority: "none" as const,
    });
    publicClaims.set(receipt, {
      pair: inputs.pair,
      parent: progress.parent,
      prior_package: inputs.prior_package,
      candidate_package: inputs.candidate_package,
      ...(inputs.parked_package ? { parked_package: inputs.parked_package } : {}),
      ...(inputs.compiler ? { compiler: { ...inputs.compiler } } : {}),
      directory,
      marker,
      previous: progress.history.at(-1),
      deadline: selected.deadline,
    });
    return receipt;
  } finally {
    claimingRoots.delete(root);
  }
}

export async function requireActualPublicJourneyInvocation(receipt: object) {
  const retained = publicClaims.get(receipt);
  if (!retained) throw new Error("actual freshly claimed public invocation required");
  const selected = await requireActualPublicJourneySource(retained.pair);
  const parent = await requireActualNativeParent(retained.parent);
  if (performance.now() >= retained.deadline)
    throw new Error("original public invocation lifetime exhausted");
  const marker = inspectPublicJourneyAttemptMarker(
    await publicJson(retained.directory, "claim.json"),
    retained.marker,
  );
  if (digest(await publicJson(retained.directory, "claim.json")) !== digest(retained.marker))
    throw new Error("public claim changed");
  const current = await inventory(
    parent.descriptor.capture_root,
    parent.descriptor.setup_grant_sha256,
  );
  if (!current.invocations.includes(marker.invocation_id))
    throw new Error("public claim anchor missing");
  const prior = await requireActualPublicJourneyPackage(retained.prior_package),
    candidate = await requireActualPublicJourneyPackage(retained.candidate_package);
  const parked = retained.parked_package
    ? await requireActualPublicJourneyPackage(retained.parked_package)
    : undefined;
  if (
    parked &&
    (parked.pair_receipt !== retained.pair ||
      parked.slot !== "parked" ||
      !isRecord(marker.request.proof_inputs) ||
      parked.identity.package.sha256 !== marker.request.proof_inputs.parked_package_sha256)
  )
    throw new Error("parked V1 package changed");
  if (retained.compiler)
    for (const slot of ["prior", "candidate"] as const) {
      const compiler = await requireActualPublicWindowsCompilerIdentity(retained.compiler[slot]);
      const proof = marker.request.proof_inputs;
      if (!isRecord(proof) || digest(compiler.identity) !== proof[`${slot}_compiler_sha256`])
        throw new Error("public compiler identity changed");
    }
  if (retained.compiler?.parked) {
    const compiler = await requireActualPublicWindowsCompilerIdentity(retained.compiler.parked);
    if (
      compiler.pair_receipt !== retained.pair ||
      compiler.slot !== "parked" ||
      !isRecord(marker.request.proof_inputs) ||
      digest(compiler.identity) !== marker.request.proof_inputs.parked_compiler_sha256
    )
      throw new Error("parked V1 compiler identity changed");
  }
  const previous = retained.previous
    ? await readPublicSettlement(
        parent,
        retained.previous.directory,
        retained.previous.marker.invocation_id,
      )
    : undefined;
  if (
    marker.phase === "continue-with-v2" &&
    (!previous ||
      !isRecord(marker.request.proof_inputs) ||
      previous.marker.phase !== "park-v0-with-v1" ||
      previous.marker.invocation_id !== marker.request.proof_inputs.previous_parked_invocation_id)
  )
    throw new Error("original parked B capture differs");
  remainingNativeParentBudget();
  return {
    parent,
    parent_receipt: retained.parent,
    pair: selected,
    pair_receipt: retained.pair,
    prior_package: prior,
    candidate_package: candidate,
    prior_package_receipt: retained.prior_package,
    candidate_package_receipt: retained.candidate_package,
    ...(parked ? { parked_package: parked, parked_package_receipt: retained.parked_package } : {}),
    ...(retained.compiler ? { compiler_receipts: { ...retained.compiler } } : {}),
    invocation_id: marker.invocation_id,
    request_sha256: marker.request_sha256,
    phase: marker.phase,
    client: marker.client,
    capture_directory: retained.directory,
    original_deadline: retained.deadline,
    previous_settled_capture: previous,
    authority: "none" as const,
    scope: "actual parent/source/attempt custody; public native proof still required" as const,
  };
}

/** Only the actual supervised Windows capture getter supplies the technical
 * result. There is deliberately no exported raw settlement constructor. */
export async function recordActualWindowsPublicSettlement(captureReceipt: object) {
  const { requireActualWindowsPublicCapture } =
    await import("./release-native-windows-capture.mts");
  const capture = await requireActualWindowsPublicCapture(captureReceipt);
  const selected = await requireActualPublicJourneyInvocation(capture.claim);
  const marker = inspectPublicJourneyAttemptMarker(
    await publicJson(selected.capture_directory, "claim.json"),
    {
      invocation_id: selected.invocation_id,
      descriptor_sha256: selected.parent.descriptor_sha256,
      setup_grant_sha256: selected.parent.descriptor.setup_grant_sha256,
    },
  );
  return retainPublicSettlement(selected, capture.settlement, marker);
}

/** Only the private actual Linux capture getter supplies these observations.
 * The raw wire is separate from ordinary exported-file bounds. */
export async function recordActualLinuxPublicSettlement(captureReceipt: object) {
  const { requireActualLinuxPublicCapture } =
    await import("./release-native-linux-public-capture.mts");
  const capture = await requireActualLinuxPublicCapture(captureReceipt);
  const selected = await requireActualPublicJourneyInvocation(capture.claim);
  if (
    selected.parent.descriptor.platform_label !== "linux-x86_64" ||
    capture.directory !== selected.capture_directory ||
    capture.retained.directory !== path.join(selected.capture_directory, "guest-capture")
  )
    throw new Error("actual Linux capture/claim directory differs");
  const marker = inspectPublicJourneyAttemptMarker(
    await publicJson(selected.capture_directory, "claim.json"),
    {
      invocation_id: selected.invocation_id,
      descriptor_sha256: selected.parent.descriptor_sha256,
      setup_grant_sha256: selected.parent.descriptor.setup_grant_sha256,
    },
  );
  const files = inspectLinuxPublicRetainedInventory(capture.files, selected.phase);
  for (const name of [
    "claim.json",
    "wsl-capture-summary.json",
    "wsl-plan.json",
    "wsl-request.json",
    "wsl-driver-plan.json",
    "wsl-registration-before.json",
    "wsl-registration-after.json",
    "guest-host-before.stdout.bin",
    "guest-host-after.stdout.bin",
  ]) {
    const { hashNativeCapturedFile } = await import("./release-native-capture-files.mts");
    files.push(
      await hashNativeCapturedFile(
        selected.capture_directory,
        name,
        4 * 1024 * 1024,
        selected.original_deadline,
      ),
    );
  }
  const settlement = {
    schema_version: 1,
    kind: "ordinary-public-native-settlement",
    authority: "none",
    invocation_id: selected.invocation_id,
    request_sha256: selected.request_sha256,
    phase: selected.phase,
    platform_label: "linux-x86_64",
    proof_outcome: inspectLinuxPublicProofOutcome(
      capture.report,
      selected.phase,
      capture.driver_status,
      capture.driver_failure,
    ),
    group: capture.group,
    roots: capture.roots,
    files,
    wire: capture.wire,
  };
  await requireActualLinuxPublicCapture(captureReceipt);
  const result = await retainPublicSettlement(selected, settlement, marker);
  await requireActualLinuxPublicCapture(captureReceipt);
  await requireActualPublicJourneyInvocation(capture.claim);
  remainingNativeParentBudget();
  return result;
}

async function retainPublicSettlement(
  selected: Awaited<ReturnType<typeof requireActualPublicJourneyInvocation>>,
  settlement: unknown,
  marker: ReturnType<typeof inspectPublicJourneyAttemptMarker>,
) {
  const validated = inspectPublicJourneySettlement(settlement, marker);
  const file = path.join(selected.capture_directory, "public-settlement.json");
  const bytes = Buffer.from(JSON.stringify(settlement));
  if (bytes.length > 256 * 1024)
    throw new Error("public settlement exceeds bounded technical manifest");
  if (await absent(file)) {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else if (
    digest(await publicJson(selected.capture_directory, "public-settlement.json")) !==
    digest(settlement)
  )
    throw new Error("retained public settlement differs; never overwrite or replay");
  await readPublicSettlement(selected.parent, selected.capture_directory, selected.invocation_id);
  remainingNativeParentBudget();
  return Object.freeze({
    kind: "retained-public-technical-settlement",
    invocation_id: selected.invocation_id,
    phase: selected.phase,
    proof_outcome: validated.proof_outcome,
    authority: "none" as const,
    scope:
      "positive owned teardown and retained observation bytes; full public A/B V2 proof remains pending",
  });
}
