/** Ordinary public source custody. A published pair is not native acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  openActualNativePublicSource,
  inspectPublicImmutableReleaseAsset,
} from "./release-native-candidate.mts";
import { remainingNativeParentBudget } from "./release-native-parent.mts";
import { createReleasePublicationReader } from "./release-publication-inventory.mts";
import {
  materializePublishedCompleteSite,
  requirePublishedCompleteSite,
} from "./release-site-readback.mts";
import {
  prepareAuthenticatedMetadataRenewal,
  inspectPreparedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { compareApplicationVersionPrecedence } from "../apps/desktop/scripts/release-version-policy.mts";
import {
  inspectPublishedMetadata,
  assertMetadataRenewalBinding,
} from "./release-metadata-contract.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Allocation = ReturnType<
  ReturnType<typeof createReleasePublicationReader>["readAllocations"]
>["allocations"][number];
function record(raw: unknown) {
  assert.ok(isRecord(raw), "public journey source record absent");
  return raw;
}
function hex(raw: unknown, length: number): string {
  assert.ok(typeof raw === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(raw));
  return raw;
}

/** Association only. Inputs must independently come from complete allocated
 * raw-commit receipts and the actual Tough-verified retained records below.
 * Selects the first two allocations, never a caller-appointed version/tag. */
export function inspectInitialPublicJourneyCohort(
  allocations: readonly Allocation[],
  files: ReadonlyMap<string, Buffer>,
  platform: "windows-x86_64" | "linux-x86_64",
) {
  assert.ok(allocations.length >= 2 && allocations.length <= 256);
  const ordered = allocations
    .map((item) => structuredClone(item))
    .sort((a, b) => compareApplicationVersionPrecedence(a.version, b.version));
  assert.equal(new Set(ordered.map((item) => item.version)).size, ordered.length);
  for (let i = 1; i < ordered.length; i++)
    assert.ok(
      compareApplicationVersionPrecedence(ordered[i - 1]!.version, ordered[i]!.version) < 0,
    );
  const manifestBytes = files.get("records/reconstruction-manifest.json");
  assert.ok(manifestBytes);
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")));
  assert.equal(manifest.schema_version, 1);
  assert.ok(Array.isArray(manifest.records) && manifest.records.length <= 1536);
  const format = platform === "windows-x86_64" ? "nsis" : "appimage";
  const records = manifest.records.map((raw: unknown) => {
    const item = record(raw);
    assert.ok(
      typeof item.path === "string" &&
        /^(?:releases|channels)\/[A-Za-z0-9._+/-]+\.json$/u.test(item.path) &&
        !item.path.split("/").some((part) => !part || part === "." || part === ".."),
    );
    const bytes = files.get(`records/${item.path}`);
    assert.ok(bytes && bytes.length === item.bytes && sha(bytes) === item.sha256);
    return { entry: item, value: record(JSON.parse(bytes.toString("utf8"))) };
  });
  assert.equal(new Set(records.map((item) => item.entry.path)).size, records.length);
  const eligible = records
    .filter(
      ({ entry, value }) =>
        entry.kind === "promotion" &&
        entry.channel === "preview" &&
        entry.target === platform &&
        entry.package === format &&
        value.eligible === true &&
        value.withdrawn === false,
    )
    .sort((a, b) => compareApplicationVersionPrecedence(a.value.version, b.value.version));
  const selected = ordered.slice(0, 2).map((allocation) => {
    const found = records.filter(
      ({ entry }) =>
        entry.kind === "release" &&
        entry.target === platform &&
        entry.package === format &&
        entry.version === allocation.version,
    );
    assert.equal(found.length, 1, "initial public cohort release absent or ambiguous");
    const { entry, value } = found[0]!;
    assert.equal(value.schema_version, 1);
    assert.equal(value.version, allocation.version);
    assert.equal(value.target, platform);
    assert.equal(value.source_commit, allocation.prepared_commit);
    assert.equal(value.source_tree, allocation.prepared_tree);
    const run = record(value.qualified_run),
      artifact = record(value.artifact);
    assert.equal(run.workflow, ".github/workflows/release.yml");
    assert.equal(run.workflow_commit, allocation.prepared_commit);
    assert.ok(typeof run.run_id === "number" && Number.isSafeInteger(run.run_id) && run.run_id > 0);
    assert.ok(
      typeof run.attempt === "number" && Number.isSafeInteger(run.attempt) && run.attempt > 0,
    );
    assert.ok(
      typeof artifact.bytes === "number" &&
        Number.isSafeInteger(artifact.bytes) &&
        artifact.bytes > 0 &&
        artifact.bytes <= 1024 ** 3,
    );
    const url = new URL(String(artifact.url));
    const filename = decodeURIComponent(url.pathname.split("/").at(-1)!);
    assert.ok(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(filename));
    assert.equal(
      url.href,
      `https://github.com/boburning/portcove/releases/download/v${allocation.version}/${filename}`,
    );
    assert.ok(
      typeof artifact.tauri_signature === "string" &&
        artifact.tauri_signature.length > 0 &&
        artifact.tauri_signature.length <= 16384,
    );
    const promotions = eligible.filter((item) => item.entry.version === allocation.version);
    assert.equal(promotions.length, 1, "initial public cohort Preview eligibility absent");
    assert.equal(promotions[0]!.value.release_path, entry.path);
    assert.equal(promotions[0]!.value.release_sha256, entry.sha256);
    assert.equal(
      promotions[0]!.value.required_bridge,
      null,
      "initial ordinary cohort cannot bypass a required bridge",
    );
    return {
      version: allocation.version,
      source_commit: hex(value.source_commit, 40),
      source_tree: hex(value.source_tree, 40),
      run_id: String(run.run_id),
      run_attempt: run.attempt,
      allocation: structuredClone(allocation),
      record_path: String(entry.path),
      record_sha256: hex(entry.sha256, 64),
      package: {
        filename,
        bytes: artifact.bytes,
        sha256: hex(artifact.sha256, 64),
        url: url.href,
        tauri_signature: artifact.tauri_signature,
        payload_key_id: hex(artifact.payload_key_id, 64),
      },
      qualified_inventory_sha256: hex(run.inventory_sha256, 64),
    };
  });
  assert.equal(
    eligible.at(-1)?.entry.version,
    selected[1]!.version,
    "current public Preview no longer equals initial V1",
  );
  assert.notEqual(selected[0]!.package.sha256, selected[1]!.package.sha256);
  assert.notEqual(selected[0]!.source_commit, selected[1]!.source_commit);
  return Object.freeze({
    profile: "ordinary-public-initial-cohort-v1" as const,
    prior: Object.freeze(selected[0]!),
    candidate: Object.freeze(selected[1]!),
    authority: "none" as const,
  });
}

