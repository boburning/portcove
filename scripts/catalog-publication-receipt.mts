import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReadableStreamReadResult } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  priorVersions,
  publishedTargets,
  publishedVersionsFromMetadata,
  publishedTargetsFromMetadata,
} from "./catalog-publish.mts";
import {
  compactListingDeliveryTarget,
  listingDeliveryMaximum,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";
import {
  catalogDefinitionContentBytes,
  catalogDefinitionIndexBytes,
} from "./release-catalog-publication-contract.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";

const pages = "https://boburning.github.io/portcove/catalog/";
const index = "definitions/index.json";
const historyTarget = "policy/official/catalog.history-checkpoint.json";
const maximumReadbackBytes = 32 * 1024 ** 2;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = /^[a-f0-9]{64}$/u;
const idPattern = /^[a-z0-9][a-z0-9-]{0,127}$/u;
type Identity = { target: string; sha256: string };
type Evidence = Identity & { revision: number };
type Definition = {
  definition: Evidence;
  contents: Identity[];
  policy: Evidence;
  launch: Evidence | null;
  policyScope: unknown;
  launchScope: unknown;
};

function object(bytes: Buffer) {
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(parsed)) throw new Error("invalid published catalog document");
  return parsed;
}
function revision(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid published catalog revision");
  return value;
}
function immutablePath({ target, sha256 }: Identity) {
  if (!digest.test(sha256)) throw new Error("invalid published catalog digest");
  return `targets/${sha256}.${target}`;
}
function targetLimit(target: string) {
  if (target === listingDeliveryTarget || target === compactListingDeliveryTarget)
    return listingDeliveryMaximum;
  if (target.startsWith("policy/")) return 65_536;
  return target === index ? catalogDefinitionIndexBytes : catalogDefinitionContentBytes;
}
function identity(targets: Record<string, string>, target: string): Identity {
  const sha256 = targets[target];
  if (!sha256 || !digest.test(sha256))
    throw new Error(`missing published catalog target ${target}`);
  return { target, sha256 };
}

type ReadCatalog = (file: string, limit: number) => Promise<Buffer>;

type CatalogSource = string | ReadCatalog;

