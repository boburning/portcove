import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readlink, realpath, opendir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode, isRecord } from "./runtime-values.mts";
import { fileIdentity } from "./development-evidence.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/application-update-game-data/", import.meta.url),
);
const port = "opentyrian-opentyrian";
const version = "v2.1.20260913";
const names = ["opentyrian.cfg", "tyrian.cfg", "tyrian.sav"];
const digest = /^[a-f0-9]{64}$/u;
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected an object in the native fixture contract");
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string" && value.length > 0);
  return value;
}

/** This joins the maintained fixture producer's retained binary and archive
 * inventory; it does not turn that producer observation into attestation. */
export async function readInstalledGameCliReceipt(
  projectRoot: string,
  filename: string,
  sourceCommit: string,
) {
  assert.ok(path.isAbsolute(projectRoot) && path.isAbsolute(filename));
  await assertOwnedUnlinkedPath(projectRoot, filename, "predecessor CLI receipt");
  const receipt = object(
    JSON.parse(
      (
        await readBoundedPublicBuildInputFile(
          projectRoot,
          path.relative(projectRoot, filename),
          65_536,
        )
      ).toString(),
    ),
  );
  assert.deepEqual(Object.keys(receipt).sort(), [
    "archive",
    "cli",
    "schema_version",
    "source_commit",
    "version",
  ]);
  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.source_commit, sourceCommit);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/u);
  assert.match(text(receipt.version), /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u);
  const cli = object(receipt.cli);
  assert.deepEqual(Object.keys(cli).sort(), ["bytes", "path", "sha256"]);
  const ownedRoot = path.dirname(filename);
  assert.ok(path.isAbsolute(text(cli.path)));
  await assertOwnedUnlinkedPath(ownedRoot, text(cli.path), "retained predecessor CLI");
  assert.ok(
    Number.isSafeInteger(cli.bytes) &&
      Number(cli.bytes) > 0 &&
      Number(cli.bytes) <= 128 * 1024 * 1024,
  );
  assert.ok(digest.test(text(cli.sha256)));
  const observed = await fileIdentity(text(cli.path), { maxBytes: Number(cli.bytes) });
  assert.equal(observed.bytes, cli.bytes);
  assert.equal(observed.sha256, cli.sha256);
  const archive = object(receipt.archive);
  assert.deepEqual(Object.keys(archive).sort(), ["bytes", "filename", "id", "sha256"]);
  assert.match(text(archive.id), /^cli-(?:linux|windows)-x86_64-/u);
  assert.match(text(archive.filename), /^[a-zA-Z0-9_.-]+$/u);
  assert.ok(digest.test(text(archive.sha256)));
  assert.ok(
    Number.isSafeInteger(archive.bytes) &&
      Number(archive.bytes) > 0 &&
      Number(archive.bytes) <= 128 * 1024 * 1024,
  );
  return {
    receipt,
    ownedRoot,
    cli: { path: observed.path, sha256: observed.sha256, version: text(receipt.version) },
  };
}

/** Reviewed game-authored data, never a library database or publisher authority. */
export async function readInstalledGameFixture() {
  const manifest = object(
    JSON.parse(
      (await readBoundedPublicBuildInputFile(fixtureRoot, "manifest.json", 65_536)).toString(),
    ),
  );
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.fixture, "opentyrian-game-authored-player-data");
  assert.equal(manifest.port_id, port);
  assert.equal(manifest.version, version);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === names.length);
  const files: Array<{ name: string; bytes: Buffer; sha256: string }> = [];
  for (const name of names) {
    const matching: unknown[] = manifest.files.filter((row: unknown) => object(row).name === name);
    assert.equal(matching.length, 1, "Missing or duplicate player-data fixture");
    const row: Record<string, unknown> = object(matching[0]);
    assert.deepEqual(Object.keys(row).sort(), ["bytes", "name", "sha256"]);
    assert.ok(
      Number.isSafeInteger(row.bytes) && Number(row.bytes) > 0 && Number(row.bytes) <= 4096,
    );
    assert.ok(digest.test(text(row.sha256)));
    const bytes = await readBoundedPublicBuildInputFile(fixtureRoot, name, Number(row.bytes));
    assert.equal(bytes.length, row.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256, row.sha256);
    files.push({ name, bytes, sha256 });
  }
  return { manifest, files };
}

