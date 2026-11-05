/** Immutable bootstrap feed input. This GET-only transport authenticates byte
 * custody and the assembly's provenance; it cannot sign, publish or deploy. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readGitHubReleaseAsset } from "./github-binary.mts";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import { applicationApi, sha256 } from "./application-release-io.mts";
import { inspectTufPublicationFacts } from "./release-metadata-contract.mts";
import {
  inspectApplicationRunCustody,
  assertApplicationCustodyMetadataExtension,
  readApplicationRunNotes,
  inspectApplicationReleaseReference,
  readApplicationBudgetOwner,
} from "./application-release-run.mts";
import type { ApplicationRunCustody } from "./application-release-run.mts";
import type { ApplicationReleaseReference } from "./application-release-run.mts";
import {
  bootstrapAssetNames,
  readBootstrapSiteArchive,
  inspectHistoricalApplicationPublication,
  inspectApplicationMetadataPublicationReceipt,
} from "./application-release-publication.mts";
import type { BootstrapPublicationBinding } from "./application-release-publication.mts";
import type { ApplicationMetadataPublicationBinding } from "./application-release-publication.mts";
import type { ApplicationMetadataRenewalBasis } from "./application-release-publication.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { inspectSiteArtifactArchive } from "./release-site-deployment.mts";
import { createReleasePublicationReader } from "./release-publication-inventory.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import {
  readApplicationPagesState,
  readApplicationPagesExecution,
  assertBootstrapPagesActor,
} from "./application-release-site.mts";

/** Resolve provider facts before downloading any prior authority. This does not
 * authenticate a signing context: immutable assembly provenance, complete public
 * byte readback and the pinned Tough verifier remain mandatory downstream.
 * Only a caller-verified immutable pending cohort may be excluded for its own
 * feed recovery. Normal admission keeps every newer/concurrent cohort hold. */
