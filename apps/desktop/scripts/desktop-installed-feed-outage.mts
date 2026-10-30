import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat as filesystemStat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readBoundedEvidenceFile } from "../../../scripts/development-evidence.mts";
import { assertOwnedUnlinkedPath } from "../../../scripts/release-path-safety.mts";
import {
  acquireOwnedProcessLock,
  isProcessAlive,
  readProcessLockOwner,
} from "../../../scripts/process-lock.mts";
import { readProcessIdentity } from "../../../scripts/heavy-rust-test-lock.mts";
import { errorCode, isRecord } from "../../../scripts/runtime-values.mts";

const maximum = 65_536;
const lstat = (filename: string) => filesystemStat(filename, { bigint: true });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const identity = (value: Awaited<ReturnType<typeof lstat>>) => ({
  dev: String(value.dev),
  ino: String(value.ino),
});
type Identity = ReturnType<typeof identity>;
interface Configuration {
  schema_version: 1;
  metadata: string;
  metadata_identity: Identity;
  control_identity: Identity;
  metadata_realpath: string;
  original_identity: Identity;
  withheld: string;
  withheld_identity: Identity;
  bytes: number;
  sha256: string;
}
async function exists(filename: string) {
  return lstat(filename).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
}
async function directory(filename: string, expected?: Identity) {
  const value = await lstat(filename);
  assert.ok(value.isDirectory() && !value.isSymbolicLink(), "Outage directory must be ordinary");
  if (expected) assert.deepEqual(identity(value), expected, "Outage directory identity changed");
  return identity(value);
}
async function writeExclusive(filename: string, bytes: Buffer, mode = 0o600) {
  const handle = await open(filename, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function originalBytes(filename: string, config: Pick<Configuration, "bytes" | "sha256">) {
  const result = await readBoundedEvidenceFile(filename, maximum);
  assert.equal(result.identity.bytes, config.bytes, "Timestamp length changed");
  assert.equal(result.identity.sha256, config.sha256, "Timestamp preimage changed");
  return result.bytes;
}
/** Fixture-only preparation before driver dispatch; never authenticates or renews a feed. */
export async function prepareInstalledFeedOutage(metadata: string, control: string) {
  assert.ok(path.isAbsolute(metadata) && path.isAbsolute(control));
  const metadataIdentity = await directory(metadata);
  await assertOwnedUnlinkedPath(
    metadata,
    path.join(metadata, "timestamp.json"),
    "fixture timestamp",
  );
  const source = path.join(metadata, "timestamp.json");
  const before = await lstat(source);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
  if (process.getuid)
    assert.equal(before.uid, BigInt(process.getuid()), "Timestamp must belong to caller");
  const preimage = await readBoundedEvidenceFile(source, maximum);
  assert.deepEqual(identity(await lstat(source)), identity(before));
  await assertOwnedUnlinkedPath(path.dirname(control), control, "outage control");
  await mkdir(control, { mode: 0o700 });
  const withheld = path.join(metadata, `.portcove-rehearsal-outage-${randomUUID()}`);
  await mkdir(withheld, { mode: 0o700 });
  await writeExclusive(path.join(control, "timestamp-preimage.json"), preimage.bytes);
  // Verify same-volume no-replace hardlinks before withholding authenticated bytes.
  const probe = path.join(withheld, "capability-source.json");
  const destination = path.join(withheld, "capability-link.json");
  await writeExclusive(probe, preimage.bytes);
  await link(probe, destination);
  assert.deepEqual(identity(await lstat(probe)), identity(await lstat(destination)));
  await assert.rejects(link(probe, destination), { code: "EEXIST" });
  await unlink(destination);
  await unlink(probe);
  const config: Configuration = {
    schema_version: 1,
    metadata,
    metadata_identity: metadataIdentity,
    control_identity: await directory(control),
    metadata_realpath: await realpath(metadata),
    original_identity: identity(before),
    withheld,
    withheld_identity: await directory(withheld),
    bytes: preimage.identity.bytes,
    sha256: preimage.identity.sha256,
  };
  const bytes = Buffer.from(JSON.stringify(config, null, 2) + "\n");
  const filename = path.join(control, "configuration.json");
  await writeExclusive(filename, bytes);
  return { configuration: filename, sha256: digest(bytes), authority: "none" as const };
}
async function readConfiguration(filename: string, sha256: string) {
  assert.ok(path.isAbsolute(filename));
  assert.match(sha256, /^[a-f0-9]{64}$/u);
  const control = path.dirname(filename);
  await assertOwnedUnlinkedPath(control, filename, "outage configuration");
  const raw = await readBoundedEvidenceFile(filename, maximum);
  assert.equal(raw.identity.sha256, sha256, "Outage configuration changed");
  const config: unknown = JSON.parse(raw.bytes.toString());
  assert.ok(isRecord(config));
  assert.deepEqual(Object.keys(config).sort(), [
    "bytes",
    "control_identity",
    "metadata",
    "metadata_identity",
    "metadata_realpath",
    "original_identity",
    "schema_version",
    "sha256",
    "withheld",
    "withheld_identity",
  ]);
  assert.equal(config.schema_version, 1);
  for (const name of [
    "control_identity",
    "metadata_identity",
    "original_identity",
    "withheld_identity",
  ]) {
    const physical: unknown = config[name];
    assert.ok(isRecord(physical));
    assert.deepEqual(Object.keys(physical).sort(), ["dev", "ino"]);
    for (const field of ["dev", "ino"]) {
      assert.equal(typeof physical[field], "string");
      assert.match(String(physical[field]), /^\d+$/u);
    }
  }

  for (const name of ["metadata", "withheld", "metadata_realpath", "sha256"])
    assert.equal(typeof config[name], "string");
  assert.ok(
    Number.isSafeInteger(config.bytes) &&
      Number(config.bytes) > 0 &&
      Number(config.bytes) <= maximum,
  );
  const value = config as unknown as Configuration;
  assert.match(value.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(path.isAbsolute(value.metadata) && path.isAbsolute(value.withheld));
  assert.equal(path.dirname(value.withheld), value.metadata);
  assert.match(path.basename(value.withheld), /^\.portcove-rehearsal-outage-[a-f0-9-]{36}$/u);
  await directory(control, value.control_identity);
  await directory(value.metadata, value.metadata_identity);
  assert.equal(await realpath(value.metadata), value.metadata_realpath);
  await assertOwnedUnlinkedPath(value.metadata, value.withheld, "withheld timestamp directory");
  await directory(value.withheld, value.withheld_identity);
  await assertOwnedUnlinkedPath(
    control,
    path.join(control, "timestamp-preimage.json"),
    "retained timestamp",
  );
  await originalBytes(path.join(control, "timestamp-preimage.json"), value);
  return { config: value, control };
}
async function acquireOutageWriter(control: string) {
  const lockPath = path.join(control, "writer.lock");
  await assertOwnedUnlinkedPath(control, lockPath, "outage writer lock");
  let staleOwner: Awaited<ReturnType<typeof readProcessLockOwner>> | undefined;
  let canReclaim = false;
  if (await exists(lockPath)) {
    staleOwner = await readProcessLockOwner(lockPath, "Installed feed outage");
    const alive = isProcessAlive(staleOwner.pid);
    const observed = alive ? readProcessIdentity(staleOwner.pid) : null;
    // ESRCH or a known different creation identity proves the original mutator ended.
    // A live owner with unavailable identity retains custody rather than being adopted.
    canReclaim =
      !alive ||
      (typeof observed === "string" &&
        typeof staleOwner.process_identity === "string" &&
        observed !== staleOwner.process_identity);
  }
  return acquireOwnedProcessLock(
    lockPath,
    { workspace: control, command: "installed owned-file-feed outage" },
    {
      label: "Installed feed outage",
      verifyIdentity: true,
      canReclaim,
      ...(staleOwner ? { expectedStaleOwner: staleOwner } : {}),
    },
  );
}
/** Restore only the original withheld inode, after proving the faulting writer is settled. */
export async function restoreInstalledFeedOutage(filename: string, sha256: string) {
  const { control } = await readConfiguration(filename, sha256);
  const lease = await acquireOutageWriter(control);
  try {
    // A driver that has not reached its fault window cannot start one after
    // parent recovery, even when its surrounding process-tree status is unknown.
    const closed = path.join(control, "fault-window-closed.json");
    const closedBytes = Buffer.from(
      JSON.stringify({ configuration_sha256: sha256, authority: "none" }) + "\n",
    );
    await assertOwnedUnlinkedPath(control, closed, "closed outage window");
    if (await exists(closed)) {
      assert.deepEqual(
        (await readBoundedEvidenceFile(closed, maximum)).bytes,
        closedBytes,
        "Outage closure marker changed",
      );
    } else {
      await writeExclusive(closed, closedBytes);
    }
    return { ...(await restoreOriginalTimestamp(filename, sha256)), new_faults_sealed: true };
  } finally {
    await lease.release();
  }
}
async function restoreOriginalTimestamp(filename: string, sha256: string) {
  const { config } = await readConfiguration(filename, sha256);
  const source = path.join(config.metadata, "timestamp.json"),
    held = path.join(config.withheld, "timestamp.json");
  await assertOwnedUnlinkedPath(config.metadata, source, "fixture timestamp");
  const current = await exists(source),
    withheld = await exists(held);
  if (withheld) {
    assert.deepEqual(identity(withheld), config.original_identity, "Withheld identity changed");
    await originalBytes(held, config);
  }
  if (current) {
    assert.deepEqual(
      identity(current),
      config.original_identity,
      "Refusing a foreign timestamp replacement",
    );
    await originalBytes(source, config);
  } else {
    assert.ok(withheld, "Recoverable original timestamp is missing");
    // Publish the ORIGINAL inode atomically; link refuses an existing destination.
    await link(held, source);
  }
  assert.deepEqual(identity(await lstat(source)), config.original_identity);
  await originalBytes(source, config);
  if (withheld) await unlink(held);
  assert.equal((await lstat(source)).nlink, 1n, "Restored timestamp must have one link");
  await originalBytes(source, config);
  return { phase: "restored", timestamp_sha256: config.sha256, authority: "none" as const };
}
/** Fault window only. The parent must also restore after positive driver/reaper settlement. */
export async function withInstalledFeedOutage<Value>(
  filename: string,
  sha256: string,
  action: () => Promise<Value>,
) {
  const { control } = await readConfiguration(filename, sha256);
  const lease = await acquireOutageWriter(control);
  try {
    const { config } = await readConfiguration(filename, sha256);
    assert.equal(
      await exists(path.join(control, "fault-window-closed.json")),
      null,
      "Outage control is closed to new fault writers",
    );
    const source = path.join(config.metadata, "timestamp.json"),
      held = path.join(config.withheld, "timestamp.json");
    await assertOwnedUnlinkedPath(config.metadata, source, "fixture timestamp");
    const before = await lstat(source);
    assert.ok(before.nlink === 1n);
    assert.deepEqual(identity(before), config.original_identity);
    await originalBytes(source, config);
    assert.equal(await exists(held), null);
    await rename(source, held);
    let observation: { ok: true; value: Value } | { ok: false; error: unknown };
    try {
      assert.deepEqual(identity(await lstat(held)), config.original_identity);
      await originalBytes(held, config);
      observation = { ok: true, value: await action() };
    } catch (error) {
      observation = { ok: false, error };
    }
    let restoration: { error: unknown } | undefined;
    try {
      await restoreOriginalTimestamp(filename, sha256);
    } catch (error) {
      restoration = { error };
    }
    if (!observation.ok && restoration)
      throw new AggregateError(
        [observation.error, restoration.error],
        "Feed outage observation and restoration failed; original preimage retained",
      );
    if (restoration) throw restoration.error;
    if (!observation.ok) throw observation.error;
    return observation.value;
  } finally {
    await lease.release();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ["phase", "metadata", "control", "configuration", "sha256"].map(
        (name) => [name, { type: "string" }] as const,
      ),
    ),
  });
  const text = (name: string) => {
    const value = values[name];
    assert.ok(typeof value === "string" && value.length);
    return value;
  };
  const phase = text("phase");
  assert.ok(phase === "prepare" || phase === "restore");
  console.log(
    JSON.stringify(
      phase === "prepare"
        ? { phase, ...(await prepareInstalledFeedOutage(text("metadata"), text("control"))) }
        : await restoreInstalledFeedOutage(text("configuration"), text("sha256")),
    ),
  );
}
