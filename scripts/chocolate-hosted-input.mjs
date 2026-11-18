import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = "535798e80243183f4030f6ea9f50940f2008e0cc",
  run = 44320330113,
  attempt = 1,
  artifact = 14436581394;
const expectedZip = "f70084ce11885ce30491a87eed2d4719f033b58b265d324165b8bc17e692dc60";
const root = path.join("C:\\pcv", process.env.GITHUB_RUN_ID + "-" + process.env.GITHUB_RUN_ATTEMPT);
const evidence = path.join(root, "evidence", "desktop-verify", "chocolate", "native");
await mkdir(evidence, { recursive: true });
await writeFile("chocolate-native-root.txt", root);
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
    meta.size_in_bytes === 186386856 &&
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
  const p = spawn("python", ["scripts/chocolate-hosted-input.py", mode, root], {
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
const parser = spawn("python", ["scripts/chocolate-hosted-input.py", "tar", root], {
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
const originalPackets = [
  [
    "doom19s.zip",
    "https://ftpmirror1.infania.net/pub/idgames/idstuff/doom/doom19s.zip",
    "cacf0142b31ca1af00796b4a0339e07992ac5f21bc3f81e7532fe1b5e1b486e6",
  ],
  [
    "htic_v12.zip",
    "https://ftpmirror1.infania.net/pub/idgames/idstuff/heretic/htic_v12.zip",
    "5ffbb47e4a5750fef144c312973ee5782266b4a63474b77478103b6c1aaed39d",
  ],
  [
    "hexndemo.zip",
    "https://youfailit.net/pub/idgames/idstuff/hexen/hexndemo.zip",
    "469ee3a254959d2fca624aec7391292fbd1ac3ebd9074b65f05cbc74de3c4572",
  ],
];
for (const [name, url, sha] of originalPackets) await download(url, name, 6000000, sha);
await python("originals");
const titles = [
  [
    "chocolate-doom-family",
    "chocolate-doom-pc-iwad",
    "doom1.wad",
    "chocolate-doom.exe",
    "doomsav0\\.dsg$",
    "58c34c61ae954493fce5ff01fd553898240a0de25658aa97b43ac9510c49581f",
  ],
  [
    "chocolate-heretic",
    "chocolate-heretic-pc-iwad",
    "heretic1.wad",
    "chocolate-heretic.exe",
    "hticsav0\\.hsg$",
    "6faa3ba85d0fb18065d6a530cf74e7d17896742b67c6acc513fcb45263ffba63",
  ],
  [
    "chocolate-hexen",
    "chocolate-hexen-pc-iwad",
    "hexendemo.wad",
    "chocolate-hexen.exe",
    "hex0\\.hxs$",
    "472a0d039acab04d0f93cb5d348ddd623270563c7c15b9b4b601e3b0f35acf23",
  ],
];
const playerDigests = JSON.parse(await readFile("scripts/chocolate-hosted-players.json", "utf8"));
const config = {
  sdk: pathToFileURL(path.resolve("product") + path.sep).href,
  product_source: source,
  checkout: manifest.identity.source,
  controller_source: process.env.GITHUB_SHA,
  cli: path.join(root, "portcove.exe"),
  cli_sha256: executables.cli.sha256,
  core_test: path.join(root, "core-tests.exe"),
  core_test_sha256: executables.core.sha256,
  alias_temp: path.join(root, "alias-temp"),
  library: path.join(root, "library"),
  evidence_dir: evidence,
  global_chocolate_root: process.env.CHOCOLATE_KNOWN_ROAMING,
  ui_helper: path.resolve("scripts/chocolate-hosted-ui.ps1"),
  scenarios: ["public-original-core-lifecycle", "exact-short-alias-fixtures"],
  titles: [],
};
assert(
  config.global_chocolate_root?.endsWith("chocolate-doom"),
  "Observed roaming Known Folder missing",
);
for (const [port, profile, name, player, save_pattern, package_sha256] of titles) {
  const b = await readFile(path.join(root, "originals", name));
  config.titles.push({
    port,
    profile,
    player,
    player_sha256: playerDigests[player],
    original: path.join(root, "originals", name),
    original_sha256: createHash("sha256").update(b).digest("hex"),
    save_pattern,
    package_sha256,
  });
}
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
      checkout: manifest.identity.source,
      target: checkout.parents[0].sha,
      tree: checkout.tree.sha,
      executables,
      original_packets: originalPackets.map(([name, url, sha256]) => ({
        name,
        url,
        sha256,
        authority:
          name === "doom19s.zip"
            ? "transport consistency only; raw IWAD uses published GDP89 SHA1"
            : "versioned GDP89 published SHA256",
      })),
      scope: "ordinary source-bound producer; native execution has its own result",
    },
    null,
    2,
  ),
);
await writeFile(
  path.join(evidence, "producer-manifest.json"),
  await readFile(path.join(root, "manifest.json")),
);
console.log(
  JSON.stringify({
    prepared: true,
    source,
    run,
    attempt,
    artifact,
    cli_sha256: executables.cli.sha256,
    core_test_sha256: executables.core.sha256,
  }),
);
