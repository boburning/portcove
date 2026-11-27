import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IgdbArtwork } from "../apps/desktop/src/transport-types.generated.d.ts";
import {
  imagePattern,
  positiveId,
  validArtworkCollection,
  validArtworkMapping,
} from "./catalog-cover-mapping.mts";
import {
  createCoreImageValidator,
  hashCoreImageValidatorFile,
  createIgdbInspector,
  isConfirmedIgdbImageGone,
  gameMediaRoles,
} from "./inspect-igdb-artwork.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { usesScummvmEngine } from "./catalog-route-holds.mts";
import { isRecord } from "./runtime-values.mts";
import { listingDirectoryTextMaximum } from "./listing-directory-carrier.mts";

const listingsPath = "crates/portcove-core/catalog/listings.json";
const repository = "boburning/portcove";
const workflow = repository + "/.github/workflows/maintenance-inventory.yml@refs/heads/main";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const validDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const maxReportBytes = 256 * 1024;
const imagesPerPass = 64;
const maxImageBytes = 64 * 1024 * 1024;
const wallMs = 150_000;
const mediaImagesPerPass = 8;
const mediaImageBytes = 16 * 1024 * 1024;
const mediaWallMs = 30_000;
const dayMs = 24 * 60 * 60 * 1000;

export function artworkHealthProducer(environment: NodeJS.ProcessEnv, revision: string) {
  const {
    GITHUB_REPOSITORY,
    GITHUB_WORKFLOW_REF,
    GITHUB_EVENT_NAME,
    GITHUB_SHA,
    GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT,
    GITHUB_REF,
    GITHUB_WORKFLOW_SHA,
  } = environment;
  if (
    GITHUB_REPOSITORY !== repository ||
    GITHUB_WORKFLOW_REF !== workflow ||
    GITHUB_EVENT_NAME !== "schedule" ||
    GITHUB_REF !== "refs/heads/main" ||
    GITHUB_SHA !== revision ||
    GITHUB_WORKFLOW_SHA !== revision ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    !GITHUB_RUN_ID ||
    !/^[1-9][0-9]{0,15}$/u.test(GITHUB_RUN_ID) ||
    !GITHUB_RUN_ATTEMPT ||
    !/^[1-9][0-9]{0,5}$/u.test(GITHUB_RUN_ATTEMPT)
  )
    throw new Error("Cover health requires the appointed scheduled maintenance run");
  return { workflow, run: GITHUB_RUN_ID, attempt: GITHUB_RUN_ATTEMPT, revision };
}

export type CoverReference = { id: string; artwork: IgdbArtwork };
export function artworkHealthInventory(document: unknown) {
  // The committed directory is read under its text bound; no row count applies.
  if (!isRecord(document) || !Array.isArray(document.listings))
    throw new Error("Artwork health needs the committed listing inventory");
  const images = new Map<string, CoverReference[]>();
  const ids = new Set<string>();
  let rows = 0;
  for (const row of document.listings as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(row.id) ||
      ids.has(row.id)
    )
      throw new Error("Invalid or duplicate listing in artwork health inventory");
    ids.add(row.id);
    const single = row.artwork;
    const collection = row.collection_covers;
    if (
      (single != null && !validArtworkMapping(single)) ||
      (collection != null && !validArtworkCollection(collection)) ||
      (single != null && collection != null)
    )
      throw new Error("Committed artwork health inventory contains an invalid cover");
    const references = validArtworkMapping(single)
      ? [single]
      : validArtworkCollection(collection)
        ? collection
        : [];
    if (references.length) rows++;
    for (const artwork of references) {
      const entries = images.get(artwork.image_id) ?? [];
      entries.push({ id: row.id, artwork });
      images.set(artwork.image_id, entries);
    }
  }
  return { images, rows };
}

type Inventory = ReturnType<typeof artworkHealthInventory>;

function rotateWindow(keys: string[], perPass: number, now: number) {
  // Stable UTC-day rotation across a stable inventory.
  const windows = Math.max(1, Math.ceil(keys.length / perPass));
  const index = Math.floor(now / dayMs) % windows;
  return { index, windows, ids: keys.sort().slice(index * perPass, (index + 1) * perPass) };
}

export function artworkHealthWindow(inventory: Inventory, now: number) {
  return rotateWindow([...inventory.images.keys()], imagesPerPass, now);
}

type MediaRole = keyof typeof gameMediaRoles;
type MediaTarget = {
  imageId: string;
  role: MediaRole;
  acceptedDigests: Map<MediaRole, Set<string>>;
};