export interface InstalledGameFixtureOptions {
  ownedRoot: string;
  library: string;
  playerRoot: string;
  cli: string;
  cliSha256: string;
  cliVersion: string;
  cliSourceCommit: string;
  platform: "linux-x86_64" | "windows-x86_64";
  environment: NodeJS.ProcessEnv;
  record: (event: { phase: string; details: unknown }) => Promise<void>;
}

async function admit(options: InstalledGameFixtureOptions) {
  const owned = await lstat(options.ownedRoot);
  assert.ok(
    owned.isDirectory() && !owned.isSymbolicLink(),
    "Fixture root must be an ordinary directory",
  );
  assert.ok(digest.test(options.cliSha256));
  assert.match(options.cliSourceCommit, /^[a-f0-9]{40}$/u);
  assert.equal(options.platform, process.platform === "linux" ? "linux-x86_64" : "windows-x86_64");
  assert.ok(process.platform === "linux" || process.platform === "win32");
  assert.equal(process.arch, "x64");
  if (process.platform === "linux") {
    assert.ok(process.getuid && process.getuid() !== 0);
    assert.equal(owned.uid, process.getuid());
    assert.equal(owned.mode & 0o022, 0, "Fixture root permits foreign writers");
  }
  await assertOwnedUnlinkedPath(options.ownedRoot, options.library, "fixture library");
  await assertOwnedUnlinkedPath(options.ownedRoot, options.playerRoot, "private game user store");
  await assertOwnedUnlinkedPath(options.ownedRoot, options.cli, "matching predecessor CLI");
  const expectedPlayerRoot = path.join(
    text(options.environment[process.platform === "linux" ? "XDG_CONFIG_HOME" : "APPDATA"]),
    process.platform === "linux" ? "opentyrian" : "OpenTyrian",
  );
  assert.equal(path.resolve(options.playerRoot), path.resolve(expectedPlayerRoot));
  const cli = await fileIdentity(options.cli, { maxBytes: 128 * 1024 * 1024 });
  assert.equal(cli.sha256, options.cliSha256, "Matching predecessor CLI changed");
  const environment = { ...options.environment };
  for (const name of Object.keys(environment))
    if (
      name.startsWith("PORTCOVE_APPLICATION_") ||
      name.startsWith("TAURI_SIGNING_") ||
      ["PORTCOVE_LIBRARY", "PORTCOVE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"].includes(name)
    )
      delete environment[name];
  return { cli, environment };
}

function assertCliVersion(options: InstalledGameFixtureOptions, environment: NodeJS.ProcessEnv) {
  const observedVersion = execFileSync(options.cli, ["--version"], {
    env: environment,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 65_536,
    windowsHide: true,
  }).trim();
  assert.equal(observedVersion, `portcove ${options.cliVersion}`);
}

/** Validate a normal Core saved-choice reply, independently of process exit. */
export function assertSavedInstalledGameLibraryChoice(value: unknown, canonicalRoot: string) {
  const result = object(value);
  assert.equal(result.ok, true);
  const data = object(result.data);
  assert.equal(data.source, "saved");
  const comparable = (root: string) =>
    process.platform === "win32" ? path.toNamespacedPath(root) : root;
  assert.equal(
    comparable(text(data.root)),
    comparable(canonicalRoot),
    "Core saved a different library root",
  );
  return result;
}

