/** Immutable application metadata transport. The caller must authenticate the
 * assembly attestation and supply fresh protected execution guards. Declared
 * metadata, release notes and these byte checks confer no execution authority. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { releaseCanonicalDigest as digest, releaseCanonicalJson } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { sha256 } from "./application-release-io.mts";
import { applicationReleaseTrust } from "./application-release-policy.mts";
import { inspectInitialApplicationDescriptor } from "./application-release-context.mts";
import {
  assertMetadataBootstrapPublication,
  inspectTufPublicationFacts,
  metadataInstant,
} from "./release-metadata-contract.mts";
import {
  inspectSiteGeneration,
  isRetainedApplicationRehearsalPath,
} from "./release-site-generation.mts";
import {
  applicationReleaseNotesPreimage,
  inspectApplicationRunCustody,
  assertApplicationCustodyMetadataExtension,
  readApplicationRunNotes,
  inspectBootstrapDraftRecovery,
  requireBootstrapDraft,
} from "./application-release-run.mts";
import type {
  ApplicationDraftAssembly,
  ApplicationDraftRecovery,
  ApplicationRunCustody,
  ApplicationReleaseReference,
} from "./application-release-run.mts";
import { inspectApplicationReleaseReference } from "./application-release-run.mts";
import type { ReleaseSourceAttestationExpectation } from "./release-source-attestation.mts";
import type { GitHubMetadataResponse } from "./github-operation.mts";
import type { GitHubRequestPolicy } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";
import { assertTrustedDirectNode } from "./release-direct-node-transport.mts";
import { compareApplicationVersionPrecedence } from "../apps/desktop/scripts/release-version-policy.mts";
import { applicationPackageNames } from "./application-release-artifacts.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";

export const bootstrapAssetNames = ["application-site.zip", "application-metadata.json"] as const;
/** Only the caller's existing fixed Release writer is admitted to the upload origin. */
export async function createApplicationAssetUploader(
  token: string | undefined,
  assertWindow?: () => void,
  operationDeadline = Infinity,
) {
  assert.ok(token && token.length <= 16384 && !/[\r\n\0]/u.test(token));
  const origin = "https://uploads.github.com";
  const deadline = Math.min(
    operationDeadline,
    coordinatorCommandDeadline() ?? Infinity,
    performance.now() + 120000,
  );
  let expected: string | undefined;
  const { createGitHubClient } = await import("./github-client.mts");
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    baseUrl: origin,
    deadline,
    requestTimeoutMs: 30000,
    maxBytes: 128 * 1024,
    allowRequest(method, url) {
      assertTrustedDirectNode("fixed application Release upload");
      assertWindow?.();
      return method === "POST" && url.href === expected;
    },
  });
  return async (releaseId: number, name: string, bytes: Buffer) => {
    assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u);
    assert.equal(expected, undefined, "application asset uploads must remain sequential");
    const endpoint = `/repos/boburning/portcove/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    expected = origin + endpoint;
    try {
      const response = await client.request(`POST ${endpoint}`, {
        data: new Uint8Array(bytes),
        headers: {
          "Content-Type": name.endsWith(".zip")
            ? "application/zip"
            : name.endsWith(".json")
              ? "application/json"
              : "application/octet-stream",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        request: { portcove: { replay: "once", attempts: 0 } },
      });
      assert.equal(response.status, 201);
    } finally {
      expected = undefined;
    }
  };
}

type AssetName = (typeof bootstrapAssetNames)[number];
export type BootstrapPublicationBinding = {
  control_commit: string;
  control_ref: string;
  opportunity: string;
  run_id: string;
  producer_attempt: number;
  appointment: {
    descriptor_sha256: string;
    setup_plan_sha256: string;
    site_preimage_sha256: string;
  };
  retained_inventory_sha256: string;
};
export type ApplicationMetadataRenewalBasis = {
  purpose: "metadata-renewal";
  opportunity: string;
  prior_generation: string;
  prior_repository_sha256: string;
  authority_repository_sha256?: string;
  renewal_parent?: ApplicationReleaseReference;
};
export type ApplicationMetadataPublicationBinding =
  | BootstrapPublicationBinding
  | (ApplicationMetadataRenewalBasis & {
      control_commit: string;
      control_ref: string;
      run_id: string;
      producer_attempt: number;
    });
const exact = (raw: Record<string, unknown>, keys: string) =>
  assert.equal(Object.keys(raw).sort().join(","), keys);

type ApplicationProducer = {
  control_commit: string;
  control_ref: string;
  run_id: string;
  attempt: number;
};
type ApplicationAsset = { id: number; name: string; bytes: number; sha256: string };
type ApplicationPublicationExpected = {
  release_id: number;
  custody: ApplicationRunCustody;
  producer: ApplicationProducer;
};

function applicationPublicationIdentity(expected: ApplicationPublicationExpected) {
  const custody = inspectApplicationRunCustody(expected.custody);
  assert.ok(Number.isSafeInteger(expected.release_id) && expected.release_id > 0);
  assert.ok(custody.preparation, "ordinary product publication requires retained preparation");
  assert.ok(
    custody.runs.some(
      (run) =>
        run.id === expected.producer.run_id &&
        run.control_commit === expected.producer.control_commit &&
        run.control_ref === expected.producer.control_ref,
    ),
  );
  assert.ok(
    Number.isSafeInteger(expected.producer.attempt) &&
      expected.producer.attempt >= 1 &&
      expected.producer.attempt <= 3,
  );
  const version = custody.preparation.version;
  return {
    custody,
    preparation: custody.preparation,
    tag: `v${version}`,
    candidate: `portcove-production-candidate-${custody.opportunity}`,
    names: [
      ...applicationPackageNames(version),
      "application-release.json",
      `Portcove_${version}_x64-setup.exe.sig`,
      "updater-inventory.json",
      ...bootstrapAssetNames,
    ].sort(),
  };
}

function inspectApplicationDraftInventory(
  response: GitHubMetadataResponse,
  namesAllowed: readonly string[],
): ApplicationAsset[] {
  assert.equal(response.status, 200);
  assert.ok(!response.headers.get("link"), "incomplete product asset inventory");
  assert.ok(Array.isArray(response.body) && response.body.length <= namesAllowed.length);
  const ids = new Set<number>(),
    names = new Set<string>();
  return response.body
    .map((raw: unknown) => {
      assert.ok(
        isRecord(raw) &&
          typeof raw.name === "string" &&
          namesAllowed.includes(raw.name) &&
          !names.has(raw.name),
      );
      assert.ok(
        typeof raw.id === "number" &&
          Number.isSafeInteger(raw.id) &&
          raw.id > 0 &&
          !ids.has(raw.id),
      );
      assert.equal(raw.state, "uploaded");
      assert.ok(
        typeof raw.size === "number" &&
          Number.isSafeInteger(raw.size) &&
          raw.size > 0 &&
          raw.size <= 512 * 1024 ** 2,
      );
      assert.ok(typeof raw.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(raw.digest));
      ids.add(raw.id);
      names.add(raw.name);
      return { id: raw.id, name: raw.name, bytes: raw.size, sha256: raw.digest.slice(7) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function inspectPublicationRelease(
  raw: unknown,
  releaseId: number,
  identity: ReturnType<typeof applicationPublicationIdentity>,
) {
  assert.ok(isRecord(raw));
  assert.equal(raw.id, releaseId);
  assert.equal(raw.target_commitish, identity.custody.source);
  assert.equal(raw.prerelease, true);
  assertApplicationCustodyMetadataExtension(
    identity.custody,
    readApplicationRunNotes(raw.body ?? "")?.custody,
  );
  assert.ok(
    (raw.draft === true &&
      raw.immutable === false &&
      [identity.candidate, identity.tag].includes(String(raw.tag_name))) ||
      (raw.draft === false && raw.immutable === true && raw.tag_name === identity.tag),
  );
  return raw;
}

function inspectPublicationTag(
  response: { status?: number; body: unknown },
  identity: ReturnType<typeof applicationPublicationIdentity>,
) {
  assert.equal(response.status, 200);
  assert.ok(
    isRecord(response.body) &&
      response.body.ref === `refs/tags/${identity.tag}` &&
      isRecord(response.body.object),
  );
  assert.equal(response.body.object.type, "commit");
  assert.equal(
    response.body.object.sha,
    identity.preparation.prepared_commit,
    "version tag belongs to different prepared bytes",
  );
}

/** Closed byte matrix only. The trusted caller must first verify package/native
 * provenance, detached signature, context identity and assembly attestation.
 * Matching imported data does not grant any write or publication authority. */
export function inspectApplicationPublicationFiles(
  expected: ApplicationPublicationExpected,
  files: ReadonlyMap<string, Buffer>,
) {
  const identity = applicationPublicationIdentity(expected);
  assert.deepEqual([...files.keys()].sort(), identity.names);
  assert.ok(
    [...files.values()].every(
      (bytes) => Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 512 * 1024 ** 2,
    ),
  );
  assert.ok([...files.values()].reduce((total, bytes) => total + bytes.length, 0) <= 2 * 1024 ** 3);
  const metadata = files.get(bootstrapAssetNames[1])!;
  assert.ok(metadata.length <= 2 * 1024 ** 2);
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadata));
  const receipt = inspectHistoricalApplicationPublication(raw, identity.custody);
  assert.ok(
    isRecord(raw) &&
      raw.kind === "application-metadata-publication" &&
      raw.purpose === "application-release",
  );
  const site = readBootstrapSiteArchive(files.get(bootstrapAssetNames[0])!, receipt);
  const manifestBytes = files.get("application-release.json")!;
  assert.ok(manifestBytes.length <= 1024 * 1024);
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  assert.ok(
    isRecord(manifest) &&
      manifest.schema_version === 1 &&
      manifest.repository === "boburning/portcove" &&
      manifest.profile === "initial-beta-windows-x86_64-v1",
  );
  assert.equal(manifest.version, identity.preparation.version);
  assert.equal(manifest.source_commit, identity.preparation.prepared_commit);
  assert.equal(manifest.source_tree, identity.preparation.prepared_tree);
  assert.ok(
    identity.custody.runs.some(
      (run) =>
        run.id === manifest.run_id &&
        run.control_commit === manifest.control_commit &&
        run.control_ref === manifest.control_ref,
    ),
  );
  assert.ok(
    typeof manifest.package_attempt === "number" &&
      Number.isSafeInteger(manifest.package_attempt) &&
      manifest.package_attempt >= 1 &&
      manifest.package_attempt <= 3,
  );
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === 5);
  const names = new Set<string>();
  for (const file of manifest.files) {
    assert.ok(
      isRecord(file) &&
        typeof file.filename === "string" &&
        applicationPackageNames(identity.preparation.version).includes(file.filename) &&
        !names.has(file.filename),
    );
    const bytes = files.get(file.filename);
    assert.ok(bytes);
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, sha256(bytes));
    names.add(file.filename);
  }
  return {
    receipt,
    metadata: raw,
    site_files: site.files,
    identities: identity.names.map((name) => ({
      name,
      bytes: files.get(name)!.length,
      sha256: sha256(files.get(name)!),
    })),
  };
}

export function applicationDraftAssembly(
  releaseId: number,
  raw: Record<string, unknown>,
  publication: ApplicationDraftAssembly["publication"],
  files: ReadonlyMap<string, Buffer>,
): ApplicationDraftAssembly {
  const {
    context_sha256,
    producer_attempt,
    prior_generation,
    prior_repository_sha256,
    retained_inventory_sha256,
  } = raw;
  assert.ok(typeof context_sha256 === "string" && typeof producer_attempt === "number");
  assert.ok(typeof prior_generation === "string" && typeof prior_repository_sha256 === "string");
  assert.ok(typeof retained_inventory_sha256 === "string");
  assert.ok(
    raw.renewal_parent === undefined || typeof raw.authority_repository_sha256 === "string",
  );
  return {
    release_id: releaseId,
    context_sha256,
    producer_attempt,
    prior_generation,
    prior_repository_sha256,
    retained_inventory_sha256,
    publication,
    ...(raw.renewal_parent === undefined
      ? {}
      : {
          renewal_parent: inspectApplicationReleaseReference(raw.renewal_parent),
          authority_repository_sha256: String(raw.authority_repository_sha256),
        }),
    subjects: bootstrapAssetNames.map((name) => {
      const bytes = files.get(name);
      assert.ok(bytes);
      return { name, bytes: bytes.length, sha256: sha256(bytes) };
    }),
  };
}

export const applicationDraftProofName = "application-draft-assembly.json";

export function applicationDraftProofBytes(assembly: ApplicationDraftAssembly) {
  return Buffer.from(
    releaseCanonicalJson({
      schema_version: 1,
      kind: "application-draft-assembly",
      assembly,
    }),
  );
}

/** Expensive, key-free draft preparation. This never publishes the release.
 * Source eligibility guards run before each write, independently of the later
 * fresh publication-protection observer. No deletion, replacement or blind retry. */
export async function prepareApplicationReleaseDraft(
  expected: ApplicationPublicationExpected,
  files: ReadonlyMap<string, Buffer>,
  transport: {
    open: (deadline: number) => Promise<ApplicationDraftPreparationProvider>;
    upload: (id: number, name: string, bytes: Buffer) => Promise<void>;
    readAsset: ApplicationPublicationReadTransport["readAsset"];
    beforeDraftWrite: () => Promise<void>;
    retainAssembly?: (assembly: ApplicationDraftAssembly) => Promise<unknown>;
  },
) {
  const inspected = inspectApplicationPublicationFiles(expected, files);
  const remote = await openApplicationPublicationRead(
    expected,
    (deadline) => transport.open(deadline),
    Infinity,
    180000,
  );
  const compare = (assets: ApplicationAsset[]) => {
    for (const asset of assets) {
      const wanted = inspected.identities.find((file) => file.name === asset.name);
      assert.ok(wanted);
      assert.equal(asset.bytes, wanted.bytes);
      assert.equal(asset.sha256, wanted.sha256);
    }
  };
  let initial = await remote.release();
  let assets = await remote.assets();
  compare(assets);
  await remote.inspectTag(initial.draft === true);
  const commit = inspectRemoteCommitObject(
    (await remote.get(`repos/boburning/portcove/git/commits/${remote.preparation.prepared_commit}`))
      .body,
    remote.preparation.prepared_commit,
  );
  assert.equal(commit.tree, remote.preparation.prepared_tree);
  assert.deepEqual(commit.parents, [remote.custody.source]);
  if (initial.draft === true) {
    if (transport.retainAssembly) {
      await transport.retainAssembly(
        applicationDraftAssembly(
          expected.release_id,
          inspected.metadata,
          inspected.receipt.publication,
          files,
        ),
      );
      const retained = await remote.release();
      assert.deepEqual(
        applicationReleaseNotesPreimage(retained),
        applicationReleaseNotesPreimage(initial),
      );
      assert.deepEqual(await remote.assets(), assets);
      initial = retained;
    }
    for (const [name, bytes] of files)
      if (!assets.some((asset) => asset.name === name)) {
        const fresh = await remote.release();
        assert.equal(fresh.draft, true);
        assert.equal(fresh.body, initial.body);
        assets = await remote.assets();
        compare(assets);
        if (!assets.some((asset) => asset.name === name)) {
          await transport.beforeDraftWrite();
          remote.within();
          try {
            await transport.upload(expected.release_id, name, bytes);
          } catch {
            /* Exact provider readback decides; no second upload. */
          }
          assets = await remote.assets();
          compare(assets);
          assert.ok(
            assets.some((asset) => asset.name === name),
            "draft asset outcome unknown; retain without retry",
          );
        }
      }
  }
  assets = await remote.assets();
  compare(assets);
  assert.equal(assets.length, files.size);
  for (const asset of assets) {
    const bytes = await transport.readAsset(asset.id, asset.bytes, remote.deadline);
    remote.within();
    assert.equal(bytes.length, asset.bytes);
    assert.equal(sha256(bytes), asset.sha256);
  }
  assert.deepEqual(
    await remote.assets(),
    assets,
    "draft asset IDs changed during physical readback",
  );
  const settled = await remote.release();
  assert.equal(settled.body, initial.body);
  if (!(await remote.inspectTag(settled.draft === true))) {
    await transport.beforeDraftWrite();
    remote.charge();
    try {
      await remote.provider.createTag();
    } catch {
      /* Lost acknowledgement is resolved by one exact GET, never another POST. */
    }
    await remote.inspectTag();
  }
  return {
    schema_version: 1,
    kind: "application-draft-publication",
    authority: "none",
    release_id: expected.release_id,
    source_commit: remote.custody.source,
    prepared_commit: remote.preparation.prepared_commit,
    version: remote.preparation.version,
    tag: `v${remote.preparation.version}`,
    opportunity: remote.custody.opportunity,
    producer: structuredClone(expected.producer),
    site_generation: inspected.receipt.site.generation,
    prior_generation: inspected.metadata.prior_generation,
    prior_repository_sha256: inspected.metadata.prior_repository_sha256,
    context_sha256: inspected.metadata.context_sha256,
    assets,
  };
}

/** Public byte-custody receipt only. The final worker must verify its standard
 * GitHub attestation against separately expected producer identity before use. */
export function inspectPreparedApplicationPublication(
  raw: unknown,
  expected: ApplicationPublicationExpected,
) {
  const identity = applicationPublicationIdentity(expected);
  assert.ok(isRecord(raw));
  exact(
    raw,
    "assets,authority,context_sha256,kind,opportunity,prepared_commit,prior_generation,prior_repository_sha256,producer,release_id,schema_version,site_generation,source_commit,tag,version",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.kind, "application-draft-publication");
  assert.equal(raw.authority, "none");
  assert.equal(raw.release_id, expected.release_id);
  assert.equal(raw.source_commit, identity.custody.source);
  assert.equal(raw.prepared_commit, identity.preparation.prepared_commit);
  assert.equal(raw.version, identity.preparation.version);
  assert.equal(raw.tag, identity.tag);
  assert.equal(raw.opportunity, identity.custody.opportunity);
  assert.deepEqual(raw.producer, expected.producer);
  for (const key of [
    "site_generation",
    "prior_generation",
    "prior_repository_sha256",
    "context_sha256",
  ] as const)
    assert.ok(typeof raw[key] === "string" && /^[a-f0-9]{64}$/u.test(raw[key]));
  assert.ok(Array.isArray(raw.assets) && raw.assets.length === identity.names.length);
  const ids = new Set<number>();
  const assets = raw.assets.map((asset: unknown): ApplicationAsset => {
    assert.ok(isRecord(asset));
    exact(asset, "bytes,id,name,sha256");
    assert.ok(
      typeof asset.id === "number" &&
        Number.isSafeInteger(asset.id) &&
        asset.id > 0 &&
        !ids.has(asset.id),
    );
    ids.add(asset.id);
    assert.ok(
      typeof asset.name === "string" &&
        typeof asset.bytes === "number" &&
        Number.isSafeInteger(asset.bytes) &&
        asset.bytes > 0 &&
        asset.bytes <= 512 * 1024 ** 2,
    );
    assert.ok(typeof asset.sha256 === "string" && /^[a-f0-9]{64}$/u.test(asset.sha256));
    return { id: asset.id, name: asset.name, bytes: asset.bytes, sha256: asset.sha256 };
  });
  assert.deepEqual(
    assets.map((asset) => asset.name),
    identity.names,
  );
  assert.ok(assets.reduce((total, asset) => total + asset.bytes, 0) <= 2 * 1024 ** 3);
  assert.ok(typeof raw.site_generation === "string");
  return { ...identity, assets, site_generation: raw.site_generation };
}

async function openApplicationPublicationRead<
  T extends Pick<PublicationMetadataProvider, "readMetadata">,
>(
  expected: ApplicationPublicationExpected,
  open: (deadline: number) => Promise<T>,
  inheritedDeadline = Infinity,
  milliseconds = 120000,
) {
  const identity = applicationPublicationIdentity(expected);
  const deadline = Math.min(
    inheritedDeadline,
    coordinatorCommandDeadline() ?? Infinity,
    performance.now() + milliseconds,
  );
  const root = `repos/boburning/portcove/releases/${expected.release_id}`;
  let requests = 0;
  const within = () =>
    assert.ok(performance.now() < deadline, "application publication phase deadline exhausted");
  within();
  const provider = await open(deadline);
  const charge = () => {
    within();
    assert.ok(
      ++requests <= 16 + identity.names.length * 8,
      "application publication request bound exhausted",
    );
  };
  const read = async (endpoint: string) => {
    charge();
    const response = await provider.readMetadata(endpoint);
    within();
    return response;
  };
  const get = async (endpoint: string) => {
    const response = await read(endpoint);
    assert.equal(response.status, 200);
    return response;
  };
  const release = async () =>
    inspectPublicationRelease((await get(root)).body, expected.release_id, identity);
  const assets = async () =>
    inspectApplicationDraftInventory(
      await get(`${root}/assets?per_page=100&page=1`),
      identity.names,
    );
  const inspectTag = async (pending = false) => {
    let response;
    try {
      response = await read(`repos/boburning/portcove/git/ref/tags/${identity.tag}`);
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 404 && pending)) throw error;
      return false;
    }
    if (response.status === 404 && pending) return false;
    inspectPublicationTag(response, identity);
    return true;
  };
  return { ...identity, provider, get, release, assets, inspectTag, deadline, within, charge };
}

/** The caller authenticates preparation first, then supplies current publication
 * eligibility/fresh protection. GitHub permits name/label/state asset updates,
 * not byte replacement: exact IDs+size+digest preserve the attested byte objects.
 * Public byte downloads are mandatory again before feed advancement. */
export async function publishPreparedApplicationRelease(
  expected: ApplicationPublicationExpected,
  preparation: Buffer,
  transport: {
    open: (deadline: number) => Promise<PublicationMetadataProvider>;
    authenticatePreparation: (bytes: Buffer) => Promise<void>;
    beforeWrite: () => Promise<() => void>;
  },
) {
  assert.ok(preparation.length > 0 && preparation.length <= 128 * 1024);
  const receipt = inspectPreparedApplicationPublication(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(preparation)),
    expected,
  );
  await transport.authenticatePreparation(preparation);
  const { provider, release, assets, inspectTag, charge } = await openApplicationPublicationRead(
    expected,
    (deadline) => transport.open(deadline),
  );
  let current = await release();
  assert.deepEqual(await assets(), receipt.assets);
  await inspectTag();
  if (current.draft === true) {
    const assertWindow = await transport.beforeWrite();
    const fresh = await release();
    assert.equal(fresh.draft, true);
    assert.equal(fresh.body, current.body);
    assert.deepEqual(await assets(), receipt.assets);
    await inspectTag();
    charge();
    assertWindow();
    try {
      await provider.publish({
        tag_name: receipt.tag,
        draft: false,
        prerelease: true,
        make_latest: "false",
        name: `Portcove ${receipt.preparation.version}`,
      });
    } catch {
      /* One mutation only; exact immutable readback decides. */
    }
    current = await release();
  }
  assert.equal(
    current.draft,
    false,
    "immutable publication outcome unknown; reconcile without retry",
  );
  assert.deepEqual(await assets(), receipt.assets);
  await inspectTag();
  return {
    schema_version: 1,
    authority: "none",
    release_id: expected.release_id,
    tag: receipt.tag,
    site_generation: receipt.site_generation,
    assets: receipt.assets,
    scope:
      "immutable publication and attested byte-object identity; public bytes/feed/installed acceptance remain separate",
  };
}

/** Identity join only. The record must come from the actual pinned TUF verifier;
 * caller-supplied JSON never authenticates payloads or native acceptance. */
export function assertApplicationPublicationRecord(
  raw: unknown,
  expected: ApplicationPublicationExpected,
  files: ReadonlyMap<string, Buffer>,
  payloadKeyId: string,
  qualification: { workflow: string; workflow_commit: string; run_id: number; attempt: number },
) {
  const identity = applicationPublicationIdentity(expected);
  const version = identity.preparation.version;
  const filename = `Portcove_${version}_x64-setup.exe`;
  const installer = files.get(filename),
    signature = files.get(`${filename}.sig`),
    inventoryBytes = files.get("updater-inventory.json");
  assert.ok(installer && signature && inventoryBytes);
  assert.ok(
    isRecord(raw) && isRecord(raw.qualified_run) && isRecord(raw.artifact) && isRecord(raw.package),
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.version, version);
  assert.equal(raw.source_commit, identity.preparation.prepared_commit);
  assert.equal(raw.source_tree, identity.preparation.prepared_tree);
  assert.equal(raw.target, "windows-x86_64");
  assert.equal(raw.os, "windows");
  assert.equal(raw.architecture, "x86_64");
  assert.deepEqual(raw.package, {
    kind: "nsis",
    owner: "portcove",
    product_id: "io.github.portcove.portcove",
  });
  assert.match(payloadKeyId, /^[a-f0-9]{64}$/u);
  assert.equal(qualification.workflow_commit, identity.custody.source);
  assert.ok(
    qualification.workflow === ".github/workflows/qualification.yml" ||
      qualification.workflow === ".github/workflows/application-release.yml",
  );
  assert.ok(Number.isSafeInteger(qualification.run_id) && qualification.run_id > 0);
  assert.ok(Number.isSafeInteger(qualification.attempt) && qualification.attempt > 0);
  assert.deepEqual(
    raw.qualified_run,
    {
      workflow: qualification.workflow,
      workflow_commit: qualification.workflow_commit,
      run_id: qualification.run_id,
      attempt: qualification.attempt,
      inventory_sha256: sha256(inventoryBytes),
    },
    "published Windows record changed its admitted qualification",
  );
  assert.deepEqual(raw.artifact, {
    url: `https://github.com/boburning/portcove/releases/download/v${version}/${filename}`,
    sha256: sha256(installer),
    bytes: installer.length,
    tauri_signature: signature.toString("utf8").replace(/\r?\n$/u, ""),
    payload_key_id: payloadKeyId,
  });
  const inventory: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(inventoryBytes),
  );
  assert.ok(
    isRecord(inventory) && Array.isArray(inventory.packages) && inventory.packages.length === 2,
  );
  assert.equal(inventory.version, version);
  assert.equal(inventory.source_commit, identity.preparation.prepared_commit);
  const names = new Set<string>();
  for (const item of inventory.packages) {
    assert.ok(isRecord(item) && typeof item.filename === "string" && !names.has(item.filename));
    names.add(item.filename);
    const bytes = files.get(item.filename);
    assert.ok(bytes && applicationPackageNames(version).includes(item.filename));
    assert.equal(item.bytes, bytes.length);
    assert.equal(item.sha256, sha256(bytes));
  }
  assert.deepEqual(
    [...names].sort(),
    [filename, `portcove-cli-${version}-windows-x86_64.zip`].sort(),
  );
}