function mediaHealthReference(asset: unknown) {
  if (
    !isRecord(asset) ||
    typeof asset.role !== "string" ||
    !Object.hasOwn(gameMediaRoles, asset.role) ||
    !isRecord(asset.igdb) ||
    !positiveId(asset.igdb.game_id) ||
    !positiveId(asset.igdb.record_id) ||
    typeof asset.igdb.image_id !== "string" ||
    !imagePattern.test(asset.igdb.image_id) ||
    !validDigest(asset.sha256)
  )
    return;
  const role = asset.role as MediaRole;
  const imageId = asset.igdb.image_id;
  const { variant, kind } = gameMediaRoles[role];
  if (
    asset.igdb.kind !== kind ||
    asset.url !== "https://images.igdb.com/igdb/image/upload/t_" + variant + "/" + imageId + ".png"
  )
    return;
  return { key: variant + "/" + imageId, imageId, role, sha256: asset.sha256 };
}

export function mediaHealthInventory(document: unknown) {
  if (!isRecord(document) || !Array.isArray(document.listings))
    throw new Error("Media health needs the committed listing inventory");
  const targets = new Map<string, MediaTarget>();
  for (const row of document.listings as unknown[]) {
    if (
      !isRecord(row) ||
      !Array.isArray(row.media) ||
      usesScummvmEngine({ listing: { implementation: row.implementation } })
    )
      continue;
    for (const asset of row.media as unknown[]) {
      const reference = mediaHealthReference(asset);
      if (!reference) continue;
      const { key, imageId, role, sha256 } = reference;
      const target = targets.get(key) ?? {
        imageId,
        role,
        acceptedDigests: new Map<MediaRole, Set<string>>(),
      };
      const digests = target.acceptedDigests.get(role) ?? new Set();
      digests.add(sha256);
      target.acceptedDigests.set(role, digests);
      targets.set(key, target);
    }
  }
  return targets;
}

type Content = { sha256: string; bytes: number; width: number; height: number };
type ImageRecord = { image_id: string } & (
  | { status: "read"; content: Content }
  | { status: "gone" | "unavailable" | "deferred" }
);

type ImageInspector = Pick<
  ReturnType<typeof createIgdbInspector>,
  "providerMetrics" | "batchStatus"
>;

async function observeImageWindow<T>(
  selected: readonly T[],
  inspector: ImageInspector,
  signal: AbortSignal,
  byteBudget: number,
  targetId: (target: T) => string,
  read: (target: T, remaining: number) => Promise<Content>,
) {
  const observations: ImageRecord[] = [];
  for (const target of selected) {
    const image_id = targetId(target);
    const remaining = byteBudget - inspector.providerMetrics.image_bytes;
    if (remaining <= 0 || signal.aborted || inspector.batchStatus().image_retry_at) {
      observations.push({ image_id, status: "deferred" });
      continue;
    }
    try {
      const { sha256, bytes, width, height } = await read(target, remaining);
      observations.push({ image_id, status: "read", content: { sha256, bytes, width, height } });
    } catch (error) {
      observations.push({
        image_id,
        status: isConfirmedIgdbImageGone(error, image_id) ? "gone" : "unavailable",
      });
    }
  }
  return observations;
}

export async function observeArtworkWindow(
  selected: readonly string[],
  inspector: ImageInspector & Pick<ReturnType<typeof createIgdbInspector>, "inspectImage">,
  signal: AbortSignal,
  byteBudget = maxImageBytes,
) {
  return observeImageWindow(
    selected,
    inspector,
    signal,
    byteBudget,
    (id) => id,
    (id, remaining) => inspector.inspectImage(id, remaining),
  );
}

export async function observeMediaArtworkWindow(
  inventory: ReturnType<typeof mediaHealthInventory>,
  inspector: ImageInspector & Pick<ReturnType<typeof createIgdbInspector>, "inspectMediaImage">,
  signal: AbortSignal,
  now: number,
) {
  const window = rotateWindow([...inventory.keys()], mediaImagesPerPass, now);
  const targets = window.ids.map((key) => inventory.get(key)!);
  const observed = await observeImageWindow(
    targets,
    inspector,
    signal,
    mediaImageBytes,
    (target) => target.imageId,
    (target, remaining) => inspector.inspectMediaImage(target.imageId, target.role, remaining),
  );
  return {
    window: { index: window.index, windows: window.windows, eligible: inventory.size },
    image_requests: inspector.providerMetrics.image_requests,
    image_bytes: inspector.providerMetrics.image_bytes,
    images: observed.map((record, index) => ({
      ...record,
      target: window.ids[index]!,
      roles: [...targets[index]!.acceptedDigests]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([role, digests]) => ({
          role,
          state:
            record.status === "read"
              ? digests.size === 1 && digests.has(record.content.sha256)
                ? "unchanged"
                : "mismatch"
              : record.status,
        })),
    })),
  };
}