/** Normal Core preference mutation and readback in the admitted private fixture. */
export async function saveInstalledGameLibraryChoice(options: InstalledGameFixtureOptions) {
  const { environment } = await admit(options);
  assertCliVersion(options, environment);
  const canonicalRoot = await realpath(options.library);
  const results = [];
  for (const args of [
    ["--json", "library", "set", options.library],
    ["--json", "library", "show"],
  ]) {
    const result: unknown = JSON.parse(
      execFileSync(options.cli, args, {
        env: environment,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
    );
    await options.record({ phase: "normal-core-library-choice-reply", details: { args, result } });
    results.push(assertSavedInstalledGameLibraryChoice(result, canonicalRoot));
  }
  return results;
}

function runCore(
  options: InstalledGameFixtureOptions,
  environment: NodeJS.ProcessEnv,
  args: string[],
) {
  const result: unknown = JSON.parse(
    execFileSync(options.cli, ["--library", options.library, "--json", ...args], {
      env: environment,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }),
  );
  const envelope = object(result);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.error, null);
  assert.ok(Number.isSafeInteger(envelope.schema_version));
  return object(envelope.data);
}

type TreeEntry = {
  path: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  uid?: number;
  gid?: number;
  bytes?: number;
  sha256?: string;
  target?: string;
};

async function snapshotRuntime(root: string) {
  const entries: TreeEntry[] = [];
  let total = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    assert.ok(depth <= 20 && entries.length <= 4096, "Excessive game-runtime fixture tree");
    const children = [];
    for await (const entry of await opendir(directory)) {
      assert.ok(children.length + entries.length < 4096, "Excessive game-runtime directory");
      children.push(entry.name);
    }
    for (const name of children.sort()) {
      assert.ok(entries.length < 4096);
      const filename = path.join(directory, name);
      const stat = await lstat(filename);
      const entry: TreeEntry = {
        path: path.relative(root, filename).split(path.sep).join("/"),
        kind: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
        mode: stat.mode & 0o7777,
        ...(process.platform === "linux" ? { uid: stat.uid, gid: stat.gid } : {}),
      };
      if (stat.isSymbolicLink()) {
        entry.target = await readlink(filename);
        assert.ok(
          !path.isAbsolute(entry.target) &&
            releasePathContains(root, path.resolve(directory, entry.target)),
          "Game-runtime link leaves its admitted root",
        );
      } else if (stat.isFile()) {
        assert.equal(stat.nlink, 1, "Game runtime contains a hardlinked file");
        const identity = await fileIdentity(filename, { maxBytes: 128 * 1024 * 1024 });
        entry.bytes = identity.bytes;
        entry.sha256 = identity.sha256;
        total += identity.bytes;
        assert.ok(total <= 512 * 1024 * 1024);
      } else assert.ok(stat.isDirectory(), "Game-runtime fixture has a special file");
      entries.push(entry);
      if (stat.isDirectory()) await visit(filename, depth + 1);
    }
  }
  await visit(root, 0);
  assert.ok(entries.length > 0);
  return { entries, files_bytes: total };
}

async function runtimePath(options: InstalledGameFixtureOptions, original: string) {
  // Core may retain Windows extended-length paths. Normalize both lexical
  // spellings with Node before the original-path link guard; never canonicalize
  // the candidate first and thereby erase a junction/reparse component.
  const library =
    process.platform === "win32" ? path.toNamespacedPath(options.library) : options.library;
  const candidate = process.platform === "win32" ? path.toNamespacedPath(original) : original;
  await assertOwnedUnlinkedPath(library, candidate, "original installed game path");
  const runtimeRoot = await realpath(candidate);
  const libraryRoot = await realpath(options.library);
  await assertOwnedUnlinkedPath(libraryRoot, runtimeRoot, "installed game runtime");
  return runtimeRoot;
}

/** Capture original runtime/player files before this observer invokes Core.
 * Candidate startup may already reconcile its state; installed records and
 * policy are subsequent status readback, not raw database preimages. */
export async function observeInstalledGameData(
  options: InstalledGameFixtureOptions,
  installed: { id: string; path: string },
) {
  const { environment } = await admit(options);
  const originalRuntime = await runtimePath(options, installed.path);
  const runtime = await snapshotRuntime(originalRuntime);
  const playerFiles = [];
  for (const name of names) {
    await assertOwnedUnlinkedPath(
      options.ownedRoot,
      path.join(options.playerRoot, name),
      "player data",
    );
    const stat = await lstat(path.join(options.playerRoot, name));
    assert.ok(stat.isFile() && stat.nlink === 1, "Player data must be an unlinked regular file");
    const identity = await fileIdentity(path.join(options.playerRoot, name), { maxBytes: 4096 });
    playerFiles.push({
      name,
      bytes: identity.bytes,
      sha256: identity.sha256,
      mode: stat.mode & 0o7777,
      ...(process.platform === "linux" ? { uid: stat.uid, gid: stat.gid } : {}),
    });
  }
  await options.record({
    phase: "original-game-files-captured",
    details: { runtime, playerFiles },
  });
  assertCliVersion(options, environment);
  const status = runCore(options, environment, ["status", port]);
  assert.equal(status.port_id, port);
  const active = object(status.active);
  assert.equal(active.id, installed.id);
  assert.equal(await runtimePath(options, text(active.path)), originalRuntime);
  assert.equal(active.port_id, port);
  assert.equal(active.version, version);
  assert.equal(active.verified, true);
  assert.equal(active.staged, false);
  const fixture = await readInstalledGameFixture();
  const expected = object(object(fixture.manifest.upstream)[options.platform]);
  const artifact = object(active.artifact);
  assert.equal(artifact.asset_name, expected.asset);
  assert.equal(artifact.sha256, expected.sha256);
  assert.equal(artifact.size, expected.bytes);
  return {
    installed: {
      id: text(active.id),
      port_id: active.port_id,
      version: active.version,
      channel: text(active.channel),
      path: text(active.path),
      artifact,
      manifest_sha256: text(active.manifest_sha256),
      selected_executable: text(active.selected_executable),
    },
    game_update_policy: text(status.update_policy),
    runtime,
    player_files: playerFiles,
  };
}

