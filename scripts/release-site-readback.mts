import { createHash } from "node:crypto";
import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";
import { isSafeSitePath } from "./release-site-composer.mts";

const origin = "https://boburning.github.io/portcove/";
const maximumFiles = 6000;
const maximumBytes = 256 * 1024 * 1024;
const maximumFileBytes = 64 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

function marker(value: unknown, expected: string) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "application_root_sha256,files,generation,previous_generation,schema_version" ||
    value.schema_version !== 1 ||
    value.generation !== expected ||
    !digest(value.application_root_sha256) ||
    !(value.previous_generation === null || digest(value.previous_generation)) ||
    !Array.isArray(value.files) ||
    value.files.length > maximumFiles
  )
    throw new Error("public site generation schema differs");
  const seen = new Set<string>();
  let total = 0;
  const files = value.files.map((file: unknown) => {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,path,sha256" ||
      typeof file.path !== "string" ||
      file.path.length > 512 ||
      !/^(?:\.nojekyll|(?:application\/(?:metadata|targets)|catalog)\/)/u.test(file.path) ||
      !isSafeSitePath(file.path) ||
      seen.has(file.path) ||
      !digest(file.sha256) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > maximumFileBytes
    )
      throw new Error("public site inventory differs");
    seen.add(file.path);
    total += file.bytes;
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  if (
    total > maximumBytes ||
    !seen.has("application/metadata/timestamp.json") ||
    !seen.has(".nojekyll") ||
    JSON.stringify(files.map((file) => file.path)) !== JSON.stringify([...seen].sort())
  )
    throw new Error("public site inventory bound/order differs");
  const unsigned = {
    schema_version: 1,
    previous_generation: value.previous_generation,
    application_root_sha256: value.application_root_sha256,
    files,
  };
  if (capacityDigest(unsigned) !== expected)
    throw new Error("public site inventory digest differs");
  return { ...unsigned, generation: expected };
}

function publicReader(deadline: number) {
  let consumed = 0;
  return async (name: string, limit: number) => {
    const timeout = Math.floor(Math.min(30_000, deadline - performance.now()));
    if (timeout <= 0) throw new Error("public site readback deadline exceeded");
    const url = new URL(name, origin).href;
    const response = await fetch(url, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/octet-stream", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status !== 200 || response.url !== url || !response.body) {
      await response.body?.cancel();
      throw new Error(`public site response unavailable: ${name}`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
      await response.body.cancel();
      throw new Error(`public site declared length exceeds bound: ${name}`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const bytes: unknown = item.value;
        if (!(bytes instanceof Uint8Array)) throw new Error("public site stream is not bytes");
        size += bytes.length;
        consumed += bytes.length;
        if (size > limit || consumed > maximumBytes + 8 * 1024 * 1024)
          throw new Error(`public site streamed bytes exceed bound: ${name}`);
        chunks.push(bytes);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  };
}

/** Independent credential-free HTTP readback of the exact already-authenticated
 * complete site. The expected marker must come from actual trusted composition,
 * never from the server being checked. This does not enumerate unlisted URLs,
 * authenticate a deployment actor or grant publication/settlement authority. */
export async function readPublicApplicationSite(expectedMarker: unknown) {
  if (!isRecord(expectedMarker) || !digest(expectedMarker.generation))
    throw new Error("independently expected site generation unavailable");
  const expected = marker(expectedMarker, expectedMarker.generation);
  const deadline = performance.now() + 120_000;
  const observations: { path: string; bytes: number; sha256: string }[] = [];
  const read = publicReader(deadline);
  const first = await read("publication.json", 4 * 1024 * 1024);
  const observed: unknown = JSON.parse(first.toString("utf8"));
  if (JSON.stringify(marker(observed, expected.generation)) !== JSON.stringify(expected))
    throw new Error("public marker differs from trusted expected site");
  for (const file of expected.files) {
    const bytes = await read(file.path, file.bytes);
    const actual = { path: file.path, bytes: bytes.length, sha256: hash(bytes) };
    observations.push(actual);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error(`public site bytes differ: ${file.path}`);
  }
  const last = await read("publication.json", 4 * 1024 * 1024);
  if (!first.equals(last)) throw new Error("public generation changed during readback");
  return {
    authority: "none",
    origin,
    generation: expected.generation,
    application_root_sha256: expected.application_root_sha256,
    marker_sha256: hash(first),
    files: observations,
    evidence_sha256: capacityDigest({ generation: expected.generation, files: observations }),
    scope: "exact expected public bytes; no unlisted-path or deployment-actor claim",
  };
}

/** Lightweight late bracket over a previously independently verified complete
 * generation. Marker equality is not a substitute for that prior byte readback. */
export async function readPublicApplicationSiteMarker(expectedMarker: unknown) {
  if (!isRecord(expectedMarker) || !digest(expectedMarker.generation))
    throw new Error("independently expected site generation unavailable");
  const expected = marker(expectedMarker, expectedMarker.generation);
  const bytes = await publicReader(performance.now() + 30_000)("publication.json", 4 * 1024 * 1024);
  const observed: unknown = JSON.parse(bytes.toString("utf8"));
  if (JSON.stringify(marker(observed, expected.generation)) !== JSON.stringify(expected))
    throw new Error("public marker differs from trusted expected site");
  return {
    generation: expected.generation,
    marker_sha256: hash(bytes),
    authority: "none",
    scope: "expected generation marker only",
  };
}
