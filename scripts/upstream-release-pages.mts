/** Read back the fixed disposable Pages rehearsal feed. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rehearsalOrigin, rehearsalPublicBase } from "./upstream-release-identity.mts";
import { rehearsalEntry, inspectRehearsalFeed } from "./upstream-release-rehearsal.mts";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const signedDirectory = "work/upstream-signed";
const publicOrigin = "https://boburning.github.io/portcove/";

async function publicBytes(url: string): Promise<Buffer | null> {
  if (!url.startsWith(publicOrigin)) throw new Error("public read left the fixed Pages origin");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "Cache-Control": "no-cache" },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length") ?? "0") > 2 * 1024 ** 2
  )
    throw new Error("bounded public Pages read refused");
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const value of response.body) {
    const chunk: unknown = value;
    assert.ok(chunk instanceof Uint8Array);
    total += chunk.byteLength;
    if (total > 2 * 1024 ** 2) throw new Error("public Pages file exceeded its streaming bound");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

async function feeds() {
  const origin = rehearsalOrigin();
  for (const name of ["baseline-feed.json", "feed.json"]) {
    if ((await rehearsalEntry(signedDirectory, name)).bytes > 2 * 1024 ** 2)
      throw new Error("public feed transfer exceeds its metadata bound");
  }
  const baseline = inspectRehearsalFeed(
    JSON.parse(await readFile(path.join(signedDirectory, "baseline-feed.json"), "utf8")),
  );
  const candidate = inspectRehearsalFeed(
    JSON.parse(await readFile(path.join(signedDirectory, "feed.json"), "utf8")),
  );
  const root = await rehearsalEntry(signedDirectory, "trusted-root.json");
  for (const files of [baseline, candidate]) {
    const bundledRoot = files.find((file) => file.path === "metadata/1.root.json");
    assert.ok(bundledRoot && sha256(bundledRoot.text) === root.sha256);
  }
  const timestamp = (files: typeof baseline) => {
    const file = files.find((value) => value.path === "metadata/timestamp.json");
    assert.ok(file);
    return sha256(file.text);
  };
  return {
    origin,
    baseline,
    candidate,
    baselineTimestamp: timestamp(baseline),
    candidateTimestamp: timestamp(candidate),
  };
}

async function verifyPublicFiles(state: "baseline" | "candidate") {
  const data = await feeds(),
    base = rehearsalPublicBase(data.origin);
  for (const file of data[state]) {
    const actual = await publicBytes(`${base}${file.path}`);
    assert.ok(
      actual && actual.equals(Buffer.from(file.text)),
      `public rehearsal byte mismatch: ${file.path}`,
    );
  }
}

async function observe(phase: "baseline" | "candidate") {
  const data = await feeds(),
    manifest = await rehearsalEntry(signedDirectory, "rehearsal.json");
  const initial = await publicBytes(`${rehearsalPublicBase(data.origin)}metadata/timestamp.json`);
  const state =
    phase === "baseline" && initial && sha256(initial) === data.candidateTimestamp
      ? "candidate"
      : phase;
  const wanted = state === "baseline" ? data.baselineTimestamp : data.candidateTimestamp;
  let actual: Buffer | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    actual = await publicBytes(`${rehearsalPublicBase(data.origin)}metadata/timestamp.json`);
    if (actual && sha256(actual) === wanted) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  assert.ok(
    actual && sha256(actual) === wanted,
    "public deployment did not reach its exact intended feed",
  );
  await verifyPublicFiles(state);
  await writeFile(
    "work/upstream-site-result.json",
    `${JSON.stringify({ scope: "actual-public-disposable-feed-byte-readback", origin: data.origin, requested_phase: phase, phase: state, timestamp_sha256: wanted, manifest_sha256: manifest.sha256, production: false })}\n`,
    { flag: "wx" },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, phase] = process.argv.slice(2);
  if (phase !== "baseline" && phase !== "candidate")
    throw new Error("fixed baseline|candidate phase required");
  if (operation !== "observe") throw new Error("expected observe baseline|candidate");
  await observe(phase);
}
