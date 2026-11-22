import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { preparePayloadSigningEnvironment } from "./release-payload-signing.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";

type RecordValue = Record<string, unknown>;
type FileIdentity = { relative_path: string; sha256: string };
export interface ReviewedGameLifecycleCase {
  port_id: string;
  platform: "windows-x86-64";
  channel: "stable" | "beta";
  predecessor: RecordValue;
  successor: RecordValue;
  libraries:
    | { state: "independently-admitted"; predecessor: string; successor: string }
    | { state: "signed-admissions-unavailable" };
  source: {
    custody: "reviewed-redistributable-fixture";
    profile_id: string;
    relative_path: string;
    sha256: string;
    storage_sha256: string;
  };
  predecessor_executable: FileIdentity;
  successor_executable: FileIdentity;
}
type RunCli = (cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;
interface MaterializerOptions {
  cli: { path: string; sha256: string };
  scratchRoot: string;
  cases: readonly ReviewedGameLifecycleCase[];
  runCli?: RunCli;
}
interface ActiveInstall {
  install_id: string;
  install_path: string;
  executable_path: string;
  executable_sha256: string;
  artifact: RecordValue;
}

const exec = promisify(execFile);
const digest = /^[a-f0-9]{64}$/u;
const identifier = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const byteLimit = 256 * 1024 * 1024;

function canonicalSpelling(value: string) {
  return process.platform === "win32" ? value.replace(/^\\\\\?\\/u, "").toLowerCase() : value;
}

function samePath(left: unknown, right: string) {
  return typeof left === "string" && canonicalSpelling(left) === canonicalSpelling(right);
}

async function directory(value: string) {
  if (!path.isAbsolute(value) || !(await lstat(value)).isDirectory())
    throw new Error("Expected an owned directory");
  const canonical = await realpath(value);
  if (!samePath(canonical, path.resolve(value))) throw new Error("Expected a canonical directory");
  return canonical;
}

async function member(root: string, relative: string) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative
      .split(/[\\\\/]/u)
      .some((part) => !part || part === "." || part === ".." || part.includes(":"))
  )
    throw new Error("Expected a relative fixture path");
  return assertOwnedUnlinkedPath(root, path.join(root, relative), "Lifecycle fixture");
}

async function requireFile(file: string, sha256: string) {
  if (!digest.test(sha256)) throw new Error("Expected a reviewed file digest");
  const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > byteLimit)
    throw new Error("Expected a bounded regular file");
  const handle = await open(file, "r");
  try {
    const match = (stat: typeof before) =>
      stat.dev === before.dev &&
      stat.ino === before.ino &&
      stat.size === before.size &&
      stat.mtimeMs === before.mtimeMs &&
      stat.ctimeMs === before.ctimeMs;
    if (!match(await handle.stat())) throw new Error("File identity changed");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > before.size) throw new Error("File exceeded its reviewed length");
      hash.update(chunk);
    }
    if (
      bytes !== before.size ||
      hash.digest("hex") !== sha256 ||
      !match(await handle.stat()) ||
      !match(await lstat(file))
    )
      throw new Error("File digest or identity changed");
  } finally {
    await handle.close();
  }
}