const pairs = new WeakMap<
  object,
  {
    session: Awaited<ReturnType<typeof openActualNativePublicSource>>;
    site: object;
    preparation: Awaited<ReturnType<typeof prepareAuthenticatedMetadataRenewal>>;
    seed: string;
    allocations: string;
    pair: ReturnType<typeof inspectInitialPublicJourneyCohort>;
    deadline: number;
  }
>();
export async function acquireActualPublicJourneyPair(parentReceipt: object) {
  const session = await openActualNativePublicSource(parentReceipt);
  const { parent, source, directory } = session;
  const deadline = performance.now() + remainingNativeParentBudget();
  const before = await source.recover();
  const input = record(before.input),
    seed = inspectPublishedMetadata(input.published_metadata);
  assert.ok(seed, "actual published metadata seed absent");
  const publication = parent.authority_configuration.publication;
  assert.ok(publication, "ratified public anchors absent");
  assert.equal(seed.root_sha256, publication.public_source.root.sha256);
  const site = await materializePublishedCompleteSite(
    {
      site_generation_sha256: seed.publication.site_generation_sha256,
      root_sha256: seed.root_sha256,
      repository_sha256: hex(seed.repository_sha256, 64),
    },
    directory,
    deadline,
  );
  const actual = await requirePublishedCompleteSite(site.receipt);
  const tool = parent.transport_configuration.post_sign_verifier;
  assert.ok(tool, "fixed actual keyless Tough verifier absent");
  const preparation = await prepareAuthenticatedMetadataRenewal({
    verifier: tool.path,
    verifier_sha256: tool.sha256,
    trusted_root: actual.root_path,
    trusted_root_sha256: actual.pins.root_sha256,
    previous_repository: actual.application,
    prior_repository_sha256: actual.pins.repository_sha256,
    generated_at: new Date().toISOString(),
    output_parent: directory,
    deadline,
  });
  const prepared = await inspectPreparedMetadataRenewal(preparation);
  assertMetadataRenewalBinding(prepared.descriptor, seed, new Date().toISOString());
  const preparedFiles = await readBoundedReleaseContextFiles(prepared.prepared_root);
  assert.equal(
    sha(preparedFiles.get("offline-targets.json")!),
    publication.public_source.offline_targets.sha256,
  );
  assert.equal(
    sha(preparedFiles.get("payload.json")!),
    publication.public_source.payload_key_registry.sha256,
  );
  const reader = createReleasePublicationReader(source.api);
  const allocations = reader.readAllocations(
    reader.tags(),
    parent.descriptor.namespace,
  ).allocations;
  const pair = inspectInitialPublicJourneyCohort(
    allocations,
    preparedFiles,
    parent.descriptor.platform_label,
  );
  const receipt = Object.freeze({
    kind: "actual-public-journey-pair",
    authority: "none",
    scope: "actual published source/Tough custody; native execution and public journey unobserved",
  });
  pairs.set(receipt, {
    session,
    site: site.receipt,
    preparation,
    seed: digest(seed),
    allocations: digest(allocations),
    pair,
    deadline,
  });
  await requireActualPublicJourneyPair(receipt);
  return receipt;
}
export async function requireActualPublicJourneyPair(receipt: object) {
  const retained = pairs.get(receipt);
  if (!retained) throw new Error("actual parent/public Tough pair required");
  assert.ok(performance.now() < retained.deadline, "original public parent lifetime exhausted");
  await retained.session.source.recheck();
  const current = await retained.session.source.recover();
  assert.equal(
    digest(record(current.input).published_metadata),
    retained.seed,
    "published seed changed during public journey",
  );
  const site = await requirePublishedCompleteSite(retained.site),
    prepared = await inspectPreparedMetadataRenewal(retained.preparation);
  assertMetadataRenewalBinding(
    prepared.descriptor,
    inspectPublishedMetadata(record(current.input).published_metadata),
    new Date().toISOString(),
  );
  const reader = createReleasePublicationReader(retained.session.source.api);
  const allocations = reader.readAllocations(
    reader.tags(),
    retained.session.parent.descriptor.namespace,
  ).allocations;
  assert.equal(
    digest(allocations),
    retained.allocations,
    "initial public allocation inventory changed",
  );
  const pair = inspectInitialPublicJourneyCohort(
    allocations,
    await readBoundedReleaseContextFiles(prepared.prepared_root),
    retained.session.parent.descriptor.platform_label,
  );
  assert.equal(digest(pair), digest(retained.pair));
  assert.ok(performance.now() < retained.deadline, "original public parent lifetime exhausted");
  return {
    pair,
    site,
    preparation: prepared,
    parent: retained.session.parent,
    directory: retained.session.directory,
    deadline: retained.deadline,
  };
}