function committedInventory(revision: string) {
  const bytes = execFileSync("git", ["show", revision + ":" + listingsPath], {
    timeout: 10_000,
    maxBuffer: listingDirectoryTextMaximum,
  });
  const document: unknown = JSON.parse(bytes.toString("utf8"));
  return { sha256: digest(bytes), inventory: artworkHealthInventory(document), document };
}

function payloadOf(value: unknown): Content | null {
  if (!isRecord(value) || !validDigest(value.sha256)) return null;
  const { sha256, bytes, width, height } = value;
  if (
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > 16 * 1024 * 1024 ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 8 * 1024 * 1024
  )
    return null;
  return { sha256, bytes, width, height };
}

export function projectArtworkHealth(
  report: unknown,
  context: {
    inventory: Inventory;
    listingsSha256: string;
    cliSha256: string;
    producer: ReturnType<typeof artworkHealthProducer>;
    now: number;
  },
) {
  const { inventory, producer, now } = context;
  if (
    !isRecord(report) ||
    report.format !== 1 ||
    report.authority !== "none" ||
    report.listings_sha256 !== context.listingsSha256 ||
    report.cli_sha256 !== context.cliSha256 ||
    !isRecord(report.producer) ||
    Object.entries(producer).some(
      ([key, value]) => !isRecord(report.producer) || report.producer[key] !== value,
    ) ||
    typeof report.observed_at !== "string" ||
    !Array.isArray(report.images)
  )
    throw new Error("Unbound cover health report");
  const at = Date.parse(report.observed_at);
  if (!Number.isFinite(at) || at > now || now - at > 2 * 60 * 60 * 1000)
    throw new Error("Cover health clock differs from its scheduled run");
  const selected = artworkHealthWindow(inventory, at);
  if (report.images.length !== selected.ids.length)
    throw new Error("Cover health report did not account for the selected window");
  const images = (report.images as unknown[]).map((row, index) => {
    if (!isRecord(row) || typeof row.image_id !== "string" || row.image_id !== selected.ids[index])
      throw new Error("Cover health report differs from the committed image window");
    const { image_id: imageId, status } = row;
    if (status !== "read" && status !== "gone" && status !== "unavailable" && status !== "deferred")
      throw new Error("Cover health report has an invalid image status");
    const content = status === "read" ? payloadOf(row.content) : null;
    if ((status === "read" && !content) || (status !== "read" && Object.hasOwn(row, "content")))
      throw new Error("Cover health result has invalid Core content evidence");
    return { imageId, status, content };
  });
  const validatedBytes = images.reduce((sum, { content }) => sum + (content?.bytes ?? 0), 0);
  if (validatedBytes > maxImageBytes)
    throw new Error("Cover health report exceeds the validated image byte budget");

  const facts = new Map<string, unknown>();
  const gaps: { subject_key: string; code: string; message: string }[] = [];
  const counts = { unchanged: 0, mismatch: 0, gone: 0, unavailable: 0, deferred: 0 };
  for (const { imageId, status, content } of images) {
    for (const { id, artwork } of inventory.images.get(imageId) ?? []) {
      const key = "port:" + id + "@" + artwork.image_id;
      if (status === "unavailable" || status === "deferred") {
        counts[status]++;
        gaps.push({ subject_key: key, code: status, message: "No admitted image observation" });
        continue;
      }
      const outcome =
        status === "gone"
          ? "gone"
          : content?.sha256 === artwork.image_sha256
            ? "unchanged"
            : "mismatch";
      counts[outcome]++;
      facts.set(key, { id, artwork, status: outcome, content, observed_at: report.observed_at });
    }
  }
  const expected = [...inventory.images.values()].reduce((sum, entries) => sum + entries.length, 0);
  return {
    revision:
      "scheduled-artwork-health:" + producer.run + "-" + producer.attempt + "@" + producer.revision,
    expected,
    rows: inventory.rows,
    counts,
    facts,
    gaps,
    complete: selected.ids.length === inventory.images.size && gaps.length === 0,
  };
}

