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
  let quiet = false;
  let showImage = false;
  const frame = {
    classList: ["detail-cover", "[--art-color:var(--color-art-indigo)]", "retained-class"],
    dataset: { artworkSource: "generated_fallback" },
    querySelector: (selector: string) =>
      selector === "img"
        ? showImage
          ? image
          : null
        : selector.includes("svg")
          ? quiet
            ? {}
            : null
          : { textContent: quiet ? "" : "OW" },
    querySelectorAll: () => (showImage ? [image] : []),
    getBoundingClientRect: () => ({ width: 200, height: 300 }),
    contains: (element: unknown) => element !== title,
  };
  let available = true;
  let removed = false;
  const probe = {
    style: {},
    remove: () => {
      removed = true;
    },
  };
  const root = {};
  const document = {
    documentElement: root,
    body: { append: (element: unknown) => assert.equal(element, probe) },
    createElement: (tag: string) => {
      assert.equal(tag, "span");
      return probe;
    },
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
      {
        document,
        args,
        getComputedStyle: (element: unknown) => ({
          objectFit: "contain",
          backgroundColor: quiet ? "rgb(32, 32, 32)" : "rgb(95, 86, 205)",
          getPropertyValue: (name: string) => {
            assert.equal(
              name,
              element === root
                ? quiet
                  ? "--color-bg-subtle"
                  : "--color-art-indigo"
                : "--art-color",
            );
            return quiet ? "#202020" : "#5f56cd";
          },
        }),
      },
      { timeout: 1000 },
    );
  };
  const browser = {};
  const fallback = segment("const fallbackVisual = async", "const expectFallbackVisual = async");
  const observation: unknown = await runInNewContext(
    `(async () => {${fallback} return fallbackVisual(".detail-cover", 3);})()`,
    { executeBrowserScript, browser },
  );
  assert.equal(
    JSON.stringify(observation),
    JSON.stringify({
      source: "generated_fallback",
      initials: "OW",
      images: 0,
      decorativeIcon: false,
      palette: "#5f56cd",
      expectedPalette: "#5f56cd",
      background: "rgb(95, 86, 205)",
      expectedBackground: "rgb(95, 86, 205)",
    }),
  );
  quiet = true;
  const quietObservation: unknown = await runInNewContext(
    `(async () => {${fallback} return fallbackVisual(".detail-cover", 3, true);})()`,
    { executeBrowserScript, browser },
  );
  assert.equal(
    JSON.stringify(quietObservation),
    JSON.stringify({
      source: "generated_fallback",
      initials: "",
      images: 0,
      decorativeIcon: true,
      palette: "#202020",
      expectedPalette: "#202020",
      background: "rgb(32, 32, 32)",
      expectedBackground: "rgb(32, 32, 32)",
    }),
  );
  quiet = false;
  showImage = true;
  assert.equal(removed, true, "color probe must not remain in the rendered tree");
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
        `(async () => {${fallback} return fallbackVisual(".detail-cover", 3);})()`,
        { executeBrowserScript, browser },
      );
    })(),
    /Artwork frame unavailable/,
  );
});