const windowsPreviewPrefix = "records/channels/preview/windows-x86_64/nsis/";
const windowsReleasePrefix = "records/releases/";

export function isApplicationWindowsJourneyRecord(name: string) {
  return (
    (name.startsWith(windowsPreviewPrefix) && name.endsWith(".json")) ||
    (name.startsWith(windowsReleasePrefix) && name.endsWith("/windows-x86_64/nsis.json"))
  );
}

function inspectApplicationWindowsPredecessor(raw: unknown, candidateVersion: string) {
  assert.ok(isRecord(raw));
  exact(
    raw,
    "installer_bytes,installer_sha256,promotion_sha256,record_sha256,source_commit,source_tree,version",
  );
  const {
    version,
    source_commit,
    source_tree,
    installer_bytes,
    installer_sha256,
    promotion_sha256,
    record_sha256,
  } = raw;
  assert.ok(typeof version === "string");
  applicationPackageNames(version);
  assert.ok(compareApplicationVersionPrecedence(version, candidateVersion) < 0);
  assert.ok(typeof source_commit === "string" && /^[a-f0-9]{40}$/u.test(source_commit));
  assert.ok(typeof source_tree === "string" && /^[a-f0-9]{40}$/u.test(source_tree));
  assert.ok(
    typeof installer_bytes === "number" &&
      Number.isSafeInteger(installer_bytes) &&
      installer_bytes > 0 &&
      installer_bytes <= 512 * 1024 ** 2,
  );
  assert.ok(typeof installer_sha256 === "string" && /^[a-f0-9]{64}$/u.test(installer_sha256));
  assert.ok(typeof promotion_sha256 === "string" && /^[a-f0-9]{64}$/u.test(promotion_sha256));
  assert.ok(typeof record_sha256 === "string" && /^[a-f0-9]{64}$/u.test(record_sha256));
  return {
    version,
    source_commit,
    source_tree,
    installer_bytes,
    installer_sha256,
    promotion_sha256,
    record_sha256,
  };
}

