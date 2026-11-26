import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requireOperationalReaderCapabilities } from "./catalog-definition-reader-gate.mts";
import { assembledInventory } from "./catalog-pages-overlay.mts";
import { priorVersions, publishedTargets } from "./catalog-publish.mts";
import {
  type AcquiredReleasedReader,
  requireCurrentCatalogReaderSelection,
  requireReleasedReaderReceipt,
} from "./catalog-released-reader.mts";
import { artworkCheckpointTarget, readArtworkCheckpoint } from "./listing-artwork-checkpoint.mts";
import {
  compactListingDeliveryTarget,
  decodeRetainedCompactListing,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";
import { catalogPublicationInventory } from "./release-catalog-publication-contract.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { preparePayloadSigningEnvironment } from "./release-payload-signing.mts";
import { isRecord } from "./runtime-values.mts";

const run = promisify(execFile);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const maximumReportBytes = 4 * 1024 ** 2;
const coverFeature = "catalog.cover-checkpoint-v1";

export function exactCoverReaderPair(files: ReadonlyMap<string, Buffer>) {
  const compact = files.get(compactListingDeliveryTarget);
  const checkpoint = files.get(artworkCheckpointTarget);
  const index = files.get("definitions/index.json");
  if (!compact || !checkpoint || !index || !files.has(listingDeliveryTarget))
    throw new Error("Released cover proof needs the complete staged compact publication bundle");
  const listing = decodeRetainedCompactListing(compact);
  readArtworkCheckpoint(checkpoint, listing);

  return {
    listing_wire_sha256: sha(compact),
    listing_decoded_sha256: sha(listing),
    checkpoint_sha256: sha(checkpoint),
    index_sha256: sha(index),
    bundle_sha256: sha(Buffer.from(JSON.stringify(catalogPublicationInventory(files)))),
  };
}

/** A successful command is insufficient. The released reader must inspect the
 * exact indexed files and explicitly bind the checkpoint to the active compact
 * directory. The older operational-only inspector keeps its own contract. */
export function requireExactReleasedCoverInspection(
  stdout: string,
  stderr: string,
  files: ReadonlyMap<string, Buffer>,
) {
  const pair = exactCoverReaderPair(files);
  if (stderr || Buffer.byteLength(stdout) > maximumReportBytes)
    throw new Error("Released cover inspector response is outside its bounds");
  const response: unknown = JSON.parse(stdout);
  const data = isRecord(response) && response.data;
  if (
    !isRecord(response) ||
    response.schema_version !== 100 ||
    response.ok !== true ||
    response.error !== null ||
    response.command !== "catalog.inspect-definition-publication" ||
    !isRecord(data) ||
    data.publication_schema !== 3 ||
    data.authority !== "none" ||
    data.scope !== "inert-catalog-publication-inspection" ||
    data.index_sha256 !== pair.index_sha256 ||
    !Array.isArray(data.files) ||
    sha(Buffer.from(JSON.stringify(data.files))) !== pair.bundle_sha256
  )
    throw new Error("Released cover inspector did not bind the exact staged bundle");
  if (
    !isRecord(data.listings) ||
    data.listings.target !== compactListingDeliveryTarget ||
    data.listings.sha256 !== pair.listing_wire_sha256 ||
    !isRecord(data.cover_checkpoint) ||
    data.cover_checkpoint.target !== artworkCheckpointTarget ||
    data.cover_checkpoint.sha256 !== pair.checkpoint_sha256 ||
    data.cover_checkpoint.listing_decoded_sha256 !== pair.listing_decoded_sha256
  )
    throw new Error(
      "Released cover inspector did not bind the checkpoint to the active compact directory",
    );
  return pair;
}

/** Use the already attested immutable released CLI. Run it only over private
 * prepared files, with no host preferences, Library or inherited credentials. */
export async function proveReleasedCoverInspection(
  reader: AcquiredReleasedReader,
  workspace: string,
  bundle: string,
  files: ReadonlyMap<string, Buffer>,
) {
  const scratch = await mkdtemp(path.join(workspace, "released-cover-proof-"));
  const env = await preparePayloadSigningEnvironment(scratch);
  const verifyReader = async () => {
    if (sha(await readControllerToolFile(reader.cli, 128 * 1024 ** 2)) !== reader.sha256)
      throw new Error("Released cover reader bytes differ from their attestation");
  };
  await chmod(reader.cli, 0o700);
  await verifyReader();
  const invoke = (args: string[]) =>
    run(reader.cli, ["--json", ...args], {
      cwd: scratch,
      env,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: maximumReportBytes,
    });
  const capabilities = await invoke(["capabilities"]);
  requireOperationalReaderCapabilities(capabilities.stdout, capabilities.stderr, reader.version, [
    coverFeature,
  ]);
  const { stdout, stderr } = await invoke(["catalog", "inspect-definition-publication", bundle]);
  const pair = requireExactReleasedCoverInspection(stdout, stderr, files);
  await verifyReader();
  return { ...reader.receipt, reader_sha256: reader.sha256, ...pair };
}

/** Compare the scoped retained proof to the exact keyless assembled logical
 * targets, after Pages overlay has checked the guarded prior and staged bytes. */
export async function recheckReleasedCoverPublication(work: string, site: string) {
  const repository = path.join(work, "repository");
  const prior = path.join(work, "prior");
  const targets = publishedTargets(repository);
  const before = priorVersions(prior) ? publishedTargets(prior) : {};
  const cover = targets[artworkCheckpointTarget];
  if (cover === undefined) {
    if (before[artworkCheckpointTarget] !== undefined)
      throw new Error("Signed candidate omitted the retained cover checkpoint");
    return;
  }
  if (cover === before[artworkCheckpointTarget] &&
      targets[compactListingDeliveryTarget] === before[compactListingDeliveryTarget]) return;

  const json = async (name: string, limit: number): Promise<unknown> =>
    JSON.parse((await readControllerToolFile(path.join(work, name), limit)).toString("utf8"));
  const receipt = await json("observation-projection.json", 1024 * 1024);
  const proof = isRecord(receipt) && receipt.released_cover_proof;
  if (!isRecord(proof) || typeof proof.reader_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(proof.reader_sha256))
    throw new Error("Signed cover transition requires exact staged released-reader proof");

  const inventory = assembledInventory(await json("assembly-report.json", 32 * 1024 ** 2));
  const files = new Map<string, Buffer>();
  let remaining = 32 * 1024 ** 2;
  for (const [name, digest] of Object.entries(targets)) {
    // The signer derives this separate history pointer after inspection.
    if (name === "policy/official/catalog.history-checkpoint.json") continue;
    const physical = `targets/${digest}.${name}`;
    const entry = inventory.get(physical);
    if (!entry || entry.sha256 !== digest || entry.bytes > remaining || files.size >= 16385)
      throw new Error("Cover proof target differs from the signed assembly inventory");
    const bytes = await readControllerToolFile(path.join(repository, physical), entry.bytes);
    if (bytes.length !== entry.bytes || sha(bytes) !== digest)
      throw new Error("Cover proof target bytes changed after signing");
    remaining -= bytes.length;
    files.set(name, bytes);
  }
  const pair = exactCoverReaderPair(files);
  if (Object.entries(pair).some(([name, digest]) => proof[name] !== digest))
    throw new Error("Released cover proof describes a different signed bundle");
  requireCurrentCatalogReaderSelection(requireReleasedReaderReceipt(proof), site);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [work, site, ...rest] = process.argv.slice(2);
  if (!work || !site || rest.length) throw new Error("Expected WORK PAGES_WORKTREE");
  await recheckReleasedCoverPublication(path.resolve(work), path.resolve(site));
}