/** Seed only after the manual updater-enabled replacement. Core owns installation;
 * the fixture copies three already game-authored files into a new private store. */
export async function seedInstalledGameData(options: InstalledGameFixtureOptions) {
  const admitted = await admit(options);
  const fixture = await readInstalledGameFixture();
  assert.equal(
    await lstat(options.playerRoot).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
      return null;
    }),
    null,
    "Player store must be new",
  );
  assertCliVersion(options, admitted.environment);
  await options.record({
    phase: "private-game-store-absent-before-install",
    details: {
      player_root: options.playerRoot,
      cli: admitted.cli,
      source_commit: options.cliSourceCommit,
    },
  });
  const expected = object(object(fixture.manifest.upstream)[options.platform]);
  const plan = runCore(options, admitted.environment, ["plan", port, "--channel", "stable"]);
  await options.record({ phase: "normal-core-plan-returned-before-admission", details: plan });
  assert.deepEqual(plan.source_requirements, []);
  const release = object(plan.release);
  const asset = object(release.asset);
  assert.equal(release.version, version);
  assert.equal(release.channel, "stable");
  assert.equal(asset.name, expected.asset);
  assert.equal(asset.sha256, expected.sha256);
  assert.equal(asset.size, expected.bytes);
  assert.equal(
    asset.url,
    `https://github.com/opentyrian/opentyrian/releases/download/${version}/${text(expected.asset)}`,
  );
  await options.record({ phase: "reviewed-normal-core-plan", details: plan });
  const installed = runCore(options, admitted.environment, [
    "install",
    port,
    "--channel",
    "stable",
  ]);
  await options.record({ phase: "normal-core-install-returned", details: installed });
  assert.equal(installed.port_id, port);
  assert.equal(installed.version, version);
  assert.equal(installed.verified, true);
  assert.equal(installed.staged, false);
  const installedArtifact = object(installed.artifact);
  assert.equal(installedArtifact.asset_name, expected.asset);
  assert.equal(installedArtifact.sha256, expected.sha256);
  assert.equal(installedArtifact.size, expected.bytes);
  const installedIdentity = { id: text(installed.id), path: text(installed.path) };
  await runtimePath(options, installedIdentity.path);
  await mkdir(options.playerRoot, { mode: 0o700 });
  await assertOwnedUnlinkedPath(options.ownedRoot, options.playerRoot, "new private player store");
  for (const file of fixture.files) {
    await writeFile(path.join(options.playerRoot, file.name), file.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    await options.record({
      phase: "game-authored-file-copied",
      details: { name: file.name, bytes: file.bytes.length, sha256: file.sha256 },
    });
  }
  const baseline = await observeInstalledGameData(options, installedIdentity);
  assert.equal(baseline.installed.id, installed.id);
  assert.deepEqual(
    baseline.player_files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
    fixture.files.map((file) => ({
      name: file.name,
      bytes: file.bytes.length,
      sha256: file.sha256,
    })),
  );
  return {
    schema_version: 1,
    scope: "checksum-valid game-authored save/configuration bytes and installed game identities",
    authority: "none; Core owns the normal installation; no library database copied",
    builder_source_commit: options.cliSourceCommit,
    source_scope:
      "caller-bound predecessor build receipt and CLI hash; not binary-derived source attestation",
    cli: { ...admitted.cli, version: options.cliVersion },
    player_root: options.playerRoot,
    backup_scope: "external game user store; outside Portcove managed backups",
    gameplay: "not_evaluated",
    fixture: fixture.manifest,
    baseline,
  };
}

export function assertInstalledGameDataPreserved(
  before: Awaited<ReturnType<typeof observeInstalledGameData>>,
  after: Awaited<ReturnType<typeof observeInstalledGameData>>,
) {
  assert.deepEqual(
    after,
    before,
    "Installed game records/runtime or original player bytes changed",
  );
}