/** Use only records materialized by the pinned TUF verifier. Initial
 * publication may have no predecessor. It cannot certify installed continuity. */
export function selectApplicationWindowsPredecessor(
  records: ReadonlyMap<string, Buffer>,
  candidateVersion: string,
  candidateRecordSha: string,
) {
  assert.ok(records.size > 0 && records.size <= 512);
  const decode = (bytes: Buffer) => {
    assert.ok(bytes.length > 0 && bytes.length <= 128 * 1024);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assert.ok(isRecord(value));
    return value;
  };
  const eligible = [];
  for (const [name, bytes] of records) {
    if (!name.startsWith(windowsPreviewPrefix)) continue;
    const value = decode(bytes);
    const { version } = value;
    assert.ok(typeof version === "string");
    applicationPackageNames(version);
    assert.equal(name, `${windowsPreviewPrefix}${version}.json`);
    assert.equal(value.schema_version, 1);
    assert.equal(value.channel, "preview");
    assert.equal(value.target, "windows-x86_64");
    assert.equal(value.package, "nsis");
    assert.ok(typeof value.eligible === "boolean" && typeof value.withdrawn === "boolean");
    if (!value.eligible || value.withdrawn) continue;
    const releasePath = `releases/${version}/windows-x86_64/nsis.json`;
    assert.equal(value.release_path, releasePath);
    const recordBytes = records.get(`records/${releasePath}`);
    assert.ok(recordBytes);
    const recordSha = sha256(recordBytes);
    assert.equal(value.release_sha256, recordSha);
    eligible.push({
      version,
      releasePath,
      recordBytes,
      recordSha,
      promotionSha: sha256(bytes),
      bridge: value.required_bridge,
    });
  }
  eligible.sort((left, right) => compareApplicationVersionPrecedence(right.version, left.version));
  for (let index = 1; index < eligible.length; index++)
    assert.ok(
      compareApplicationVersionPrecedence(eligible[index - 1]!.version, eligible[index]!.version) >
        0,
    );
  const current = eligible[0];
  assert.ok(
    current && current.version === candidateVersion,
    "candidate is not current Windows Preview",
  );
  assert.equal(current.recordSha, candidateRecordSha);
  let previous = eligible[1];
  if (current.bridge !== null) {
    previous = eligible
      .slice(1)
      .find((entry) =>
        isDeepStrictEqual(current.bridge, { path: entry.releasePath, sha256: entry.recordSha }),
      );
    assert.ok(previous, "Windows Preview requires an eligible published bridge");
  }
  if (!previous) return null;
  const record = decode(previous.recordBytes);
  assert.equal(record.schema_version, 1);
  assert.equal(record.version, previous.version);
  assert.equal(record.target, "windows-x86_64");
  assert.equal(record.os, "windows");
  assert.equal(record.architecture, "x86_64");
  assert.deepEqual(record.package, {
    kind: "nsis",
    owner: "portcove",
    product_id: "io.github.portcove.portcove",
  });
  assert.ok(isRecord(record.artifact));
  assert.equal(
    record.artifact.url,
    `https://github.com/boburning/portcove/releases/download/v${previous.version}/Portcove_${previous.version}_x64-setup.exe`,
  );
  return inspectApplicationWindowsPredecessor(
    {
      version: previous.version,
      source_commit: record.source_commit,
      source_tree: record.source_tree,
      installer_bytes: record.artifact.bytes,
      installer_sha256: record.artifact.sha256,
      promotion_sha256: previous.promotionSha,
      record_sha256: previous.recordSha,
    },
    candidateVersion,
  );
}

/** Installer and desktop byte identities from the qualified immutable cohort.
 * This is a source handoff. The Windows consumer must re-fetch and verify bytes. */
export function inspectApplicationWindowsCandidate(
  raw: unknown,
  expected: { release_id: number; custody: ApplicationRunCustody },
  generation: string,
) {
  const custody = inspectApplicationRunCustody(expected.custody);
  const preparation = custody.preparation;
  assert.ok(preparation?.qualification);
  assert.match(generation, /^[a-f0-9]{64}$/u);
  assert.ok(isRecord(raw));
  exact(
    raw,
    "assets,authority,generation,kind,predecessor,record_sha256,release_id,schema_version",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.kind, "application-windows-candidate");
  assert.equal(raw.authority, "none");
  assert.equal(raw.release_id, expected.release_id);
  assert.equal(raw.generation, generation);
  const recordSha = raw.record_sha256;
  assert.ok(typeof recordSha === "string" && /^[a-f0-9]{64}$/u.test(recordSha));
  const rawAssets = raw.assets;
  assert.ok(Array.isArray(rawAssets) && rawAssets.length === 2);
  const names = [`Portcove_${preparation.version}_x64-setup.exe`, "portcove-desktop.exe"];
  const assets = names.map((name, index) => {
    const value: unknown = rawAssets[index];
    assert.ok(isRecord(value));
    exact(value, "bytes,id,name,sha256");
    assert.equal(value.name, name);
    const { id, bytes, sha256 } = value;
    assert.ok(typeof id === "number" && Number.isSafeInteger(id) && id > 0);
    assert.ok(
      typeof bytes === "number" &&
        Number.isSafeInteger(bytes) &&
        bytes > 0 &&
        bytes <= 512 * 1024 ** 2,
    );
    assert.ok(typeof sha256 === "string" && /^[a-f0-9]{64}$/u.test(sha256));
    return { id, name, bytes, sha256 };
  });
  assert.equal(new Set(assets.map((asset) => asset.id)).size, assets.length);
  return {
    schema_version: 1,
    kind: "application-windows-candidate",
    authority: "none",
    generation,
    release_id: expected.release_id,
    predecessor:
      raw.predecessor === null
        ? null
        : inspectApplicationWindowsPredecessor(raw.predecessor, preparation.version),
    record_sha256: recordSha,
    assets,
  };
}

/** Interpret already verified upstream release attestations. This pure parser
 * does not verify signatures: the fixed caller must invoke pinned gh release
 * verify first. Release inclusion is not source/native/TUF/payload authority. */
