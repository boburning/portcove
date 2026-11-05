/** Public TUF context transfer. Only the maintained Rust verifier authenticates
 * its contents; this envelope supplies no signing or publication authority. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import {
  readApplicationJson,
  receiveApplicationData,
  writeApplicationJson,
  sha256,
} from "./application-release-io.mts";
import {
  applicationReleaseTrust,
  inspectApplicationReleaseExecution,
  verifyApplicationReleaseTrust,
} from "./application-release-policy.mts";
import { inspectMetadataBootstrapDescriptor } from "./release-metadata-contract.mts";
import {
  readBoundedReleaseContextFiles,
  mergeReleaseRecordBytes,
  releaseRecordManifestBytes,
  releaseSigningContextBytes,
} from "./release-signing-context.mts";
import { inspectPreparedMetadataRenewal } from "./release-metadata-renewal.mts";
import type { PreparedMetadataRenewal } from "./release-metadata-renewal.mts";
import {
  inspectMetadataRenewalDescriptor,
  inspectMetadataRoleVersions,
  metadataInstant,
} from "./release-metadata-contract.mts";
import { createApplicationUpdaterInventory } from "./application-release-artifacts.mts";
import type { inspectApplicationPackageBytes } from "./application-release-artifacts.mts";
import { inspectNativeReleaseQualification } from "./release-native-qualification-contract.mts";
import { reconstructApplicationUpdateRecords } from "./reconstruct-application-update-records.mts";
import { loadPackagePolicy } from "./release-package-policy.mts";
import { applyReviewedPreviewWithdrawals } from "./release-preview-withdrawals.mts";
import { parseVersionClassification } from "../apps/desktop/scripts/release-version-policy.mts";
import { inspectTufContextPaths } from "./release-tuf-signing.mts";
import { payloadSigningEnvironment } from "./release-payload-signing.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import {
  inspectApplicationReleaseReference,
  inspectApplicationRunCustody,
} from "./application-release-run.mts";

export function inspectInitialApplicationDescriptor(
  raw: unknown,
  expected: {
    descriptor_sha256: string;
    setup_plan_sha256: string;
    site_preimage_sha256: string;
  },
  now = Date.now(),
) {
  for (const digest of Object.values(expected)) assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(releaseCanonicalDigest(raw), expected.descriptor_sha256);
  const descriptor = inspectMetadataBootstrapDescriptor(raw);
  assert.equal(descriptor.setup_plan_sha256, expected.setup_plan_sha256);
  assert.equal(descriptor.initial_site_preimage_sha256, expected.site_preimage_sha256);
  assert.equal(descriptor.root_sha256, applicationReleaseTrust.root.sha256);
  assert.equal(descriptor.offline_targets_sha256, applicationReleaseTrust.targets.sha256);
  assert.equal(descriptor.payload_key_registry_sha256, applicationReleaseTrust.payload.sha256);
  assert.ok(Number.isSafeInteger(now) && now >= 0);
  assert.ok(Date.parse(descriptor.generated_at) <= now + 300000);
  for (const value of Object.values(descriptor.expires)) assert.ok(Date.parse(value) > now);
  return descriptor;
}

export function inspectApplicationBootstrapSource(
  raw: unknown,
  expected: {
    descriptor_sha256: string;
    setup_plan_sha256: string;
    site_preimage_sha256: string;
  },
  now = Date.now(),
) {
  assert.ok(isRecord(raw) && raw.purpose === "metadata-bootstrap");
  assert.equal(raw.opportunity, expected.descriptor_sha256);
  assert.deepEqual(raw.bootstrap_appointment, expected);
  return inspectInitialApplicationDescriptor(raw.bootstrap_descriptor, expected, now);
}

/** Stable authority basis, independent of invocation IDs, retries and clocks.
 * Parsing this identity does not authenticate the referenced public repository. */