async function readState(site: CatalogSource | null) {
  if (!site)
    return {
      versions: null,
      timestamp: null,
      index: null,
      listings: null,
      historyPointer: null,
      definitions: new Map<string, Definition>(),
    };
  const read: ReadCatalog =
    typeof site === "string"
      ? (name, limit) => readControllerToolFile(path.join(site, name), limit)
      : site;
  const timestampBytes = await read("metadata/timestamp.json", 1_048_576);
  const timestamp = sha256(timestampBytes);
  let versions;
  let targets;
  if (typeof site === "string") {
    versions = priorVersions(site);
    if (!versions) throw new Error("published catalog timestamp is missing");
    targets = publishedTargets(site);
  } else {
    const document = object(timestampBytes);
    const snapshotMeta =
      isRecord(document.signed) && isRecord(document.signed.meta)
        ? document.signed.meta["snapshot.json"]
        : null;
    const snapshotVersion = revision(isRecord(snapshotMeta) ? snapshotMeta.version : null);
    const snapshot = object(await read(`metadata/${snapshotVersion}.snapshot.json`, 8 * 1024 ** 2));
    versions = publishedVersionsFromMetadata((name) =>
      name === "timestamp.json" ? document : snapshot,
    );
    const definitions = await read(
      `metadata/${versions.definitions}.official-definitions.json`,
      8 * 1024 ** 2,
    );
    const policy = await read(`metadata/${versions.policy}.official-policy.json`, 8 * 1024 ** 2);
    const metadata = new Map([
      [`${versions.definitions}.official-definitions.json`, object(definitions)],
      [`${versions.policy}.official-policy.json`, object(policy)],
    ]);
    targets = publishedTargetsFromMetadata(versions, (name) => metadata.get(name));
  }
  const indexIdentity = identity(targets, index);
  let remaining = maximumReadbackBytes;
  const readTarget = async (entry: Identity) => {
    const result = await read(immutablePath(entry), Math.min(remaining, targetLimit(entry.target)));
    remaining -= result.length;
    if (sha256(result) !== entry.sha256)
      throw new Error(`published catalog target bytes differ for ${entry.target}`);
    return object(result);
  };
  const indexDocument = await readTarget(indexIdentity);
  if (
    indexDocument.index_schema !== 1 ||
    !Array.isArray(indexDocument.definitions) ||
    indexDocument.definitions.length > 2048
  )
    throw new Error("published catalog index exceeds receipt scope");
  const definitions = new Map<string, Definition>();
  for (const raw of indexDocument.definitions as unknown[]) {
    if (
      !isRecord(raw) ||
      raw.namespace !== "official" ||
      typeof raw.stable_id !== "string" ||
      !idPattern.test(raw.stable_id) ||
      definitions.has(raw.stable_id) ||
      typeof raw.target !== "string" ||
      !/^sha256\/[a-f0-9]{64}\.json$/u.test(raw.target)
    )
      throw new Error("published catalog definition identity differs");
    const id = raw.stable_id;
    const definition = { ...identity(targets, raw.target), revision: revision(raw.revision) };
    const entry = await readTarget(definition);
    if (
      entry.namespace !== "official" ||
      entry.stable_id !== id ||
      entry.revision !== definition.revision
    )
      throw new Error(`published definition entry differs for ${id}`);
    const references = [entry.execution_contract, entry.persistence_contract];
    for (const field of ["source_contracts", "artifact_bindings", "evidence_references"]) {
      const values = entry[field];
      if (!Array.isArray(values) || values.length > 256)
        throw new Error("published definition reference bound differs");
      references.push(...(values as unknown[]));
    }
    const contents = [...new Set(references)].map((target) => {
      if (typeof target !== "string" || !/^sha256\/[a-f0-9]{64}\.json$/u.test(target))
        throw new Error("published definition content path differs");
      return identity(targets, target);
    });
    const policyIdentity = identity(targets, `policy/official/${id}.json`);
    const policyDocument = await readTarget(policyIdentity);
    const { policy_revision, decision, ...scope } = policyDocument;
    if (
      !isRecord(decision) ||
      decision.index_sha256 !== indexIdentity.sha256 ||
      decision.definition_sha256 !== definition.sha256 ||
      decision.definition_revision !== definition.revision
    )
      throw new Error(`published policy binding differs for ${id}`);
    const { index_sha256: _index, ...authority } = decision;
    const policy = { ...policyIdentity, revision: revision(policy_revision) };
    const launchTarget = `policy/official/${id}.launch.json`;
    let launch: Evidence | null = null;
    let launchScope: unknown = null;
    if (Object.hasOwn(targets, launchTarget)) {
      const launchIdentity = identity(targets, launchTarget);
      const {
        revision: launchRevision,
        policy_sha256: binding,
        ...assessments
      } = await readTarget(launchIdentity);
      if (binding !== policy.sha256) throw new Error(`published launch binding differs for ${id}`);
      launch = { ...launchIdentity, revision: revision(launchRevision) };
      launchScope = assessments;
    }
    definitions.set(id, {
      definition,
      contents,
      policy,
      launch,
      policyScope: { ...scope, decision: authority },
      launchScope,
    });
  }
  const activeListingTarget = Object.hasOwn(targets, compactListingDeliveryTarget)
    ? compactListingDeliveryTarget
    : listingDeliveryTarget;
  return {
    versions,
    timestamp,
    index: indexIdentity,
    listings: Object.hasOwn(targets, activeListingTarget)
      ? identity(targets, activeListingTarget)
      : null,
    historyPointer: Object.hasOwn(targets, historyTarget) ? identity(targets, historyTarget) : null,
    definitions,
  };
}

type State = Awaited<ReturnType<typeof readState>>;
function compact(definition: Definition | undefined) {
  if (!definition) return null;
  const { definition: entry, contents, policy, launch } = definition;
  return { entry, contents, policy, launch };
}

/** Uses the assembled new and verified retained local repository metadata. A
 * caller must still read back the returned immutable public targets. */
