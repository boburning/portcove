/** Keyless reader gate for a signed, locally assembled definition repository. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { readApprovedCoverJournal } from "./catalog-cover-approval.mts";
import { requireExactReleasedCoverInspection } from "./listing-observation-delivery.mts";
import { publishedTargets } from "./catalog-publish.mts";
import {
  acquireCatalogReleasedReader,
  requireCurrentCatalogReaderSelection,
  requireServedCatalogReaderSelection,
} from "./catalog-released-reader.mts";
import { artworkCheckpointTarget } from "./listing-artwork-checkpoint.mts";
import {
  compactListingDeliveryTarget,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";
import { readCatalogCoreMachineEnvelope } from "./release-catalog-inspection.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { preparePayloadSigningEnvironment } from "./release-payload-signing.mts";
import { isRecord } from "./runtime-values.mts";

type Files = ReadonlyMap<string, Buffer>;
const indexPath = "definitions/index.json";
const separateTargets = new Set([
  "policy/official/catalog.history-checkpoint.json",
  listingDeliveryTarget,
  compactListingDeliveryTarget,
  artworkCheckpointTarget,
]);
const coverTargets = new Set([
  listingDeliveryTarget,
  compactListingDeliveryTarget,
  artworkCheckpointTarget,
]);
const approvalCustom = "portcove_cover_approvals_v1";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);
const maximum = 16 * 1024 * 1024;
const digest = /^[a-f0-9]{64}$/u;

function object(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error("Invalid catalog reader gate object");
  return raw;
}
function parse(bytes: Buffer | undefined): Record<string, unknown> {
  if (!bytes) throw new Error("Catalog reader gate input is missing");
  return object(JSON.parse(bytes.toString("utf8")) as unknown);
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid catalog reader gate array");
  return value;
}
function number(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid catalog reader requirement version");
  return value;
}
type ReaderRequirements = {
  schema: number;
  projection: number;
  features: string[];
  capabilities: Map<string, { minimum: number; maximum: number }>;
  policySchema: number;
  launchSchema: number;
};

function indexed(files: Files) {
  const results = new Map<string, ReaderRequirements>();
  for (const raw of list(parse(files.get(indexPath)).definitions)) {
    const row = object(raw);
    const id = String(row.stable_id);
    if (row.namespace !== "official" || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(id) || results.has(id))
      throw new Error("Invalid catalog reader subject");
    const entry = parse(files.get(String(row.target)));
    const projection = parse(files.get(String(entry.execution_contract)));
    const policy = parse(files.get(`policy/official/${id}.json`));
    const launch = files.get(`policy/official/${id}.launch.json`);
    const capabilities = new Map<string, { minimum: number; maximum: number }>();
    for (const raw of list(entry.required_capabilities)) {
      const cap = object(raw);
      if (typeof cap.template !== "string" || capabilities.has(cap.template))
        throw new Error("Invalid catalog reader capability inventory");
      const minimum = number(cap.minimum_version);
      const maximum = number(cap.maximum_version);
      if (maximum < minimum) throw new Error("Invalid catalog reader capability range");
      capabilities.set(cap.template, { minimum, maximum });
    }
    const features = list(entry.required_features ?? []).map((name) => {
      if (typeof name !== "string") throw new Error("Invalid named reader feature");
      return name;
    });
    results.set(id, {
      schema: number(entry.definition_schema),
      projection: number(projection.contract_schema),
      features,
      capabilities,
      policySchema: number(policy.policy_schema),
      launchSchema: launch ? number(parse(launch).assessment_schema) : 0,
    });
  }
  return results;
}

function exceeds(candidate: ReaderRequirements, old: ReaderRequirements) {
  return (
    candidate.schema > old.schema ||
    candidate.projection > old.projection ||
    candidate.policySchema > old.policySchema ||
    candidate.launchSchema > old.launchSchema ||
    candidate.features.some((feature) => !old.features.includes(feature)) ||
    [...candidate.capabilities].some(([template, range]) => {
      const historic = old.capabilities.get(template);
      return !historic || range.minimum > historic.minimum || range.maximum < historic.maximum;
    })
  );
}

/** Dropping an entry or widening its accepted capability range does not
 * create a new reader dependency. */