const packages = new WeakMap<
  object,
  { pair: object; slot: "prior" | "candidate"; path: string; provider: string; read: () => unknown }
>();
/** Complete immutable Release association and opaque package acquisition only.
 * The fixed installed parent subsequently compares actual installed bytes. */
export async function materializeActualPublicJourneyPackage(
  pairReceipt: object,
  slot: "prior" | "candidate",
) {
  assert.ok(slot === "prior" || slot === "candidate");
  const selected = await requireActualPublicJourneyPair(pairReceipt),
    retained = pairs.get(pairReceipt)!;
  const identity = selected.pair[slot];
  const read = () => {
    const release = record(
      retained.session.source.api.request(
        "GET",
        `repos/boburning/portcove/releases/tags/v${identity.version}`,
      ).body,
    );
    assert.ok(typeof release.id === "number" && Number.isSafeInteger(release.id) && release.id > 0);
    const assets = retained.session.source.api.paginateRest(
      `repos/boburning/portcove/releases/${release.id}/assets?per_page=100`,
      {
        select: (body: unknown) => {
          assert.ok(Array.isArray(body) && body.length <= 64);
          return body.map((item: unknown) => item);
        },
        identity: (item: unknown) => {
          const id = record(item).id;
          assert.ok(typeof id === "number" && Number.isSafeInteger(id) && id > 0);
          return id;
        },
        label: "ordinary public immutable Release assets",
      },
    );
    assert.ok(assets.length <= 64);
    return { release, assets };
  };
  const before = read();
  const artifact = inspectPublicImmutableReleaseAsset(
    {
      version: identity.version,
      source_commit: identity.source_commit,
      source_tree: identity.source_tree,
      artifact: identity.package,
    },
    identity,
    before.release,
    before.assets,
  );
  const bytes = retained.session.source.downloadAsset(
    `repos/boburning/portcove/releases/assets/${artifact.id}`,
    {
      cwd: selected.directory,
      maxBytes: artifact.bytes,
      timeoutMs: remainingNativeParentBudget(120000),
    },
  );
  assert.ok(bytes.length === artifact.bytes && sha(bytes) === artifact.sha256);
  const file = path.join(selected.directory, `${slot}-${identity.package.filename}`);
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  assert.equal(
    digest(read()),
    digest(before),
    "immutable public Release changed during package acquisition",
  );
  await requireActualPublicJourneyPair(pairReceipt);
  const receipt = Object.freeze({
    kind: "actual-public-journey-package",
    authority: "none",
    scope: "exact immutable public package custody only",
  });
  packages.set(receipt, { pair: pairReceipt, slot, path: file, provider: digest(before), read });
  return receipt;
}
export async function requireActualPublicJourneyPackage(receipt: object) {
  const retained = packages.get(receipt);
  if (!retained) throw new Error("actual public immutable package custody required");
  const selected = await requireActualPublicJourneyPair(retained.pair),
    identity = selected.pair[retained.slot];
  const bytes = await readBoundedPublicBuildInputFile(
    path.dirname(retained.path),
    path.basename(retained.path),
    identity.package.bytes,
  );
  assert.ok(bytes.length === identity.package.bytes && sha(bytes) === identity.package.sha256);
  assert.equal(
    digest(retained.read()),
    retained.provider,
    "immutable public package provider changed before use",
  );
  assert.ok(performance.now() < selected.deadline, "original public parent lifetime exhausted");
  return {
    pair: selected,
    slot: retained.slot,
    path: retained.path,
    identity: structuredClone(identity),
    provider_sha256: retained.provider,
    authority: "none" as const,
  };
}
