/** Bounded preservation of permitted, already-accepted release artifacts (#1306).
 *
 * Maintainer-side tooling only. It records capture state for a declared finite
 * scope, verifies every stored object by a separate complete read-back, and
 * exports/restores a content-addressed inventory. It grants no trust: Core
 * acquisition still selects and verifies artifacts only from authenticated
 * accepted records, and a stored object or URL is transport, never identity.
 * No backend, credential or production acquisition path is configured here. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";

export const inventoryFormat = "portcove-preservation-inventory-v1";

/** Immutable accepted identity copied from a protected acceptance record. */
export type AcceptedArtifact = Readonly<{
  port_id: string;
  platform: string;
  repository: string;
  release_id: number;
  asset_id: number;
  tag: string;
  commit_sha1: string;
  filename: string;
  size: number;
  sha256: string;
  original_url: string;
  distribution_basis: string;
  protected_acceptance: string;
}>;

export type PreservationState = "pending" | "verified" | "failed" | "ineligible";

export type PreservationRecord = Readonly<{
  artifact: AcceptedArtifact;
  object_key: string;
  state: PreservationState;
  reason: string | null;
  recorded_at: string;
  verified_at: string | null;
}>;

/** A declared finite scope. Anything outside it is ineligible, never fetched. */
export type PreservationScope = Readonly<{
  artifacts: ReadonlySet<string>;
  distribution_bases: ReadonlySet<string>;
}>;

/** Storage transport. Implementations stage privately and publish atomically
 * without replacing an existing object; `read` must return the stored bytes. */
export interface PreservationStore {
  exists(key: string): Promise<boolean>;
  stage(chunks: AsyncIterable<Uint8Array>): Promise<string>;
  publish(staged: string, key: string): Promise<void>;
  discard(staged: string): Promise<void>;
  read(key: string): AsyncIterable<Uint8Array>;
  availableBytes(): Promise<number>;
}

const hex = (length: number) => new RegExp(`^[a-f0-9]{${length}}$`, "u");

export function scopeKey(artifact: Pick<AcceptedArtifact, "port_id" | "platform" | "asset_id">) {
  return `${artifact.port_id}:${artifact.platform}:${artifact.asset_id}`;
}

export function objectKey(artifact: Pick<AcceptedArtifact, "sha256">) {
  return `${artifact.sha256}.asset`;
}

/** Rejects malformed identity before any network or storage access. */
export function validateArtifact(value: AcceptedArtifact): void {
  const text = (field: string, entry: unknown) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 2048 || /\p{Cc}/u.test(entry))
      throw new Error(`accepted artifact ${field} is invalid`);
  };
  for (const field of [
    "port_id",
    "platform",
    "repository",
    "tag",
    "filename",
    "original_url",
    "distribution_basis",
    "protected_acceptance",
  ] as const)
    text(field, value[field]);
  for (const field of ["port_id", "platform"] as const)
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(value[field]))
      throw new Error(`accepted artifact ${field} is invalid`);
  if (!/^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/u.test(value.repository))
    throw new Error("accepted artifact repository is invalid");
  if (/[\\/]/u.test(value.filename) || value.filename === "." || value.filename === "..")
    throw new Error("accepted artifact filename is invalid");
  for (const field of ["release_id", "asset_id", "size"] as const)
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0)
      throw new Error(`accepted artifact ${field} must be a positive integer`);
  if (!hex(64).test(value.sha256)) throw new Error("accepted artifact sha256 is invalid");
  if (!hex(40).test(value.commit_sha1)) throw new Error("accepted artifact commit is invalid");
  const url = new URL(value.original_url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("accepted artifact original URL is invalid");
}

/** Hashes a stream while enforcing the accepted size as a hard bound. */
async function* bounded(
  chunks: AsyncIterable<Uint8Array>,
  limit: number,
  digest: ReturnType<typeof createHash>,
  counter: { bytes: number },
): AsyncIterable<Uint8Array> {
  for await (const chunk of chunks) {
    counter.bytes += chunk.byteLength;
    if (counter.bytes > limit) throw new Error("byte stream exceeds the accepted size");
    digest.update(chunk);
    yield chunk;
  }
}

/** A complete, separate read of the stored object. Upload success, ETags and
 * local hashing of the uploaded stream never establish `verified`. */
