/** Bounded, anonymous reads of Portcove's public GitHub releases. No token or
 * credential is sent: release assets are fetched from the public download
 * route and API reads are unauthenticated GETs of fixed endpoints. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const repository = "boburning/portcove";
const coordinate = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

/** Stream one public release asset with at most one redirect to GitHub's
 * release-asset origin and at most `maximumBytes` bytes. `label` names the
 * caller in every refusal; the bytes are returned unverified. */
export async function downloadPortcoveReleaseAsset(
  tag: string,
  name: string,
  maximumBytes: number,
  label = "Portcove",
) {
  for (const segment of [tag, name])
    if (!coordinate.test(segment)) throw new Error(`Invalid ${label} release asset coordinate`);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error(`Invalid ${label} release asset bound`);
  let url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 1; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal });
    if (response.status === 302) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      assert.ok(location && redirects === 0, `${label} release redirect limit`);
      const next = new URL(location, url);
      assert.ok(
        next.protocol === "https:" &&
          next.hostname === "release-assets.githubusercontent.com" &&
          !next.username &&
          !next.password &&
          !next.port,
        `${label} release redirect refused`,
      );
      url = next.href;
      continue;
    }
    assert.equal(response.status, 200, `${label} public release unavailable`);
    assert.ok(response.body);
    const chunks: Uint8Array[] = [];
    let count = 0;
    for await (const raw of response.body) {
      const chunk: unknown = raw;
      assert.ok(chunk instanceof Uint8Array, `${label} download stream representation`);
      count += chunk.byteLength;
      assert.ok(count <= maximumBytes, `${label} download byte bound`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`${label} release redirect limit`);
}

/** Download one asset and require its exact size and SHA-256. */
export async function downloadPinnedPortcoveReleaseAsset(
  tag: string,
  pin: { name: string; bytes: number; sha256: string },
  label = "Portcove",
) {
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || !/^[a-f0-9]{64}$/u.test(pin.sha256))
    throw new Error(`Invalid ${label} release asset pin`);
  const bytes = await downloadPortcoveReleaseAsset(tag, pin.name, pin.bytes, label);
  assert.equal(bytes.length, pin.bytes, `${label} release asset size differs`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    pin.sha256,
    `${label} release asset digest differs`,
  );
  return bytes;
}

/** One anonymous, bounded GET of a fixed public API path of this repository. */
export async function fetchPublicPortcoveApi(route: string, maximumBytes = 1024 * 1024) {
  if (!/^(?:releases\/tags|attestations|git\/ref\/tags|git\/tags)\/[a-zA-Z0-9._:-]+$/u.test(route))
    throw new Error("Invalid public Portcove API route");
  const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Public Portcove API ${route.split("/")[0]} unavailable (${response.status})`);
  }
  assert.ok(response.body);
  const chunks: Uint8Array[] = [];
  let count = 0;
  for await (const raw of response.body) {
    const chunk: unknown = raw;
    assert.ok(chunk instanceof Uint8Array, "Public Portcove API stream representation");
    count += chunk.byteLength;
    assert.ok(count <= maximumBytes, "Public Portcove API byte bound");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
