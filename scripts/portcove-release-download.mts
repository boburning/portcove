import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export async function downloadPinnedPortcoveReleaseAsset(
  tag: string,
  pin: { name: string; bytes: number; sha256: string },
) {
  for (const segment of [tag, pin.name]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(segment))
      throw new Error("Invalid Portcove release asset coordinate");
  }
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || !/^[a-f0-9]{64}$/u.test(pin.sha256))
    throw new Error("Invalid Portcove release asset pin");
  let url = `https://github.com/boburning/portcove/releases/download/${tag}/${pin.name}`;
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 1; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal });
    if (response.status === 302) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      assert.ok(location && redirects === 0, "Portcove release redirect limit");
      const next = new URL(location, url);
      assert.ok(
        next.protocol === "https:" &&
          next.hostname === "release-assets.githubusercontent.com" &&
          !next.username &&
          !next.password &&
          !next.port,
        "Portcove release redirect refused",
      );
      url = next.href;
      continue;
    }
    assert.equal(response.status, 200, "Portcove public release unavailable");
    assert.ok(response.body);
    const chunks: Uint8Array[] = [];
    let count = 0;
    for await (const raw of response.body) {
      const chunk: unknown = raw;
      assert.ok(chunk instanceof Uint8Array, "Portcove download stream representation");
      count += chunk.byteLength;
      assert.ok(count <= pin.bytes, "Portcove download byte bound");
      chunks.push(chunk);
    }
    const result = Buffer.concat(chunks);
    assert.equal(result.length, pin.bytes, "Portcove release asset size differs");
    assert.equal(
      createHash("sha256").update(result).digest("hex"),
      pin.sha256,
      "Portcove release asset digest differs",
    );
    return result;
  }
  throw new Error("Portcove release redirect limit");
}