export function inspectApplicationRenewalSource(raw: unknown) {
  assert.ok(isRecord(raw) && raw.purpose === "metadata-renewal");
  assert.ok(
    raw.execution_path === "metadata-maintenance" || raw.execution_path === "metadata-recovery",
  );
  assert.ok(isRecord(raw.renewal_basis));
  const basis = raw.renewal_basis;
  assert.equal(
    Object.keys(basis).sort().join(","),
    "kind,repository_sha256,root_sha256,schema_version,site_generation",
  );
  assert.equal(basis.schema_version, 1);
  assert.equal(basis.kind, "application-metadata-renewal-basis");
  for (const key of ["repository_sha256", "root_sha256", "site_generation"] as const)
    assert.ok(typeof basis[key] === "string" && /^[a-f0-9]{64}$/u.test(basis[key]));
  assert.equal(basis.root_sha256, applicationReleaseTrust.root.sha256);
  assert.equal(raw.opportunity, releaseCanonicalDigest(basis));
  if (raw.renewal_parent !== undefined) {
    const parent = inspectApplicationReleaseReference(raw.renewal_parent);
    assert.notEqual(parent.opportunity, raw.opportunity);
    assert.ok(
      typeof raw.renewal_public_prior_repository_sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(raw.renewal_public_prior_repository_sha256),
    );
    assert.notEqual(
      raw.renewal_public_prior_repository_sha256,
      basis.repository_sha256,
      "forward renewal requires an unserved authority basis",
    );
  } else assert.equal(raw.renewal_public_prior_repository_sha256, undefined);
  if (raw.renewal_clock === "native-context-reservation-v1")
    assert.equal(raw.renewal_generated_at, undefined);
  else {
    assert.equal(raw.renewal_clock, undefined);
    metadataInstant(raw.renewal_generated_at);
  }
  return basis;
}

/** Bind the actual authenticated context to its fixed source selection before
 * any role can access a key. Rust separately checks signatures and records. */
export function assertApplicationRenewalContext(files: ReadonlyMap<string, Buffer>, raw: unknown) {
  const basis = inspectApplicationRenewalSource(raw);
  assert.ok(isRecord(raw));
  const renewal = files.get("renewal.json");
  assert.ok(renewal && !files.has("initial-bootstrap.json"));
  const descriptor = inspectMetadataRenewalDescriptor(JSON.parse(renewal.toString("utf8")));
  assert.notEqual(descriptor.schema_version, 2, "application contexts retain pinned Targets");
  if (raw.renewal_clock !== "native-context-reservation-v1") {
    assert.equal(descriptor.schema_version, raw.renewal_parent === undefined ? 1 : 3);
  }
  if (raw.renewal_parent !== undefined)
    assert.equal(descriptor.prior_expiration_policy, "historical-online-expired-v1");
  if (raw.renewal_parent !== undefined) {
    assert.ok(isRecord(raw.run_custody));
    const custody = inspectApplicationRunCustody(raw.run_custody.custody);
    assert.equal(custody.budget?.kind, "member");
    assert.equal(custody.opportunity, raw.opportunity);
  }
  assert.equal(descriptor.offline_targets_sha256, applicationReleaseTrust.targets.sha256);
  assert.equal(descriptor.root_sha256, basis.root_sha256);
  assert.equal(descriptor.prior_repository_sha256, basis.repository_sha256);
  assert.equal(applicationContextPriorRepositorySha256(files), basis.repository_sha256);
  if (raw.renewal_clock !== "native-context-reservation-v1")
    assert.equal(descriptor.generated_at, raw.renewal_generated_at);
  const context = files.get("context.json");
  assert.ok(context);
  const exactNumbers = (bytes: Buffer): unknown =>
    JSON.parse(
      bytes.toString("utf8"),
      (_key: string, value: unknown, token?: { source?: string }) => {
        if (typeof value !== "number") return value;
        assert.ok(token?.source && /^[1-9][0-9]*$/u.test(token.source));
        return token.source;
      },
    );
  assert.equal(
    releaseCanonicalDigest(exactNumbers(context)),
    releaseCanonicalDigest(
      exactNumbers(
        releaseSigningContextBytes(descriptor, "single-owner-one-of-one-v1", "offline-pinned-v1"),
      ),
    ),
    "actual signing context differs from the source-bound renewal descriptor",
  );
  return descriptor;
}