export async function readScheduledArtworkHealth(
  file: string,
  revision: string,
  cliSha256: string,
) {
  const producer = artworkHealthProducer(process.env, revision);
  const { sha256, inventory } = committedInventory(revision);
  const bytes = await readControllerToolFile(file, maxReportBytes);
  const report: unknown = JSON.parse(bytes.toString("utf8"));
  const verified = projectArtworkHealth(report, {
    inventory,
    listingsSha256: sha256,
    cliSha256,
    producer,
    now: Date.now(),
  });
  return { ...verified, revision: verified.revision + "#sha256:" + digest(bytes) };
}

async function main(args: string[]) {
  const [cli, output, mediaOutput] = args;
  if (
    !cli ||
    !output ||
    args.length > 3 ||
    (mediaOutput && path.resolve(mediaOutput) === path.resolve(output))
  )
    throw new Error("Expected Core CLI and distinct new receipt paths");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    timeout: 10_000,
    encoding: "utf8",
  }).trim();
  const producer = artworkHealthProducer(process.env, revision);
  const { sha256, inventory, document } = committedInventory(revision);
  const mediaInventory = mediaOutput ? mediaHealthInventory(document) : undefined;
  const hasMedia = (mediaInventory?.size ?? 0) > 0;
  const cliSha256 = hashCoreImageValidatorFile(path.resolve(cli));
  const startedAt = Date.now();
  const scratch = mkdtempSync(path.join(tmpdir(), "portcove-artwork-health-"));
  try {
    const validate = createCoreImageValidator(cli, scratch, cliSha256);
    const operationStart = performance.now();
    const operationDeadline = operationStart + wallMs;
    const coverBudget = hasMedia ? wallMs - mediaWallMs : wallMs;
    const coverDeadline = operationStart + coverBudget;
    const operationSignal = AbortSignal.timeout(wallMs);
    const signal = hasMedia
      ? AbortSignal.any([operationSignal, AbortSignal.timeout(coverBudget)])
      : operationSignal;
    const inspector = createIgdbInspector(
      undefined,
      (bytes) => validate(bytes, coverDeadline),
      fetch,
      { signal },
    );
    const window = artworkHealthWindow(inventory, startedAt);
    const observations = await observeArtworkWindow(
      window.ids,
      inspector,
      signal,
      hasMedia ? maxImageBytes - mediaImageBytes : maxImageBytes,
    );
    const report = {
      format: 1,
      authority: "none",
      producer,
      listings_sha256: sha256,
      cli_sha256: cliSha256,
      observed_at: new Date(startedAt).toISOString(),
      images: observations,
    };
    const summary = projectArtworkHealth(report, {
      inventory,
      listingsSha256: sha256,
      cliSha256,
      producer,
      now: Date.now(),
    });
    const bytes = JSON.stringify(report) + "\n";
    if (Buffer.byteLength(bytes) > maxReportBytes)
      throw new Error("Cover health report exceeds its bound");
    writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
    if (mediaOutput && mediaInventory) {
      const providerRetry = inspector.batchStatus().image_retry_at;
      const mediaDeadline = Math.min(operationDeadline, performance.now() + mediaWallMs);
      const mediaSignal = providerRetry
        ? AbortSignal.abort()
        : AbortSignal.any([operationSignal, AbortSignal.timeout(mediaWallMs)]);
      const mediaInspector = createIgdbInspector(
        undefined,
        (bytes) => validate(bytes, mediaDeadline),
        fetch,
        {
          signal: mediaSignal,
        },
      );
      const assessment = await observeMediaArtworkWindow(
        mediaInventory,
        mediaInspector,
        mediaSignal,
        startedAt,
      );
      const mediaReport = {
        format: 1,
        authority: "none",
        producer,
        listings_sha256: sha256,
        cli_sha256: cliSha256,
        observed_at: report.observed_at,
        retry_at: providerRetry ?? mediaInspector.batchStatus().image_retry_at,
        ...assessment,
      };
      const mediaBytes = JSON.stringify(mediaReport) + "\n";
      if (Buffer.byteLength(mediaBytes) > maxReportBytes)
        throw new Error("Media health report exceeds its bound");
      writeFileSync(mediaOutput, mediaBytes, { flag: "wx", mode: 0o600 });
    }
    console.log(
      JSON.stringify({
        rows: summary.rows,
        selected_images: window.ids.length,
        counts: summary.counts,
      }),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
