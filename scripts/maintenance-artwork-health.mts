import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IgdbArtwork } from "../apps/desktop/src/transport-types.generated.d.ts";
import { validArtworkCollection, validArtworkMapping } from "./catalog-cover-mapping.mts";
import {
  createCoreImageValidator,
  createIgdbInspector,
  isConfirmedIgdbImageGone,
} from "./inspect-igdb-artwork.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";

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
  if (!isRecord(document) || !Array.isArray(document.listings) || document.listings.length > 10_000)
    throw new Error("Artwork health needs the bounded committed listing inventory");
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

export function artworkHealthWindow(inventory: Inventory, now: number) {
  const ids = [...inventory.images.keys()].sort();
  // Stable UTC-day rotation. A full cycle samples every image in a stable inventory.
  const windows = Math.max(1, Math.ceil(ids.length / imagesPerPass));
  const index = Math.floor(now / dayMs) % windows;
  return { index, windows, ids: ids.slice(index * imagesPerPass, (index + 1) * imagesPerPass) };
}

type Content = { sha256: string; bytes: number; width: number; height: number };
type ImageRecord = { image_id: string } & (
  | { status: "read"; content: Content }
  | { status: "gone" | "unavailable" | "deferred" }
);

export async function observeArtworkWindow(
  selected: readonly string[],
  inspector: Pick<
    ReturnType<typeof createIgdbInspector>,
    "inspectImage" | "providerMetrics" | "batchStatus"
  >,
  signal: AbortSignal,
) {
  const observations: ImageRecord[] = [];
  for (const imageId of selected) {
    const remaining = maxImageBytes - inspector.providerMetrics.image_bytes;
    if (remaining <= 0 || signal.aborted || inspector.batchStatus().image_retry_at) {
      observations.push({ image_id: imageId, status: "deferred" });
      continue;
    }
    try {
      const { sha256, bytes, width, height } = await inspector.inspectImage(imageId, remaining);
      observations.push({
        image_id: imageId,
        status: "read",
        content: { sha256, bytes, width, height },
      });
    } catch (error) {
      observations.push({
        image_id: imageId,
        status: isConfirmedIgdbImageGone(error, imageId) ? "gone" : "unavailable",
      });
    }
  }
  return observations;
}

function committedInventory(revision: string) {
  const bytes = execFileSync("git", ["show", revision + ":" + listingsPath], {
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    sha256: digest(bytes),
    inventory: artworkHealthInventory(JSON.parse(bytes.toString("utf8"))),
  };
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
  const [cli, output] = args;
  if (!cli || !output || args.length !== 2)
    throw new Error("Expected Core CLI and new receipt path");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    timeout: 10_000,
    encoding: "utf8",
  }).trim();
  const producer = artworkHealthProducer(process.env, revision);
  const { sha256, inventory } = committedInventory(revision);
  const cliSha256 = digest(await readControllerToolFile(path.resolve(cli)));
  const startedAt = Date.now();
  const scratch = mkdtempSync(path.join(tmpdir(), "portcove-artwork-health-"));
  try {
    const validate = createCoreImageValidator(cli, scratch, cliSha256);
    const signal = AbortSignal.timeout(wallMs);
    const inspector = createIgdbInspector(undefined, validate, fetch, { signal });
    const window = artworkHealthWindow(inventory, startedAt);
    const observations = await observeArtworkWindow(window.ids, inspector, signal);
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