async function runCli(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const { stdout } = await exec(cli, args, {
    cwd,
    env,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function validateCase(item: ReviewedGameLifecycleCase) {
  if (
    !identifier.test(item.port_id) ||
    item.platform !== "windows-x86-64" ||
    !["stable", "beta"].includes(item.channel) ||
    item.source?.custody !== "reviewed-redistributable-fixture" ||
    !identifier.test(item.source.profile_id) ||
    !digest.test(item.source.sha256) ||
    !digest.test(item.source.storage_sha256) ||
    !digest.test(item.successor_executable.sha256)
  )
    throw new Error("Lifecycle case has no reviewed native input scope");
  for (const subject of [item.predecessor, item.successor]) {
    if (
      !isRecord(subject.definition) ||
      subject.definition.namespace !== "official" ||
      subject.definition.stable_id !== item.port_id ||
      subject.platform !== item.platform ||
      subject.channel !== item.channel ||
      typeof subject.tag !== "string" ||
      typeof subject.artifact_sha256 !== "string" ||
      !digest.test(subject.artifact_sha256)
    )
      throw new Error("Lifecycle case has no exact official package scope");
  }
  if (
    item.predecessor.tag === item.successor.tag ||
    item.predecessor.artifact_sha256 === item.successor.artifact_sha256
  )
    throw new Error("Lifecycle case needs two distinct exact packages");
}

/**
 * Consume a protected, reviewed fixture inventory and two already-provisioned,
 * disposable libraries. A portable restore alone cannot establish scoped
 * publisher authority. Core rechecks both admissions and their replay floors.
 */
export async function materializeGameLifecycleLibraries(options: MaterializerOptions) {
  const holds: { port_id: string; platform: string; channel: string; reason: string }[] = [];
  const work: {
    cli: MaterializerOptions["cli"];
    port_id: string;
    platform: "windows-x86-64";
    channel: "stable" | "beta";
    scope_sha256: string;
    preparation_json: string;
    preparation: RecordValue;
    predecessor_library: string;
    successor_library: string;
    predecessor_active: ActiveInstall;
    successor_library_active: ActiveInstall;
    successor_executable: FileIdentity;
    source: ReviewedGameLifecycleCase["source"];
  }[] = [];
  if (options.cases.length === 0) return { work, holds };
  if (options.cases.length > 4) throw new Error("Lifecycle fixture exceeds case budget");

  const cli = options.cli;
  const invoke = options.runCli ?? runCli;
  const seen = new Set<string>();
  for (const item of options.cases) {
    const key = JSON.stringify([item.port_id, item.platform, item.channel]);
    if (seen.has(key)) throw new Error("Duplicate lifecycle fixture scope");
    seen.add(key);
    let reason = "invalid-reviewed-fixture";
    try {
      validateCase(item);
      if (item.libraries.state !== "independently-admitted") {
        reason = "independent-signed-library-admissions-unavailable";
        throw new Error("Source libraries must already have independent signed admission");
      }
      const scratchRoot = await directory(options.scratchRoot);
      const predecessor = await directory(await member(scratchRoot, item.libraries.predecessor));
      const successor = await directory(await member(scratchRoot, item.libraries.successor));
      if (
        releasePathContains(predecessor, successor) ||
        releasePathContains(successor, predecessor)
      )
        throw new Error("Independently admitted library roots must be separate");
      if (!path.isAbsolute(cli.path) || !samePath(await realpath(cli.path), cli.path))
        throw new Error("Lifecycle CLI must be an exact canonical executable");
      const scope = await mkdtemp(path.join(scratchRoot, "pcg-"));
      const environment = await preparePayloadSigningEnvironment(scope);
      const command = async (library: string, name: string, args: string[]) => {
        await requireFile(cli.path, cli.sha256);
        const raw = await invoke(
          cli.path,
          ["--library", library, "--json", "--non-interactive", ...args],
          scope,
          environment,
        );
        const envelope: unknown = JSON.parse(raw);
        if (!isRecord(envelope) || envelope.ok !== true || envelope.command !== name)
          throw new Error("Core refused or returned another contract");
        return { raw, data: envelope.data };
      };
      const readObject = async (library: string, name: string, args: string[]) => {
        const result = await command(library, name, args);
        if (!isRecord(result.data)) throw new Error("Core response is not an object");
        return { ...result, data: result.data };
      };
      const observePredecessor = async (library: string): Promise<ActiveInstall> => {
        const { data: status } = await readObject(library, "status", ["status", item.port_id]);
        const active = status.active;
        if (
          !isRecord(active) ||
          !isRecord(active.artifact) ||
          active.port_id !== item.port_id ||
          status.port_id !== item.port_id ||
          active.channel !== item.channel ||
          status.channel !== item.channel ||
          active.staged !== false ||
          active.verified !== true ||
          active.version !== item.predecessor.tag ||
          active.artifact.sha256 !== item.predecessor.artifact_sha256 ||
          typeof active.id !== "string" ||
          typeof active.path !== "string" ||
          active.selected_executable !== item.predecessor_executable.relative_path
        )
          throw new Error("Active runtime is not the exact predecessor");
        const install = await directory(active.path);
        await assertOwnedUnlinkedPath(library, install, "Installed predecessor");
        const exe = await member(install, item.predecessor_executable.relative_path);
        await requireFile(exe, item.predecessor_executable.sha256);
        const { data: verification } = await readObject(library, "verify", [
          "verify",
          item.port_id,
        ]);
        if (verification.install_id !== active.id || verification.valid !== true)
          throw new Error("Core refused predecessor immutable verification");
        if (!item.source.relative_path.startsWith("source-inbox/"))
          throw new Error("Source is not in the reviewed disposable inbox");
        const expectedSource = await member(library, item.source.relative_path);
        const { data: sources } = await command(library, "source.list", ["source", "list"]);
        if (
          !Array.isArray(sources) ||
          sources.length !== 1 ||
          !isRecord(sources[0]) ||
          sources[0].profile_id !== item.source.profile_id ||
          !samePath(sources[0].path, expectedSource) ||
          sources[0].storage_sha256 !== item.source.storage_sha256
        ) {
          throw new Error("Registered source is not the exact disposable fixture");
        }
        const { data: source } = await readObject(library, "source.verify", [
          "source",
          "verify",
          item.source.profile_id,
        ]);
        if (
          source.profile_id !== item.source.profile_id ||
          source.sha256 !== item.source.sha256 ||
          source.storage_sha256 !== item.source.storage_sha256 ||
          !samePath(source.path, expectedSource) ||
          !isRecord(source.inspection) ||
          source.inspection.health !== "current"
        )
          throw new Error("Core refused exact reviewed source verification");
        return {
          install_id: active.id,
          install_path: install,
          executable_path: exe,
          executable_sha256: item.predecessor_executable.sha256,
          artifact: active.artifact,
        };
      };
      reason = "exact-admission-or-live-selection-unavailable";
      const preparation = await readObject(successor, "catalog.prepare-successor-evidence", [
        "catalog",
        "prepare-successor-evidence",
        item.port_id,
        "--predecessor-library",
        predecessor,
      ]);
      if (
        !isDeepStrictEqual(preparation.data.predecessor, item.predecessor) ||
        !isDeepStrictEqual(preparation.data.successor, item.successor) ||
        preparation.data.rule_version !== 1 ||
        !Number.isSafeInteger(preparation.data.selected_at) ||
        Number(preparation.data.selected_at) < 1 ||
        !Array.isArray(preparation.data.anchor_observations) ||
        preparation.data.anchor_observations.length === 0
      )
        throw new Error("Core prepared another evidence pair");
      reason = "exact-predecessor-or-lawful-source-unavailable";
      await member(scope, item.successor_executable.relative_path);
      const previousActive = await observePredecessor(predecessor);
      const nextActive = await observePredecessor(successor);
      if (!isDeepStrictEqual(previousActive.artifact, nextActive.artifact))
        throw new Error("Materialized libraries do not share the exact predecessor package");
      work.push({
        cli,
        port_id: item.port_id,
        platform: item.platform,
        channel: item.channel,
        scope_sha256: createHash("sha256").update(preparation.raw).digest("hex"),
        preparation_json: preparation.raw,
        preparation: preparation.data,
        predecessor_library: predecessor,
        successor_library: successor,
        predecessor_active: previousActive,
        successor_library_active: nextActive,
        successor_executable: item.successor_executable,
        source: item.source,
      });
    } catch {
      holds.push({ port_id: item.port_id, platform: item.platform, channel: item.channel, reason });
    }
  }
  return { work, holds };
}
