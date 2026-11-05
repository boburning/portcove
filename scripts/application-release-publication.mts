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
} from "./application-release-run.mts";
import type {
  ApplicationDraftAssembly,
  ApplicationDraftRecovery,
  ApplicationRunCustody,
  ApplicationReleaseReference,
} from "./application-release-run.mts";
import { inspectApplicationReleaseReference } from "./application-release-run.mts";
import type { ReleaseSourceAttestationExpectation } from "./release-source-attestation.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { GitHubApiError } from "./github-api.mts";
import { compareApplicationVersionPrecedence } from "../apps/desktop/scripts/release-version-policy.mts";
import { applicationPackageNames } from "./application-release-artifacts.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";

export const bootstrapAssetNames = ["application-site.zip", "application-metadata.json"] as const;
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
type PublicationApi = Pick<CoordinatorRemoteApi, "request">;

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
  response: ReturnType<PublicationApi["request"]>,
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

/** Fixed provider facts only. Asset IDs identify byte objects; names are mutable.
 * Public byte reads and standard attestation remain separate prerequisites. */
function applicationPublicationReader(
  api: PublicationApi,
  expected: ApplicationPublicationExpected,
  milliseconds: number,
) {
  const identity = applicationPublicationIdentity(expected);
  const started = performance.now();
  let requests = 0;
  const within = () =>
    assert.ok(
      performance.now() - started < milliseconds,
      "application publication phase deadline exhausted",
    );
  const request = (method: string, suffix: string, body?: unknown) => {
    within();
    assert.ok(
      ++requests <= 16 + identity.names.length * 8,
      "application publication request bound exhausted",
    );
    const response = api.request(method, `repos/boburning/portcove/${suffix}`, body);
    within();
    return response;
  };
  const get = (suffix: string) => {
    const response = request("GET", suffix);
    assert.equal(response.status, 200);
    return response;
  };
  const release = () => {
    const raw = get(`releases/${expected.release_id}`).body;
    assert.ok(isRecord(raw));
    assert.equal(raw.id, expected.release_id);
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
  };
  const assets = () =>
    inspectApplicationDraftInventory(
      get(`releases/${expected.release_id}/assets?per_page=100&page=1`),
      identity.names,
    );
  const tag = (pending: boolean) => {
    let response;
    try {
      response = request("GET", `git/ref/tags/${identity.tag}`);
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 404 && pending)) throw error;
      return false;
    }
    if (response.status === 404 && pending) return false;
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
    return true;
  };
  return { ...identity, get, request, within, release, assets, inspectTag: tag };
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
    api: PublicationApi;
    upload: (id: number, name: string, bytes: Buffer) => Promise<void>;
    readAsset: (id: number, maximum: number) => Promise<Buffer>;
    beforeDraftWrite: () => Promise<void>;
    retainAssembly?: (assembly: ApplicationDraftAssembly) => Promise<unknown>;
  },
) {
  const inspected = inspectApplicationPublicationFiles(expected, files);
  const remote = applicationPublicationReader(transport.api, expected, 180000);
  const compare = (assets: ApplicationAsset[]) => {
    for (const asset of assets) {
      const wanted = inspected.identities.find((file) => file.name === asset.name);
      assert.ok(wanted);
      assert.equal(asset.bytes, wanted.bytes);
      assert.equal(asset.sha256, wanted.sha256);
    }
  };
  let initial = remote.release();
  let assets = remote.assets();
  compare(assets);
  remote.inspectTag(initial.draft === true);
  const commit = inspectRemoteCommitObject(
    remote.get(`git/commits/${remote.preparation.prepared_commit}`).body,
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
      const retained = remote.release();
      assert.deepEqual(
        applicationReleaseNotesPreimage(retained),
        applicationReleaseNotesPreimage(initial),
      );
      assert.deepEqual(remote.assets(), assets);
      initial = retained;
    }
    for (const [name, bytes] of files)
      if (!assets.some((asset) => asset.name === name)) {
        const fresh = remote.release();
        assert.equal(fresh.draft, true);
        assert.equal(fresh.body, initial.body);
        assets = remote.assets();
        compare(assets);
        if (!assets.some((asset) => asset.name === name)) {
          await transport.beforeDraftWrite();
          remote.within();
          try {
            await transport.upload(expected.release_id, name, bytes);
          } catch {
            /* Exact provider readback decides; no second upload. */
          }
          assets = remote.assets();
          compare(assets);
          assert.ok(
            assets.some((asset) => asset.name === name),
            "draft asset outcome unknown; retain without retry",
          );
        }
      }
  }
  assets = remote.assets();
  compare(assets);
  assert.equal(assets.length, files.size);
  for (const asset of assets) {
    const bytes = await transport.readAsset(asset.id, asset.bytes);
    remote.within();
    assert.equal(bytes.length, asset.bytes);
    assert.equal(sha256(bytes), asset.sha256);
  }
  assert.deepEqual(remote.assets(), assets, "draft asset IDs changed during physical readback");
  const settled = remote.release();
  assert.equal(settled.body, initial.body);
  if (!remote.inspectTag(settled.draft === true)) {
    await transport.beforeDraftWrite();
    remote.within();
    try {
      remote.request("POST", "git/refs", {
        ref: `refs/tags/${remote.tag}`,
        sha: remote.preparation.prepared_commit,
      });
    } catch {
      /* Lost acknowledgement is resolved by one exact GET, never another POST. */
    }
    remote.inspectTag(false);
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

/** The caller authenticates preparation first, then supplies current publication
 * eligibility/fresh protection. GitHub permits name/label/state asset updates,
 * not byte replacement: exact IDs+size+digest preserve the attested byte objects.
 * Public byte downloads are mandatory again before feed advancement. */
export async function publishPreparedApplicationRelease(
  expected: ApplicationPublicationExpected,
  preparation: Buffer,
  transport: {
    api: PublicationApi;
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
  const remote = applicationPublicationReader(transport.api, expected, 120000);
  let current = remote.release();
  assert.deepEqual(remote.assets(), receipt.assets);
  remote.inspectTag(false);
  if (current.draft === true) {
    const assertWindow = await transport.beforeWrite();
    const fresh = remote.release();
    assert.equal(fresh.draft, true);
    assert.equal(fresh.body, current.body);
    assert.deepEqual(remote.assets(), receipt.assets);
    remote.inspectTag(false);
    remote.within();
    assertWindow();
    try {
      remote.request("PATCH", `releases/${expected.release_id}`, {
        tag_name: receipt.tag,
        draft: false,
        prerelease: true,
        make_latest: "false",
        name: `Portcove ${receipt.preparation.version}`,
      });
    } catch {
      /* One mutation only; exact immutable readback decides. */
    }
    current = remote.release();
  }
  assert.equal(
    current.draft,
    false,
    "immutable publication outcome unknown; reconcile without retry",
  );
  assert.deepEqual(remote.assets(), receipt.assets);
  remote.inspectTag(false);
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
    api: PublicationApi;
    authenticateRelease: (
      expected: Parameters<typeof inspectApplicationReleaseAttestation>[1],
    ) => Promise<void>;
    readAsset: (id: number, maximum: number) => Promise<Buffer>;
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
  const response = transport.api.request("GET", `repos/boburning/portcove/releases/tags/${tag}`);
  assert.equal(response.status, 200);
  const raw = response.body;
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
  const remote = applicationPublicationReader(transport.api, expected, 120000);
  const before = remote.release();
  assert.equal(before.draft, false);
  remote.inspectTag(false);
  const inventory = remote.assets();
  assert.equal(
    inventory.length,
    remote.names.length,
    "immutable product asset inventory is incomplete",
  );
  const selected = select(inventory);
  await transport.authenticateRelease({
    release_id: expected.release_id,
    tag: remote.tag,
    prepared_commit: remote.preparation.prepared_commit,
    assets: inventory,
  });
  remote.within();
  const files = new Map<string, Buffer>();
  for (const asset of selected) {
    const bytes = await transport.readAsset(asset.id, asset.bytes);
    remote.within();
    assert.equal(bytes.length, asset.bytes);
    assert.equal(sha256(bytes), asset.sha256, "immutable Windows candidate bytes differ");
    files.set(asset.name, bytes);
  }
  assert.deepEqual(remote.release(), before);
  assert.deepEqual(remote.assets(), inventory);
  remote.inspectTag(false);
  return files;
}

/** Permanent immutable availability input. No temporary transfer or private
 * preparation proof is needed. The caller authenticates upstream release
 * inclusion before byte reads, then expected assembly provenance and payload
 * authority before any feed advancement. No provider mutation is available. */
export async function readImmutableApplicationRelease(
  expected: ApplicationPublicationExpected,
  transport: {
    api: PublicationApi;
    authenticateRelease: (
      expected: Parameters<typeof inspectApplicationReleaseAttestation>[1],
    ) => Promise<void>;
    readAsset: (id: number, maximum: number) => Promise<Buffer>;
    authenticateContents: (
      files: ReadonlyMap<string, Buffer>,
      inspected: ReturnType<typeof inspectApplicationPublicationFiles>,
    ) => Promise<void>;
  },
) {
  const remote = applicationPublicationReader(transport.api, expected, 120000);
  const before = remote.release();
  assert.equal(before.draft, false, "feed requires published immutable assets");
  assert.equal(before.immutable, true);
  const assets = remote.assets();
  assert.deepEqual(
    assets.map((asset) => asset.name),
    remote.names,
  );
  assert.ok(assets.reduce((total, asset) => total + asset.bytes, 0) <= 2 * 1024 ** 3);
  remote.inspectTag(false);
  await transport.authenticateRelease({
    release_id: expected.release_id,
    tag: remote.tag,
    prepared_commit: remote.preparation.prepared_commit,
    assets,
  });
  remote.within();
  const files = new Map<string, Buffer>();
  for (const asset of assets) {
    remote.within();
    const bytes = await transport.readAsset(asset.id, asset.bytes);
    remote.within();
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.length, asset.bytes);
    assert.equal(sha256(bytes), asset.sha256, `immutable asset bytes differ: ${asset.name}`);
    files.set(asset.name, bytes);
  }
  const inspected = inspectApplicationPublicationFiles(expected, files);
  await transport.authenticateContents(files, inspected);
  remote.within();
  assert.deepEqual(remote.release(), before, "immutable release changed during byte verification");
  assert.deepEqual(remote.assets(), assets);
  remote.inspectTag(false);
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
export function readApplicationDraftRecoveryState(
  api: PublicationApi,
  expected: ApplicationPublicationExpected,
) {
  const custody = inspectApplicationRunCustody(expected.custody);
  const ordinary = custody.preparation !== null;
  const candidate = `portcove-production-candidate-${custody.opportunity}`;
  const remote = ordinary ? applicationPublicationReader(api, expected, 120000) : undefined;
  const endpoint = `repos/boburning/portcove/releases/${expected.release_id}`;
  assert.ok(Number.isSafeInteger(expected.release_id) && expected.release_id > 0);
  const release =
    remote?.release() ??
    (() => {
      const response = api.request("GET", endpoint);
      assert.equal(response.status, 200);
      assert.ok(isRecord(response.body));
      const value = response.body;
      assert.equal(value.id, expected.release_id);
      assert.equal(value.tag_name, candidate);
      assert.equal(value.target_commitish, custody.source);
      assert.equal(value.prerelease, true);
      assertApplicationCustodyMetadataExtension(
        custody,
        readApplicationRunNotes(value.body)?.custody,
      );
      return value;
    })();
  assert.ok(typeof release.body === "string" && typeof release.tag_name === "string");
  if (release.draft === false) {
    assert.equal(release.immutable, true);
    return undefined;
  }
  assert.equal(release.draft, true);
  assert.equal(release.immutable, false);
  const assets =
    remote?.assets() ??
    inspectApplicationDraftInventory(
      api.request("GET", `${endpoint}/assets?per_page=100&page=1`),
      bootstrapAssetNames,
    );
  const direct = remote
    ? remote.inspectTag(true)
    : (() => {
        let response;
        try {
          response = api.request("GET", `repos/boburning/portcove/git/ref/tags/${candidate}`);
        } catch (error) {
          if (error instanceof GitHubApiError && error.status === 404) return false;
          throw error;
        }
        if (response.status === 404) return false;
        assert.equal(response.status, 200);
        assert.ok(isRecord(response.body) && response.body.ref === `refs/tags/${candidate}`);
        assert.ok(isRecord(response.body.object));
        assert.equal(response.body.object.type, "commit");
        assert.equal(response.body.object.sha, custody.source);
        return true;
      })();
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
    api: PublicationApi;
    inspectDraft: () => {
      release_id: number;
      draft: boolean;
      immutable: boolean;
      tag: string;
      source: string;
      notes: string;
      assets: ApplicationAsset[];
    };
    claim: (
      assetId: number,
      beforeWrite: () => Promise<void>,
    ) => Promise<{ release_id: number; notes: string } | undefined>;
    beforeWrite: () => Promise<() => void>;
  },
) {
  assert.equal(old.release_id, recovery.release_id);
  assert.equal(replacement.release_id, recovery.release_id);
  assert.equal(old.context_sha256, recovery.old_context_sha256);
  assert.equal(replacement.context_sha256, recovery.replacement_context_sha256);
  const readDraft = () => {
    const { assets: inventory, ...release } = transport.inspectDraft();
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
  let settled = readDraft();
  for (const target of recovery.assets) {
    if (!settled.assets.some((asset) => asset.id === target.id)) continue;
    const before = settled;
    const claimed = await transport.claim(target.id, async () => {
      const window = await transport.beforeWrite();
      assert.deepEqual(readDraft(), before, "draft changed before removal claim");
      window();
      assertFresh();
    });
    assert.ok(claimed, "old asset removal already claimed and ID is still present");
    const afterClaim = readDraft();
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
    assert.deepEqual(readDraft(), afterClaim, "draft changed after removal claim");
    window();
    assertFresh();
    try {
      const response = transport.api.request(
        "DELETE",
        `repos/boburning/portcove/releases/assets/${target.id}`,
      );
      assert.equal(response.status, 204);
    } catch {
      // An ambiguous outcome is decided by fresh inventory, never a repeated DELETE.
    }
    settled = readDraft();
    assert.deepEqual(settled.release, afterClaim.release);
    assert.deepEqual(
      settled.assets,
      before.assets.filter((asset) => asset.id !== target.id),
      "old asset removal outcome unknown or another draft asset changed",
    );
  }
  assert.deepEqual(readDraft(), settled);
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
export type BootstrapPublicationTransport = {
  api: Pick<CoordinatorRemoteApi, "request">;
  upload: (releaseId: number, name: AssetName, bytes: Buffer) => Promise<void>;
  readAsset: (assetId: number, maximumBytes: number) => Promise<Buffer>;
  beforeWrite: () => Promise<() => void>;
  retainAssembly?: (assembly: ApplicationDraftAssembly) => Promise<unknown>;
};

/** Caller owns native Actions concurrency. No creation/deletion/clobber or
 * blind mutation retry. A lost acknowledgment is resolved by exact readback. */
export async function publishApplicationMetadataRelease(
  transport: BootstrapPublicationTransport,
  expected: {
    release_id: number;
    custody: ApplicationRunCustody;
    binding: ApplicationMetadataPublicationBinding;
  },
  metadata: Buffer,
  archive: Buffer,
) {
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
  const get = (endpoint: string) => {
    budget();
    const result = transport.api.request("GET", endpoint);
    assert.equal(result.status, 200);
    return result.body;
  };
  const release = () => {
    const raw = get(root);
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
  const assets = () => {
    // Two fixed assets; a full page is never treated as complete coverage.
    const raw = get(`${root}/assets?per_page=100&page=1`);
    assert.ok(Array.isArray(raw) && raw.length <= 2);
    const seen = new Set<string>();
    return raw.map((value: unknown): Asset => {
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
  };
  const verifyBytes = async () => {
    const actual = assets();
    assert.equal(actual.length, files.size);
    for (const asset of actual) {
      budget();
      const bytes = await transport.readAsset(asset.id, asset.size);
      assert.equal(bytes.length, asset.size);
      assert.equal(sha256(bytes), asset.digest.slice(7));
    }
    return actual;
  };
  let current = release();
  let actual = assets();
  const inspectTag = (allowPending: boolean) => {
    budget();
    let result;
    try {
      result = transport.api.request("GET", `repos/boburning/portcove/git/ref/tags/${tag}`);
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
  inspectTag(current.draft === true);
  if (current.draft === true) {
    if (transport.retainAssembly && "purpose" in expected.binding) {
      assert.ok(isRecord(metadataReceipt));
      await transport.retainAssembly(
        applicationDraftAssembly(expected.release_id, metadataReceipt, receipt.publication, files),
      );
      const retained = release();
      assert.deepEqual(
        applicationReleaseNotesPreimage(retained),
        applicationReleaseNotesPreimage(current),
      );
      assert.deepEqual(assets(), actual);
      current = retained;
    }
    for (const [name, bytes] of files)
      if (!actual.some((asset) => asset.name === name)) {
        const assertWindow = await transport.beforeWrite();
        const fresh = release();
        assert.equal(fresh.draft, true);
        assert.equal(fresh.body, current.body, "draft notes changed before upload");
        actual = assets();
        if (!actual.some((asset) => asset.name === name)) {
          budget();
          assertWindow();
          try {
            await transport.upload(expected.release_id, name, bytes);
          } catch {
            /* Exact readback decides. */
          }
          actual = assets();
          assert.ok(
            actual.some((asset) => asset.name === name),
            "upload outcome unknown; hold without retry",
          );
        }
      }
    await verifyBytes();
    const assertWindow = await transport.beforeWrite();
    const fresh = release();
    assert.equal(fresh.draft, true);
    assert.equal(fresh.body, current.body, "draft notes changed before publication");
    // Revalidate all object identities after the fresh guard and immediately
    // before the sole irreversible mutation. Remote asset bytes were read above.
    assert.deepEqual(assets(), actual);
    inspectTag(true);
    budget();
    // Uploads, byte reads and the fresh guard may consume the metadata's
    // remaining lifetime. This final local barrier follows all provider reads.
    inspectApplicationMetadataPublicationReceipt(metadataReceipt, expected.binding, custody);
    assertWindow();
    try {
      transport.api.request("PATCH", root, {
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
    current = release();
  }
  assert.equal(current.draft, false, "publication outcome unknown; hold without retry");
  assert.equal(current.immutable, true);
  const ref = get(`repos/boburning/portcove/git/ref/tags/${tag}`);
  assert.ok(
    isRecord(ref) &&
      ref.ref === `refs/tags/${tag}` &&
      isRecord(ref.object) &&
      ref.object.type === "commit" &&
      ref.object.sha === custody.source,
    "published tag source differs",
  );
  actual = await verifyBytes();
  const settled = release();
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
