/** Verify and inspect the retained nonproduction rehearsal inputs. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import { workspaceVersion } from "./release-package-policy.mts";
import { isRecord } from "./runtime-values.mts";
import {
  rehearsalExecution,
  rehearsalOriginRef,
  rehearsalOrigin,
  rehearsalPublicBase,
} from "./upstream-release-identity.mts";

export function rehearsalVersions(run: { run_id: string; run_attempt: number }) {
  return {
    predecessor: "0.0.0-rehearsal.0",
    public_predecessor: `0.0.0-rehearsal.${run.run_id}.0`,
    candidate: `0.0.0-rehearsal.${run.run_id}.${run.run_attempt}`,
  };
}
const repository = "boburning/portcove";
const manifestName = "rehearsal.json";
type Entry = { name: string; bytes: number; sha256: string };
type Manifest = {
  scope: "disposable-nonproduction";
  source: string;
  version: string;
  run_id: string;
  run_attempt: number;
  signer_attempt?: number;
  files: Entry[];
};
function identity() {
  return rehearsalOrigin();
}
function gh(args: string[]) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 2 * 1024 ** 2,
    env: { ...process.env, GH_HOST: "github.com" },
  });
}
function api(endpoint: string): unknown {
  return JSON.parse(gh(["api", `repos/${repository}/${endpoint}`, "--method", "GET"]));
}
async function entry(directory: string, name: string): Promise<Entry> {
  if (!/^[A-Za-z0-9_.-]{1,160}$/u.test(name)) throw new Error("unsafe rehearsal filename");
  const file = path.join(directory, name);
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size < 1 || s.size > 256 * 1024 ** 2)
    throw new Error("rehearsal file is not a bounded regular file");
  const hash = createHash("sha256");
  let observedBytes = 0;
  for await (const chunk of createReadStream(file)) {
    if (!Buffer.isBuffer(chunk)) throw new Error("unexpected payload stream encoding");
    observedBytes += chunk.length;
    if (observedBytes > s.size) throw new Error("payload grew while hashing");
    hash.update(chunk);
  }
  if (observedBytes !== s.size) throw new Error("payload changed while hashing");
  return { name, bytes: s.size, sha256: hash.digest("hex") };
}
export function inspectRehearsalManifest(
  value: unknown,
  expected: ReturnType<typeof identity> & { signer_attempt?: number },
): Manifest {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      (Array.isArray(value.files) && value.files.length === 10
        ? "files,run_attempt,run_id,scope,signer_attempt,source,version"
        : "files,run_attempt,run_id,scope,source,version") ||
    value.scope !== "disposable-nonproduction" ||
    value.source !== expected.source ||
    value.run_id !== expected.run_id ||
    value.run_attempt !== expected.run_attempt ||
    value.version !== rehearsalVersions(expected).candidate ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version) ||
    !Array.isArray(value.files) ||
    ![4, 10].includes(value.files.length)
  )
    throw new Error("rehearsal manifest source/run/attempt/scope differs");
  if (
    value.files.length === 10 &&
    (!Number.isSafeInteger(expected.signer_attempt) ||
      Number(expected.signer_attempt) < expected.run_attempt ||
      value.signer_attempt !== expected.signer_attempt)
  )
    throw new Error("signed rehearsal manifest has a different signing producer attempt");
  const files = value.files.map((f: unknown) => {
    if (
      !isRecord(f) ||
      Object.keys(f).sort().join(",") !== "bytes,name,sha256" ||
      typeof f.name !== "string" ||
      !/^[A-Za-z0-9_.-]{1,160}$/u.test(f.name) ||
      typeof f.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(f.sha256) ||
      !Number.isSafeInteger(f.bytes) ||
      Number(f.bytes) < 1 ||
      Number(f.bytes) > 256 * 1024 ** 2
    )
      throw new Error("invalid rehearsal asset");
    return { name: f.name, bytes: Number(f.bytes), sha256: f.sha256 };
  });
  if (files.reduce((bytes, file) => bytes + file.bytes, 0) > 2 * 1024 ** 3)
    throw new Error("rehearsal assembly exceeds the appointed2GiB aggregate limit");
  const payload = `Portcove_${value.version}_x64-setup.exe`;
  if (files[0]?.name !== payload)
    throw new Error("rehearsal payload must be the first exact asset");
  const publicInputs = [
    "fixture.patch",
    "windows-compatibility.json",
    `portcove-cli-${value.version}-windows-x86_64.zip`,
  ];
  const wanted =
    files.length === 4
      ? [payload, ...publicInputs]
      : [
          payload,
          `${payload}.sig`,
          "disposable.pub",
          "updater-inventory.json",
          "trusted-root.json",
          "feed.json",
          "baseline-feed.json",
          ...publicInputs,
        ];
  if (JSON.stringify(files.map((f) => f.name).sort()) !== JSON.stringify(wanted.sort()))
    throw new Error("rehearsal asset set differs");
  return {
    scope: "disposable-nonproduction",
    source: expected.source,
    run_id: expected.run_id,
    run_attempt: expected.run_attempt,
    ...(value.files.length === 10 ? { signer_attempt: expected.signer_attempt } : {}),
    version: value.version,
    files,
  };
}
async function manifest(directory: string) {
  const s = await lstat(path.join(directory, manifestName));
  if (!s.isFile() || s.isSymbolicLink() || s.size > 16384)
    throw new Error("invalid manifest size/type");
  const value: unknown = JSON.parse(await readFile(path.join(directory, manifestName), "utf8"));
  const m = inspectRehearsalManifest(value, {
    ...identity(),
    ...(isRecord(value) && Array.isArray(value.files) && value.files.length === 10
      ? { signer_attempt: Number(process.env.PORTCOVE_REHEARSAL_SIGNER_ATTEMPT) }
      : {}),
  });
  const names = (await readdir(directory)).sort();
  if (
    JSON.stringify(names) !== JSON.stringify([...m.files.map((f) => f.name), manifestName].sort())
  )
    throw new Error("unexpected artifact files");
  for (const f of m.files) {
    if (JSON.stringify(await entry(directory, f.name)) !== JSON.stringify(f))
      throw new Error("artifact bytes differ");
  }
  return m;
}
async function verify(directory: string, phase = "verify") {
  const m = await manifest(directory);
  const attesterAttempt =
    m.files.length === 4
      ? Number(process.env.PORTCOVE_REHEARSAL_PACKAGE_ATTESTER_ATTEMPT)
      : m.signer_attempt;
  if (
    !Number.isSafeInteger(attesterAttempt) ||
    Number(attesterAttempt) < m.run_attempt ||
    Number(attesterAttempt) > rehearsalExecution().run_attempt
  )
    throw new Error("actual package/signer attester attempt is unavailable");
  // Authenticate one aggregate manifest. Its exact entries bind every payload byte.
  // Re-attesting the unchanged payload in two jobs would make lookup ambiguous.
  const f = await entry(directory, manifestName);
  if (!/^[a-z-]{1,32}$/u.test(phase)) throw new Error("unknown verification phase");
  const evidence = path.join("work", `verified-manifest-${phase}`);
  await mkdir(evidence, { recursive: true });
  await verifyReleaseSourceAttestation(
    evidence,
    path.resolve(directory, manifestName),
    {
      source_commit: m.source,
      ref: rehearsalOriginRef,
      run_id: m.run_id,
      run_attempt: Number(attesterAttempt),
      subjects: [{ filename: manifestName, sha256: f.sha256 }],
    },
    { scope: "upstream-rehearsal" },
  );
  return m;
}
export function inspectRehearsalFeed(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    throw new Error("invalid public fixture feed");
  const names = new Set<string>();
  let total = 0;
  return value.map((f: unknown) => {
    if (
      !isRecord(f) ||
      Object.keys(f).sort().join(",") !== "path,text" ||
      typeof f.path !== "string" ||
      f.path.length > 256 ||
      !/^(metadata|targets)\/(?:[A-Za-z0-9_.-]+\/){0,8}[A-Za-z0-9_.-]+$/u.test(f.path) ||
      f.path.split("/").some((p) => p === "." || p === "..") ||
      names.has(f.path) ||
      typeof f.text !== "string" ||
      (total += Buffer.byteLength(f.text)) > 2 * 1024 ** 2
    )
      throw new Error("unsafe, duplicate or oversized public fixture metadata");
    names.add(f.path);
    return { path: f.path, text: f.text };
  });
}
async function preparePredecessor(directory: string, publicTransport = false) {
  const { reproducePreparedReleaseVersionFiles } =
    await import("../apps/desktop/scripts/prepare-release-version.mts");
  const m = await manifest(directory);
  if (m.files.length !== 10)
    throw new Error("predecessor requires the complete signed public fixture");
  const feed = path.join(directory, "feed.json");
  if ((await lstat(feed)).size > 2 * 1024 ** 2)
    throw new Error("public fixture feed exceeds bound");
  const files = inspectRehearsalFeed(JSON.parse(await readFile(feed, "utf8")));
  if (!publicTransport) {
    const output = "work/upstream-public-feed";
    await mkdir(output);
    for (const file of files) {
      const target = path.join(output, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text, { flag: "wx" });
    }
  }
  const base = await workspaceVersion();
  const prepared = reproducePreparedReleaseVersionFiles((name) => readFileSync(name, "utf8"), {
    base_version: base,
    version: publicTransport
      ? rehearsalVersions(identity()).public_predecessor
      : rehearsalVersions(identity()).predecessor,
  });
  for (const [name, contents] of prepared) await writeFile(name, contents);
}
export function inspectRehearsalReleaseReadback(
  release: unknown,
  ref: unknown,
  assets: unknown,
  expected: { id: number; tag: string; source: string; files: Entry[] },
  state: "draft" | "immutable",
) {
  if (
    !isRecord(release) ||
    release.id !== expected.id ||
    release.tag_name !== expected.tag ||
    release.target_commitish !== expected.source ||
    release.draft !== (state === "draft") ||
    release.immutable !== (state === "immutable") ||
    (state === "immutable" &&
      (typeof release.published_at !== "string" ||
        !Number.isFinite(Date.parse(release.published_at)))) ||
    release.prerelease !== true ||
    !isRecord(ref) ||
    ref.ref !== `refs/tags/${expected.tag}` ||
    !isRecord(ref.object) ||
    ref.object.type !== "commit" ||
    ref.object.sha !== expected.source ||
    !Array.isArray(assets) ||
    assets.length !== expected.files.length
  )
    throw new Error("final draft, tag or complete asset inventory changed");
  const names = new Set<string>();
  for (const asset of assets) {
    if (
      !isRecord(asset) ||
      typeof asset.name !== "string" ||
      names.has(asset.name) ||
      !expected.files.some(
        (f) =>
          f.name === asset.name && f.bytes === asset.size && `sha256:${f.sha256}` === asset.digest,
      )
    )
      throw new Error("final draft asset identity changed");
    names.add(asset.name);
  }
  return {
    release_id: expected.id,
    tag: expected.tag,
    source: expected.source,
    draft: release.draft,
    immutable: release.immutable,
    prerelease: release.prerelease,
    files: expected.files,
    observed_at: new Date().toISOString(),
  };
}
export function inspectRehearsalDraftReadback(
  release: unknown,
  ref: unknown,
  assets: unknown,
  expected: { id: number; tag: string; source: string; files: Entry[] },
) {
  return inspectRehearsalReleaseReadback(release, ref, assets, expected, "draft");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = process.argv[2],
    directory = process.argv[3];
  identity();
  if (phase === "inspect" && directory) {
    const m = await manifest(directory);
    process.stdout.write(
      `${JSON.stringify({ ...identity(), version: m.version, ...rehearsalVersions(identity()), public_base: rehearsalPublicBase(identity()), executor_attempt: rehearsalExecution().run_attempt, executor: rehearsalExecution() })}\n`,
    );
  } else if (phase === "prepare-predecessor" && directory) await preparePredecessor(directory);
  else if (phase === "prepare-public-predecessor" && directory)
    await preparePredecessor(directory, true);
  else if (phase === "verify" && directory) await verify(directory);
  else
    throw new Error(
      "expected inspect|verify|prepare-predecessor|prepare-public-predecessor DIRECTORY",
    );
}

export {
  entry as rehearsalEntry,
  verify as verifyRehearsalPackage,
  manifest as readRehearsalManifest,
  api as rehearsalApi,
  gh as rehearsalGh,
};
export type { Entry as RehearsalEntry, Manifest as RehearsalManifest };