export function inspectApplicationReleaseAttestation(
  raw: unknown,
  expected: {
    release_id: number;
    tag: string;
    prepared_commit: string;
    assets: readonly ApplicationAsset[];
  },
) {
  assert.ok(isRecord(raw) && isRecord(raw.verificationResult));
  const verified = raw.verificationResult;
  assert.ok(
    isRecord(verified.signature) &&
      Array.isArray(verified.verifiedTimestamps) &&
      verified.verifiedTimestamps.length > 0,
  );
  const statement = verified.statement;
  assert.ok(
    isRecord(statement) && Array.isArray(statement.subject) && isRecord(statement.predicate),
  );
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, "https://in-toto.io/attestation/release/v0.1");
  const purl = `pkg:github/boburning/portcove@${expected.tag}`;
  assert.deepEqual(statement.predicate, {
    ownerId: "43177418",
    purl,
    releaseId: String(expected.release_id),
    repository: "boburning/portcove",
    repositoryId: "1354613114",
    tag: expected.tag,
  });
  assert.equal(statement.subject.length, expected.assets.length + 1);
  const wanted = [
    { uri: purl, digest: { sha1: expected.prepared_commit } },
    ...expected.assets.map((asset) => ({ name: asset.name, digest: { sha256: asset.sha256 } })),
  ];
  const order = (value: unknown) => {
    assert.ok(isRecord(value));
    return String(value.name ?? value.uri);
  };
  const sorted = (values: readonly unknown[]) =>
    [...values].sort((a, b) => order(a).localeCompare(order(b)));
  assert.deepEqual(
    sorted(statement.subject),
    sorted(wanted),
    "release attestation inventory differs",
  );
  return { authority: "none", assets: expected.assets };
}

/** Read just the two Windows subjects after authenticating the full immutable
 * inventory. GitHub's Release attestation and direct tag both bind their source. */
export async function readApplicationWindowsCandidateAssets(
  raw: unknown,
  expected: ApplicationPublicationExpected,
  generation: string,
  transport: {
    open: ApplicationPublicationReadTransport["open"];
    readReleaseByTag: (tag: string, deadline: number) => Promise<unknown>;
    deadline?: number;
    authenticateRelease: (
      expected: Parameters<typeof inspectApplicationReleaseAttestation>[1],
      deadline: number,
    ) => Promise<void>;
    readAsset: ApplicationPublicationReadTransport["readAsset"];
  },
) {
  const candidate = inspectApplicationWindowsCandidate(raw, expected, generation);
  const files = await readImmutableWindowsPair(expected, transport, (inventory) => {
    for (const asset of candidate.assets)
      assert.deepEqual(
        inventory.find((entry) => entry.id === asset.id),
        asset,
        "immutable Windows candidate asset identity changed",
      );
    return candidate.assets;
  });
  return { candidate, files };
}

type WindowsPairTransport = Parameters<typeof readApplicationWindowsCandidateAssets>[3];

export async function readApplicationWindowsPredecessorAssets(
  predecessor: NonNullable<ReturnType<typeof inspectApplicationWindowsCandidate>["predecessor"]>,
  transport: WindowsPairTransport,
) {
  const tag = `v${predecessor.version}`;
  const deadline = Math.min(
    transport.deadline ?? Infinity,
    coordinatorCommandDeadline() ?? Infinity,
    performance.now() + 30000,
  );
  assert.ok(performance.now() < deadline, "application predecessor Release deadline exhausted");
  const raw = await transport.readReleaseByTag(tag, deadline);
  assert.ok(performance.now() < deadline, "application predecessor Release deadline exhausted");
  assert.ok(
    isRecord(raw) && typeof raw.id === "number" && Number.isSafeInteger(raw.id) && raw.id > 0,
  );
  assert.equal(raw.tag_name, tag);
  assert.equal(raw.draft, false);
  assert.equal(raw.immutable, true);
  const notes = readApplicationRunNotes(raw.body);
  const prep = notes?.custody.preparation;
  assert.ok(notes && prep?.qualification);
  assert.equal(prep.version, predecessor.version);
  assert.equal(prep.prepared_commit, predecessor.source_commit);
  assert.equal(prep.prepared_tree, predecessor.source_tree);
  const actor = notes.custody.runs[0];
  assert.ok(actor);
  return readImmutableWindowsPair(
    {
      release_id: raw.id,
      custody: notes.custody,
      producer: {
        control_commit: actor.control_commit,
        control_ref: actor.control_ref,
        run_id: actor.id,
        attempt: 1,
      },
    },
    transport,
    (inventory) => {
      const installer = inventory.find(
        (asset) => asset.name === `Portcove_${predecessor.version}_x64-setup.exe`,
      );
      const executable = inventory.find((asset) => asset.name === "portcove-desktop.exe");
      assert.ok(installer && executable);
      assert.equal(installer.bytes, predecessor.installer_bytes);
      assert.equal(installer.sha256, predecessor.installer_sha256);
      return [installer, executable];
    },
  );
}

async function readImmutableWindowsPair(
  expected: ApplicationPublicationExpected,
  transport: WindowsPairTransport,
  select: (inventory: ApplicationAsset[]) => readonly ApplicationAsset[],
) {
  const remote = await openApplicationPublicationRead(
    expected,
    (deadline) => transport.open(expected, deadline),
    transport.deadline,
  );
  const before = await remote.release();
  assert.equal(before.draft, false);
  await remote.inspectTag();
  const inventory = await remote.assets();
  assert.equal(
    inventory.length,
    remote.names.length,
    "immutable product asset inventory is incomplete",
  );
  const selected = select(inventory);
  await transport.authenticateRelease(
    {
      release_id: expected.release_id,
      tag: remote.tag,
      prepared_commit: remote.preparation.prepared_commit,
      assets: inventory,
    },
    remote.deadline,
  );
  remote.within();
  const files = new Map<string, Buffer>();
  for (const asset of selected) {
    const bytes = await transport.readAsset(asset.id, asset.bytes, remote.deadline);
    remote.within();
    assert.equal(bytes.length, asset.bytes);
    assert.equal(sha256(bytes), asset.sha256, "immutable Windows candidate bytes differ");
    files.set(asset.name, bytes);
  }
  assert.deepEqual(await remote.release(), before);
  assert.deepEqual(await remote.assets(), inventory);
  await remote.inspectTag();
  return files;
}

/** Permanent immutable availability input. No temporary transfer or private
 * preparation proof is needed. The caller authenticates upstream release
 * inclusion before byte reads, then expected assembly provenance and payload
 * authority before any feed advancement. No provider mutation is available. */
export async function readImmutableApplicationRelease(
  expected: ApplicationPublicationExpected,
  transport: {
    open: ApplicationPublicationReadTransport["open"];
    authenticateRelease: (
      expected: Parameters<typeof inspectApplicationReleaseAttestation>[1],
      deadline: number,
    ) => Promise<void>;
    readAsset: ApplicationPublicationReadTransport["readAsset"];
    authenticateContents: (
      files: ReadonlyMap<string, Buffer>,
      inspected: ReturnType<typeof inspectApplicationPublicationFiles>,
    ) => Promise<void>;
  },
) {
  const remote = await openApplicationPublicationRead(expected, (deadline) =>
    transport.open(expected, deadline),
  );
  const before = await remote.release();
  assert.equal(before.draft, false, "feed requires published immutable assets");
  assert.equal(before.immutable, true);
  const assets = await remote.assets();
  assert.deepEqual(
    assets.map((asset) => asset.name),
    remote.names,
  );
  assert.ok(assets.reduce((total, asset) => total + asset.bytes, 0) <= 2 * 1024 ** 3);
  await remote.inspectTag();
  await transport.authenticateRelease(
    {
      release_id: expected.release_id,
      tag: remote.tag,
      prepared_commit: remote.preparation.prepared_commit,
      assets,
    },
    remote.deadline,
  );
  remote.within();
  const files = new Map<string, Buffer>();
  for (const asset of assets) {
    remote.within();
    const bytes = await transport.readAsset(asset.id, asset.bytes, remote.deadline);
    remote.within();
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.length, asset.bytes);
    assert.equal(sha256(bytes), asset.sha256, `immutable asset bytes differ: ${asset.name}`);
    files.set(asset.name, bytes);
  }
  const inspected = inspectApplicationPublicationFiles(expected, files);
  await transport.authenticateContents(files, inspected);
  remote.within();
  assert.deepEqual(
    await remote.release(),
    before,
    "immutable release changed during byte verification",
  );
  assert.deepEqual(await remote.assets(), assets);
  await remote.inspectTag();
  return {
    site: inspected.receipt.site,
    files: inspected.site_files,
    publication: inspected.receipt.publication,
    metadata: inspected.metadata,
    producer_attempt: inspected.receipt.producer_attempt,
    receipt: {
      schema_version: 1,
      authority: "none",
      release_id: expected.release_id,
      tag: remote.tag,
      site_generation: inspected.receipt.site.generation,
      assets,
      scope:
        "complete immutable public bytes and authenticated contents; deployment and installed acceptance remain separate",
    },
  };
}

/** Closed attestation-subject data, portable across runners. No workspace paths. */
export function inspectBootstrapPublicationReceipt(
  raw: unknown,
  expected: BootstrapPublicationBinding,
  now = Date.now(),
) {
  assert.ok(isRecord(raw));
  exact(
    raw,
    "authority,bootstrap_descriptor,control_commit,control_ref,kind,opportunity,producer_attempt,publication,retained_inventory_sha256,run_id,schema_version,site_archive,site_generation",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.kind, "application-bootstrap-publication");
  assert.equal(raw.authority, "none");
  assert.match(expected.control_commit, /^[a-f0-9]{40}$/u);
  assert.match(
    expected.control_ref,
    /^refs\/tags\/portcove-production-controller-windows-[A-Za-z0-9._-]{1,64}$/u,
  );
  assert.match(expected.run_id, /^[1-9][0-9]{0,15}$/u);
  assert.ok(Number.isSafeInteger(Number(expected.run_id)));
  assert.ok(
    Number.isSafeInteger(expected.producer_attempt) &&
      expected.producer_attempt > 0 &&
      expected.producer_attempt <= 3,
  );
  for (const key of [
    "control_commit",
    "control_ref",
    "opportunity",
    "run_id",
    "producer_attempt",
    "retained_inventory_sha256",
  ] as const)
    assert.equal(raw[key], expected[key]);
  assert.equal(expected.opportunity, expected.appointment.descriptor_sha256);
  assert.match(expected.retained_inventory_sha256, /^[a-f0-9]{64}$/u);
  const descriptor = inspectInitialApplicationDescriptor(
    raw.bootstrap_descriptor,
    expected.appointment,
    now,
  );
  assertMetadataBootstrapPublication(descriptor, raw.publication);
  const publication = inspectTufPublicationFacts(raw.publication);
  return {
    descriptor,
    ...inspectApplicationPublicationSite(
      raw,
      publication,
      expected.retained_inventory_sha256,
      null,
    ),
  };
}

function inspectApplicationPublicationSite(
  raw: Record<string, unknown>,
  publication: ReturnType<typeof inspectTufPublicationFacts>,
  retainedInventory: string,
  previousGeneration: string | null,
) {
  assert.ok(isRecord(raw.site_generation) && typeof raw.site_generation.generation === "string");
  const site = inspectSiteGeneration(raw.site_generation, raw.site_generation.generation);
  assert.equal(site.previous_generation, previousGeneration);
  assert.equal(site.application_root_sha256, applicationReleaseTrust.root.sha256);
  if (site.schema_version === 2) assert.equal(site.catalog_root_sha256, null);
  assert.ok(
    site.files.every(
      (file) =>
        file.path === ".nojekyll" ||
        file.path.startsWith("application/") ||
        isRetainedApplicationRehearsalPath(file.path),
    ),
    "application publication cannot appoint a catalog feed",
  );
  const application = site.files
    .filter((file) => file.path.startsWith("application/"))
    .map((file) => ({ ...file, path: file.path.slice("application/".length) }));
  assert.equal(digest(application), publication.repository_sha256);
  for (const [name, expectedSha] of [
    ["metadata/1.root.json", publication.root_sha256],
    ["metadata/timestamp.json", publication.timestamp_sha256],
    [`metadata/${publication.versions.snapshot}.snapshot.json`, publication.snapshot_sha256],
    [`metadata/${publication.versions.targets}.targets.json`, publication.offline_targets_sha256],
  ])
    assert.equal(application.find((file) => file.path === name)?.sha256, expectedSha);
  assert.equal(
    digest(site.files.filter((file) => !file.path.startsWith("application/"))),
    retainedInventory,
  );
  assert.ok(isRecord(raw.site_archive));
  exact(raw.site_archive, "bytes,filename,sha256");
  assert.equal(raw.site_archive.filename, bootstrapAssetNames[0]);
  assert.ok(
    typeof raw.site_archive.bytes === "number" &&
      Number.isSafeInteger(raw.site_archive.bytes) &&
      raw.site_archive.bytes >= 22 &&
      raw.site_archive.bytes <= 512 * 1024 ** 2,
  );
  assert.ok(
    typeof raw.site_archive.sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.site_archive.sha256),
  );
  return {
    publication,
    site,
    archive: {
      filename: bootstrapAssetNames[0],
      bytes: raw.site_archive.bytes,
      sha256: raw.site_archive.sha256,
    },
  };
}

