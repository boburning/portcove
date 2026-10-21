/** Same-process release record preparation. This is neither publication admission
 * nor a constructor for imported qualification reports. */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { requirePreparedPayloadSignatures } from "./release-payload-preparation.mts";
import {
  inspectPreparedMetadataRenewal,
  prepareAuthenticatedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import type { PreparedMetadataRenewal } from "./release-metadata-renewal.mts";
import { readVerifiedReleasePublicBuildInputFiles } from "./release-public-build-provenance.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { reconstructApplicationUpdateRecords } from "./reconstruct-application-update-records.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { artifactName, packagesForPlatform } from "./release-package-policy.mts";
import { updaterIdentity } from "./updater-artifact-inventory.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";
import { applyReviewedPreviewWithdrawals } from "./release-preview-withdrawals.mts";
import { validateOpportunity } from "./release-coordinator.mts";
import {
  requirePublishedCompleteSite,
  materializePublishedCompleteSite,
} from "./release-site-readback.mts";
import { requireControllerPublicationAuthorities } from "./release-authority-configuration.mts";
import { readRemoteCoordinatorSnapshot } from "./release-coordinator-recovery.mts";
import {
  inspectPublishedMetadata,
  assertMetadataRenewalBinding,
} from "./release-metadata-contract.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Files = Map<string, Buffer>;
const roles = ["targets", "releases", "preview", "stable", "snapshot", "timestamp"] as const;
const identities = (files: Files) =>
  [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));

export async function readBoundedReleaseContextFiles(directory: string) {
  const output: Files = new Map();
  let count = 0,
    total = 0;
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
    throw new Error("release context root changed");
  const walk = async (prefix: string, depth: number): Promise<void> => {
    if (depth > 18) throw new Error("release context depth exceeds bound");
    for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
      if (++count > 8192 || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(entry.name))
        throw new Error("release context path or count differs");
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = await assertOwnedUnlinkedPath(
        directory,
        path.join(directory, name),
        "retained release context",
      );
      if (entry.isDirectory()) await walk(name, depth + 1);
      else {
        if (!entry.isFile() || (await lstat(file)).nlink !== 1)
          throw new Error("release context file is linked or not regular");
        const bytes = await readControllerToolFile(file, 1024 * 1024);
        total += bytes.length;
        if (total > 128 * 1024 * 1024 || output.size >= 2208)
          throw new Error("release context bytes/count exceed bound");
        output.set(name, bytes);
      }
    }
  };
  await walk("", 0);
  return output;
}

/** Data-only merge used by the actual factory below. Historical immutable target
 * collisions refuse, including a re-issued record with different evidence. */
export function mergeReleaseRecordBytes(
  prior: ReadonlyMap<string, Buffer>,
  added: ReadonlyMap<string, Buffer>,
) {
  const result: Files = new Map();
  let total = 0;
  for (const files of [prior, added])
    for (const [name, input] of files) {
      if (
        !/^(?:releases|channels)\/[A-Za-z0-9._+/-]+\.json$/u.test(name) ||
        name.split("/").some((part) => part === "." || part === ".." || !part) ||
        input.length < 1 ||
        input.length > 1024 * 1024
      )
        throw new Error("bounded release record path or bytes differ");
      const bytes = Buffer.from(input),
        existing = result.get(name);
      if (existing && !existing.equals(bytes))
        throw new Error("immutable historical release record collision");
      if (!existing) {
        total += bytes.length;
        result.set(name, bytes);
      }
      if (result.size > 1100 || total > 64 * 1024 * 1024)
        throw new Error("release record inventory exceeds bound");
    }
  return result;
}

