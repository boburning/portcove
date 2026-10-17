import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = stripTypeScriptTypes(
  await readFile(new URL("./desktop-artwork-test.mts", import.meta.url), "utf8"),
  { mode: "strip" },
);
function segment(from: string, until: string) {
  const start = source.indexOf(from),
    end = source.indexOf(until, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
void test("serialized local artwork fallback preserves generated identity and geometry", async () => {
  const image = {};
  const title = { textContent: "original" };
  const frame = {
    classList: ["detail-cover", "palette-3", "retained-class"],
    dataset: { artworkSource: "generated_fallback" },
    querySelector: (selector: string) => (selector === "img" ? image : { textContent: "OW" }),
    getBoundingClientRect: () => ({ width: 200, height: 300 }),
    contains: (element: unknown) => element !== title,
  };
  let available = true;
  const document = {
    querySelector: (selector: string) =>
      selector === "#port-detail-title" ? title : available ? frame : null,
  };
  const executeBrowserScript = (
    _browser: unknown,
    callback: unknown,
    ...args: unknown[]
  ): unknown => {
    assert.ok(typeof callback === "function");
    return runInNewContext(
      `(${callback.toString()})(...args)`,
      { document, args, getComputedStyle: () => ({ objectFit: "contain" }) },
      { timeout: 1000 },
    );
  };
  const browser = {};
  const fallback = segment("const fallbackVisual = async", "const expectFallbackVisual = async");
  const observation: unknown = await runInNewContext(
    `(async () => {${fallback} return fallbackVisual(".detail-cover");})()`,
    { executeBrowserScript, browser },
  );
  assert.equal(
    JSON.stringify(observation),
    JSON.stringify({ source: "generated_fallback", initials: "OW", palette: "palette-3" }),
  );
  const geometry = segment(
    "const geometry = await executeBrowserScript",
    "assert.ok(Math.abs(geometry.ratio",
  );
  const measured: unknown = await runInNewContext(
    `(async () => {${geometry} return geometry;})()`,
    { executeBrowserScript, browser },
  );
  assert.equal(
    JSON.stringify(measured),
    JSON.stringify({ ratio: 2 / 3, fit: "contain", titleOutsideImage: true }),
  );
  available = false;
  await assert.rejects(
    (async () => {
      await runInNewContext(
        `(async () => {${fallback} return fallbackVisual(".detail-cover");})()`,
        { executeBrowserScript, browser },
      );
    })(),
    /Artwork frame unavailable/,
  );
});