/** Historical receipt data. Registered native custody and actual assembly
 * provenance must authenticate its producer; pinned Tough authenticates prior
 * metadata separately. Expired historical bootstrap descriptors are inspected
 * at their recorded generation time, never used as current freshness authority. */
export function inspectHistoricalApplicationPublication(
  raw: unknown,
  custody: ApplicationRunCustody,
) {
  assert.ok(isRecord(raw));
  const inspectedCustody = inspectApplicationRunCustody(custody);
  assert.ok(raw.schema_version === 1 || raw.schema_version === 2);
  assert.equal(raw.authority, "none");
  assert.equal(raw.opportunity, inspectedCustody.opportunity);
  assert.ok(
    typeof raw.producer_attempt === "number" &&
      Number.isSafeInteger(raw.producer_attempt) &&
      raw.producer_attempt >= 1 &&
      raw.producer_attempt <= 3,
  );
  const producer = inspectedCustody.runs.find((run) => run.id === raw.run_id);
  assert.ok(producer, "historical assembly producer is absent from native custody");
  assert.equal(raw.control_commit, producer.control_commit);
  assert.equal(raw.control_ref, producer.control_ref);
  assert.ok(
    typeof raw.retained_inventory_sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(raw.retained_inventory_sha256),
  );
  if (raw.kind === "application-bootstrap-publication") {
    assert.equal(raw.schema_version, 1);
    assert.equal(inspectedCustody.preparation, null);
    assert.ok(isRecord(raw.bootstrap_descriptor));
    const descriptor = raw.bootstrap_descriptor;
    assert.ok(
      typeof descriptor.generated_at === "string" &&
        typeof descriptor.setup_plan_sha256 === "string" &&
        typeof descriptor.initial_site_preimage_sha256 === "string",
    );
    return {
      ...inspectBootstrapPublicationReceipt(
        raw,
        {
          ...producer,
          control_commit: producer.control_commit,
          control_ref: producer.control_ref,
          run_id: producer.id,
          producer_attempt: raw.producer_attempt,
          opportunity: inspectedCustody.opportunity,
          retained_inventory_sha256: raw.retained_inventory_sha256,
          appointment: {
            descriptor_sha256: inspectedCustody.opportunity,
            setup_plan_sha256: descriptor.setup_plan_sha256,
            site_preimage_sha256: descriptor.initial_site_preimage_sha256,
          },
        },
        Date.parse(descriptor.generated_at),
      ),
      producer,
      producer_attempt: raw.producer_attempt,
    };
  }
  const fields =
    "authority,context_sha256,control_commit,control_ref,kind,opportunity,prior_generation,prior_repository_sha256,producer_attempt,publication,purpose,retained_inventory_sha256,run_id,schema_version,site_archive,site_generation";
  exact(
    raw,
    raw.schema_version === 2
      ? `${fields},authority_repository_sha256,renewal_parent`.split(",").sort().join(",")
      : fields,
  );
  assert.equal(raw.kind, "application-metadata-publication");
  assert.ok(raw.purpose === "application-release" || raw.purpose === "metadata-renewal");
  assert.equal(inspectedCustody.preparation !== null, raw.purpose === "application-release");
  if (raw.schema_version === 2) {
    assert.equal(raw.purpose, "metadata-renewal");
    assert.equal(
      inspectedCustody.budget?.kind,
      "member",
      "forward renewal must retain its cost owner",
    );
    const parent = inspectApplicationReleaseReference(raw.renewal_parent);
    assert.notEqual(parent.opportunity, raw.opportunity);
    assert.ok(
      typeof raw.authority_repository_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(raw.authority_repository_sha256),
    );
    assert.notEqual(raw.authority_repository_sha256, raw.prior_repository_sha256);
  }
  for (const key of ["prior_generation", "prior_repository_sha256", "context_sha256"] as const)
    assert.ok(typeof raw[key] === "string" && /^[a-f0-9]{64}$/u.test(raw[key]));
  const publication = inspectTufPublicationFacts(raw.publication);
  assert.equal(publication.root_sha256, applicationReleaseTrust.root.sha256);
  if (raw.purpose === "metadata-renewal")
    assert.equal(
      raw.opportunity,
      digest({
        schema_version: 1,
        kind: "application-metadata-renewal-basis",
        root_sha256: publication.root_sha256,
        repository_sha256: raw.authority_repository_sha256 ?? raw.prior_repository_sha256,
        site_generation: raw.prior_generation,
      }),
      "historical renewal changed its canonical authority basis",
    );
  assert.ok(typeof raw.prior_generation === "string");
  return {
    ...inspectApplicationPublicationSite(
      raw,
      publication,
      raw.retained_inventory_sha256,
      raw.prior_generation,
    ),
    producer,
    producer_attempt: raw.producer_attempt,
  };
}

/** Fixed draft inspection used before staging a recovery backup. Published
 * releases are identified for a no-op; they are never recovery targets. */
export async function readApplicationDraftRecoveryState(
  open: (deadline: number) => Promise<Pick<PublicationMetadataProvider, "readMetadata">>,
  expected: ApplicationPublicationExpected,
) {
  const custody = inspectApplicationRunCustody(expected.custody);
  const identity =
    custody.preparation === null ? undefined : applicationPublicationIdentity(expected);
  const tag = identity?.tag ?? `portcove-production-candidate-${custody.opportunity}`;
  const endpoint = `repos/boburning/portcove/releases/${expected.release_id}`;
  assert.ok(Number.isSafeInteger(expected.release_id) && expected.release_id > 0);
  const deadline = Math.min(coordinatorCommandDeadline() ?? Infinity, performance.now() + 120000);
  const provider = await open(deadline);
  const response = await provider.readMetadata(endpoint);
  assert.equal(response.status, 200);
  const release = identity
    ? inspectPublicationRelease(response.body, expected.release_id, identity)
    : response.body;
  assert.ok(
    isRecord(release) && typeof release.body === "string" && typeof release.tag_name === "string",
  );
  if (!identity) {
    assert.equal(release.id, expected.release_id);
    assert.equal(release.tag_name, tag);
    assert.equal(release.target_commitish, custody.source);
    assert.equal(release.prerelease, true);
    assertApplicationCustodyMetadataExtension(
      custody,
      readApplicationRunNotes(release.body)?.custody,
    );
  }
  if (release.draft === false) {
    assert.equal(release.immutable, true);
    return undefined;
  }
  assert.equal(release.draft, true);
  assert.equal(release.immutable, false);
  const assets = inspectApplicationDraftInventory(
    await provider.readMetadata(`${endpoint}/assets?per_page=100&page=1`),
    identity?.names ?? bootstrapAssetNames,
  );
  let ref: GitHubMetadataResponse | undefined;
  try {
    ref = await provider.readMetadata(`repos/boburning/portcove/git/ref/tags/${tag}`);
  } catch (error) {
    if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
  }
  const direct = ref !== undefined && ref.status !== 404;
  if (direct) {
    assert.ok(ref);
    if (identity) inspectPublicationTag(ref, identity);
    else {
      assert.equal(ref.status, 200);
      assert.ok(isRecord(ref.body) && ref.body.ref === `refs/tags/${tag}`);
      assert.ok(isRecord(ref.body.object));
      assert.equal(ref.body.object.type, "commit");
      assert.equal(ref.body.object.sha, custody.source);
    }
  }
  return {
    release_id: expected.release_id,
    draft: true,
    immutable: false,
    tag: release.tag_name,
    source: custody.source,
    notes: release.body,
    direct,
    assets,
  };
}

export function createApplicationDraftRecoveryReader(
  token: string,
  expected: ApplicationPublicationExpected,
  deadline: number,
): Promise<Pick<PublicationMetadataProvider, "readMetadata">> {
  const custody = inspectApplicationRunCustody(expected.custody);
  const tag =
    custody.preparation === null
      ? `portcove-production-candidate-${custody.opportunity}`
      : applicationPublicationIdentity(expected).tag;
  return createApplicationPublicationProvider(token, expected.release_id, tag, undefined, deadline);
}

export async function removeFixedApplicationDraftAsset(
  token: string,
  assetId: number,
  requireFresh: () => void,
) {
  assert.ok(Number.isSafeInteger(assetId) && assetId > 0);
  const endpoint = `/repos/boburning/portcove/releases/assets/${assetId}`;
  const deadline = Math.min(coordinatorCommandDeadline() ?? Infinity, performance.now() + 30000);
  const { createGitHubClient } = await import("./github-client.mts");
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline,
    requestTimeoutMs: 30000,
    maxBytes: 8 * 1024 ** 2,
    allowRequest(method, url) {
      assertTrustedDirectNode("fixed application draft asset removal");
      requireFresh();
      return method === "DELETE" && url.href === `https://api.github.com${endpoint}`;
    },
  });
  let dispatched = false;
  const policy: GitHubRequestPolicy = {
    replay: "once",
    attempts: 0,
    observe(observation) {
      dispatched = observation.dispatched;
    },
  };
  try {
    const response = await client.request(`DELETE ${endpoint}`, {
      request: { portcove: policy },
    });
    assert.equal(response.status, 204);
  } catch (error) {
    if (!dispatched) throw error;
    // Only the authoritative readback decides the result of a dispatched DELETE.
  }
}

/** Collect a backup preimage from the surviving provider assets. The fixed
 * caller must supply a fresh draft inventory and verify the original assembly
 * attestation before any recovery record or mutation. */