export async function describeCatalogPublication(prior: CatalogSource | null, next: CatalogSource) {
  const before = await readState(prior);
  const after = await readState(next);
  const pending = new Map<string, Identity>();
  const requireReadback = (candidate: Identity | null | undefined) => {
    if (candidate) pending.set(candidate.target, candidate);
  };
  requireReadback(after.index);
  const changes = [...new Set([...before.definitions.keys(), ...after.definitions.keys()])]
    .sort()
    .flatMap((id) => {
      const old = before.definitions.get(id);
      const current = after.definitions.get(id);
      if (isDeepStrictEqual(compact(old), compact(current))) return [];
      const kind = !old
        ? "initial"
        : !current
          ? "removed"
          : !isDeepStrictEqual(old.definition, current.definition)
            ? "revised"
            : before.index?.sha256 !== after.index?.sha256 &&
                isDeepStrictEqual(old.policyScope, current.policyScope) &&
                isDeepStrictEqual(old.launchScope, current.launchScope)
              ? "retained-index-rebind"
              : "policy-revised";
      requireReadback(current?.definition);
      current?.contents.forEach(requireReadback);
      requireReadback(current?.policy);
      requireReadback(current?.launch);
      return [{ id, kind, prior: compact(old), published: compact(current) }];
    });
  const listingChanged = !isDeepStrictEqual(before.listings, after.listings);
  if (listingChanged) requireReadback(after.listings);
  if (pending.size > 256 || changes.length > 128)
    throw new Error("publication receipt target count exceeds its bound");
  const snapshot = ({ versions, timestamp, index, listings }: State) => ({
    versions,
    timestamp_sha256: timestamp,
    index,
    listings,
  });
  return {
    prior: snapshot(before),
    published: snapshot(after),
    changes,
    listingChanged,
    historyPointer: after.historyPointer,
    targets: [...pending.values()],
  };
}

