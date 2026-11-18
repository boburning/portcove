import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = "889ad59f3f2607f8d39b355c85a6edab730b4f9f",
  run = 44383634182,
  attempt = 1,
  artifact = 14471676320;
const expectedZip = "0b2034ff8c814f71db780a8f02db8222a820f35f052b93ff3ec55e71fefbeabb";
const root = path.join("C:\\pcv", process.env.GITHUB_RUN_ID + "-" + process.env.GITHUB_RUN_ATTEMPT);
const evidence = path.join(root, "evidence", "desktop-verify", "naev", "native");
await mkdir(evidence, { recursive: true });
await writeFile("naev-native-root.txt", root);
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
    meta.size_in_bytes === 185891465 &&
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
  const p = spawn("python", ["scripts/naev-hosted-input.py", mode, root], {
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
const parser = spawn("python", ["scripts/naev-hosted-input.py", "tar", root], {
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
    "naev-0.13.5-win64.exe",
    "https://codeberg.org/naev/naev/releases/download/v0.13.5/naev-0.13.5-win64.exe",
    "68fd20aad081a90109fad0ad79707cee96c819843c2bbfcfe8e55342ab1c1bd5",
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
        "isolated test-only llvmpipe; no Naev stock-driver rendering, system changes or GPU qualification",
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
  player: path.join(root, "player", "naev.exe"),
  player_root: path.join(root, "player"),
  player_sha256: "9f13f7775bc521c99eec136bd3f4f7c9b24a50e1bc7eeb13c2ffa3facc6e85b9",
  roaming: process.env.NAEV_KNOWN_ROAMING,
  profile: path.join(root, "player", "naev-data"),
  ui_helper: path.resolve("scripts/naev-hosted-ui.ps1"),
  scenarios: ["naev-native-client-registration-play-normal-exit-external-preservation"],
};
assert(config.roaming?.endsWith("Naev"));
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
        "complete official native Naev engine/data portable payload; installer, uninstaller and plugins never executed; no Registry changes",
    },
    null,
    2,
  ),
);