export async function readBack(store: PreservationStore, key: string, artifact: AcceptedArtifact) {
  const digest = createHash("sha256");
  const counter = { bytes: 0 };
  try {
    for await (const _ of bounded(store.read(key), artifact.size, digest, counter));
  } catch (error) {
    return { matches: false, reason: `stored object read-back failed: ${String(error)}` };
  }
  const sha256 = digest.digest("hex");
  if (counter.bytes !== artifact.size || sha256 !== artifact.sha256)
    return { matches: false, reason: "stored object differs from the accepted size or SHA-256" };
  return { matches: true, reason: null };
}

export type CaptureInput = Readonly<{
  artifact: AcceptedArtifact;
  scope: PreservationScope;
  store: PreservationStore;
  /** Original upstream bytes; called only for an eligible, absent object. */
  fetchOriginal: () => AsyncIterable<Uint8Array>;
  now: () => Date;
}>;

/** Streams bytes into private staging and publishes them only when they match
 * the accepted size and SHA-256. Every failure removes its private staging. */
async function publishVerified(
  store: PreservationStore,
  chunks: () => AsyncIterable<Uint8Array>,
  artifact: AcceptedArtifact,
): Promise<{ ok: true } | { ok: false; deferred: boolean; reason: string }> {
  const key = objectKey(artifact);
  if ((await store.availableBytes()) < artifact.size)
    return { ok: false, deferred: true, reason: "preservation capacity is exhausted" };
  const digest = createHash("sha256");
  const counter = { bytes: 0 };
  let staged: string;
  try {
    staged = await store.stage(bounded(chunks(), artifact.size, digest, counter));
  } catch (error) {
    const deferred = (error as NodeJS.ErrnoException).code === "ENOSPC";
    return {
      ok: false,
      deferred,
      reason: deferred
        ? "preservation capacity was exhausted during transfer"
        : `byte transfer failed: ${String(error)}`,
    };
  }
  if (counter.bytes !== artifact.size || digest.digest("hex") !== artifact.sha256) {
    await store.discard(staged);
    return { ok: false, deferred: false, reason: "bytes differ from the accepted size or SHA-256" };
  }
  try {
    await store.publish(staged, key);
  } catch (error) {
    await store.discard(staged);
    // A concurrent writer may have published first; the caller verifies that object.
    if (!(await store.exists(key)))
      return { ok: false, deferred: false, reason: `publication failed: ${String(error)}` };
  }
  return { ok: true };
}

/** Idempotent, bounded capture for one accepted artifact. A failure reports a
 * gap; it never invalidates accepted bytes or affects a working upstream route.
 * `pending` means deferred (for example by capacity), distinct from `failed`. */
export async function capture(input: CaptureInput): Promise<PreservationRecord> {
  const { artifact, scope, store, now } = input;
  validateArtifact(artifact);
  const key = objectKey(artifact);
  const record = (state: PreservationState, reason: string | null): PreservationRecord => {
    const at = now().toISOString();
    return {
      artifact,
      object_key: key,
      state,
      reason,
      recorded_at: at,
      verified_at: state === "verified" ? at : null,
    };
  };
  if (!scope.artifacts.has(scopeKey(artifact)))
    return record("ineligible", "artifact is outside the declared preservation scope");
  if (!scope.distribution_bases.has(artifact.distribution_basis))
    return record("ineligible", "distribution basis does not permit preservation");

  try {
    // Replay or backfill verifies an existing object instead of uploading again.
    // A differing object is preserved for review rather than overwritten.
    if (!(await store.exists(key))) {
      const published = await publishVerified(store, input.fetchOriginal, artifact);
      if (!published.ok) return record(published.deferred ? "pending" : "failed", published.reason);
    }
    const stored = await readBack(store, key, artifact);
    return stored.matches ? record("verified", null) : record("failed", stored.reason);
  } catch (error) {
    return record("failed", `preservation storage failed: ${String(error)}`);
  }
}

/** Finite backfill over an explicit list; each artifact is captured independently. */
export async function backfill(
  artifacts: readonly AcceptedArtifact[],
  input: Omit<CaptureInput, "artifact" | "fetchOriginal"> & {
    fetchOriginal: (artifact: AcceptedArtifact) => AsyncIterable<Uint8Array>;
  },
): Promise<PreservationRecord[]> {
  const records: PreservationRecord[] = [];
  for (const artifact of artifacts)
    records.push(
      await capture({ ...input, artifact, fetchOriginal: () => input.fetchOriginal(artifact) }),
    );
  return records;
}