async function readLiveDigest(
  url: string,
  limit: number,
  signal: AbortSignal,
  fetcher: typeof fetch,
  retainBody = false,
) {
  const response = await fetcher(url, { signal, redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("public catalog readback unavailable");
  }
  const reader = response.body.getReader();
  const hasher = createHash("sha256");
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      count += value.byteLength;
      if (count > limit) throw new Error("public catalog readback exceeds receipt bound");
      hasher.update(value);
      if (retainBody) chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return {
    sha256: hasher.digest("hex"),
    bytes: count,
    body: retainBody ? Buffer.concat(chunks, count) : undefined,
  };
}

async function confirmLiveTarget(
  url: string,
  expected: string,
  limit: number,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const result = await readLiveDigest(url, limit, signal, fetcher);
  if (result.sha256 !== expected) throw new Error("public catalog readback bytes differ");
  return result.bytes;
}

type LateOutcome = "awaiting-deployment" | "timestamp-changed-during-observation" | "incomplete";

export class LateReadbackFailure extends Error {
  readonly outcome: LateOutcome;
  readonly observedTimestampSha256: string;

  constructor(outcome: LateOutcome, observedTimestampSha256: string) {
    super(`public catalog readback bytes differ (${outcome})`);
    this.outcome = outcome;
    this.observedTimestampSha256 = observedTimestampSha256;
  }
}

function observedNewerTimestamp(body: Buffer | undefined, current: number | undefined) {
  if (!body || current === undefined) return false;
  try {
    const envelope = object(body);
    if (!isRecord(envelope.signed) || !isRecord(envelope.signed.meta)) return false;
    const next = revision(envelope.signed.version);
    const snapshot = envelope.signed.meta["snapshot.json"];
    // This reports a higher version present in a public response. The
    // response never supplies evidence that supersession was authenticated.
    return (
      next > current &&
      isRecord(snapshot) &&
      isRecord(snapshot.hashes) &&
      typeof snapshot.hashes.sha256 === "string" &&
      digest.test(snapshot.hashes.sha256) &&
      revision(snapshot.version) > 0 &&
      revision(snapshot.length) > 0
    );
  } catch {
    return false;
  }
}

export type BrowseReadback = { path: string; sha256: string };
export type HistoryReadback = BrowseReadback & { bytes: number };

export async function verifyCatalogPublicationLive(
  description: Awaited<ReturnType<typeof describeCatalogPublication>>,
  nonce: string,
  fetcher: typeof fetch = fetch,
  browse: readonly BrowseReadback[] = [],
  history: readonly HistoryReadback[] = [],
  late?: { metadata: readonly HistoryReadback[] },
) {
  const signal = AbortSignal.timeout(45_000);
  const timestamp = description.published.timestamp_sha256;
  if (!timestamp) throw new Error("no published timestamp for receipt");
  const timestampUrl = `${pages}metadata/timestamp.json?receipt=${encodeURIComponent(nonce)}`;
  let remaining = maximumReadbackBytes;
  const readTimestamp = async (ending: boolean) => {
    const result = await readLiveDigest(
      ending ? `${timestampUrl}-end` : timestampUrl,
      1_048_576,
      signal,
      fetcher,
      ending && !!late,
    );
    if (result.sha256 === timestamp) return;
    if (!late) throw new Error("public catalog readback bytes differ");
    throw new LateReadbackFailure(
      !ending && result.sha256 === description.prior.timestamp_sha256
        ? "awaiting-deployment"
        : ending && observedNewerTimestamp(result.body, description.published.versions?.timestamp)
          ? "timestamp-changed-during-observation"
          : "incomplete",
      result.sha256,
    );
  };
  await readTimestamp(false);
  for (const entry of late?.metadata ?? []) {
    const actual = await confirmLiveTarget(
      `${pages}${entry.path}`,
      entry.sha256,
      entry.bytes,
      signal,
      fetcher,
    );
    if (actual !== entry.bytes) throw new Error("public catalog role metadata length differs");
  }
  for (const target of description.targets) {
    remaining -= await confirmLiveTarget(
      pages + immutablePath(target),
      target.sha256,
      Math.min(targetLimit(target.target), remaining),
      signal,
      fetcher,
    );
  }
  let browseRemaining = 64 * 1024 ** 2;
  for (const entry of browse) {
    const limit = entry.path === "browse/inputs.json" ? 8192 : browseRemaining;
    browseRemaining -= await confirmLiveTarget(
      `${pages}${entry.path}?receipt=${encodeURIComponent(nonce)}`,
      entry.sha256,
      Math.min(limit, browseRemaining),
      signal,
      fetcher,
    );
  }
  for (const entry of history) {
    const url = new URL(`../${entry.path}`, pages);
    const bytes = await confirmLiveTarget(url.href, entry.sha256, entry.bytes, signal, fetcher);
    if (bytes !== entry.bytes) throw new Error("public catalog history length differs");
  }
  await readTimestamp(true);
  return maximumReadbackBytes - remaining;
}

async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      work: { type: "string" },
      output: { type: "string" },
      "browse-index-sha256": { type: "string" },
      "browse-inputs-sha256": { type: "string" },
    },
  });
  const { work, output } = values;
  const browse = values["browse-index-sha256"];
  const inputs = values["browse-inputs-sha256"];
  const { COMMIT, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_EVENT_NAME } = process.env;
  if (
    !work ||
    !output ||
    !browse ||
    !inputs ||
    !digest.test(browse) ||
    !digest.test(inputs) ||
    !COMMIT ||
    !/^[a-f0-9]{40}$/u.test(COMMIT) ||
    !GITHUB_RUN_ID ||
    !/^\d+$/u.test(GITHUB_RUN_ID) ||
    !GITHUB_RUN_ATTEMPT ||
    !/^\d+$/u.test(GITHUB_RUN_ATTEMPT) ||
    !GITHUB_EVENT_NAME ||
    !/^[a-z_]{1,32}$/u.test(GITHUB_EVENT_NAME)
  )
    throw new Error(
      "catalog publication receipt requires exact producing run and readback evidence",
    );
  const prior = path.join(work, "prior");
  const description = await describeCatalogPublication(
    existsSync(prior) ? prior : null,
    path.join(work, "repository"),
  );
  const bytes = await verifyCatalogPublicationLive(
    description,
    `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`,
  );
  const priorBrowse = path.join(work, "prior-browse/inputs.json");
  const priorInputs = existsSync(priorBrowse)
    ? sha256(await readControllerToolFile(priorBrowse, 8192))
    : null;
  const { targets, listingChanged, historyPointer: _historyPointer, ...receipt } = description;
  const serialized = `${JSON.stringify(
    {
      schema_version: 1,
      kind: "catalog-publication-live-readback",
      observed_at: new Date().toISOString(),
      authority: "none",
      source_commit: COMMIT,
      run: GITHUB_RUN_ID,
      attempt: GITHUB_RUN_ATTEMPT,
      trigger: GITHUB_EVENT_NAME,
      ...receipt,
      publication_kind: receipt.changes.length
        ? "definition-or-policy-change"
        : listingChanged || priorInputs !== inputs
          ? "descriptive-refresh"
          : "metadata-renewal",
      descriptive_target_changed: listingChanged,
      browse: { index_sha256: browse, inputs_sha256: inputs, prior_inputs_sha256: priorInputs },
      readback: {
        immutable_targets: targets,
        immutable_target_bytes: bytes,
        timestamp_rechecked: true,
      },
    },
    null,
    2,
  )}\n`;
  if (Buffer.byteLength(serialized) > 1_048_576)
    throw new Error("catalog publication receipt exceeds its byte bound");
  await writeFile(output, serialized, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