export async function readExpiredApplicationDraftAssets(
  expected: { release_id: number; custody: ApplicationRunCustody },
  financialOwner: { release_id: number; custody: ApplicationRunCustody },
  replacement: ApplicationDraftAssembly,
  replacementMetadata: Buffer,
  assets: readonly ApplicationAsset[],
  transport: {
    readAsset: (id: number, maximumBytes: number) => Promise<Buffer>;
    authenticateAssembly: (
      filename: string,
      bytes: Buffer,
      expected: ReleaseSourceAttestationExpectation,
    ) => Promise<void>;
  },
  now = Date.now(),
) {
  const custody = inspectApplicationRunCustody(expected.custody);
  const owner = inspectApplicationRunCustody(financialOwner.custody);
  assert.equal(replacement.release_id, expected.release_id);
  if (custody.budget?.kind === "member") {
    assert.equal(financialOwner.release_id, custody.budget.owner_release_id);
    assert.notEqual(financialOwner.release_id, expected.release_id);
    assert.equal(owner.opportunity, custody.budget.owner_opportunity);
    const scope =
      owner.budget?.kind === "owner" &&
      owner.budget.scopes.find((entry) => entry.opportunity === custody.opportunity);
    assert.ok(scope && custody.runs.every((run) => scope.run_ids.includes(run.id)));
  } else {
    assert.equal(financialOwner.release_id, expected.release_id);
    assertApplicationCustodyMetadataExtension(custody, owner);
  }
  const reservations = owner.metadata_contexts ?? [];
  const nextContext = reservations.at(-1);
  assert.ok(nextContext);
  assert.equal(nextContext.context_sha256, replacement.context_sha256);
  const history = owner.draft_assemblies ?? [];
  const next = history.find((entry) => entry.context_sha256 === nextContext.context_sha256);
  assert.deepEqual(next, replacement, "replacement assembly is not retained under the owner");
  assert.ok(next);
  const staged = assets.filter((asset) => bootstrapAssetNames.some((name) => name === asset.name));
  assert.ok(staged.length > 0 && staged.length <= 2);
  assert.equal(new Set(staged.map((asset) => asset.name)).size, staged.length);
  assert.equal(new Set(assets.map((asset) => asset.id)).size, assets.length);
  const candidates = history.filter(
    (entry) =>
      entry !== next &&
      entry.release_id === expected.release_id &&
      staged.every((asset) =>
        entry.subjects.some(
          (subject) =>
            subject.name === asset.name &&
            subject.bytes === asset.bytes &&
            subject.sha256 === asset.sha256,
        ),
      ),
  );
  assert.equal(candidates.length, 1, "staged assets do not identify one retained assembly");
  const old = candidates[0]!;
  const oldContext = reservations.find((entry) => entry.context_sha256 === old.context_sha256);
  assert.ok(oldContext && reservations.indexOf(oldContext) < reservations.indexOf(nextContext));
  for (const context of [oldContext, nextContext]) {
    assert.equal(context.opportunity, custody.opportunity);
    assert.ok(
      custody.runs.some(
        (run) =>
          run.id === context.run_id &&
          run.control_commit === context.control_commit &&
          run.control_ref === context.control_ref,
      ),
    );
  }
  for (const field of [
    "prior_generation",
    "prior_repository_sha256",
    "authority_repository_sha256",
    "renewal_parent",
    "retained_inventory_sha256",
  ] as const)
    assert.deepEqual(next[field], old[field], `draft replacement changed ${field}`);
  assert.equal(next.publication.root_sha256, old.publication.root_sha256);
  assert.equal(next.publication.offline_targets_sha256, old.publication.offline_targets_sha256);
  assert.equal(next.publication.records_sha256, old.publication.records_sha256);
  assert.notEqual(next.publication.repository_sha256, old.publication.repository_sha256);
  assert.ok(Number.isSafeInteger(now) && now > 0);
  const instant = BigInt(now) * 1_000_000n;
  const online = ["releases", "preview", "stable", "snapshot", "timestamp"] as const;
  assert.ok(
    online.some((role) => metadataInstant(old.publication.expires[role]) <= instant),
    "staged metadata is still fresh",
  );
  assert.ok(
    Object.values(next.publication.expires).every((expiry) => metadataInstant(expiry) > instant),
    "replacement metadata has expired",
  );
  assert.equal(next.publication.versions.targets, old.publication.versions.targets);
  assert.equal(next.publication.expires.targets, old.publication.expires.targets);
  for (const role of online)
    assert.ok(
      BigInt(next.publication.versions[role]) > BigInt(old.publication.versions[role]),
      "draft replacement reused an online version",
    );
  const backup = [];
  for (const asset of staged) {
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0);
    const bytes = await transport.readAsset(asset.id, asset.bytes);
    assert.equal(bytes.length, asset.bytes);
    assert.equal(sha256(bytes), asset.sha256);
    backup.push({ asset, bytes });
  }
  const authenticate = async (
    assembly: ApplicationDraftAssembly,
    context: typeof nextContext,
    filename: string,
    bytes: Buffer,
  ) => {
    const producer = {
      source_commit: context.control_commit,
      ref: context.control_ref,
      run_id: context.run_id,
      run_attempt: assembly.producer_attempt,
    };
    await transport.authenticateAssembly(filename, bytes, {
      ...producer,
      subjects: assembly.subjects.map((asset) => ({ filename: asset.name, sha256: asset.sha256 })),
    });
    const proof = applicationDraftProofBytes(assembly);
    await transport.authenticateAssembly(applicationDraftProofName, proof, {
      ...producer,
      subjects: [{ filename: applicationDraftProofName, sha256: sha256(proof) }],
    });
  };
  const nextMetadata = next.subjects[1]!;
  assert.equal(replacementMetadata.length, nextMetadata.bytes);
  assert.equal(sha256(replacementMetadata), nextMetadata.sha256);
  const subject = backup[0]!;
  await authenticate(old, oldContext, subject.asset.name, subject.bytes);
  await authenticate(next, nextContext, nextMetadata.name, replacementMetadata);
  const { preimage, replacementProducer } = readStagedDraftRecoveryBackup(
    { release_id: expected.release_id, assets },
    owner,
    old.context_sha256,
    next.context_sha256,
  );
  return {
    old,
    next,
    backup,
    preimage,
    replacementProducer,
    authority: "none" as const,
  };
}

/** Rebuild the backup contract from the exact draft bracket and retained
 * assemblies, after the same-job stage already authenticated both producers. */
export function readStagedDraftRecoveryBackup(
  draft: { release_id: number; assets: readonly ApplicationAsset[] },
  owner: ApplicationRunCustody,
  oldContext: string,
  replacementContext: string,
) {
  const old = owner.draft_assemblies?.find((assembly) => assembly.context_sha256 === oldContext);
  const next = owner.draft_assemblies?.find(
    (assembly) => assembly.context_sha256 === replacementContext,
  );
  const producer = owner.metadata_contexts?.at(-1);
  assert.ok(old && next && old !== next && producer);
  assert.equal(old.release_id, draft.release_id);
  assert.equal(next.release_id, draft.release_id);
  assert.equal(producer.context_sha256, replacementContext);
  const staged = draft.assets.filter((asset) =>
    bootstrapAssetNames.some((name) => name === asset.name),
  );
  assert.ok(staged.length > 0);
  for (const asset of staged)
    assert.ok(
      old.subjects.some(
        (subject) =>
          subject.name === asset.name &&
          subject.bytes === asset.bytes &&
          subject.sha256 === asset.sha256,
      ),
    );
  return {
    next,
    backup: staged.map((asset) => ({ asset })),
    preimage: {
      release_id: draft.release_id,
      old_context_sha256: oldContext,
      replacement_context_sha256: replacementContext,
      retained_assets_sha256: digest(
        draft.assets
          .filter((asset) => !staged.includes(asset))
          .sort((left, right) => left.id - right.id),
      ),
      assets: staged
        .map(({ id, name }) => ({ id, name }))
        .sort((left, right) => left.id - right.id),
    },
    replacementProducer: { run_id: producer.run_id, source: producer.control_commit },
  };
}

/** A provider upload acknowledgement alone cannot authorize retention. Read
 * the exact bounded archive by ID, then compare its closed physical contents
 * with the original attested provider bytes before returning the notes record. */
export async function verifyApplicationDraftRecoveryBackup(
  verified: ReturnType<typeof readStagedDraftRecoveryBackup>,
  artifactId: number,
  producer: { run_id: string; run_attempt: number; source: string },
  readArtifact: (expected: {
    id: number;
    name: string;
    run_id: string;
    source: string;
    files: readonly string[];
  }) => Promise<{
    bytes: number;
    sha256: string;
    files: ReadonlyMap<string, Buffer>;
  }>,
): Promise<ApplicationDraftRecovery> {
  assert.ok(Number.isSafeInteger(artifactId) && artifactId > 0);
  assert.equal(producer.run_id, verified.replacementProducer.run_id);
  assert.equal(producer.source, verified.replacementProducer.source);
  assert.ok(
    Number.isSafeInteger(producer.run_attempt) &&
      producer.run_attempt >= verified.next.producer_attempt &&
      producer.run_attempt <= 3,
  );
  const artifact = await readArtifact({
    id: artifactId,
    name: `application-draft-recovery-${producer.run_id}-${producer.run_attempt}`,
    run_id: producer.run_id,
    source: producer.source,
    files: verified.backup.map(({ asset }) => asset.name),
  });
  assert.ok(
    Number.isSafeInteger(artifact.bytes) &&
      artifact.bytes >= 22 &&
      artifact.bytes <= 512 * 1024 ** 2,
  );
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(artifact.files.size, verified.backup.length);
  for (const { asset } of verified.backup) {
    const bytes = artifact.files.get(asset.name);
    assert.ok(bytes);
    assert.equal(bytes.length, asset.bytes);
    assert.equal(sha256(bytes), asset.sha256, "recovery backup bytes differ");
  }
  return {
    ...verified.preimage,
    backup: {
      id: artifactId,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      run_attempt: producer.run_attempt,
    },
  };
}

/** Remove only verified, backed-up old IDs. The fixed caller owns protection,
 * the backup readback and the durable owner claim for every request. */
export async function removeExpiredApplicationDraftAssets(
  recovery: ApplicationDraftRecovery,
  old: ApplicationDraftAssembly,
  replacement: ApplicationDraftAssembly,
  transport: {
    removeAsset: (id: number, assertFresh: () => void) => Promise<void>;
    inspectDraft: () => Promise<{
      release_id: number;
      draft: boolean;
      immutable: boolean;
      tag: string;
      source: string;
      notes: string;
      assets: ApplicationAsset[];
    }>;
    claim: (
      assetId: number,
      beforeWrite: () => Promise<void>,
    ) => Promise<{ release_id: number; notes: string } | undefined>;
    beforeWrite: () => Promise<() => void | Promise<void>>;
  },
) {
  assert.equal(old.release_id, recovery.release_id);
  assert.equal(replacement.release_id, recovery.release_id);
  assert.equal(old.context_sha256, recovery.old_context_sha256);
  assert.equal(replacement.context_sha256, recovery.replacement_context_sha256);
  const readDraft = async () => {
    const { assets: inventory, ...release } = await transport.inspectDraft();
    assert.equal(release.release_id, recovery.release_id);
    assert.equal(release.draft, true);
    assert.equal(release.immutable, false);
    const assets = [...inventory].sort((left, right) => left.id - right.id);
    assert.equal(new Set(assets.map((asset) => asset.id)).size, assets.length);
    assert.equal(new Set(assets.map((asset) => asset.name)).size, assets.length);
    const retained = assets.filter(
      (asset) => !bootstrapAssetNames.some((name) => name === asset.name),
    );
    assert.equal(
      digest(retained),
      recovery.retained_assets_sha256,
      "retained draft assets changed",
    );
    for (const asset of assets) {
      if (retained.includes(asset)) continue;
      assert.ok(
        recovery.assets.some((entry) => entry.id === asset.id && entry.name === asset.name),
      );
      assert.ok(
        old.subjects.some(
          (subject) =>
            subject.name === asset.name &&
            subject.bytes === asset.bytes &&
            subject.sha256 === asset.sha256,
        ),
      );
    }
    return { release, assets };
  };
  const assertFresh = () => {
    const instant = BigInt(Date.now()) * 1_000_000n;
    assert.ok(
      Object.values(replacement.publication.expires).every(
        (expiry) => metadataInstant(expiry) > instant,
      ),
      "replacement metadata expired during recovery",
    );
  };
  let settled = await readDraft();
  for (const target of recovery.assets) {
    if (!settled.assets.some((asset) => asset.id === target.id)) continue;
    const before = settled;
    const claimed = await transport.claim(target.id, async () => {
      const window = await transport.beforeWrite();
      assert.deepEqual(await readDraft(), before, "draft changed before removal claim");
      await window();
      assertFresh();
    });
    assert.ok(claimed, "old asset removal already claimed and ID is still present");
    const afterClaim = await readDraft();
    assert.deepEqual(afterClaim.assets, before.assets);
    assert.deepEqual(
      afterClaim.release,
      {
        ...before.release,
        notes: claimed.release_id === recovery.release_id ? claimed.notes : before.release.notes,
      },
      "draft changed during removal claim",
    );
    const window = await transport.beforeWrite();
    assert.deepEqual(await readDraft(), afterClaim, "draft changed after removal claim");
    await window();
    assertFresh();
    await transport.removeAsset(target.id, assertFresh);
    settled = await readDraft();
    assert.deepEqual(settled.release, afterClaim.release);
    assert.deepEqual(
      settled.assets,
      before.assets.filter((asset) => asset.id !== target.id),
      "old asset removal outcome unknown or another draft asset changed",
    );
  }
  assert.deepEqual(await readDraft(), settled);
  assertFresh();
  return { assets: settled.assets, authority: "none" as const };
}