export function strengthenedReaderSubjects(prior: Files | null, next: Files) {
  const before = prior ? indexed(prior) : null;
  return [...indexed(next)]
    .filter(([id, candidate]) => {
      const old = before?.get(id);
      if (old) return exceeds(candidate, old);
      if (candidate.schema >= 4 || candidate.projection >= 4 || candidate.features.length)
        return true;
      // A first catalog can bootstrap legacy definitions. With an established
      // catalog, a new subject must fit a previously published requirement set.
      return before !== null && ![...before.values()].some((entry) => !exceeds(candidate, entry));
    })
    .map(([id]) => id)
    .sort();
}

function validTarget(target: string) {
  return (
    target === indexPath ||
    /^sha256\/[a-f0-9]{64}\.json$/u.test(target) ||
    /^policy\/official\/[a-z0-9][a-z0-9-]*(?:\.launch)?\.json$/u.test(target)
  );
}

async function repositoryBundle(
  repository: string,
  report?: Record<string, unknown>,
  includeCover = false,
) {
  const files = new Map<string, Buffer>();
  let approvals: unknown;
  const targets = publishedTargets(repository, (role, target, metadata) => {
    if (
      role === "official-policy" &&
      target === compactListingDeliveryTarget &&
      isRecord(metadata.custom)
    )
      approvals = metadata.custom[approvalCustom];
  });
  if (report && !isDeepStrictEqual(report.cover_approvals, approvals))
    throw new Error("Cover approval journal differs from exact signed policy");
  const reportFiles = report ? list(report.files).map(object) : [];
  const reportByName = new Map(reportFiles.map((entry) => [entry.target, entry]));
  for (const [target, sha] of Object.entries(targets)) {
    if (separateTargets.has(target) && !(includeCover && coverTargets.has(target))) continue;
    if (!digest.test(sha) || !(validTarget(target) || (includeCover && coverTargets.has(target))))
      throw new Error("Unexpected logical target in the signed reader bundle");
    const name = `targets/${sha}.${target}`;
    const bytes = await readControllerToolFile(path.join(repository, name), maximum);
    const attested = reportByName.get(name);
    if (
      hash(bytes) !== sha ||
      (report && (!attested || attested.sha256 !== sha || attested.bytes !== bytes.length))
    )
      throw new Error("Signed logical target differs from the verified repository inventory");
    files.set(target, bytes);
  }
  if (!files.has(indexPath) || (report && report.index_sha256 !== hash(files.get(indexPath)!)))
    throw new Error("Signed definition index differs from repository verification");
  if (includeCover && [...coverTargets].some((target) => !files.has(target)))
    throw new Error("Released cover proof requires the signed legacy, compact and cover targets");
  return { files, approvals: readApprovedCoverJournal(approvals) };
}

async function writeBundle(directory: string, files: Files) {
  for (const [name, bytes] of files) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  }
}

async function inspectedTargets(work: string) {
  // Listing carriers, their cover checkpoint and the history pointer have separate checks.
  const inspection = parse(
    await readControllerToolFile(path.join(work, "inspection.json"), 4 * 1024 * 1024),
  );
  const targets = new Map<string, { bytes: number; sha256: string }>();
  for (const entry of list(inspection.files).map(object)) {
    const { target, bytes, sha256 } = entry;
    if (typeof target === "string" && separateTargets.has(target)) continue;
    if (
      typeof target !== "string" ||
      !validTarget(target) ||
      targets.has(target) ||
      typeof sha256 !== "string" ||
      !digest.test(sha256)
    )
      throw new Error("Inspected reader target is malformed");
    targets.set(target, { bytes: number(bytes), sha256 });
  }
  return targets;
}

async function priorBundle(work: string) {
  const plan = parse(await readControllerToolFile(path.join(work, "plan.json"), 1024 * 1024));
  if (typeof plan.prior !== "boolean") throw new Error("Signed catalog prior state missing");
  return plan.prior ? await repositoryBundle(path.join(work, "prior")) : null;
}

export async function readerProofHint(work: string) {
  const next = new Map<string, Buffer>();
  for (const [target, entry] of await inspectedTargets(work)) {
    const bytes = await readControllerToolFile(path.join(work, "bundle", target), maximum);
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256)
      throw new Error("Preparation reader target differs from the inspected logical bundle");
    next.set(target, bytes);
  }
  const prior = await priorBundle(work);
  return (
    strengthenedReaderSubjects(prior?.files ?? null, next).length > 0 ||
    existsSync(path.join(work, "cover-approvals.json"))
  );
}

