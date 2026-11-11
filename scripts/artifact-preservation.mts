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

/** Idempotent, bounded capture for one accepted artifact. A failure reports a
 * gap; it never invalidates accepted bytes or affects a working upstream route. */
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

  if (await store.exists(key)) {
    // Replay or backfill: verify the existing object instead of uploading again.
    // A differing object is preserved for review rather than overwritten.
    const existing = await readBack(store, key, artifact);
    return existing.matches ? record("verified", null) : record("failed", existing.reason);
  }
  if ((await store.availableBytes()) < artifact.size)
    return record("failed", "preservation capacity is exhausted; capture deferred");

  const digest = createHash("sha256");
  const counter = { bytes: 0 };
  let staged: string;
  try {
    staged = await store.stage(bounded(input.fetchOriginal(), artifact.size, digest, counter));
  } catch (error) {
    return record("failed", `original transfer failed: ${String(error)}`);
  }
  if (counter.bytes !== artifact.size || digest.digest("hex") !== artifact.sha256) {
    await store.discard(staged);
    return record("failed", "original bytes differ from the accepted size or SHA-256");
  }
  try {
    await store.publish(staged, key);
  } catch (error) {
    await store.discard(staged);
    // A concurrent capture may have published first; verify that object instead.
    if (!(await store.exists(key))) return record("failed", `publication failed: ${String(error)}`);
  }
  const stored = await readBack(store, key, artifact);
  return stored.matches ? record("verified", null) : record("failed", stored.reason);
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

/** Exports only verified records; unverified objects are never usable alternatives. */
export function exportInventory(records: readonly PreservationRecord[]): {
  inventory: Inventory;
  sha256: string;
} {
  const verified = records
    .filter((record) => record.state === "verified")
    .map(({ artifact, object_key }) => ({ artifact, object_key }))
    .sort((left, right) => left.object_key.localeCompare(right.object_key));
  const inventory: Inventory = { format: inventoryFormat, records: verified };
  const text = JSON.stringify(inventory);
  return { inventory, sha256: createHash("sha256").update(text).digest("hex") };
}

/** Restores every inventory object into another store and verifies it there.
 * Identity and authority are unchanged; the result reports each object. */
export async function restoreInventory(
  inventory: Inventory,
  from: PreservationStore,
  to: PreservationStore,
): Promise<{ object_key: string; restored: boolean; reason: string | null }[]> {
  if (inventory.format !== inventoryFormat) throw new Error("unknown preservation inventory");
  const results = [];
  for (const { artifact, object_key } of inventory.records) {
    validateArtifact(artifact);
    if (object_key !== objectKey(artifact)) throw new Error("inventory object key differs");
    const source = await readBack(from, object_key, artifact);
    if (!source.matches) {
      results.push({ object_key, restored: false, reason: source.reason });
      continue;
    }
    if (!(await to.exists(object_key))) {
      const staged = await to.stage(from.read(object_key));
      try {
        await to.publish(staged, object_key);
      } catch (error) {
        await to.discard(staged);
        if (!(await to.exists(object_key))) {
          results.push({ object_key, restored: false, reason: String(error) });
          continue;
        }
      }
    }
    const target = await readBack(to, object_key, artifact);
    results.push({ object_key, restored: target.matches, reason: target.reason });
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
      for await (const chunk of chunks) await file.write(chunk);
      await file.sync();
    } catch (error) {
      await file.close();
      await rm(staged, { force: true });
      throw error;
    }
    await file.close();
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