/** Preserve Rust's exact positive-u64 versions without a Number conversion. */
export function releaseSigningContextBytes(
  descriptor: Awaited<ReturnType<typeof inspectPreparedMetadataRenewal>>["descriptor"],
) {
  const versions = Object.fromEntries(
    roles.map((role) => {
      const version = descriptor.next_versions[role];
      if (!/^[1-9][0-9]{0,19}$/u.test(version) || BigInt(version) > 18446744073709551615n)
        throw new Error("release context version is not positive u64");
      return [role, version];
    }),
  );
  const base = JSON.stringify({
    schema_version: 1,
    generated_at: descriptor.generated_at,
    trusted_root: "trusted-root.json",
    offline_targets: "offline-targets.json",
    payload_key_registry: "payload.json",
    reconstructed_records: "records",
    previous_repository: "prior",
    expires: descriptor.next_expires,
  });
  const exactVersions = `{${roles.map((role) => `${JSON.stringify(role)}:${versions[role]}`).join(",")}}`;
  return Buffer.from(`${base.slice(0, -1)},"versions":${exactVersions}}\n`);
}

export function releaseRecordManifestBytes(
  manifests: readonly unknown[],
  files: ReadonlyMap<string, Buffer>,
) {
  const records = new Map<string, Record<string, unknown>>();
  for (const raw of manifests) {
    if (!isRecord(raw) || raw.schema_version !== 1 || !Array.isArray(raw.records))
      throw new Error("record manifest shape differs");
    for (const item of raw.records as unknown[]) {
      if (!isRecord(item) || typeof item.path !== "string")
        throw new Error("record manifest identity differs");
      const bytes = files.get(item.path);
      if (!bytes || item.bytes !== bytes.length || item.sha256 !== hash(bytes))
        throw new Error("record manifest byte identity differs");
      const existing = records.get(item.path);
      if (existing && digest(existing) !== digest(item))
        throw new Error("record manifest collision");
      records.set(item.path, structuredClone(item));
    }
  }
  if (records.size !== files.size) throw new Error("record manifest is incomplete");
  return Buffer.from(
    `${JSON.stringify({ schema_version: 1, records: [...records.values()].sort((a, b) => String(a.path).localeCompare(String(b.path))) }, null, 2)}\n`,
  );
}

type BoundContext = {
  payload: object;
  prior: PreparedMetadataRenewal;
  previous_site?: object;
  directory: string;
  files: { path: string; bytes: number; sha256: string }[];
  binding: {
    version: string;
    source_commit: string;
    source_tree: string;
    run_id: string;
    run_attempt: number;
    aggregate_sha256: string;
    signatures_sha256: string;
    records_sha256: string;
    native_checks: { id: number; report_sha256: string }[];
    sbom_sha256: string;
    pending_obligations: readonly string[];
  };
};
const contexts = new WeakMap<object, BoundContext>();

/** Connected fixed payload caller: the current durable published seed supplies
 * site pins, complete-site custody supplies the actual prior tree, and the
 * authenticated Rust tool supplies Tough facts before any new record factory.
 * No caller path, imported descriptor or historical timestamp selects a prior. */