async function assembly(work: string) {
  const report = parse(
    await readControllerToolFile(path.join(work, "assembly-report.json"), 32 * 1024 * 1024),
  );
  if (
    report.schema_version !== 1 ||
    report.authority !== "none" ||
    ![report.repository_sha256, report.index_sha256, report.timestamp_sha256].every(
      (id) => typeof id === "string" && digest.test(id),
    )
  )
    throw new Error("Signed catalog assembly report is malformed");
  const signed = await repositoryBundle(path.join(work, "repository"), report);
  const next = signed.files;
  const intended = await inspectedTargets(work);
  if (
    intended.size !== next.size ||
    [...intended].some(([target, entry]) => {
      const bytes = next.get(target);
      return !bytes || bytes.length !== entry.bytes || hash(bytes) !== entry.sha256;
    })
  )
    throw new Error("Signed reader bundle differs from the inspected logical bundle");
  const priorRepository = await priorBundle(work);
  const prior = priorRepository?.files ?? null;
  const oldApprovals = priorRepository?.approvals ?? readApprovedCoverJournal(undefined);
  const approvalChanged = !isDeepStrictEqual(signed.approvals, oldApprovals);
  if (
    approvalChanged &&
    (signed.approvals.consumed_packets.length !== oldApprovals.consumed_packets.length + 1 ||
      !oldApprovals.consumed_packets.every(
        (packet, index) => signed.approvals.consumed_packets[index] === packet,
      ))
  )
    throw new Error("Released reader gate found a rewritten or removed approval journal");
  if (approvalChanged) {
    const planned = readApprovedCoverJournal(
      parse(await readControllerToolFile(path.join(work, "cover-approvals.json"), 256 * 1024)),
    );
    if (!isDeepStrictEqual(planned, signed.approvals))
      throw new Error("Signed approval journal differs from the protected preparation");
  }
  const priorIndex = prior ? hash(prior.get(indexPath)!) : null;
  const identity = {
    repository_sha256: report.repository_sha256,
    index_sha256: report.index_sha256,
    timestamp_sha256: report.timestamp_sha256,
    prior_index_sha256: priorIndex,
    prior_timestamp_sha256: prior
      ? hash(
          await readControllerToolFile(path.join(work, "prior/metadata/timestamp.json"), maximum),
        )
      : null,
    subjects: strengthenedReaderSubjects(prior, next),
    ...(approvalChanged ? { cover_approval: signed.approvals.consumed_packets.at(-1)! } : {}),
  };
  return { identity, prior, next, report };
}