export async function prepareApplicationMetadataRenewalContext(
  directory: string,
  receipt: PreparedMetadataRenewal,
  source: unknown,
) {
  const prior = await inspectPreparedMetadataRenewal(receipt);
  assert.equal(prior.initial_root_profile, "single-owner-one-of-one-v1");
  assert.equal(prior.descriptor.root_sha256, applicationReleaseTrust.root.sha256);
  assert.equal(prior.descriptor.offline_targets_sha256, applicationReleaseTrust.targets.sha256);
  const files = await readBoundedReleaseContextFiles(prior.prepared_root);
  assertApplicationRenewalContext(files, source);
  assert.ok(
    files.get("payload.json") &&
      sha256(files.get("payload.json")!) === applicationReleaseTrust.payload.sha256,
  );
  await inspectPreparedMetadataRenewal(receipt);
  await mkdir(directory);
  for (const [name, bytes] of files) {
    assert.ok(allowed(name));
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
}

const allowed = (name: string) =>
  name.length <= 512 &&
  name.split("/").length <= 24 &&
  name
    .split("/")
    .every(
      (part) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(part) && part !== "." && part !== "..",
    ) &&
  ([
    "context.json",
    "trusted-root.json",
    "offline-targets.json",
    "payload.json",
    "initial-bootstrap.json",
    "renewal.json",
    "prior/repository-manifest.json",
  ].includes(name) ||
    /^(?:records\/|prior\/(?:metadata|targets)\/)/u.test(name));

/** Data identity only. Assembly compares these exact context prior bytes with
 * independently authenticated current public metadata before composing a site. */
export function applicationContextPriorRepositorySha256(files: ReadonlyMap<string, Buffer>) {
  const prior = [...files].filter(
    ([name]) => name.startsWith("prior/") && name !== "prior/repository-manifest.json",
  );
  assert.ok(prior.length > 0 && prior.every(([name]) => allowed(name)));
  return releaseCanonicalDigest(
    prior
      .map(([name, bytes]) => ({
        path: name.slice("prior/".length),
        bytes: bytes.length,
        sha256: sha256(bytes),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}

export async function packApplicationContext(directory: string, destination: string) {
  const current = inspectApplicationReleaseExecution(process.env);
  const publicFiles = await readBoundedReleaseContextFiles(directory);
  const files = [...publicFiles].map(([name, bytes]) => ({
    path: name,
    bytes: bytes.length,
    sha256: sha256(bytes),
    base64: bytes.toString("base64"),
  }));
  await writeApplicationJson(destination, {
    schema_version: 1,
    source: current.source,
    run_id: current.run_id,
    producer_attempt: current.run_attempt,
    authority: "none",
    files,
  });
}

export async function unpackApplicationContext(
  raw: unknown,
  directory: string,
  expected: { source: string; run_id: string; attempt: number },
) {
  assert.ok(isRecord(raw) && raw.schema_version === 1 && raw.authority === "none");
  assert.equal(raw.source, expected.source);
  assert.equal(raw.run_id, expected.run_id);
  assert.equal(raw.producer_attempt, expected.attempt);
  assert.ok(Array.isArray(raw.files) && raw.files.length > 0 && raw.files.length <= 6000);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const value of raw.files) {
    assert.ok(
      isRecord(value) &&
        typeof value.path === "string" &&
        allowed(value.path) &&
        !files.has(value.path),
    );
    assert.ok(
      Number.isSafeInteger(value.bytes) &&
        Number(value.bytes) > 0 &&
        Number(value.bytes) <= 2 * 1024 ** 2,
    );
    assert.ok(
      typeof value.base64 === "string" &&
        value.base64.length <= Math.ceil(Number(value.bytes) / 3) * 4,
    );
    const bytes = Buffer.from(value.base64, "base64");
    assert.equal(bytes.length, value.bytes);
    assert.equal(bytes.toString("base64"), value.base64);
    assert.equal(sha256(bytes), value.sha256);
    total += bytes.length;
    assert.ok(total <= 24 * 1024 ** 2);
    files.set(value.path, bytes);
  }
  assert.ok(
    files.has("context.json") && files.has("trusted-root.json") && files.has("payload.json"),
  );
  assert.equal(sha256(files.get("trusted-root.json")!), applicationReleaseTrust.root.sha256);
  assert.equal(sha256(files.get("payload.json")!), applicationReleaseTrust.payload.sha256);
  inspectTufContextPaths(files.get("context.json")!);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  for (const [name, bytes] of files) {
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  return files;
}

export async function receiveApplicationContext() {
  const current = inspectApplicationReleaseExecution(process.env);
  const attempt = Number(process.env.PORTCOVE_CONTEXT_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current.run_attempt);
  const transfer = path.resolve("work/application-context-transfer");
  await receiveApplicationData(transfer, {
    id: Number(process.env.PORTCOVE_CONTEXT_ARTIFACT),
    name: `application-context-${current.run_id}-${attempt}`,
    run_id: current.run_id,
    source: current.source,
    files: ["context-bundle.json"],
    maximum_file_bytes: 32 * 1024 ** 2,
    maximum_archive_bytes: 32 * 1024 ** 2,
  });
  const directory = path.resolve("work/application-context");
  await unpackApplicationContext(
    await readApplicationJson(path.join(transfer, "context-bundle.json"), 32 * 1024 ** 2),
    directory,
    { source: current.source, run_id: current.run_id, attempt },
  );
  return directory;
}

export function inspectApplicationContextBeforeKey(
  directory: string,
  tool: string,
  scratch: string,
) {
  const bytes = execFileSync(tool, ["inspect-tuf-context", path.join(directory, "context.json")], {
    env: payloadSigningEnvironment(scratch),
    timeout: 90000,
    maxBuffer: 65536,
    stdio: "pipe",
  });
  const result: unknown = JSON.parse(bytes.toString("utf8"));
  assert.ok(isRecord(result) && result.schema_version === 1 && result.authority === "none");
  assert.equal(result.root_sha256, applicationReleaseTrust.root.sha256);
  assert.equal(result.payload_key_registry_sha256, applicationReleaseTrust.payload.sha256);
  return result;
}

export async function prepareInitialApplicationContext(
  directory: string,
  raw: unknown,
  expected: { descriptor_sha256: string; setup_plan_sha256: string; site_preimage_sha256: string },
) {
  await verifyApplicationReleaseTrust();
  const descriptor = inspectInitialApplicationDescriptor(raw, expected);
  await mkdir(directory);
  for (const [from, to] of [
    [applicationReleaseTrust.root.path, "trusted-root.json"],
    [applicationReleaseTrust.targets.path, "offline-targets.json"],
    [applicationReleaseTrust.payload.path, "payload.json"],
  ])
    await copyFile(from!, path.join(directory, to!));
  await writeApplicationJson(path.join(directory, "initial-bootstrap.json"), raw);
  await writeApplicationJson(path.join(directory, "records/reconstruction-manifest.json"), {
    schema_version: 1,
    records: [],
  });
  const versions: Record<string, number> = {};
  for (const [role, version] of Object.entries(descriptor.versions)) {
    assert.equal(version, "1");
    versions[role] = 1;
  }
  await writeApplicationJson(path.join(directory, "context.json"), {
    schema_version: 1,
    initial_root_profile: "single-owner-one-of-one-v1",
    top_level_targets_profile: "offline-pinned-v1",
    generated_at: descriptor.generated_at,
    trusted_root: "trusted-root.json",
    offline_targets: "offline-targets.json",
    payload_key_registry: "payload.json",
    reconstructed_records: "records",
    initial_bootstrap: "initial-bootstrap.json",
    versions,
    expires: descriptor.expires,
  });
}

export type ApplicationRecordContextInput = {
  manifest: Awaited<ReturnType<typeof inspectApplicationPackageBytes>>;
  unsigned_artifact: number;
  native_report: unknown;
  inventory: Buffer;
  signature: Buffer;
  /** Full reviewed classifier, including independently reviewed withdrawals. */
  classification: unknown;
  qualification: {
    workflow: string;
    workflow_commit: string;
    run_id: number;
    attempt: number;
  };
  evidence_ids: string[];
};

async function reconstructApplicationContextInput(
  payload: Buffer,
  input: ApplicationRecordContextInput,
) {
  assert.equal(sha256(payload), applicationReleaseTrust.payload.sha256);
  const registry: unknown = JSON.parse(payload.toString("utf8"));
  assert.ok(
    isRecord(registry) &&
      Array.isArray(registry.keys) &&
      registry.keys.length === 1 &&
      isRecord(registry.keys[0]) &&
      typeof registry.keys[0].id === "string",
  );
  const native = inspectNativeReleaseQualification(input.native_report);
  const policy = await loadPackagePolicy();
  const inventory = createApplicationUpdaterInventory(
    input.manifest,
    native,
    input.unsigned_artifact,
    input.signature,
    registry.keys[0].id,
    policy,
  );
  assert.deepEqual(
    JSON.parse(input.inventory.toString("utf8")),
    inventory,
    "signed inventory differs from actual package/native/signature inputs",
  );
  const classification = parseVersionClassification(input.classification);
  assert.equal(input.qualification.workflow_commit, classification.source_commit);
  assert.ok(
    [".github/workflows/release.yml", ".github/workflows/qualification.yml"].includes(
      input.qualification.workflow,
    ),
  );
  const reconstructed = await reconstructApplicationUpdateRecords(
    [
      {
        inventoryBytes: input.inventory,
        signatureBytes: input.signature,
        source_tree: input.manifest.source_tree,
        qualified_run: input.qualification,
        execution_context: native.host.execution_context,
        compatibility: native.compatibility,
        evidence_ids: input.evidence_ids,
      },
    ],
    {
      [`v${input.manifest.version}`]: {
        version: input.manifest.version,
        preview_eligible: true,
        production_eligible: false,
        targets: ["windows-x86_64"],
      },
    },
    { policy },
  );
  return reconstructed;
}

/** Reconstruct current release rows from independently verified physical inputs.
 * This byte join grants no authority and leaves historical/withdrawal validation
 * with the original factory and pinned Rust prior/context inspection. */
export async function assertApplicationContextCurrentRecords(
  files: ReadonlyMap<string, Buffer>,
  input: ApplicationRecordContextInput,
) {
  const payload = files.get("payload.json");
  assert.ok(payload);
  const reconstructed = await reconstructApplicationContextInput(payload, input);
  for (const [name, bytes] of reconstructed.files) {
    if (name === "reconstruction-manifest.json") continue;
    assert.ok(
      files.get(`records/${name}`)?.equals(bytes),
      "signing context current release differs from actual package/native/signature inputs",
    );
  }
}

/** Data-only join shared by the actual factory below and focused contract tests.
 * A matching descriptor or map is not an authenticated prior or key authority. */
export async function composeApplicationRecordContext(
  priorFiles: ReadonlyMap<string, Buffer>,
  rawDescriptor: unknown,
  input: ApplicationRecordContextInput,
) {
  const descriptor = inspectMetadataRenewalDescriptor(rawDescriptor);
  assert.equal(
    descriptor.prior_expiration_policy,
    undefined,
    "historical renewal cannot add or withdraw application records",
  );
  const required = (name: string) => {
    const bytes = priorFiles.get(name);
    assert.ok(bytes, `prepared prior is missing ${name}`);
    return bytes;
  };
  assert.equal(descriptor.root_sha256, applicationReleaseTrust.root.sha256);
  assert.equal(sha256(required("trusted-root.json")), applicationReleaseTrust.root.sha256);
  assert.equal(sha256(required("payload.json")), applicationReleaseTrust.payload.sha256);
  assert.equal(descriptor.offline_targets_sha256, applicationReleaseTrust.targets.sha256);
  assert.equal(sha256(required("offline-targets.json")), applicationReleaseTrust.targets.sha256);
  assert.equal(
    releaseCanonicalDigest(JSON.parse(required("renewal.json").toString("utf8"))),
    releaseCanonicalDigest(descriptor),
  );
  assert.ok(
    !priorFiles.has("initial-bootstrap.json"),
    "application release cannot use a bootstrap context",
  );
  const reconstructed = await reconstructApplicationContextInput(required("payload.json"), input);
  const oldRecords = new Map(
    [...priorFiles]
      .filter(
        ([name]) => name.startsWith("records/") && name !== "records/reconstruction-manifest.json",
      )
      .map(([name, bytes]) => [name.slice(8), bytes]),
  );
  const identities = [...oldRecords]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) }));
  assert.equal(releaseCanonicalDigest(identities), descriptor.unchanged_records_sha256);
  const withdrawn = applyReviewedPreviewWithdrawals(
    oldRecords,
    JSON.parse(required("records/reconstruction-manifest.json").toString("utf8")),
    input.classification,
    input.manifest.version,
  );
  const records = mergeReleaseRecordBytes(
    withdrawn.files,
    new Map([...reconstructed.files].filter(([name]) => name !== "reconstruction-manifest.json")),
  );
  const files = new Map<string, Buffer>(
    [...priorFiles]
      .filter(([name]) => !name.startsWith("records/"))
      .map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
  for (const [name, bytes] of records) files.set(`records/${name}`, bytes);
  files.set(
    "records/reconstruction-manifest.json",
    releaseRecordManifestBytes([withdrawn.manifest, reconstructed.manifest], records),
  );
  files.set(
    "context.json",
    releaseSigningContextBytes(
      descriptor,
      "single-owner-one-of-one-v1",
      descriptor.schema_version === 2 ? "online-unchanged-authority-v1" : "offline-pinned-v1",
    ),
  );
  // This output adds application records; it cannot claim unchanged renewal.
  files.delete("renewal.json");
  inspectTufContextPaths(files.get("context.json")!);
  return {
    files,
    added_records: reconstructed.manifest.records.length,
    withdrawals: withdrawn.withdrawals.length,
    authority: "none" as const,
  };
}

/** Only the maintained verifier's private prepared-prior getter enters here.
 * Source/package/native/signature provenance is checked by the fixed receiver;
 * the output still requires the existing Rust pre-key context inspection. */
export async function prepareApplicationReleaseContext(
  directory: string,
  priorReceipt: PreparedMetadataRenewal,
  input: ApplicationRecordContextInput,
) {
  const prior = await inspectPreparedMetadataRenewal(priorReceipt);
  assert.equal(prior.initial_root_profile, "single-owner-one-of-one-v1");
  const source = await readBoundedReleaseContextFiles(prior.prepared_root);
  const result = await composeApplicationRecordContext(source, prior.descriptor, input);
  await inspectPreparedMetadataRenewal(priorReceipt);
  assert.ok([...result.files.keys()].every(allowed));
  await mkdir(directory);
  for (const [name, bytes] of result.files) {
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  return {
    directory,
    added_records: result.added_records,
    withdrawals: result.withdrawals,
    authority: "none" as const,
  };
}

/** Full public context identity for the native version reservation. This parser
 * does not authenticate inputs or authorize any role; the fixed Rust verifier
 * and live owner read must bracket its use. */
export function applicationMetadataContextIdentity(files: ReadonlyMap<string, Buffer>) {
  const bytes = files.get("context.json");
  assert.ok(bytes);
  const raw: unknown = JSON.parse(
    bytes.toString("utf8"),
    (_key: string, value: unknown, token?: { source?: string }) => {
      if (typeof value !== "number") return value;
      assert.ok(token?.source && /^[1-9][0-9]*$/u.test(token.source));
      return token.source;
    },
  );
  assert.ok(isRecord(raw) && raw.schema_version === "1" && typeof raw.generated_at === "string");
  metadataInstant(raw.generated_at);
  const versions = inspectMetadataRoleVersions(raw.versions);
  const required = (name: string) => {
    const value = files.get(name);
    assert.ok(value);
    return value;
  };
  const inventory = (values: readonly [string, Buffer][]) =>
    values
      .map(([name, value]) => ({ path: name, bytes: value.length, sha256: sha256(value) }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    generated_at: raw.generated_at,
    versions,
    root_sha256: sha256(required("trusted-root.json")),
    offline_targets_sha256: sha256(required("offline-targets.json")),
    prior_repository_sha256: applicationContextPriorRepositorySha256(files),
    context_sha256: sha256(bytes),
    context_inventory_sha256: releaseCanonicalDigest(inventory([...files])),
    records_sha256: releaseCanonicalDigest(
      inventory(
        [...files]
          .filter(
            ([name]) =>
              name.startsWith("records/") && name !== "records/reconstruction-manifest.json",
          )
          .map(([name, value]): [string, Buffer] => [name.slice(8), value]),
      ),
    ),
  };
}