export async function prepareControllerReleaseSigningContext(
  payloadReceipt: object,
  outputParent: string,
  deadline: number,
) {
  const withinBudget = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("release context phase deadline exhausted");
  };
  withinBudget();
  const payload = await requirePreparedPayloadSignatures(payloadReceipt);
  const authorities = await requireControllerPublicationAuthorities("payload");
  if (
    !isRecord(payload.context.facts.configuration) ||
    payload.context.facts.configuration.namespace !== authorities.namespace
  )
    throw new Error("release context namespace differs from actual admission");
  const snapshot = () =>
    readRemoteCoordinatorSnapshot(
      outputParent,
      { schema_version: 1, namespace: authorities.namespace },
      { transport: { cwd: outputParent, deadline } },
    );
  const before = await snapshot();
  if (before.checkpoint !== payload.settlement.checkpoint)
    throw new Error("release context requires current settled payload checkpoint");
  const published = inspectPublishedMetadata(before.input.published_metadata);
  if (!published)
    throw new Error("release context requires actual published metadata; bootstrap is separate");
  if (typeof published.repository_sha256 !== "string")
    throw new Error("published repository identity absent");
  const publicPins = authorities.publication.public_source;
  if (
    published.root_sha256 !== publicPins.root.sha256 ||
    published.offline_targets_sha256 !== publicPins.offline_targets.sha256
  )
    throw new Error("published seed differs from ratified public Root/Targets");
  withinBudget();
  const site = await materializePublishedCompleteSite(
    {
      site_generation_sha256: published.publication.site_generation_sha256,
      root_sha256: published.root_sha256,
      repository_sha256: published.repository_sha256,
    },
    outputParent,
    deadline,
  );
  const currentSite = await requirePublishedCompleteSite(site.receipt);
  const generatedAt = new Date()
    .toISOString()
    .replace(/\.000Z$/u, "Z")
    .replace(/(\.\d*?[1-9])0+Z$/u, "$1Z");
  const prior = await prepareAuthenticatedMetadataRenewal({
    verifier: payload.tools.rust,
    verifier_sha256: hash(await readControllerToolFile(payload.tools.rust)),
    trusted_root: currentSite.root_path,
    trusted_root_sha256: published.root_sha256,
    previous_repository: currentSite.application,
    prior_repository_sha256: published.repository_sha256,
    generated_at: generatedAt,
    output_parent: outputParent,
    deadline,
  });
  const actualPrior = await inspectPreparedMetadataRenewal(prior);
  assertMetadataRenewalBinding(actualPrior.descriptor, published, generatedAt);
  for (const [name, pin] of [
    ["trusted-root.json", publicPins.root],
    ["offline-targets.json", publicPins.offline_targets],
    ["payload.json", publicPins.payload_key_registry],
  ] as const) {
    const bytes = await readControllerToolFile(
      path.join(actualPrior.prepared_root, name),
      1024 * 1024,
    );
    if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256)
      throw new Error("authenticated prior public signing data differs from setup");
  }
  withinBudget();
  const context = await prepareReleaseSigningContext(
    payloadReceipt,
    prior,
    outputParent,
    site.receipt,
  );
  const after = await snapshot();
  if (
    before.checkpoint !== after.checkpoint ||
    digest(before.input.published_metadata) !== digest(after.input.published_metadata)
  )
    throw new Error("published baseline changed during release context preparation");
  await requirePreparedPayloadSignatures(payloadReceipt);
  withinBudget();
  return context;
}