export type Inventory = Readonly<{
  format: typeof inventoryFormat;
  records: readonly Readonly<{ artifact: AcceptedArtifact; object_key: string }>[];
}>;

const artifactFields = [
  "port_id",
  "platform",
  "repository",
  "release_id",
  "asset_id",
  "tag",
  "commit_sha1",
  "filename",
  "size",
  "sha256",
  "original_url",
  "distribution_basis",
  "protected_acceptance",
] as const;

/** Exports only verified records, one per object, in a canonical field order so
 * the same verified set always has the same digest. */
export function exportInventory(records: readonly PreservationRecord[]): {
  inventory: Inventory;
  sha256: string;
} {
  // One object may legitimately carry several accepted identities (for example
  // the same archive accepted for two platforms); dedupe on the full identity.
  const verified = new Map<string, { artifact: AcceptedArtifact; object_key: string }>();
  for (const record of records)
    if (record.state === "verified") {
      const canonical = Object.fromEntries(
        artifactFields.map((field) => [field, record.artifact[field]]),
      ) as AcceptedArtifact;
      verified.set(`${record.object_key}\n${JSON.stringify(canonical)}`, {
        artifact: canonical,
        object_key: record.object_key,
      });
    }
  const inventory: Inventory = {
    format: inventoryFormat,
    records: [...verified.keys()].sort().map((key) => verified.get(key)!),
  };
  const text = JSON.stringify(inventory);
  return { inventory, sha256: createHash("sha256").update(text).digest("hex") };
}

/** Restores every inventory object into another store. Bytes are re-verified
 * while staging and again by target read-back; identity and authority are
 * unchanged. Each object is reported independently. */
export async function restoreInventory(
  inventory: Inventory,
  from: PreservationStore,
  to: PreservationStore,
): Promise<{ object_key: string; restored: boolean; reason: string | null }[]> {
  if (inventory.format !== inventoryFormat) throw new Error("unknown preservation inventory");
  const results = [];
  for (const { artifact, object_key } of inventory.records) {
    try {
      validateArtifact(artifact);
      if (object_key !== objectKey(artifact)) throw new Error("inventory object key differs");
      if (!(await to.exists(object_key))) {
        const published = await publishVerified(to, () => from.read(object_key), artifact);
        if (!published.ok) {
          results.push({ object_key, restored: false, reason: published.reason });
          continue;
        }
      }
      const target = await readBack(to, object_key, artifact);
      results.push({ object_key, restored: target.matches, reason: target.reason });
    } catch (error) {
      results.push({ object_key, restored: false, reason: String(error) });
    }
  }
  return results;
}

/** Local filesystem store for fixtures and owned recovery namespaces. Objects
 * are published with an exclusive link, so an existing object is never replaced. */
export class FileSystemPreservationStore implements PreservationStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private object(key: string) {
    if (!/^[a-f0-9]{64}\.asset$/u.test(key)) throw new Error("invalid preservation object key");
    return path.join(this.root, key);
  }

  async exists(key: string) {
    try {
      const entry = await lstat(this.object(key));
      if (!entry.isFile()) throw new Error("preservation object is not a regular file");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async stage(chunks: AsyncIterable<Uint8Array>) {
    await mkdir(this.root, { recursive: true });
    const staged = path.join(this.root, `.partial-${randomUUID()}`);
    const file = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    try {
      try {
        for await (const chunk of chunks)
          for (let offset = 0; offset < chunk.byteLength;) {
            const { bytesWritten } = await file.write(chunk, offset);
            offset += bytesWritten;
          }
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
    return staged;
  }

  async publish(staged: string, key: string) {
    // `link` fails with EEXIST instead of replacing a concurrently published object.
    await link(staged, this.object(key));
    await rm(staged, { force: true });
  }

  async discard(staged: string) {
    await rm(staged, { force: true });
  }

  async *read(key: string) {
    const file = await open(this.object(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      for await (const chunk of file.createReadStream({ autoClose: false })) yield chunk as Buffer;
    } finally {
      await file.close();
    }
  }

  async availableBytes() {
    await mkdir(this.root, { recursive: true });
    const stats = await statfs(this.root);
    return stats.bavail * stats.bsize;
  }

  async keys() {
    return (await readdir(this.root)).filter((name) => /^[a-f0-9]{64}\.asset$/u.test(name));
  }
}
