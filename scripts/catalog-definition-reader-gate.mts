import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { operationalReaderRequirements } from "./catalog-definition-requirements.mts";
import { assembledInventory } from "./catalog-pages-overlay.mts";
import { priorVersions, publishedTargets } from "./catalog-publish.mts";
import {
  acquireCatalogReleasedReader,
  liveReleasedReaderSources,
  requireCurrentCatalogReaderSelection,
  requireReleasedReaderReceipt,
} from "./catalog-released-reader.mts";
import { artworkCheckpointTarget } from "./listing-artwork-checkpoint.mts";
import {
  compactListingDeliveryTarget,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";
import { readCatalogCoreMachineEnvelope } from "./release-catalog-inspection.mts";
import { catalogPublicationInventory } from "./release-catalog-publication-contract.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { preparePayloadSigningEnvironment } from "./release-payload-signing.mts";
import { isRecord } from "./runtime-values.mts";

const run = promisify(execFile);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const index = "definitions/index.json";
const separateTargets = new Set([
  artworkCheckpointTarget,
  listingDeliveryTarget,
  compactListingDeliveryTarget,
  "policy/official/catalog.history-checkpoint.json",
]);
const maximumBytes = 32 * 1024 ** 2;
const digest = /^[a-f0-9]{64}$/u;
const receiptFile = "operational-reader-proof.json";
type Inventory = ReturnType<typeof assembledInventory>;

function operationalTarget(name: string) {
  return (
    name === index ||
    /^sha256\/[a-f0-9]{64}\.json$/u.test(name) ||
    /^policy\/official\/[a-z0-9][a-z0-9-]{0,127}(?:\.launch)?\.json$/u.test(name)
  );
}

async function logicalFiles(
  entries: Iterable<{ target: string; sha256: string; bytes?: number }>,
  location: (target: string, sha256: string) => string,
  assembled?: Inventory,
) {
  const result = new Map<string, Buffer>();
  let remaining = maximumBytes;
  for (const { target, sha256, bytes } of entries) {
    if (separateTargets.has(target)) continue;
    if (
      !operationalTarget(target) ||
      !digest.test(sha256) ||
      result.has(target) ||
      result.size >= 16385
    )
      throw new Error("Invalid operational reader target: " + target);
    const attested = assembled?.get(`targets/${sha256}.${target}`);
    if (assembled && attested?.sha256 !== sha256)
      throw new Error("Operational reader target is absent from signed assembly: " + target);
    if (remaining <= 0) throw new Error("Operational reader proof exceeds its byte bound");
    const contents = await readControllerToolFile(
      location(target, sha256),
      Math.min(remaining, 16 * 1024 ** 2),
    );
    if (
      hash(contents) !== sha256 ||
      (bytes !== undefined && contents.length !== bytes) ||
      (attested && contents.length !== attested.bytes)
    )
      throw new Error("Operational reader target bytes differ: " + target);
    remaining -= contents.length;
    result.set(target, contents);
  }
  if (!result.has(index)) throw new Error("Operational reader bundle has no index");
  return result;
}

async function json(file: string, bound: number) {
  const value: unknown = JSON.parse((await readControllerToolFile(file, bound)).toString("utf8"));
  if (!isRecord(value))
    throw new Error("Invalid operational reader proof input: " + path.basename(file));
  return value;
}

async function published(directory: string, report?: Inventory) {
  return logicalFiles(
    Object.entries(publishedTargets(directory)).map(([target, sha256]) => ({ target, sha256 })),
    (target, sha256) => path.join(directory, "targets", `${sha256}.${target}`),
    report,
  );
}

async function previous(work: string) {
  const prior = path.join(work, "prior");
  return priorVersions(prior) ? published(prior) : null;
}

async function prepared(work: string) {
  const inspection = await json(path.join(work, "inspection.json"), 4 * 1024 ** 2);
  if (!Array.isArray(inspection.files))
    throw new Error("Operational reader proof requires an inspection inventory");
  return logicalFiles(
    inspection.files.map((file: unknown) => {
      if (
        !isRecord(file) ||
        typeof file.target !== "string" ||
        typeof file.sha256 !== "string" ||
        typeof file.bytes !== "number" ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1
      )
        throw new Error("Invalid inspected reader target");
      return { target: file.target, sha256: file.sha256, bytes: file.bytes };
    }),
    (target) => path.join(work, "bundle", target),
  );
}

export function operationalReaderProofScope(
  prior: ReadonlyMap<string, Buffer> | null,
  next: ReadonlyMap<string, Buffer>,
) {
  const { subjects, features } = operationalReaderRequirements(prior, next);
  if (!subjects.length) return null;
  if (!prior)
    throw new Error(
      "Strengthened operational reader requirements need an authenticated prior catalog",
    );
  return {
    subjects,
    features,
    prior: hash(Buffer.from(JSON.stringify(catalogPublicationInventory(prior)))),
    candidate: hash(Buffer.from(JSON.stringify(catalogPublicationInventory(next)))),
  };
}

async function inspect(
  invoke: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  directory: string,
  files: ReadonlyMap<string, Buffer>,
) {
  for (const [name, bytes] of files) {
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { mode: 0o700, recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  const { stdout, stderr } = await invoke(["catalog", "inspect-definition-publication", directory]);
  readCatalogCoreMachineEnvelope(stdout, stderr, files);
}

export function requireOperationalReaderCapabilities(
  stdout: string,
  stderr: string,
  version: string,
  features: readonly string[],
) {
  const reply: unknown = JSON.parse(stdout);
  const data = isRecord(reply) && reply.data;
  if (
    stderr ||
    !isRecord(reply) ||
    reply.ok !== true ||
    reply.error !== null ||
    reply.command !== "capabilities" ||
    !isRecord(data) ||
    data.product !== "Portcove" ||
    data.product_version !== version
  )
    throw new Error("The selected released CLI does not match its verified product and version");
  const advertised = data.definition_features;
  if (
    features.length &&
    (!Array.isArray(advertised) || !features.every((feature) => advertised.includes(feature)))
  )
    throw new Error("The selected released CLI does not prove the required operational features");
}

/** Run only after the current Core inspector and keyless context admit the exact inputs. */
async function provePreparedReader(work: string, site: string) {
  const [prior, next] = await Promise.all([previous(work), prepared(work)]);
  const scope = operationalReaderProofScope(prior, next);
  if (!scope || !prior) return;
  const scratch = await mkdtemp(path.join(path.dirname(work), "operational-reader-"));
  const env = await preparePayloadSigningEnvironment(scratch);
  const reader = await acquireCatalogReleasedReader(
    scratch,
    liveReleasedReaderSources(process.cwd(), scratch, site),
  );
  const verifyReader = async () => {
    if (hash(await readControllerToolFile(reader.cli, 128 * 1024 ** 2)) !== reader.sha256)
      throw new Error("Released operational reader bytes changed during proof");
  };
  await chmod(reader.cli, 0o700);
  await verifyReader();
  const invoke = (args: string[]) =>
    run(reader.cli, ["--json", ...args], {
      cwd: scratch,
      env,
      timeout: 90000,
      maxBuffer: 4 * 1024 ** 2,
      encoding: "utf8",
    });
  const { stdout, stderr } = await invoke(["capabilities"]);
  requireOperationalReaderCapabilities(stdout, stderr, reader.version, scope.features);
  await inspect(invoke, path.join(scratch, "prior"), prior);
  await inspect(invoke, path.join(scratch, "candidate"), next);
  await verifyReader();
  await writeFile(
    path.join(work, receiptFile),
    JSON.stringify({
      scope,
      reader: reader.receipt,
      reader_sha256: reader.sha256,
    }),
    { flag: "wx", mode: 0o600 },
  );
}

export function requireOperationalReaderProof(
  scope: NonNullable<ReturnType<typeof operationalReaderProofScope>>,
  receipt: unknown,
) {
  if (
    !isRecord(receipt) ||
    !isDeepStrictEqual(receipt.scope, scope) ||
    typeof receipt.reader_sha256 !== "string" ||
    !digest.test(receipt.reader_sha256)
  )
    throw new Error("Released operational reader proof differs from the signed transition");
  return requireReleasedReaderReceipt(receipt.reader);
}

/** Run after assembling and staging exact signed bytes, before any Pages commit. */
async function recheckSignedReader(work: string, site: string) {
  const report = assembledInventory(
    await json(path.join(work, "assembly-report.json"), 32 * 1024 ** 2),
  );
  const [prior, next] = await Promise.all([
    previous(work),
    published(path.join(work, "repository"), report),
  ]);
  const scope = operationalReaderProofScope(prior, next);
  if (!scope) return;
  const receipt = await json(path.join(work, receiptFile), 1024 * 1024);
  const reader = requireOperationalReaderProof(scope, receipt);
  requireCurrentCatalogReaderSelection(reader, site);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, work, site, ...rest] = process.argv.slice(2);
  if (!work || !site || rest.length || (mode !== "prepare" && mode !== "recheck"))
    throw new Error("Expected prepare|recheck WORK PAGES_WORKTREE");
  if (mode === "prepare") await provePreparedReader(path.resolve(work), path.resolve(site));
  else await recheckSignedReader(path.resolve(work), path.resolve(site));
}