async function check(work: string, tool: string, output: string) {
  const { identity, prior, next, report } = await assembly(work);
  if (!identity.subjects.length && !identity.cover_approval)
    throw new Error("Prepared reader proof hint differs from exact signed requirements");
  if (!prior)
    throw new Error(
      "Strengthened catalog reader requirements need an authenticated previous known-good bundle",
    );
  const directory = await mkdtemp(path.join(work, "named-reader-"));
  const root = path.join(work, "root.json");
  const offline = path.join(work, "offline-targets.json");
  const config = path.join(directory, "verify-prior.json");
  const paths = {
    repository: path.join(work, "prior"),
    trusted_root: root,
    offline_targets: offline,
  };
  await writeFile(
    config,
    JSON.stringify({
      schema_version: 1,
      initial_root_profile: "single-owner-one-of-one-v1",
      ...paths,
      trusted_root_sha256: hash(await readControllerToolFile(root, maximum)),
      offline_targets_sha256: hash(await readControllerToolFile(offline, maximum)),
    }),
    { flag: "wx", mode: 0o600 },
  );
  const env = await preparePayloadSigningEnvironment(path.join(directory, "environment"));
  const verified = parse(
    Buffer.from(
      (
        await run(tool, ["verify-definition-repository", config], {
          cwd: directory,
          env,
          timeout: 90000,
          maxBuffer: 32 * 1024 * 1024,
        })
      ).stdout,
    ),
  );
  if (
    verified.authority !== "none" ||
    !isDeepStrictEqual((await repositoryBundle(paths.repository, verified)).files, prior)
  )
    throw new Error("Previous catalog is not the authenticated known-good bundle");
  await run(
    "git",
    [
      "fetch",
      "--quiet",
      "origin",
      "refs/heads/gh-pages:refs/remotes/origin/gh-pages",
      "refs/heads/main:refs/remotes/origin/main",
    ],
    { timeout: 30000 },
  );
  const official = await acquireCatalogReleasedReader(directory);
  await requireServedCatalogReaderSelection(official.receipt);
  const bytes = await readControllerToolFile(official.cli, 128 * 1024 * 1024);
  if (hash(bytes) !== official.sha256)
    throw new Error("Official reader changed during acquisition");
  const executable = path.join(directory, "reader");
  await writeFile(executable, bytes, { flag: "wx", mode: 0o700 });
  const invoke = (args: string[]) =>
    run(executable, ["--json", ...args], {
      cwd: directory,
      env,
      timeout: 90000,
      maxBuffer: 4 * 1024 * 1024,
    });
  const capabilities = await invoke(["capabilities"]);
  const result = parse(Buffer.from(capabilities.stdout));
  if (
    capabilities.stderr ||
    result.ok !== true ||
    result.command !== "capabilities" ||
    object(result.data).product_version !== official.version
  )
    throw new Error("Frozen reader version differs from the selected official released reader");
  const proofInputs = identity.cover_approval
    ? ([
        ["prior", (await repositoryBundle(paths.repository, verified, true)).files],
        ["candidate", (await repositoryBundle(path.join(work, "repository"), report, true)).files],
      ] as const)
    : ([
        ["prior", prior],
        ["candidate", next],
      ] as const);
  for (const [label, files] of proofInputs) {
    const bundle = path.join(directory, label);
    await writeBundle(bundle, files);
    const { stdout, stderr } = await invoke(["catalog", "inspect-definition-publication", bundle]);
    if (!identity.cover_approval) readCatalogCoreMachineEnvelope(stdout, stderr, files);
    else {
      if (stderr || Buffer.byteLength(stdout) > 4 * 1024 * 1024)
        throw new Error("Released cover inspection response differs");
      const envelope = parse(Buffer.from(stdout));
      if (envelope.schema_version !== 100)
        throw new Error("Released cover inspection response schema differs");
      requireExactReleasedCoverInspection(
        envelope,
        files.get(artworkCheckpointTarget)!,
        files.get(compactListingDeliveryTarget)!,
      );
      const observed = list(object(envelope.data).files).map(object);
      if (
        observed.length !== files.size ||
        observed.some(
          (row) =>
            typeof row.target !== "string" ||
            !files.has(row.target) ||
            row.bytes !== files.get(row.target)?.length ||
            row.sha256 !== hash(files.get(row.target)!),
        ) ||
        new Set(observed.map((row) => row.target)).size !== files.size
      )
        throw new Error("Released cover reader did not verify every exact signed bundle target");
    }
  }
  if (hash(await readControllerToolFile(executable, 128 * 1024 * 1024)) !== official.sha256)
    throw new Error("Frozen reader changed during inspection");
  await writeFile(
    output,
    JSON.stringify({ ...identity, reader: official.receipt, reader_sha256: official.sha256 }),
    { flag: "wx", mode: 0o600 },
  );
}

export async function recheckReaderGate(work: string, receipt: string, site: string) {
  const { identity } = await assembly(work);
  if (!identity.subjects.length && !identity.cover_approval) return;

  const { reader, reader_sha256, ...operation } = parse(
    await readControllerToolFile(receipt, 1024 * 1024),
  );
  if (!isDeepStrictEqual(operation, identity))
    throw new Error("Released reader checked a different signed candidate or historical baseline");
  const selected = object(reader);
  const commit = /^[a-f0-9]{40}$/u;
  if (
    typeof reader_sha256 !== "string" ||
    !digest.test(reader_sha256) ||
    ![selected.feed_commit, selected.source, selected.tag_object].every(
      (value) => typeof value === "string" && commit.test(value),
    ) ||
    ![selected.archive_sha256, selected.checksum_sha256].every(
      (value) => typeof value === "string" && digest.test(value),
    ) ||
    number(selected.archive_bytes) > 64 * 1024 * 1024
  )
    throw new Error("Frozen official reader identity is malformed");
  number(selected.release_id);
  number(selected.asset_id);
  requireCurrentCatalogReaderSelection(selected, site);
  await requireServedCatalogReaderSelection(selected);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, work, first, second, ...rest] = process.argv.slice(2);
  if (mode === "hint" && work && !first) {
    console.log(await readerProofHint(path.resolve(work)));
  } else {
    if (!work || !first || !second || rest.length || (mode !== "check" && mode !== "recheck"))
      throw new Error(
        "Expected hint WORK, check WORK RELEASE_TOOLS RECEIPT or recheck WORK RECEIPT SITE",
      );
    if (mode === "check")
      await check(path.resolve(work), path.resolve(first), path.resolve(second));
    else await recheckReaderGate(path.resolve(work), path.resolve(first), path.resolve(second));
  }
}