type PendingCohort = { release_id: number; custody: ApplicationRunCustody };
export function discoverPublishedApplicationCohort(
  api: CoordinatorRemoteApi,
  pending?: PendingCohort | readonly PendingCohort[],
) {
  const exclusions: readonly PendingCohort[] =
    pending === undefined ? [] : "release_id" in pending ? [pending] : pending;
  assert.ok(
    exclusions.length <= 3 &&
      new Set(exclusions.map((value) => value.release_id)).size === exclusions.length,
  );
  const state = readApplicationPagesState(api);
  const execution = readApplicationPagesExecution(api, state);
  const cohorts = createReleasePublicationReader(api)
    .releaseNotes()
    .flatMap((release) => {
      const notes = readApplicationRunNotes(release.body ?? "");
      const nativeTag = /^portcove-production-candidate-(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(
        String(release.tag_name),
      );
      const nativeAsset =
        Array.isArray(release.assets) &&
        release.assets.some(
          (asset: unknown) => isRecord(asset) && asset.name === "application-metadata.json",
        );
      if (!release.draft && (nativeTag || nativeAsset))
        assert.ok(
          notes,
          "published native cohort lost its run custody; recover before continuation",
        );
      if (!notes || release.draft) return [];
      assert.equal(release.immutable, true, "published native cohort is mutable");
      assert.equal(release.target_commitish, notes.custody.source, "native source anchor changed");
      assert.ok(typeof release.published_at === "string");
      const published = Date.parse(release.published_at);
      assert.ok(Number.isFinite(published));
      return [{ release, custody: notes.custody, published }];
    });
  const matches = cohorts.filter(({ custody }) =>
    custody.runs.some((run) => run.id === execution.run.id),
  );
  assert.equal(matches.length, 1, "prior feed has no unique immutable native cohort");
  const selected = matches[0]!;
  assert.deepEqual(
    selected.custody.runs.find((run) => run.id === execution.run.id),
    execution.run,
    "immutable cohort and actual feed actor disagree",
  );
  assert.ok(typeof execution.deployment_created_at === "string");
  assert.ok(
    selected.published <= Date.parse(execution.deployment_created_at),
    "feed predates immutable publication",
  );
  for (const excluded of exclusions) {
    const recovered = cohorts.find((cohort) => cohort.release.id === excluded.release_id);
    assert.ok(
      recovered && recovered.release.id !== selected.release.id,
      "recovery exclusion must identify a distinct immutable pending cohort",
    );
    assert.deepEqual(recovered.custody, inspectApplicationRunCustody(excluded.custody));
  }
  assert.ok(
    cohorts.every(
      (cohort) =>
        cohort.release.id === selected.release.id ||
        exclusions.some((value) => value.release_id === cohort.release.id) ||
        cohort.published < selected.published,
    ),
    "newer or concurrent immutable cohort requires feed recovery before a new release",
  );
  const candidate = `portcove-production-candidate-${selected.custody.opportunity}`;
  const version = selected.custody.preparation;
  const tag = selected.release.tag_name;
  assert.ok(tag === candidate || (version !== null && tag === `v${version.version}`));
  const expectedCommit = tag === candidate ? selected.custody.source : version!.prepared_commit;
  const response = api.request("GET", `repos/boburning/portcove/git/ref/tags/${tag}`);
  assert.equal(response.status, 200);
  assert.ok(
    isRecord(response.body) &&
      response.body.ref === `refs/tags/${tag}` &&
      isRecord(response.body.object),
  );
  // This publisher creates direct immutable source/version tags; annotated or
  // ambiguous tag chains require separate qualification rather than guessing.
  assert.equal(response.body.object.type, "commit");
  assert.equal(response.body.object.sha, expectedCommit);
  assert.deepEqual(
    readApplicationPagesState(api),
    state,
    "prior Pages actor changed during cohort discovery",
  );
  assert.ok(
    typeof selected.release.id === "number" &&
      Number.isSafeInteger(selected.release.id) &&
      selected.release.id > 0,
  );
  return {
    release_id: selected.release.id,
    custody: selected.custody,
    state,
    execution,
    authority: "none" as const,
  };
}

/** Read only metadata and authenticate the complete two-subject assembly. The
 * immutable archive digest is checked against provider facts and the signed
 * receipt without transferring the archive again; actual public component bytes
 * are independently downloaded and authenticated by the pinned verifier. Other
 * product assets are inventoried, not claimed as verified binary evidence. */
export async function readRegisteredImmutableApplicationMetadata(
  discovered: { release_id: number; custody: ApplicationRunCustody },
  transport: {
    api: GitHubRestReader;
    readAsset: (id: number, maximum: number) => Promise<Buffer>;
    authenticateAssembly: (
      metadata: Buffer,
      subjects: readonly { filename: string; sha256: string }[],
      producer: { id: string; control_commit: string; control_ref: string },
      attempt: number,
    ) => Promise<void>;
  },
) {
  const custody = inspectApplicationRunCustody(discovered.custody);
  assert.ok(Number.isSafeInteger(discovered.release_id) && discovered.release_id > 0);
  const root = `repos/boburning/portcove/releases/${discovered.release_id}`;
  const started = performance.now();
  const get = (endpoint: string) => {
    assert.ok(performance.now() - started < 120000, "prior metadata read deadline exhausted");
    const response = transport.api.request("GET", endpoint);
    assert.equal(response.status, 200);
    assert.ok(performance.now() - started < 120000, "prior metadata response was late");
    return response;
  };
  const readRelease = () => {
    const raw = get(root).body;
    assert.ok(isRecord(raw));
    assert.equal(raw.id, discovered.release_id);
    assert.equal(raw.draft, false);
    assert.equal(raw.immutable, true);
    assert.equal(raw.target_commitish, custody.source);
    assert.deepEqual(readApplicationRunNotes(raw.body ?? "")?.custody, custody);
    return {
      id: raw.id,
      tag_name: raw.tag_name,
      target_commitish: raw.target_commitish,
      published_at: raw.published_at,
      custody,
    };
  };
  const before = readRelease();
  const response = get(`${root}/assets?per_page=100&page=1`);
  assert.ok(!response.headers.get("link"), "prior asset inventory is incomplete");
  assert.ok(
    Array.isArray(response.body) && response.body.length >= 2 && response.body.length <= 64,
  );
  const names = new Set<string>(),
    ids = new Set<number>();
  const assets = response.body.map((raw: unknown) => {
    assert.ok(isRecord(raw));
    assert.ok(
      typeof raw.name === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u.test(raw.name) &&
        !names.has(raw.name),
    );
    assert.ok(
      typeof raw.id === "number" && Number.isSafeInteger(raw.id) && raw.id > 0 && !ids.has(raw.id),
    );
    assert.equal(raw.state, "uploaded");
    assert.ok(
      typeof raw.size === "number" &&
        Number.isSafeInteger(raw.size) &&
        raw.size > 0 &&
        raw.size <= 512 * 1024 ** 2,
    );
    assert.ok(typeof raw.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(raw.digest));
    names.add(raw.name);
    ids.add(raw.id);
    return { id: raw.id, name: raw.name, bytes: raw.size, sha256: raw.digest.slice(7) };
  });
  const metadata = assets.find((asset) => asset.name === bootstrapAssetNames[1]);
  const archive = assets.find((asset) => asset.name === bootstrapAssetNames[0]);
  if (custody.preparation === null)
    assert.equal(assets.length, 2, "metadata recovery cannot adopt executable assets");
  assert.ok(metadata && archive && metadata.bytes <= 2 * 1024 ** 2);
  const bytes = await transport.readAsset(metadata.id, metadata.bytes);
  assert.equal(bytes.length, metadata.bytes);
  assert.equal(sha256(bytes), metadata.sha256);
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const receipt = inspectHistoricalApplicationPublication(raw, custody);
  assert.equal(receipt.archive.bytes, archive.bytes);
  assert.equal(receipt.archive.sha256, archive.sha256);
  const subjects = [archive, metadata].map((asset) => ({
    filename: asset.name,
    sha256: asset.sha256,
  }));
  await transport.authenticateAssembly(bytes, subjects, receipt.producer, receipt.producer_attempt);
  assert.deepEqual(
    readRelease(),
    before,
    "immutable prior release changed during provenance verification",
  );
  const tag = custody.preparation
    ? `v${custody.preparation.version}`
    : `portcove-production-candidate-${custody.opportunity}`;
  assert.equal(before.tag_name, tag);
  const reference = get(`repos/boburning/portcove/git/ref/tags/${tag}`).body;
  assert.ok(
    isRecord(reference) && reference.ref === `refs/tags/${tag}` && isRecord(reference.object),
  );
  assert.equal(reference.object.type, "commit");
  assert.equal(reference.object.sha, custody.preparation?.prepared_commit ?? custody.source);
  assert.deepEqual(
    readRelease(),
    before,
    "immutable metadata custody changed during tag verification",
  );
  assert.ok(performance.now() - started < 120000, "prior metadata verification was late");
  return { receipt, metadata: raw, assets, authority: "none" as const };
}

/** A served prior additionally binds the immutable receipt to the actual Pages
 * actor. Unserved recovery uses the registered immutable reader above instead. */
export async function readImmutableApplicationMetadata(
  discovered: ReturnType<typeof discoverPublishedApplicationCohort>,
  transport: Parameters<typeof readRegisteredImmutableApplicationMetadata>[1],
) {
  const started = performance.now();
  assert.deepEqual(readApplicationPagesState(transport.api), discovered.state);
  const prior = await readRegisteredImmutableApplicationMetadata(discovered, transport);
  assert.deepEqual(
    readApplicationPagesState(transport.api),
    discovered.state,
    "prior Pages actor changed during metadata verification",
  );
  assertBootstrapPagesActor(
    discovered.state,
    prior.receipt.site.generation,
    discovered.custody.runs,
  );
  assert.ok(performance.now() - started < 120000, "prior metadata verification was late");
  return prior;
}

/** The fixed publisher captures the actual pinned uploader's local TAR. This
 * verifies its opaque provider copy, never parses or extracts an incoming TAR.
 * Job/attempt custody comes from the fixed DAG's exact output artifact ID. */
export async function verifyBootstrapPagesArtifact(
  expected: {
    artifact_id: number;
    control_commit: string;
    run_id: string;
    producer_attempt: number;
    tar: { bytes: number; sha256: string };
  },
  transport: {
    api: GitHubRestReader;
    readArchive: (id: number, maximum: number) => Promise<Buffer>;
  },
) {
  assert.ok(Number.isSafeInteger(expected.artifact_id) && expected.artifact_id > 0);
  assert.match(expected.control_commit, /^[a-f0-9]{40}$/u);
  assert.match(expected.run_id, /^[1-9][0-9]{0,15}$/u);
  assert.ok(Number.isSafeInteger(Number(expected.run_id)));
  assert.ok(
    Number.isSafeInteger(expected.producer_attempt) &&
      expected.producer_attempt >= 1 &&
      expected.producer_attempt <= 3,
  );
  assert.ok(
    Number.isSafeInteger(expected.tar.bytes) &&
      expected.tar.bytes >= 1024 &&
      expected.tar.bytes <= 512 * 1024 ** 2,
  );
  assert.match(expected.tar.sha256, /^[a-f0-9]{64}$/u);
  const start = performance.now();
  const metadata = () => {
    const response = transport.api.request(
      "GET",
      `repos/boburning/portcove/actions/artifacts/${expected.artifact_id}`,
    );
    assert.ok(performance.now() - start < 120000);
    assert.equal(response.status, 200);
    const raw = response.body;
    assert.ok(isRecord(raw));
    assert.equal(raw.id, expected.artifact_id);
    assert.equal(raw.name, `application-pages-${expected.run_id}-${expected.producer_attempt}`);
    assert.equal(raw.expired, false);
    assert.ok(
      typeof raw.size_in_bytes === "number" &&
        Number.isSafeInteger(raw.size_in_bytes) &&
        raw.size_in_bytes >= 22 &&
        raw.size_in_bytes <= 512 * 1024 ** 2,
    );
    assert.ok(typeof raw.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(raw.digest));
    assert.ok(isRecord(raw.workflow_run));
    assert.equal(raw.workflow_run.id, Number(expected.run_id));
    assert.equal(raw.workflow_run.head_sha, expected.control_commit);
    assert.equal(raw.workflow_run.repository_id, 1354613114);
    assert.equal(raw.workflow_run.head_repository_id, 1354613114);
    return {
      id: expected.artifact_id,
      name: raw.name,
      bytes: raw.size_in_bytes,
      sha256: raw.digest.slice(7),
    };
  };
  const before = metadata();
  const archive = await transport.readArchive(expected.artifact_id, before.bytes);
  assert.equal(archive.length, before.bytes);
  assert.equal(sha256(archive), before.sha256);
  const tar = inspectSiteArtifactArchive(archive, expected.tar);
  assert.deepEqual(metadata(), before, "Pages artifact changed during byte verification");
  return {
    schema_version: 1,
    authority: "none",
    artifact: before,
    tar: { bytes: tar.bytes, sha256: tar.sha256 },
    control_commit: expected.control_commit,
    run_id: expected.run_id,
    producer_attempt: expected.producer_attempt,
    scope: "exact fixed-uploader TAR bytes only; no deployment or public acceptance",
  };
}

export async function readImmutableApplicationMetadataFeed(
  expected: {
    release_id: number;
    custody: ApplicationRunCustody;
    binding: ApplicationMetadataPublicationBinding | ApplicationMetadataRenewalBasis;
  },
  transport: {
    api: GitHubRestReader;
    readAsset: (id: number, maximum: number) => Promise<Buffer>;
    authenticateAssembly: (
      assets: ReadonlyMap<string, Buffer>,
      producer: { id: string; control_commit: string; control_ref: string },
      attempt: number,
    ) => Promise<void>;
  },
) {
  assert.ok(Number.isSafeInteger(expected.release_id) && expected.release_id > 0);
  const custody = inspectApplicationRunCustody(expected.custody);
  assert.equal(custody.preparation, null);
  assert.equal(custody.opportunity, expected.binding.opportunity);
  if ("run_id" in expected.binding) {
    const binding = expected.binding;
    assert.ok(
      custody.runs.some(
        (run) =>
          run.id === binding.run_id &&
          run.control_commit === binding.control_commit &&
          run.control_ref === binding.control_ref,
      ),
    );
  }
  const root = `repos/boburning/portcove/releases/${expected.release_id}`;
  const tag = `portcove-production-candidate-${custody.opportunity}`;
  const started = performance.now();
  let calls = 0;
  const within = () =>
    assert.ok(
      ++calls <= 12 && performance.now() - started < 120000,
      "immutable feed input request/duration bound exhausted",
    );
  const get = (endpoint: string) => {
    within();
    const response = transport.api.request("GET", endpoint);
    within();
    assert.equal(response.status, 200);
    return response.body;
  };
  const release = () => {
    const raw = get(root);
    assert.ok(isRecord(raw));
    assert.equal(raw.id, expected.release_id);
    assert.equal(raw.draft, false, "feed requires an already published release");
    assert.equal(raw.immutable, true, "feed requires immutable release assets");
    assert.equal(raw.prerelease, true);
    assert.equal(raw.tag_name, tag);
    assert.equal(raw.target_commitish, custody.source);
    assertApplicationCustodyMetadataExtension(custody, readApplicationRunNotes(raw.body)?.custody);
  };
  release();
  const list = get(`${root}/assets?per_page=100&page=1`);
  assert.ok(Array.isArray(list) && list.length === 2);
  const names = new Set<string>();
  const ids = new Set<number>();
  const assets = new Map<string, Buffer>();
  const observed = [];
  // A complete two-asset inventory cannot hide a pagination tail.
  for (const raw of list) {
    assert.ok(
      isRecord(raw) &&
        typeof raw.name === "string" &&
        bootstrapAssetNames.includes(raw.name as (typeof bootstrapAssetNames)[number]),
    );
    assert.ok(!names.has(raw.name));
    names.add(raw.name);
    assert.ok(
      typeof raw.id === "number" && Number.isSafeInteger(raw.id) && raw.id > 0 && !ids.has(raw.id),
    );
    ids.add(raw.id);
    assert.equal(raw.state, "uploaded");
    const maximum = raw.name.endsWith(".zip") ? 512 * 1024 ** 2 : 2 * 1024 ** 2;
    assert.ok(
      typeof raw.size === "number" &&
        Number.isSafeInteger(raw.size) &&
        raw.size > 0 &&
        raw.size <= maximum,
    );
    assert.ok(typeof raw.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(raw.digest));
    const bytes = await transport.readAsset(raw.id, raw.size);
    assert.equal(bytes.length, raw.size);
    assert.equal(sha256(bytes), raw.digest.slice(7));
    assets.set(raw.name, bytes);
    observed.push({ id: raw.id, name: raw.name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  assert.equal(names.size, 2);
  const metadata = assets.get(bootstrapAssetNames[1]);
  const archive = assets.get(bootstrapAssetNames[0]);
  assert.ok(metadata && archive);
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
  const receipt = inspectApplicationMetadataPublicationReceipt(raw, expected.binding, custody);
  const historical = inspectHistoricalApplicationPublication(raw, custody);
  await transport.authenticateAssembly(assets, historical.producer, historical.producer_attempt);
  const decoded = readBootstrapSiteArchive(archive, receipt);
  const ref = get(`repos/boburning/portcove/git/ref/tags/${tag}`);
  assert.ok(
    isRecord(ref) &&
      ref.ref === `refs/tags/${tag}` &&
      isRecord(ref.object) &&
      ref.object.type === "commit" &&
      ref.object.sha === custody.source,
  );
  release();
  return {
    files: decoded.files,
    site: decoded.site,
    publication: receipt.publication,
    producer: historical.producer,
    producer_attempt: historical.producer_attempt,
    receipt: {
      schema_version: 1,
      authority: "none",
      release_id: expected.release_id,
      tag,
      site_generation: decoded.site.generation,
      assets: observed,
      scope:
        "immutable asset bytes and assembly provenance; deployment and public client acceptance remain separate",
    },
  };
}

export function readImmutableBootstrapFeed(
  expected: {
    release_id: number;
    custody: ApplicationRunCustody;
    binding: BootstrapPublicationBinding;
  },
  transport: Parameters<typeof readImmutableApplicationMetadataFeed>[1],
) {
  return readImmutableApplicationMetadataFeed(expected, transport);
}

function applicationMetadataTransport(
  scratch: string,
): Parameters<typeof readRegisteredImmutableApplicationMetadata>[1] {
  return {
    api: applicationApi,
    async readAsset(id, maximum) {
      return readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${id}`, {
        cwd: process.cwd(),
        maxBytes: maximum,
        timeoutMs: 30000,
      });
    },
    async authenticateAssembly(metadata, subjects, producer, attempt) {
      const directory = path.join(scratch, "prior-provenance");
      await mkdir(directory);
      await writeFile(path.join(directory, bootstrapAssetNames[1]), metadata, {
        flag: "wx",
        mode: 0o600,
      });
      await verifyReleaseSourceAttestation(
        directory,
        bootstrapAssetNames[1],
        {
          source_commit: producer.control_commit,
          ref: producer.control_ref,
          run_id: producer.id,
          run_attempt: attempt,
          subjects,
        },
        { scope: "application-assembly" },
      );
    },
  };
}

export function readApplicationImmutableMetadata(
  expected: { release_id: number; custody: ApplicationRunCustody },
  scratch: string,
) {
  return readRegisteredImmutableApplicationMetadata(
    expected,
    applicationMetadataTransport(scratch),
  );
}

export async function readApplicationPriorPublication(
  scratch: string,
  pending?: Parameters<typeof discoverPublishedApplicationCohort>[1],
) {
  const discovered = discoverPublishedApplicationCohort(applicationApi, pending);
  const prior = await readImmutableApplicationMetadata(
    discovered,
    applicationMetadataTransport(scratch),
  );
  return { discovered, prior };
}

/** A forward renewal is bounded by the existing three execution slots. Every
 * excluded unserved cohort has its own immutable assembly proof and cost owner;
 * arbitrary release IDs cannot become public-preimage exceptions. */
export async function readApplicationPendingLineage(
  first: ApplicationReleaseReference,
  scratch: string,
  transport: {
    api: Pick<CoordinatorRemoteApi, "request">;
    readMetadata: typeof readApplicationImmutableMetadata;
  } = {
    api: applicationApi,
    readMetadata: readApplicationImmutableMetadata,
  },
) {
  const nodes: (Awaited<ReturnType<typeof readApplicationImmutableMetadata>> & PendingCohort)[] =
    [];
  const started = performance.now();
  let reference: ApplicationReleaseReference | undefined =
    inspectApplicationReleaseReference(first);
  let ownerId: number | undefined;
  while (reference) {
    assert.ok(
      nodes.length < 3 && performance.now() - started < 120000,
      "pending renewal lineage exceeds its fixed bound",
    );
    assert.ok(
      !nodes.some((node) => node.release_id === reference?.release_id),
      "pending renewal lineage cycle",
    );
    const response = transport.api.request(
      "GET",
      `repos/boburning/portcove/releases/${reference.release_id}`,
    );
    assert.equal(response.status, 200);
    assert.ok(isRecord(response.body) && response.body.id === reference.release_id);
    const notes = readApplicationRunNotes(response.body.body);
    assert.ok(notes && notes.custody.opportunity === reference.opportunity);
    const directory = path.join(scratch, `lineage-${nodes.length}`);
    await mkdir(directory);
    const expected: PendingCohort = { release_id: reference.release_id, custody: notes.custody };
    const metadata = await transport.readMetadata(expected, directory);
    assert.ok(
      isRecord(metadata.metadata) && metadata.metadata.kind === "application-metadata-publication",
    );
    const owner = readApplicationBudgetOwner(transport.api, expected);
    assert.ok(typeof owner.release_id === "number");
    if (ownerId === undefined) ownerId = owner.release_id;
    else assert.equal(owner.release_id, ownerId, "forward renewal changed its original cost owner");
    const node: (typeof nodes)[number] = { ...metadata, ...expected };
    const child = nodes.at(-1);
    if (child) {
      const childMetadata = child.metadata;
      assert.ok(isRecord(childMetadata));
      assert.equal(
        childMetadata.authority_repository_sha256,
        node.receipt.publication.repository_sha256,
      );
      assert.equal(
        child.receipt.publication.records_sha256,
        node.receipt.publication.records_sha256,
        "metadata-only renewal changed accepted records",
      );
      assert.equal(
        childMetadata.prior_repository_sha256,
        metadata.metadata.prior_repository_sha256,
        "forward renewal changed its public application preimage",
      );
      const reservations = owner.custody.metadata_contexts ?? [];
      const reservation = reservations.find(
        (entry) =>
          entry.context_sha256 === childMetadata.context_sha256 &&
          entry.opportunity === child.custody.opportunity &&
          entry.run_id === child.receipt.producer.id &&
          entry.control_commit === child.receipt.producer.control_commit &&
          entry.control_ref === child.receipt.producer.control_ref,
      );
      if (reservation) {
        assert.equal(reservation.root_sha256, child.receipt.publication.root_sha256);
        assert.equal(
          reservation.offline_targets_sha256,
          child.receipt.publication.offline_targets_sha256,
        );
        assert.equal(
          reservation.prior_repository_sha256,
          node.receipt.publication.repository_sha256,
        );
        assert.equal(reservation.records_sha256, child.receipt.publication.records_sha256);
        assert.deepEqual(reservation.versions, child.receipt.publication.versions);
      }
      const priorReservation = reservation
        ? reservations[reservations.indexOf(reservation) - 1]
        : undefined;
      for (const role of [
        "targets",
        "releases",
        "preview",
        "stable",
        "snapshot",
        "timestamp",
      ] as const) {
        const parentFloor = BigInt(node.receipt.publication.versions[role]);
        const reservedFloor = priorReservation
          ? BigInt(priorReservation.versions[role])
          : parentFloor;
        const floor = reservedFloor > parentFloor ? reservedFloor : parentFloor;
        assert.equal(
          BigInt(child.receipt.publication.versions[role]),
          role === "targets" ? parentFloor : floor + 1n,
          "forward renewal version lineage changed or lost its burned-version reservation",
        );
      }
    }
    nodes.push(node);
    reference =
      metadata.metadata.renewal_parent === undefined
        ? undefined
        : inspectApplicationReleaseReference(metadata.metadata.renewal_parent);
  }
  assert.ok(performance.now() - started < 120000, "pending renewal lineage verification was late");
  return nodes;
}

/** Declared join only. The caller authenticates both immutable assemblies and
 * uses the pinned verifier on the pending authority bytes before key access. */
export function assertApplicationForwardPreimage(
  metadata: unknown,
  rawPending: unknown,
  rawPublic: unknown,
) {
  assert.ok(isRecord(metadata) && metadata.kind === "application-metadata-publication");
  const pending = inspectTufPublicationFacts(rawPending),
    current = inspectTufPublicationFacts(rawPublic);
  assert.equal(
    metadata.prior_repository_sha256,
    current.repository_sha256,
    "pending authority was based on another public application repository",
  );
  assert.notEqual(pending.repository_sha256, current.repository_sha256);
  assert.equal(pending.root_sha256, current.root_sha256);
  assert.equal(pending.offline_targets_sha256, current.offline_targets_sha256);
  for (const role of ["targets", "releases", "preview", "stable", "snapshot", "timestamp"] as const)
    assert.ok(
      role === "targets"
        ? pending.versions[role] === current.versions[role]
        : BigInt(pending.versions[role]) > BigInt(current.versions[role]),
      "pending authority does not advance the current public floors",
    );
  if (metadata.purpose === "metadata-renewal" && metadata.schema_version === 1)
    assert.equal(
      pending.records_sha256,
      current.records_sha256,
      "metadata maintenance changed public accepted records",
    );
  else
    assert.ok(
      metadata.purpose === "application-release" || metadata.purpose === "metadata-renewal",
    );
}
