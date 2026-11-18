import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = "02c0beb9035893936eef4fa8d3484a74e5028059",
  run = 44390241368,
  attempt = 1,
  artifact = 14476541615;
const expectedZip = "42141314fc38144044d29de6201dbe8fb5efaa91eab20f105acfdc60fa12acfe";
const root = path.join("C:\\pcv", process.env.GITHUB_RUN_ID + "-" + process.env.GITHUB_RUN_ATTEMPT);
const evidence = path.join(root, "evidence", "desktop-verify", "freeorion", "native");
await mkdir(evidence, { recursive: true });
await writeFile("freeorion-native-root.txt", root);
const api = "https://api.github.com/repos/boburning/portcove";
const headers = {
  Authorization: "Bearer " + process.env.GH_TOKEN,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
async function json(url) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  assert(r.ok, "Authenticated metadata read failed");
  return r.json();
}
const meta = await json(api + "/actions/artifacts/" + artifact);
assert(
  meta.id === artifact &&
    !meta.expired &&
    meta.size_in_bytes === 185887823 &&
    meta.digest === "sha256:" + expectedZip &&
    meta.workflow_run.id === run &&
    meta.workflow_run.head_sha === source &&
    meta.name === `windows-rust-tests-${run}-${attempt}`,
);
async function download(url, file, cap, expected, auth = false) {
  let r = await fetch(url, {
    headers: auth ? headers : {},
    redirect: auth ? "manual" : "follow",
    signal: AbortSignal.timeout(120000),
  });
  if (auth) {
    assert([301, 302, 303, 307, 308].includes(r.status));
    const target = r.headers.get("location");
    assert(target?.startsWith("https://"));
    r = await fetch(target, { signal: AbortSignal.timeout(120000) });
  }
  assert(r.ok, "Input download failed");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of r.body) {
    bytes += chunk.length;
    assert(bytes <= cap, "Input byte budget exceeded");
    chunks.push(chunk);
  }
  const b = Buffer.concat(chunks),
    sha = createHash("sha256").update(b).digest("hex");
  assert.equal(sha, expected, "Input identity differs");
  await writeFile(path.join(root, file), b, { flag: "wx" });
  return { bytes, sha256: sha };
}
await download(
  api + "/actions/artifacts/" + artifact + "/zip",
  "producer.zip",
  200 * 1024 * 1024,
  expectedZip,
  true,
);
async function python(mode) {
  const p = spawn("python", ["scripts/freeorion-hosted-input.py", mode, root], {
    stdio: "inherit",
  });
  const [c] = await once(p, "close");
  assert.equal(c, 0, "Bounded input inspection failed");
}
await python("outer");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const checkout = await json(api + "/git/commits/" + manifest.identity.source);
assert.equal(checkout.parents[1].sha, source);
assert.equal(checkout.parents.length, 2);
const decoder = spawn(
  "C:\\Program Files\\7-Zip\\7z.exe",
  ["x", "-so", "-bso0", "-bsp0", path.join(root, "tests.tar.zst")],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const parser = spawn("python", ["scripts/freeorion-hosted-input.py", "tar", root], {
  stdio: ["pipe", "inherit", "inherit"],
});
let decoded = 0,
  pipeFailure = null;
function stopExtraction(error) {
  pipeFailure ??= String(error);
  decoder.kill();
  parser.kill();
}
decoder.on("error", stopExtraction);
parser.on("error", stopExtraction);
parser.stdin.on("error", stopExtraction);
decoder.stdout.on("error", stopExtraction);
decoder.stdout.on("data", (b) => {
  decoded += b.length;
  if (decoded > 4 * 1024 ** 3) {
    stopExtraction(new Error("Decoded archive byte budget exceeded"));
  }
});
decoder.stdout.pipe(parser.stdin);
const timer = setTimeout(() => {
  stopExtraction(new Error("Archive extraction deadline exceeded"));
}, 90000);
const results = await Promise.all([once(decoder, "close"), once(parser, "close")]);
clearTimeout(timer);
assert(
  pipeFailure === null && decoded <= 4 * 1024 ** 3 && results.every(([c]) => c === 0),
  "Bounded test-archive extraction failed",
);
const executables = JSON.parse(await readFile(path.join(root, "executables.json"), "utf8"));
const packets = [
  [
    "FreeOrion_v0.5.1.2_Win32_Setup.exe",
    "https://github.com/freeorion/freeorion/releases/download/v0.5.1.2/FreeOrion_v0.5.1.2_Win32_Setup.exe",
    "2788f7283bd04987d4bb27984e3a1c24ff5455146b66ee77b89d2aca71cd0907",
  ],
];
for (const [name, url, digest] of packets) await download(url, name, 250000000, digest);
await python("player");
// Isolated test-only software OpenGL; never install a system driver or run deployment scripts.
const mesaArchive = "mesa3d-26.2.7-release-mingw.7z";
await download(
  "https://github.com/pal1000/mesa-dist-win/releases/download/26.2.7/" + mesaArchive,
  mesaArchive,
  60000000,
  "19c74aad7b09e682473b8de4c35b47e6498de97b71cae5511a231b8eb02f2b22",
);
const mesaFiles = [
  {
    name: "opengl32.dll",
    bytes: 113152,
    sha256: "218b6ebd9011fd2660a116923fa5c232e6d4db86f6f8a4141a0d19b2e7c9d915",
  },
  {
    name: "libgallium_wgl.dll",
    bytes: 77711360,
    sha256: "4d493cc131fec96c72c2e7dd61afa7d7608ee337ac86a8120aec2c423d10136c",
  },
];
for (const file of mesaFiles) {
  // Fixed member streamed to a caller-owned path; no archive paths reach filesystem APIs.
  // Pinned 55.8MB archive has a 256MiB LZMA2 dictionary; cap output and wall time before decoding.
  const p = spawn(
    "C:\\Program Files\\7-Zip\\7z.exe",
    ["x", "-so", "-bso0", "-bsp0", path.join(root, mesaArchive), "x64\\" + file.name],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const chunks = [];
  let bytes = 0;
  let failure = null;
  const stop = (error) => {
    failure ??= String(error);
    p.kill();
  };
  p.on("error", stop);
  p.stdout.on("error", stop);
  p.stderr.on("data", () => {});
  p.stdout.on("data", (b) => {
    bytes += b.length;
    if (bytes > file.bytes) stop("Mesa output exceeds exact member size");
    else chunks.push(b);
  });
  const timer = setTimeout(() => stop("Mesa decode deadline exceeded"), 60000);
  const [code] = await once(p, "close");
  clearTimeout(timer);
  assert(failure === null && code === 0 && bytes === file.bytes, "Mesa fixed member decode failed");
  const buffer = Buffer.concat(chunks);
  assert.equal(createHash("sha256").update(buffer).digest("hex"), file.sha256);
  await writeFile(path.join(root, "player", file.name), buffer, { flag: "wx" });
}
await writeFile(
  path.join(evidence, "mesa-test-dependencies.json"),
  JSON.stringify(
    {
      archive: mesaArchive,
      archive_sha256: "19c74aad7b09e682473b8de4c35b47e6498de97b71cae5511a231b8eb02f2b22",
      files: mesaFiles,
      scope:
        "isolated test-only llvmpipe; no FreeOrion stock-driver rendering, system changes or GPU qualification",
    },
    null,
    2,
  ),
);
const config = {
  sdk: pathToFileURL(path.resolve("product") + path.sep).href,
  product_source: source,
  checkout: manifest.identity.source,
  controller_source: process.env.GITHUB_SHA,
  cli: path.join(root, "portcove.exe"),
  cli_sha256: executables.cli.sha256,
  library: path.join(root, "library"),
  evidence_dir: evidence,
  player: path.join(root, "player", "FreeOrion.exe"),
  player_root: path.join(root, "player"),
  player_sha256: "5df7b6e59f557ce7a0470ad3473e296650f292b9801bfb61157581c803b182df",
  roaming: process.env.FREEORION_KNOWN_ROAMING,
  profile: process.env.FREEORION_KNOWN_ROAMING,
  ui_helper: path.resolve("scripts/freeorion-hosted-ui.ps1"),
  scenarios: ["freeorion-native-client-registration-play-normal-exit-external-preservation"],
};
assert(config.roaming?.endsWith("FreeOrion"));
await writeFile(path.join(root, "native-config.json"), JSON.stringify(config, null, 2));
await writeFile(
  path.join(evidence, "producer.json"),
  JSON.stringify(
    {
      source,
      run,
      attempt,
      artifact,
      artifact_sha256: expectedZip,
      compiled_checkout: manifest.identity.source,
      executables,
      packets: packets.map(([name, url, sha256]) => ({
        name,
        url,
        sha256,
        digest_authority: "observed identity only; user-selected external native client",
      })),
      scope:
        "complete official native FreeOrion engine/data payload; installer, uninstaller and bundled redistributable never executed; no Registry changes",
    },
    null,
    2,
  ),
);
