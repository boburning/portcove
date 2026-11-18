import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
const source = "1e3fbb9bbe42fcdd97822280a94d97163643a422",
  run = 44331666488,
  attempt = 1,
  artifact = 14444465879;
const expectedZip = "65a292bc4fe3445e2bc87cf99b63d1afc9aa4370e9f81c61b20baebf9c31f947";
const root = path.join("C:\\pcv", process.env.GITHUB_RUN_ID + "-" + process.env.GITHUB_RUN_ATTEMPT);
const evidence = path.join(root, "evidence", "desktop-verify", "carry-alias", "native");
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
    meta.size_in_bytes === 186405809 &&
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
  library: path.join(root, "unused-library"),
  evidence_dir: evidence,
  global_chocolate_root: null,
  ui_helper: null,
  scenarios: ["native-short-file-alias-preservation", "native-short-directory-alias-preservation"],
  titles: [],
};
await writeFile(path.join(root, "native-config.json"), JSON.stringify(config, null, 2));
await writeFile(
  path.join(evidence, "producer.json"),
  JSON.stringify(
    {
      source,
      run,
      attempt,
      artifact,
      expected_zip_sha256: expectedZip,
      executables,
      scope: "ordinary exact-source producer; only two Core filesystem fixtures will execute",
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
    core_test_sha256: executables.core.sha256,
  }),
);