/** Recheck the exact provider ZIP, including CRC, closed inventory and marker.
 * Maintained Rust already authenticated the component in the attested assembly. */
export function inspectBootstrapSiteArchive(
  archive: Buffer,
  receipt: Pick<
    ReturnType<typeof inspectBootstrapPublicationReceipt>,
    "publication" | "site" | "archive"
  >,
) {
  return readBootstrapSiteArchive(archive, receipt).site;
}

/** The draft-capable source producer may only copy the appointed original bytes. */
export async function readOriginalBootstrapSiteAsset(
  raw: unknown,
  transport: {
    release: (id: number) => Promise<{ status?: number; body: unknown }>;
    readAsset: (id: number, bytes: number) => Promise<Buffer>;
  },
) {
  const expected = inspectBootstrapDraftRecovery(raw);
  const asset = expected.site_archive;
  assert.ok(asset, "original bootstrap site identity unavailable");
  const inspect = async () => {
    const response = await transport.release(expected.release_id);
    assert.equal(response.status, 200);
    const draft = response.body;
    requireBootstrapDraft(draft, expected);
    assert.ok(isRecord(draft));
    return draft;
  };
  const before = await inspect();
  const bytes = await transport.readAsset(asset.id, asset.bytes);
  assert.equal(bytes.length, asset.bytes);
  assert.equal(sha256(bytes), asset.sha256);
  const after = await inspect();
  // Download counters may advance during our own physical readback.
  for (const key of [
    "id",
    "body",
    "name",
    "tag_name",
    "target_commitish",
    "draft",
    "immutable",
    "prerelease",
  ])
    assert.deepEqual(
      after[key],
      before[key],
      "bootstrap draft changed during original asset readback",
    );
  return bytes;
}

/** Decode only the exact bounded source-packet copy. Assembly still verifies
 * every ZIP entry against its independently generated complete site map. */
export function decodeBootstrapDraftSiteAsset(raw: unknown, encoded: unknown) {
  const { site_archive: asset } = inspectBootstrapDraftRecovery(raw);
  assert.ok(asset && typeof encoded === "string");
  assert.equal(encoded.length, 4 * Math.ceil(asset.bytes / 3));
  const bytes = Buffer.from(encoded, "base64");
  assert.equal(bytes.length, asset.bytes);
  assert.equal(bytes.toString("base64"), encoded);
  assert.equal(sha256(bytes), asset.sha256);
  return bytes;
}

/** Decoded data remains inert. No extraction or candidate code is executed. */
export function readBootstrapSiteArchive(
  archive: Buffer,
  receipt: Pick<
    ReturnType<typeof inspectBootstrapPublicationReceipt>,
    "publication" | "site" | "archive"
  >,
) {
  assert.equal(archive.length, receipt.archive.bytes);
  assert.equal(sha256(archive), receipt.archive.sha256);
  const identities = new Map(receipt.site.files.map((file) => [file.path, file]));
  assert.ok(
    identities.size <= 63 && [...identities.keys()].every((name) => name.length <= 256),
    "bootstrap site exceeds maintained ZIP inventory bounds",
  );
  const parsed = inspectBoundedZip(
    archive,
    {
      compressedBytes: 512 * 1024 ** 2,
      expandedBytes: 256 * 1024 ** 2,
      files: identities.size + 1,
      nameBytes: 256,
      allowedPaths: new Set([...identities.keys(), "publication.json"]),
    },
    { deadline: Date.now() + 30000 },
  );
  assert.equal(parsed.entries.length, identities.size + 1);
  const files = new Map<string, Buffer>();
  for (const entry of parsed.entries) {
    const identity = identities.get(entry.name);
    assert.ok(entry.bytes <= (entry.name === "publication.json" ? 2 * 1024 ** 2 : 64 * 1024 ** 2));
    if (identity) assert.equal(entry.bytes, identity.bytes);
    const compressed = archive.subarray(entry.data, entry.dataEnd);
    const bytes =
      entry.method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.bytes) });
    assert.equal(bytes.length, entry.bytes);
    assert.equal(crc32(bytes), entry.crc);
    files.set(entry.name, bytes);
    if (entry.name === "publication.json") {
      assert.deepEqual(
        inspectSiteGeneration(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          receipt.site.generation,
        ),
        receipt.site,
      );
    } else {
      assert.ok(identity);
      assert.equal(sha256(bytes), identity.sha256);
    }
  }
  return { site: receipt.site, files };
}

type Asset = { id: number; name: AssetName; size: number; digest: string };

export function inspectMetadataDraftPreparation(
  raw: unknown,
  expected: Pick<
    ReleaseSourceAttestationExpectation,
    "source_commit" | "ref" | "run_id" | "run_attempt"
  >,
  purpose: "metadata-bootstrap" | "metadata-renewal",
) {
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "assembly_attempt,assets,authority,control_commit,control_ref,kind,producer_attempt,release_id,run_id,schema_version,site_generation",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.authority, "none");
  assert.equal(
    raw.kind,
    purpose === "metadata-bootstrap"
      ? "application-bootstrap-draft-preparation"
      : "application-renewal-draft-preparation",
  );
  assert.equal(raw.control_commit, expected.source_commit);
  assert.equal(raw.control_ref, expected.ref);
  assert.equal(raw.run_id, expected.run_id);
  assert.equal(raw.producer_attempt, expected.run_attempt);
  assert.ok(
    typeof raw.assembly_attempt === "number" &&
      Number.isSafeInteger(raw.assembly_attempt) &&
      raw.assembly_attempt >= 1 &&
      raw.assembly_attempt <= expected.run_attempt,
  );
  assert.ok(
    typeof raw.release_id === "number" &&
      Number.isSafeInteger(raw.release_id) &&
      raw.release_id > 0,
  );
  assert.ok(typeof raw.site_generation === "string" && /^[a-f0-9]{64}$/u.test(raw.site_generation));
  assert.ok(Array.isArray(raw.assets) && raw.assets.length === bootstrapAssetNames.length);
  const assets = raw.assets.map((asset: unknown): Asset => {
    assert.ok(isRecord(asset) && Object.keys(asset).sort().join(",") === "digest,id,name,size");
    assert.ok(typeof asset.id === "number" && Number.isSafeInteger(asset.id) && asset.id > 0);
    assert.ok(bootstrapAssetNames.includes(asset.name as AssetName));
    assert.ok(
      typeof asset.size === "number" &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.size <= 512 * 1024 ** 2,
    );
    assert.ok(typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(asset.digest));
    return { id: asset.id, name: asset.name as AssetName, size: asset.size, digest: asset.digest };
  });
  assert.equal(new Set(assets.map((asset) => asset.id)).size, bootstrapAssetNames.length);
  assert.deepEqual(assets.map((asset) => asset.name).sort(), [...bootstrapAssetNames].sort());
  return {
    assembly_attempt: raw.assembly_attempt,
    release_id: raw.release_id,
    site_generation: raw.site_generation,
    assets,
  };
}

/** Current metadata-only publication. Historical provenance is verified by the
 * caller; this join keeps renewal on its selected public basis and producer. */
export function inspectApplicationMetadataPublicationReceipt(
  raw: unknown,
  binding: ApplicationMetadataPublicationBinding | ApplicationMetadataRenewalBasis,
  custody: ApplicationRunCustody,
) {
  if (!("purpose" in binding)) return inspectBootstrapPublicationReceipt(raw, binding);
  assert.equal(binding.purpose, "metadata-renewal");
  assert.ok(isRecord(raw));
  assert.equal(raw.purpose, "metadata-renewal");
  assert.equal(inspectApplicationRunCustody(custody).preparation, null);
  for (const key of ["opportunity", "prior_generation", "prior_repository_sha256"] as const)
    assert.equal(raw[key], binding[key]);
  if (binding.renewal_parent !== undefined) {
    assert.equal(raw.schema_version, 2);
    assert.deepEqual(
      raw.renewal_parent,
      inspectApplicationReleaseReference(binding.renewal_parent),
    );
    assert.equal(raw.authority_repository_sha256, binding.authority_repository_sha256);
  } else {
    assert.equal(raw.schema_version, 1);
    assert.equal(binding.authority_repository_sha256, undefined);
  }
  if ("run_id" in binding)
    for (const key of ["control_commit", "control_ref", "run_id", "producer_attempt"] as const)
      assert.equal(raw[key], binding[key]);
  const receipt = inspectHistoricalApplicationPublication(raw, custody);
  assert.equal(
    binding.opportunity,
    digest({
      schema_version: 1,
      kind: "application-metadata-renewal-basis",
      root_sha256: receipt.publication.root_sha256,
      repository_sha256: binding.authority_repository_sha256 ?? binding.prior_repository_sha256,
      site_generation: binding.prior_generation,
    }),
  );
  for (const expires of Object.values(receipt.publication.expires))
    assert.ok(
      Date.parse(expires) > Date.now(),
      "expired metadata cannot be published or advance the feed",
    );
  return receipt;
}
type ApplicationPublicationReadTransport = {
  open: (
    expected: ApplicationPublicationExpected,
    deadline: number,
  ) => Promise<Pick<PublicationMetadataProvider, "readMetadata">>;
  readAsset: (id: number, maximum: number, deadline: number) => Promise<Buffer>;
};

type PublicationMetadataProvider = {
  readMetadata: (endpoint: string) => Promise<GitHubMetadataResponse>;
  publish: (body: Record<string, unknown>) => Promise<void>;
};

export type BootstrapPublicationTransport = PublicationMetadataProvider & {
  upload: (releaseId: number, name: AssetName, bytes: Buffer) => Promise<void>;
  readAsset: (assetId: number, maximumBytes: number) => Promise<Buffer>;
  beforeWrite: (phase: "asset" | "publish") => Promise<() => void | Promise<void>>;
  retainAssembly?: (assembly: ApplicationDraftAssembly) => Promise<unknown>;
};