export async function prepareReleaseSigningContext(
  payloadReceipt: object,
  priorReceipt: PreparedMetadataRenewal,
  outputParent: string,
  previousSite?: object,
) {
  // Both getters check actual private provenance before any output effect.
  const payload = await requirePreparedPayloadSignatures(payloadReceipt);
  const prior = await inspectPreparedMetadataRenewal(priorReceipt);
  const site =
    previousSite === undefined ? undefined : await requirePublishedCompleteSite(previousSite);
  if (
    site &&
    (site.pins.root_sha256 !== prior.descriptor.root_sha256 ||
      site.pins.repository_sha256 !== prior.descriptor.prior_repository_sha256)
  )
    throw new Error("complete published site and authenticated Tough prior differ");
  const publicInputs = await readVerifiedReleasePublicBuildInputFiles(
    payload.context.public_build_inputs_receipt,
  );
  const { accepted, policy } = await inspectTrustedAssemblyInput(payload.context.facts.assembly);
  if (
    accepted.release_profile !== "initial-beta-win-linux" ||
    prior.verifier_sha256 !== hash(await readControllerToolFile(payload.tools.rust))
  )
    throw new Error("release context requires selected actual tools and package profile");
  const source: Files = new Map();
  for (const file of prior.files) {
    const bytes = await readControllerToolFile(
      path.join(prior.prepared_root, file.path),
      file.bytes,
    );
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("prior authenticated context changed");
    source.set(file.path, bytes);
  }
  if (!source.get("trusted-root.json")?.equals(publicInputs.get("root.json")!))
    throw new Error("candidate and authenticated prior root differ");
  const registry = JSON.parse(source.get("payload.json")!.toString("utf8")) as unknown;
  const keySha = payload.signatures[0]!.request.public_key_sha256;
  const publicKeyBytes = await readControllerToolFile(payload.public_key.path, 16384);
  if (!publicKeyBytes.equals(publicInputs.get("updater-public.key")!))
    throw new Error("signed payload key differs from actual build inputs");
  if (
    !isRecord(registry) ||
    registry.schema_version !== 1 ||
    !Array.isArray(registry.keys) ||
    !registry.keys.some(
      (entry: unknown) =>
        isRecord(entry) &&
        entry.id === keySha &&
        entry.tauri_public_key === publicKeyBytes.toString("utf8").trim(),
    )
  )
    throw new Error("actual payload key is absent from authenticated prior registry");
  const qualified = [];
  for (const native of payload.native) {
    const signature = payload.signatures.find(
      (entry) => entry.request.platform_label === native.platform_label,
    );
    if (!signature) throw new Error("actual native platform signature missing");
    const updater = updaterIdentity(policy, native.platform_label, accepted.version);
    const files = packagesForPlatform(policy, native.platform_label).map((entry) => {
      const filename = artifactName(entry, accepted.version),
        actual = accepted.files.find(
          (file) => file.filename === filename && file.platform_label === native.platform_label,
        );
      if (!actual) throw new Error("actual complete record package inventory missing");
      return { id: entry.id, filename, bytes: actual.bytes, sha256: actual.sha256 };
    });
    const actualUpdater = files.find((file) => file.filename === updater.filename);
    if (!actualUpdater) throw new Error("native updater package missing");
    const inventory = {
      schema_version: 1,
      repository: "boburning/portcove",
      version: accepted.version,
      source_commit: accepted.source_commit,
      platform_label: native.platform_label,
      application_identifier: "io.github.portcove.portcove",
      packages: files,
      updater: {
        ...actualUpdater,
        target: updater.target,
        format: updater.format,
        public_key_sha256: keySha,
        signature: signature.signature,
      },
    };
    qualified.push({
      inventoryBytes: Buffer.from(JSON.stringify(inventory)),
      signatureBytes: await readControllerToolFile(signature.path, 16384),
      source_tree: accepted.source_tree,
      qualified_run: {
        workflow: ".github/workflows/release.yml",
        workflow_commit: accepted.source_commit,
        run_id: payload.context.facts.evidence.run.id,
        attempt: accepted.run_attempt,
      },
      execution_context: native.host.execution_context,
      compatibility: native.compatibility,
      evidence_ids: [
        ...native.evidence_ids,
        `aggregate:${payload.aggregate.sha256}`,
        `sbom:${payload.sbom.sha256}`,
      ],
    });
  }
  const reconstructed = await reconstructApplicationUpdateRecords(
    qualified,
    {
      [`v${accepted.version}`]: {
        version: accepted.version,
        preview_eligible: true,
        production_eligible: false,
        targets: payload.native.map((entry) => entry.platform_label),
      },
    },
    { policy },
  );
  const oldRecords: Files = new Map(
    [...source]
      .filter(
        ([name]) => name.startsWith("records/") && name !== "records/reconstruction-manifest.json",
      )
      .map(([name, bytes]) => [name.slice(8), bytes]),
  );
  const withdrawn = applyReviewedPreviewWithdrawals(
    oldRecords,
    JSON.parse(source.get("records/reconstruction-manifest.json")!.toString("utf8")) as unknown,
    validateOpportunity(payload.context.facts.opportunity).classification,
    accepted.version,
  );
  const records = mergeReleaseRecordBytes(
    withdrawn.files,
    new Map([...reconstructed.files].filter(([name]) => name !== "reconstruction-manifest.json")),
  );
  const manifest = releaseRecordManifestBytes(
    [withdrawn.manifest, reconstructed.manifest],
    records,
  );
  for (const name of [...source.keys()]) if (name.startsWith("records/")) source.delete(name);
  for (const [name, bytes] of records) source.set(`records/${name}`, bytes);
  source.set("records/reconstruction-manifest.json", manifest);
  source.set("context.json", releaseSigningContextBytes(prior.descriptor));
  // The unchanged-renewal descriptor is not a description of this new release.
  source.delete("renewal.json");
  const binding = {
    version: accepted.version,
    source_commit: accepted.source_commit,
    source_tree: accepted.source_tree,
    run_id: String(accepted.run_id),
    run_attempt: accepted.run_attempt,
    aggregate_sha256: payload.aggregate.sha256,
    signatures_sha256: digest(
      payload.signatures.map((entry) => ({
        platform: entry.request.platform_label,
        ...entry.signature,
      })),
    ),
    records_sha256: digest(identities(records)),
    native_checks: payload.native.map((entry) => ({
      id: entry.check.id,
      report_sha256: entry.check.report_sha256,
    })),
    sbom_sha256: payload.sbom.sha256,
    pending_obligations: [...payload.pending_obligations],
  };
  await requirePreparedPayloadSignatures(payloadReceipt);
  await inspectPreparedMetadataRenewal(priorReceipt);
  await readVerifiedReleasePublicBuildInputFiles(payload.context.public_build_inputs_receipt);
  const directory = await mkdtemp(
    path.join(path.resolve(outputParent), "release-signing-context-"),
  );
  try {
    for (const [name, bytes] of source) {
      const destination = await assertOwnedUnlinkedPath(
        directory,
        path.join(directory, name),
        "public release signing context",
      );
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    const receipt = Object.freeze({
      kind: "actual-release-signing-context" as const,
      ...binding,
      authority: "none" as const,
    });
    contexts.set(receipt, {
      payload: payloadReceipt,
      prior: priorReceipt,
      ...(previousSite === undefined ? {} : { previous_site: previousSite }),
      directory,
      files: identities(source),
      binding,
    });
    await requireReleaseSigningContext(receipt);
    return receipt;
  } catch (error) {
    throw new Error(`release signing context refused; retain ${directory}`, { cause: error });
  }
}

/** Actual private expected record set for role wrappers/Pages joins. Imported
 * public context files and attestation claims cannot manufacture this receipt. */
export async function requireReleaseSigningContext(receipt: object) {
  const bound = contexts.get(receipt);
  if (!bound) throw new Error("actual same-process release signing context required");
  const payload = await requirePreparedPayloadSignatures(bound.payload);
  await inspectPreparedMetadataRenewal(bound.prior);
  const previousSite =
    bound.previous_site === undefined
      ? undefined
      : await requirePublishedCompleteSite(bound.previous_site);
  await readVerifiedReleasePublicBuildInputFiles(payload.context.public_build_inputs_receipt);
  if (
    digest(identities(await readBoundedReleaseContextFiles(bound.directory))) !==
    digest(bound.files)
  )
    throw new Error("actual release signing context changed");
  return Object.freeze({
    directory: bound.directory,
    context: path.join(bound.directory, "context.json"),
    binding: structuredClone(bound.binding),
    tools: payload.tools,
    controls: payload.context.controls,
    opportunity: structuredClone(payload.context.facts.opportunity),
    checkpoint: payload.context.checkpoint,
    coordinator_repository: payload.context.coordinator_repository,
    facts: structuredClone(payload.context.facts),
    control_facts: structuredClone(payload.context.admission.controls),
    settled_checkpoint: payload.settlement.checkpoint,
    previous_site: previousSite,
    authority: "none" as const,
  });
}

/** Public bytes for the reviewed upload route; no credential state or private
 * receipt is serialized. A receiver must independently authenticate attestation
 * and provider custody before using these files. */
export async function readReleaseSigningContextFiles(receipt: object) {
  await requireReleaseSigningContext(receipt);
  const bound = contexts.get(receipt);
  if (!bound) throw new Error("actual same-process release signing context required");
  const files = await readBoundedReleaseContextFiles(bound.directory);
  if (digest(identities(files)) !== digest(bound.files))
    throw new Error("actual release signing context changed during readback");
  return files;
}
