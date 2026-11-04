/** Nonproduction runner/transfer/sign/draft proof. No production authority is consumed. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseSourceAttestation } from "./release-source-attestation.mts";
import { workspaceVersion, loadPackagePolicy } from "./release-package-policy.mts";
import { isRecord } from "./runtime-values.mts";

export function rehearsalVersions(run: { run_id: string; run_attempt: number }) {
  return {
    predecessor: "0.0.0-rehearsal.0",
    candidate: `0.0.0-rehearsal.${run.run_id}.${run.run_attempt}`,
  };
}
export function rehearsalPackageConfiguration() {
  return {
    bundle: { createUpdaterArtifacts: false, windows: { nsis: { installMode: "currentUser" } } },
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
  files: Entry[];
};
function identity() {
  const source = process.env.GITHUB_SHA ?? "";
  const run_id = process.env.GITHUB_RUN_ID ?? "";
  const run_attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (
    process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REPOSITORY_ID !== "1354613114" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !/^[a-f0-9]{40}$/u.test(source) ||
    !/^[1-9][0-9]{0,19}$/u.test(run_id) ||
    !Number.isSafeInteger(Number(run_id)) ||
    !Number.isSafeInteger(run_attempt) ||
    run_attempt < 1
  )
    throw new Error("rehearsal requires this repository's main dispatch and exact run identity");
  return { source, run_id, run_attempt };
}
function gh(args: string[], input?: unknown) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 2 * 1024 ** 2,
    input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, GH_HOST: "github.com" },
  });
}
function api(endpoint: string, method = "GET", input?: unknown): unknown {
  return JSON.parse(
    gh(
      [
        "api",
        `repos/${repository}/${endpoint}`,
        "--method",
        method,
        ...(input === undefined ? [] : ["--input", "-"]),
      ],
      input,
    ),
  );
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
  expected: ReturnType<typeof identity>,
): Manifest {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "files,run_attempt,run_id,scope,source,version" ||
    value.scope !== "disposable-nonproduction" ||
    value.source !== expected.source ||
    value.run_id !== expected.run_id ||
    value.run_attempt !== expected.run_attempt ||
    value.version !== rehearsalVersions(expected).candidate ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version) ||
    !Array.isArray(value.files) ||
    ![4, 9].includes(value.files.length)
  )
    throw new Error("rehearsal manifest source/run/attempt/scope differs");
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
  const payload = `Portcove_${value.version}_x64-setup.exe`;
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
          ...publicInputs,
        ];
  if (JSON.stringify(files.map((f) => f.name).sort()) !== JSON.stringify(wanted.sort()))
    throw new Error("rehearsal asset set differs");
  return { scope: "disposable-nonproduction", ...expected, version: value.version, files };
}
async function manifest(directory: string) {
  const s = await lstat(path.join(directory, manifestName));
  if (!s.isFile() || s.isSymbolicLink() || s.size > 16384)
    throw new Error("invalid manifest size/type");
  const m = inspectRehearsalManifest(
    JSON.parse(await readFile(path.join(directory, manifestName), "utf8")),
    identity(),
  );
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
async function writeManifest(directory: string, value: Manifest) {
  await writeFile(path.join(directory, manifestName), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
}
async function verify(directory: string) {
  const m = await manifest(directory);
  // Authenticate one aggregate manifest. Its exact entries bind every payload byte.
  // Re-attesting the unchanged payload in two jobs would make lookup ambiguous.
  const f = await entry(directory, manifestName);
  const evidence = path.join("work", "verified-manifest");
  await mkdir(evidence, { recursive: true });
  await verifyReleaseSourceAttestation(
    evidence,
    path.resolve(directory, manifestName),
    {
      source_commit: m.source,
      ref: "refs/heads/main",
      run_id: m.run_id,
      run_attempt: m.run_attempt,
      subjects: [{ filename: manifestName, sha256: f.sha256 }],
    },
    { scope: "upstream-rehearsal" },
  );
  return m;
}
async function prepareCandidate() {
  const { reproducePreparedReleaseVersionFiles } =
    await import("../apps/desktop/scripts/prepare-release-version.mts");
  const base = await workspaceVersion(process.cwd());
  const files = reproducePreparedReleaseVersionFiles((name) => readFileSync(name, "utf8"), {
    base_version: base,
    version: rehearsalVersions(identity()).candidate,
  });
  for (const [name, contents] of files) await writeFile(name, contents);
  await mkdir("work/upstream-preparation");
  const patch = execFileSync("git", ["diff", "--binary", "HEAD", "--", ...files.keys()], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  await writeFile("work/upstream-preparation/fixture.patch", patch, { flag: "wx" });
  await writeFile(
    "work/upstream-preparation/package.conf.json",
    `${JSON.stringify(rehearsalPackageConfiguration())}\n`,
    { flag: "wx" },
  );
}
async function stage() {
  const version = await workspaceVersion(process.cwd());
  if (version !== rehearsalVersions(identity()).candidate)
    throw new Error("candidate fixture version differs");
  const filename = `Portcove_${version}_x64-setup.exe`;
  const output = "work/upstream-unsigned";
  await mkdir(output);
  await copyFile(path.join("target/release/bundle/nsis", filename), path.join(output, filename));
  await copyFile("work/upstream-preparation/fixture.patch", path.join(output, "fixture.patch"));
  const contract = execFileSync(
    "cargo",
    [
      "run",
      "--locked",
      "--release",
      "--quiet",
      "-p",
      "portcove-desktop",
      "--example",
      "prepare_installed_update",
      "--",
      "describe",
      rehearsalVersions(identity()).predecessor,
    ],
    { timeout: 300000, maxBuffer: 65536 },
  );
  await writeFile(path.join(output, "windows-compatibility.json"), contract, { flag: "wx" });
  const cli = `portcove-cli-${version}-windows-x86_64.zip`;
  await copyFile(path.join("release-assets", cli), path.join(output, cli));
  await writeManifest(output, {
    scope: "disposable-nonproduction",
    ...identity(),
    version,
    files: await Promise.all(
      [filename, "fixture.patch", "windows-compatibility.json", cli].map((name) =>
        entry(output, name),
      ),
    ),
  });
}
async function sign(directory: string) {
  const m = await verify(directory);
  if (m.files.length !== 4) throw new Error("signer only consumes the unsigned package");
  const output = "work/upstream-signed",
    privateRoot = "work/upstream-disposable-private";
  await mkdir(output);
  await mkdir(privateRoot, { mode: 0o700 });
  const key = path.resolve(privateRoot, "disposable.key");
  const cli = path.resolve("apps/desktop/node_modules/@tauri-apps/cli/tauri.js");
  const invoke = (args: string[]) =>
    execFileSync(process.execPath, [cli, ...args], {
      timeout: 120000,
      stdio: "pipe",
      maxBuffer: 65536,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot },
    });
  try {
    if (invoke(["--version"]).toString().trim() !== "tauri-cli 2.12.2")
      throw new Error("wrong signer version");
    invoke(["signer", "generate", "--ci", "--password", "", "--write-keys", key]);
    const payload = path.resolve(output, m.files[0]!.name);
    await copyFile(path.join(directory, m.files[0]!.name), payload);
    invoke([
      "signer",
      "sign",
      "--private-key-path",
      key,
      "--password",
      "",
      "--app-version",
      m.version,
      payload,
    ]);
    await copyFile(`${key}.pub`, path.join(output, "disposable.pub"));
    execFileSync(
      path.resolve("target/release/portcove-release-tools"),
      [
        "verify",
        payload,
        `${payload}.sig`,
        path.resolve(output, "disposable.pub"),
        m.files[0]!.sha256,
        String(m.files[0]!.bytes),
      ],
      { timeout: 120000, maxBuffer: 65536, stdio: "pipe" },
    );
    const box = Buffer.from((await readFile(`${payload}.sig`, "utf8")).trim(), "base64").toString(
      "utf8",
    );
    const comment = box.trim().split(/\r?\n/u)[2];
    if (
      !comment?.startsWith("trusted comment: timestamp:") ||
      !comment.endsWith(`\tfile:${m.files[0]!.name}\tversion:${m.version}`)
    )
      throw new Error("signed filename or version differs");
    for (const name of [
      "fixture.patch",
      "windows-compatibility.json",
      `portcove-cli-${m.version}-windows-x86_64.zip`,
    ])
      await copyFile(path.join(directory, name), path.join(output, name));
    await disposableFeed(output, privateRoot, m);
    await writeManifest(output, {
      ...m,
      files: await Promise.all(
        [
          m.files[0]!.name,
          `${m.files[0]!.name}.sig`,
          "disposable.pub",
          "fixture.patch",
          "windows-compatibility.json",
          `portcove-cli-${m.version}-windows-x86_64.zip`,
          "updater-inventory.json",
          "trusted-root.json",
          "feed.json",
        ].map((name) => entry(output, name)),
      ),
    });
  } catch {
    // A subprocess error may contain the generated private key; never retain it.
    throw new Error("disposable signing or independent payload verification refused");
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
}
async function disposableFeed(output: string, privateRoot: string, m: Manifest) {
  const { updaterIdentity } = await import("./updater-artifact-inventory.mts");
  const { reconstructApplicationUpdateRecords, writeApplicationUpdateReconstruction } =
    await import("./reconstruct-application-update-records.mts");
  const tool = path.resolve("target/release/portcove-release-tools");
  const fixture = path.resolve(privateRoot, "tuf");
  execFileSync(
    path.resolve("target/release/examples/generate_test_updater_repository"),
    [fixture, path.resolve(output, "disposable.pub")],
    { timeout: 120000, maxBuffer: 65536, stdio: "pipe" },
  );
  const policy = await loadPackagePolicy();
  const updater = updaterIdentity(policy, "windows-x86_64", m.version);
  const artifact = await entry(output, updater.filename);
  const signature = await entry(output, `${updater.filename}.sig`);
  const cliName = `portcove-cli-${m.version}-windows-x86_64.zip`;
  const cli = await entry(output, cliName);
  const publicKey = Buffer.from(
    (await readFile(path.join(output, "disposable.pub"), "utf8")).trim(),
    "base64",
  );
  const asArtifact = (e: Entry) => ({ filename: e.name, bytes: e.bytes, sha256: e.sha256 });
  const inventory = {
    schema_version: 1,
    repository,
    version: m.version,
    source_commit: m.source,
    platform_label: "windows-x86_64",
    application_identifier: "io.github.portcove.portcove",
    packages: [
      { id: updater.id, ...asArtifact(artifact) },
      { id: "cli-windows-x86_64-zip", ...asArtifact(cli) },
    ],
    updater: {
      id: updater.id,
      target: updater.target,
      format: updater.format,
      ...asArtifact(artifact),
      public_key_sha256: createHash("sha256").update(publicKey).digest("hex"),
      signature: asArtifact(signature),
    },
  };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory)}\n`);
  await writeFile(path.join(output, "updater-inventory.json"), inventoryBytes, { flag: "wx" });
  const contract: unknown = JSON.parse(
    await readFile(path.join(output, "windows-compatibility.json"), "utf8"),
  );
  if (!isRecord(contract) || !isRecord(contract.compatibility))
    throw new Error("Windows fixture compatibility absent");
  const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    encoding: "utf8",
    timeout: 30000,
  }).trim();
  const reconstruction = await reconstructApplicationUpdateRecords(
    [
      {
        inventoryBytes,
        signatureBytes: await readFile(path.join(output, signature.name)),
        source_tree: sourceTree,
        qualified_run: {
          workflow: ".github/workflows/upstream-release-rehearsal.yml",
          workflow_commit: m.source,
          run_id: Number(m.run_id),
          attempt: m.run_attempt,
        },
        execution_context: "installed-current-user",
        compatibility: contract.compatibility,
        evidence_ids: [`disposable-upstream-rehearsal-${m.run_id}-${m.run_attempt}`],
      },
    ],
    {
      [`v${m.version}`]: {
        version: m.version,
        preview_eligible: true,
        production_eligible: false,
        targets: ["windows-x86_64"],
      },
    },
  );
  await writeApplicationUpdateReconstruction(path.join(fixture, "records"), reconstruction);
  execFileSync(tool, ["build-tuf", path.join(fixture, "build-tuf.json")], {
    timeout: 120000,
    maxBuffer: 65536,
    stdio: "pipe",
  });
  await copyFile(path.join(fixture, "trusted-root.json"), path.join(output, "trusted-root.json"));
  // Public JSON only; no private directory or executable can cross this fixture boundary.
  const publicFiles: { path: string; text: string }[] = [];
  async function collect(relative: string) {
    const directory = path.join(fixture, "repository", relative);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = `${relative}/${item.name}`;
      if (item.isDirectory()) await collect(name);
      else if (item.isFile())
        publicFiles.push({
          path: name,
          text: await readFile(path.join(fixture, "repository", name), "utf8"),
        });
      else throw new Error("nonregular public fixture metadata");
    }
  }
  await collect("metadata");
  await collect("targets");
  await writeFile(path.join(output, "feed.json"), `${JSON.stringify(publicFiles)}\n`, {
    flag: "wx",
  });
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
async function preparePredecessor(directory: string) {
  const { reproducePreparedReleaseVersionFiles } =
    await import("../apps/desktop/scripts/prepare-release-version.mts");
  const m = await manifest(directory);
  if (m.files.length !== 9)
    throw new Error("predecessor requires the complete signed public fixture");
  const feed = path.join(directory, "feed.json");
  if ((await lstat(feed)).size > 2 * 1024 ** 2)
    throw new Error("public fixture feed exceeds bound");
  const files = inspectRehearsalFeed(JSON.parse(await readFile(feed, "utf8")));
  const output = "work/upstream-public-feed";
  await mkdir(output);
  for (const file of files) {
    const target = path.join(output, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.text, { flag: "wx" });
  }
  const base = await workspaceVersion();
  const prepared = reproducePreparedReleaseVersionFiles((name) => readFileSync(name, "utf8"), {
    base_version: base,
    version: rehearsalVersions(identity()).predecessor,
  });
  for (const [name, contents] of prepared) await writeFile(name, contents);
}
export function inspectRehearsalDraftReadback(
  release: unknown,
  ref: unknown,
  assets: unknown,
  expected: { id: number; tag: string; source: string; files: Entry[] },
) {
  if (
    !isRecord(release) ||
    release.id !== expected.id ||
    release.tag_name !== expected.tag ||
    release.target_commitish !== expected.source ||
    release.draft !== true ||
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
    prerelease: release.prerelease,
    files: expected.files,
    observed_at: new Date().toISOString(),
  };
}
async function draft(directory: string) {
  const m = await verify(directory);
  if (m.files.length !== 9) throw new Error("draft requires the complete signed package");
  const tag = `v${m.version}`;
  const all = [...m.files, await entry(directory, manifestName)];
  const ref = `refs/tags/${tag}`;
  const refs = api(`git/matching-refs/tags/${tag}`);
  if (!Array.isArray(refs)) throw new Error("incomplete rehearsal tag observation");
  const exact = refs.filter((r) => isRecord(r) && r.ref === ref);
  if (exact.length > 1) throw new Error("ambiguous rehearsal tag");
  if (exact.length === 0) api("git/refs", "POST", { ref, sha: m.source });
  const observedTag = api(`git/ref/tags/${tag}`);
  if (
    !isRecord(observedTag) ||
    observedTag.ref !== ref ||
    !isRecord(observedTag.object) ||
    observedTag.object.type !== "commit" ||
    observedTag.object.sha !== m.source
  )
    throw new Error("rehearsal tag has a different source; it is never replaced");

  // List-by-tag 404 is not used as a reason to create: only an observed complete list is.
  const releases = api("releases?per_page=100");
  if (!Array.isArray(releases) || releases.length === 100)
    throw new Error("incomplete release discovery");
  const matches = releases.filter((r) => isRecord(r) && r.tag_name === tag);
  if (matches.length > 1) throw new Error("ambiguous rehearsal release");
  let release: unknown = matches[0];
  if (!release)
    release = api("releases", "POST", {
      tag_name: tag,
      target_commitish: m.source,
      name: `NONPRODUCTION #534 rehearsal ${m.run_id}/${m.run_attempt}`,
      draft: true,
      prerelease: true,
      make_latest: "false",
      body: "Disposable signing/transfer rehearsal. Not an eligible Portcove release. Never use these keys or packages for production.",
    });
  if (
    !isRecord(release) ||
    release.draft !== true ||
    release.target_commitish !== m.source ||
    typeof release.id !== "number" ||
    !Number.isSafeInteger(release.id)
  )
    throw new Error("draft identity differs; published releases are never modified");
  const assets = api(`releases/${release.id}/assets?per_page=100`);
  if (!Array.isArray(assets) || assets.length > all.length)
    throw new Error("draft asset inventory differs");
  for (const a of assets) {
    if (
      !isRecord(a) ||
      !all.some((f) => f.name === a.name && f.bytes === a.size && `sha256:${f.sha256}` === a.digest)
    )
      throw new Error("existing draft asset differs; no overwrite permitted");
  }
  for (const f of all)
    if (!assets.some((a) => isRecord(a) && a.name === f.name))
      gh(["release", "upload", tag, path.join(directory, f.name), "--repo", repository]);
  const downloaded = "work/upstream-draft-readback";
  await mkdir(downloaded);
  gh(["release", "download", tag, "--repo", repository, "--dir", downloaded]);
  if (
    JSON.stringify((await readdir(downloaded)).sort()) !==
    JSON.stringify(all.map((f) => f.name).sort())
  )
    throw new Error("draft readback set differs");
  for (const f of all)
    if (JSON.stringify(await entry(downloaded, f.name)) !== JSON.stringify(f))
      throw new Error("draft readback bytes differ");
  const observed = inspectRehearsalDraftReadback(
    api(`releases/${release.id}`),
    api(`git/ref/tags/${tag}`),
    api(`releases/${release.id}/assets?per_page=100`),
    { id: release.id, tag, source: m.source, files: all },
  );
  // Deliberately draft-only until installed/feed integration is qualified in this same slice.
  await writeFile(
    "work/upstream-draft-result.json",
    `${JSON.stringify({
      scope: m.scope,
      ...observed,
      production: false,
    })}\n`,
    { flag: "wx" },
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = process.argv[2],
    directory = process.argv[3];
  identity();
  if (phase === "prepare-candidate") await prepareCandidate();
  else if (phase === "prepare-predecessor" && directory) await preparePredecessor(directory);
  else if (phase === "stage") await stage();
  else if (phase === "sign" && directory) await sign(directory);
  else if (phase === "draft" && directory) await draft(directory);
  else if (phase === "verify" && directory) await verify(directory);
  else throw new Error("expected stage, verify DIRECTORY, sign DIRECTORY or draft DIRECTORY");
}