/** The metadata operation can read only its exact draft, assets and tag. */
export async function createApplicationMetadataPublicationProvider(
  token: string,
  releaseId: number,
  opportunity: string,
  assertWindow: () => void,
  deadline: number,
): Promise<Pick<BootstrapPublicationTransport, "readMetadata" | "publish">> {
  assert.match(opportunity, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
  return createApplicationPublicationProvider(
    token,
    releaseId,
    `portcove-production-candidate-${opportunity}`,
    assertWindow,
    deadline,
  );
}

export function createPreparedApplicationPublicationProvider(
  token: string,
  expected: ApplicationPublicationExpected,
  assertWindow: () => void,
  deadline: number,
) {
  const { tag } = applicationPublicationIdentity(expected);
  return createApplicationPublicationProvider(
    token,
    expected.release_id,
    tag,
    assertWindow,
    deadline,
  );
}

export function createPreparedApplicationPublicationReader(
  token: string,
  expected: ApplicationPublicationExpected,
  deadline: number,
): Promise<Pick<PublicationMetadataProvider, "readMetadata">> {
  const { tag } = applicationPublicationIdentity(expected);
  return createApplicationPublicationProvider(token, expected.release_id, tag, undefined, deadline);
}

type ApplicationDraftPreparationProvider = Pick<PublicationMetadataProvider, "readMetadata"> & {
  createTag: () => Promise<void>;
};

export function createApplicationDraftPreparationProvider(
  token: string,
  expected: ApplicationPublicationExpected,
  deadline: number,
): Promise<ApplicationDraftPreparationProvider> {
  const { tag, preparation } = applicationPublicationIdentity(expected);
  return createApplicationPublicationProvider(
    token,
    expected.release_id,
    tag,
    undefined,
    deadline,
    preparation.prepared_commit,
  );
}

async function createApplicationPublicationProvider(
  token: string,
  releaseId: number,
  tag: string,
  assertWindow: (() => void) | undefined,
  deadline: number,
  preparedCommit?: string,
): Promise<PublicationMetadataProvider & ApplicationDraftPreparationProvider> {
  assert.ok(token && token.length <= 16384 && !/[\r\n\0]/u.test(token));
  assert.ok(Number.isSafeInteger(releaseId) && releaseId > 0);
  const root = `repos/boburning/portcove/releases/${releaseId}`;
  const readable = new Set([
    root,
    `${root}/assets?per_page=100&page=1`,
    `repos/boburning/portcove/git/ref/tags/${tag}`,
  ]);
  if (preparedCommit !== undefined) {
    assert.match(preparedCommit, /^[a-f0-9]{40}$/u);
    readable.add(`repos/boburning/portcove/git/commits/${preparedCommit}`);
  }
  const tagCreationRoute = "repos/boburning/portcove/git/refs";
  const { createGitHubClient } = await import("./github-client.mts");
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline,
    requestTimeoutMs: 30000,
    maxBytes: 8 * 1024 ** 2,
    allowRequest(method, url) {
      assertTrustedDirectNode("fixed application metadata publication");
      if (url.origin !== "https://api.github.com") return false;
      const endpoint = url.pathname.slice(1) + url.search;
      if (method === "GET") return readable.has(endpoint);
      if (method === "POST") return preparedCommit !== undefined && endpoint === tagCreationRoute;
      if (!assertWindow || method !== "PATCH" || endpoint !== root) return false;
      assertWindow();
      return true;
    },
  });
  const options = () => ({ portcove: { replay: "once" as const, attempts: 0 } });
  return {
    async readMetadata(endpoint) {
      assert.ok(readable.has(endpoint));
      const response = await client.request(`GET /${endpoint}`, { request: options() });
      const link: unknown = response.headers.link;
      assert.ok(link === undefined || typeof link === "string");
      return {
        status: response.status,
        body: response.data,
        headers: new Map(typeof link === "string" ? [["link", link]] : []),
      };
    },
    async createTag() {
      assert.ok(preparedCommit);
      const response = await client.request(`POST /${tagCreationRoute}`, {
        ref: `refs/tags/${tag}`,
        sha: preparedCommit,
        request: options(),
      });
      assert.equal(response.status, 201);
    },
    async publish(body) {
      const response = await client.request(`PATCH /${root}`, { ...body, request: options() });
      assert.equal(response.status, 200);
    },
  };
}

/** Caller owns native Actions concurrency. No creation/deletion/clobber or
 * blind mutation retry. A lost acknowledgment is resolved by exact readback. */
export async function publishApplicationMetadataRelease(
  transport: BootstrapPublicationTransport,
  expected: {
    release_id: number;
    custody: ApplicationRunCustody;
    binding: ApplicationMetadataPublicationBinding;
    prepared_assets?: readonly Asset[];
    original_site?: ReturnType<typeof inspectBootstrapDraftRecovery>["site_archive"];
  },
  metadata: Buffer,
  archive: Buffer,
  mode: "combined" | "prepare" | "publish" = "combined",
) {
  assert.ok(["combined", "prepare", "publish"].includes(mode));
  if (mode === "publish")
    assert.equal(expected.prepared_assets?.length, bootstrapAssetNames.length);
  if (expected.original_site) assert.ok(!("purpose" in expected.binding));
  assert.ok(metadata.length > 0 && metadata.length <= 2 * 1024 ** 2);
  const metadataReceipt: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(metadata),
  );
  const receipt = inspectApplicationMetadataPublicationReceipt(
    metadataReceipt,
    expected.binding,
    expected.custody,
  );
  inspectBootstrapSiteArchive(archive, receipt);
  const custody = inspectApplicationRunCustody(expected.custody);
  assert.equal(custody.preparation, null, "metadata transport cannot publish application binaries");
  assert.equal(custody.opportunity, expected.binding.opportunity);
  assert.ok(
    custody.runs.some(
      (run) =>
        run.id === expected.binding.run_id &&
        run.control_commit === expected.binding.control_commit &&
        run.control_ref === expected.binding.control_ref,
    ),
  );
  assert.ok(Number.isSafeInteger(expected.release_id) && expected.release_id > 0);
  const tag = `portcove-production-candidate-${custody.opportunity}`;
  const root = `repos/boburning/portcove/releases/${expected.release_id}`;
  const files = new Map<AssetName, Buffer>([
    [bootstrapAssetNames[0], archive],
    [bootstrapAssetNames[1], metadata],
  ]);
  const started = performance.now();
  let calls = 0;
  const budget = () =>
    assert.ok(
      ++calls <= 32 && performance.now() - started <= 120000,
      "bootstrap publication request/duration bound exhausted",
    );
  const get = async (endpoint: string) => {
    budget();
    const result = await transport.readMetadata(endpoint);
    assert.equal(result.status, 200);
    return result.body;
  };
  const release = async () => {
    const raw = await get(root);
    assert.ok(isRecord(raw));
    assert.equal(raw.id, expected.release_id);
    assert.equal(raw.tag_name, tag);
    assert.equal(raw.target_commitish, custody.source);
    assert.equal(raw.prerelease, true);
    assertApplicationCustodyMetadataExtension(custody, readApplicationRunNotes(raw.body)?.custody);
    assert.ok(
      (raw.draft === true && raw.immutable === false) ||
        (raw.draft === false && raw.immutable === true),
    );
    return raw;
  };
  const assets = async () => {
    // Two fixed assets; a full page is never treated as complete coverage.
    const raw = await get(`${root}/assets?per_page=100&page=1`);
    assert.ok(Array.isArray(raw) && raw.length <= 2);
    const seen = new Set<string>();
    const actual = raw.map((value: unknown): Asset => {
      assert.ok(isRecord(value) && typeof value.name === "string");
      const bytes = files.get(value.name as AssetName);
      assert.ok(
        bytes && !seen.has(value.name) && value.state === "uploaded",
        "unexpected, duplicate or incomplete bootstrap asset",
      );
      seen.add(value.name);
      assert.ok(typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0);
      assert.equal(value.size, bytes.length);
      assert.equal(value.digest, `sha256:${sha256(bytes)}`);
      return {
        id: value.id,
        name: value.name as AssetName,
        size: bytes.length,
        digest: String(value.digest),
      };
    });
    if (expected.original_site) {
      const original = expected.original_site;
      assert.deepEqual(
        actual.find((asset) => asset.name === original.name),
        {
          id: original.id,
          name: original.name,
          size: original.bytes,
          digest: `sha256:${original.sha256}`,
        },
        "appointed original site asset is missing or changed; preserve without retry",
      );
    }
    if (mode === "publish") {
      assert.equal(
        actual.length,
        files.size,
        "protected publication requires every asset prepared first",
      );
      assert.deepEqual(
        actual.toSorted((a, b) => a.id - b.id),
        expected.prepared_assets!.toSorted((a, b) => a.id - b.id),
        "prepared asset IDs or bytes changed before publication readback",
      );
    }
    return actual;
  };
  const verifyBytes = async () => {
    const actual = await assets();
    assert.equal(actual.length, files.size);
    for (const asset of actual) {
      budget();
      const bytes = await transport.readAsset(asset.id, asset.size);
      assert.equal(bytes.length, asset.size);
      assert.equal(sha256(bytes), asset.digest.slice(7));
    }
    return actual;
  };
  let current = await release();
  let actual = await assets();
  const inspectTag = async (allowPending: boolean) => {
    budget();
    let result;
    try {
      result = await transport.readMetadata(`repos/boburning/portcove/git/ref/tags/${tag}`);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        assert.ok(allowPending, "immutable release tag is missing");
        return;
      }
      throw error;
    }
    if (result.status === 404) {
      assert.ok(allowPending, "immutable release tag is missing");
      return;
    }
    assert.equal(result.status, 200);
    const ref = result.body;
    assert.ok(
      isRecord(ref) &&
        ref.ref === `refs/tags/${tag}` &&
        isRecord(ref.object) &&
        ref.object.type === "commit" &&
        ref.object.sha === custody.source,
      "existing tag source differs; hold before publication",
    );
  };
  await inspectTag(current.draft === true);
  if (mode === "prepare")
    assert.equal(current.draft, true, "draft preparation cannot resume an immutable release");
  if (current.draft === true) {
    if (mode !== "publish" && transport.retainAssembly && "purpose" in expected.binding) {
      assert.ok(isRecord(metadataReceipt));
      await transport.retainAssembly(
        applicationDraftAssembly(expected.release_id, metadataReceipt, receipt.publication, files),
      );
      const retained = await release();
      assert.deepEqual(
        applicationReleaseNotesPreimage(retained),
        applicationReleaseNotesPreimage(current),
      );
      assert.deepEqual(await assets(), actual);
      current = retained;
    }
    for (const [name, bytes] of mode === "publish" ? [] : files)
      if (!actual.some((asset) => asset.name === name)) {
        const assertWindow = await transport.beforeWrite("asset");
        const fresh = await release();
        assert.equal(fresh.draft, true);
        assert.equal(fresh.body, current.body, "draft notes changed before upload");
        actual = await assets();
        if (!actual.some((asset) => asset.name === name)) {
          budget();
          await assertWindow();
          try {
            await transport.upload(expected.release_id, name, bytes);
          } catch {
            /* Exact readback decides. */
          }
          actual = await assets();
          assert.ok(
            actual.some((asset) => asset.name === name),
            "upload outcome unknown; hold without retry",
          );
        }
      }
    await verifyBytes();
    if (mode === "prepare") {
      const settled = await release();
      assert.equal(settled.draft, true);
      assert.equal(settled.body, current.body, "draft notes changed during preparation");
      assert.deepEqual(await assets(), actual, "draft asset identities changed during preparation");
      return {
        schema_version: 1,
        authority: "none",
        release_id: expected.release_id,
        tag,
        site_generation: receipt.site.generation,
        assets: actual,
        scope: "mutable metadata draft preparation only; no publication",
      };
    }
    const assertWindow = await transport.beforeWrite("publish");
    const fresh = await release();
    assert.equal(fresh.draft, true);
    assert.equal(fresh.body, current.body, "draft notes changed before publication");
    // Revalidate all object identities after the fresh guard and immediately
    // before the sole irreversible mutation. Remote asset bytes were read above.
    assert.deepEqual(await assets(), actual);
    await inspectTag(true);
    budget();
    // Uploads, byte reads and the fresh guard may consume the metadata's
    // remaining lifetime. The final Pages read and local barrier follow the draft checks.
    await assertWindow();
    inspectApplicationMetadataPublicationReceipt(metadataReceipt, expected.binding, custody);
    try {
      await transport.publish({
        draft: false,
        prerelease: true,
        make_latest: "false",
        name:
          "purpose" in expected.binding
            ? "Portcove application metadata renewal"
            : "Portcove application metadata bootstrap",
      });
    } catch {
      /* No second PATCH; immutable readback decides. */
    }
    current = await release();
  }
  assert.equal(current.draft, false, "publication outcome unknown; hold without retry");
  assert.equal(current.immutable, true);
  const ref = await get(`repos/boburning/portcove/git/ref/tags/${tag}`);
  assert.ok(
    isRecord(ref) &&
      ref.ref === `refs/tags/${tag}` &&
      isRecord(ref.object) &&
      ref.object.type === "commit" &&
      ref.object.sha === custody.source,
    "published tag source differs",
  );
  actual = await verifyBytes();
  const settled = await release();
  assert.equal(settled.draft, false);
  return {
    schema_version: 1,
    authority: "none",
    release_id: expected.release_id,
    tag,
    site_generation: receipt.site.generation,
    assets: actual,
    scope: "immutable metadata assets only; public feed and client acceptance remain separate",
  };
}

export function publishBootstrapRelease(
  transport: BootstrapPublicationTransport,
  expected: {
    release_id: number;
    custody: ApplicationRunCustody;
    binding: BootstrapPublicationBinding;
  },
  metadata: Buffer,
  archive: Buffer,
) {
  return publishApplicationMetadataRelease(transport, expected, metadata, archive);
}
