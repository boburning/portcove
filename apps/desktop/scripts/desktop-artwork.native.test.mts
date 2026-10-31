import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
type Artwork = typeof import("./desktop-artwork-test.mts");
type ArtworkReader = "readArtworkFallback" | "readArtworkGeometry" | "waitForArtworkImage";
function runContract(options?: {
  alias?: ArtworkReader;
  disabled?: ArtworkReader;
  expected?: string;
}) {
  return runDesktopModuleFixture(
    new URL("./desktop-artwork-test.mts", import.meta.url),
    `
      import {runInNewContext} from 'node:vm';
      const actual=await import(entry);
      const disabled=${JSON.stringify(options?.disabled ?? null)};
      const subject=disabled?{...actual,[disabled]:()=>({})}:actual;
      let rejected=false;
      try { await (${artworkContract.toString()})(subject); }
      catch(error) {
        if(error?.code==='ERR_ASSERTION')console.error('ARTWORK_CONTRACT_ASSERTION '+error.message);
        if(!disabled||error?.code!=='ERR_ASSERTION'||!error.message.includes(${JSON.stringify(options?.expected ?? null)}))throw error;
        rejected=true;console.log('ARTWORK_EXPECTED_BEHAVIORAL_REJECTION '+disabled);
      }
      if(disabled)assert.equal(rejected,true,'Disabled callback unexpectedly retained its behavior');
      else console.log('ARTWORK_CONTRACT_OK');
    `,
    options?.alias ? { exportName: options.alias, variant: "aliased" } : undefined,
  );
}
async function artworkContract(subject: Artwork) {
  const image = { naturalWidth: 200, naturalHeight: 300 };
  const title = { textContent: "original" };
  let quiet = false;
  let showImage = false;
  const frame = {
    classList: ["collection-art", "[--art-color:var(--color-art-indigo)]", "retained-class"],
    dataset: { artworkSource: "generated_fallback" },
    querySelector: (selector: string) =>
      selector === "img"
        ? showImage
          ? image
          : null
        : selector === ':scope > span > svg[aria-hidden="true"]'
          ? quiet
            ? {}
            : null
          : selector === ":scope > span"
            ? { textContent: quiet ? "" : "OW" }
            : null,
    querySelectorAll: (selector: string) => {
      assert.equal(selector, "img", "Count actual artwork images");
      return showImage ? [image] : [];
    },
    getBoundingClientRect: () => ({ width: 420, height: 300 }),
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
      selector === "#port-detail-title"
        ? title
        : (selector === ".collection-art" ||
              selector === ".game-hero-detail .game-hero-foreground") &&
            available
          ? frame
          : null,
  };
  let probeFailure: Error | undefined;
  const execute = (callback: unknown, ...args: unknown[]): unknown => {
    assert.ok(typeof callback === "function");
    return runInNewContext(
      `(${callback.toString()})(...args)`,
      {
        document,
        args,
        getComputedStyle: (element: unknown) => {
          if (element === probe && probeFailure) throw probeFailure;
          return {
            objectFit: element === image ? "contain" : "cover",
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
          };
        },
      },
      { timeout: 1000 },
    );
  };
  const browser = {
    executeScript: async (callback: unknown, ...args: unknown[]) => execute(callback, ...args),
  };
  const invokeBrowser = (callback: unknown, ...args: unknown[]): unknown => {
    assert.ok(typeof callback === "function", "Retain the actual artwork reader function");
    return Reflect.apply(callback, undefined, [browser, ...args]);
  };
  const observation = await invokeBrowser(subject.readArtworkFallback, ".collection-art", 3, false);
  assert.deepEqual(
    structuredClone(observation),
    {
      source: "generated_fallback",
      initials: "OW",
      images: 0,
      decorativeIcon: false,
      palette: "#5f56cd",
      expectedPalette: "#5f56cd",
      background: "rgb(95, 86, 205)",
      expectedBackground: "rgb(95, 86, 205)",
    },
    "Generated artwork fallback observation",
  );
  quiet = true;
  const quietObservation = await invokeBrowser(
    subject.readArtworkFallback,
    ".collection-art",
    3,
    true,
  );
  assert.deepEqual(structuredClone(quietObservation), {
    source: "generated_fallback",
    initials: "",
    images: 0,
    decorativeIcon: true,
    palette: "#202020",
    expectedPalette: "#202020",
    background: "rgb(32, 32, 32)",
    expectedBackground: "rgb(32, 32, 32)",
  });
  quiet = false;
  showImage = true;
  assert.equal(removed, true, "color probe must not remain in the rendered tree");
  const loadedFrame = await invokeBrowser(subject.readArtworkFallback, ".collection-art", 3, false);
  assert.ok(loadedFrame !== null && typeof loadedFrame === "object");
  assert.equal(
    Reflect.get(loadedFrame, "images"),
    1,
    "Retain the actual present artwork image count",
  );
  let measured: unknown;
  await assert.doesNotReject(async () => {
    measured = await invokeBrowser(subject.readArtworkGeometry);
  }, "Measured artwork geometry");
  assert.deepEqual(
    structuredClone(measured),
    { ratio: 2 / 3, fit: "contain", titleOutsideImage: true },
    "Measured artwork geometry",
  );
  available = false;
  await assert.rejects(
    Promise.resolve(invokeBrowser(subject.readArtworkFallback, ".collection-art", 3, false)),
    /Artwork frame unavailable/,
  );
  await assert.rejects(
    Promise.resolve(invokeBrowser(subject.readArtworkGeometry)),
    /Artwork frame unavailable/,
  );
  available = true;
  showImage = false;
  await assert.rejects(
    Promise.resolve(invokeBrowser(subject.readArtworkGeometry)),
    /Artwork image unavailable/,
  );
  await assert.rejects(
    Promise.resolve(invokeBrowser(subject.readArtworkFallback, ".collection-art", 6, false)),
    /Unknown generated artwork palette/,
  );
  removed = false;
  probeFailure = new Error("controlled artwork probe style failure");
  await assert.rejects(
    Promise.resolve(invokeBrowser(subject.readArtworkFallback, ".collection-art", 3, false)),
    (error) => error === probeFailure,
  );
  assert.equal(removed, true, "color probe cleanup must run when style observation fails");

  // A lazy foreground does not exist until its stable outer hero is revealed.
  // An already-rendered wide preview keeps the ordinary default anchor route.
  let revealed = false;
  let imagePresent = true;
  let decoded = true;
  const revealFrame = {
    scrollIntoView: () => {
      revealed = true;
    },
  };
  const hero = ".game-hero-detail";
  const heroImage = `${hero} .game-hero-foreground img`;
  const wideImage = ".wide-artwork img";
  const visibilityDocument = {
    querySelector: (selector: string) => {
      assert.ok(selector === heroImage || selector === wideImage);
      return revealed && imagePresent
        ? { complete: decoded, naturalWidth: decoded ? 384 : 0 }
        : null;
    },
  };
  const visibilityBrowser = {
    findElements: async (locator: unknown) => {
      assert.ok(locator !== null && typeof locator === "object");
      const value: unknown = Reflect.get(locator, "value");
      return value === hero ||
        value === ".wide-artwork" ||
        (revealed && value === `${hero} .game-hero-foreground`)
        ? [revealFrame]
        : [];
    },
    executeScript: async (callback: unknown, ...args: unknown[]) => {
      assert.ok(typeof callback === "function" || typeof callback === "string");
      const value: unknown = runInNewContext(
        typeof callback === "string"
          ? `(function(){${callback}})(...args)`
          : `(${callback.toString()})(...args)`,
        { document: visibilityDocument, args },
        { timeout: 1000 },
      );
      return value;
    },
    wait: async (condition: unknown, deadline: number, message?: string): Promise<unknown> => {
      assert.equal(deadline, 10_000, "Retain the finite artwork wait budget");
      let result: unknown;
      if (typeof condition === "function") result = await Reflect.apply(condition, undefined, []);
      else {
        assert.ok(condition !== null && typeof condition === "object");
        // The existing isolated module fixture represents elementLocated as
        // its inert locator; no real Selenium package crosses that boundary.
        if (Reflect.get(condition, "using") === "css selector") {
          result = (await visibilityBrowser.findElements(condition))[0];
        } else {
          const evaluate: unknown = Reflect.get(condition, "fn");
          assert.ok(typeof evaluate === "function");
          result = await Reflect.apply(evaluate, condition, [visibilityBrowser]);
        }
      }
      if (!result) throw new Error(message ?? "Artwork reveal anchor unavailable");
      return result;
    },
  };
  const waitImage = async (selector: string, anchor?: string): Promise<unknown> => {
    const value: unknown = Reflect.apply(subject.waitForArtworkImage, undefined, [
      visibilityBrowser,
      selector,
      anchor,
    ]);
    return value;
  };
  await waitImage(heroImage, hero);
  assert.equal(revealed, true, "Reveal actual lazy hero before reading its foreground");
  revealed = false;
  await assert.rejects(waitImage(heroImage), /Artwork reveal anchor unavailable/);
  await waitImage(wideImage);
  assert.equal(revealed, true);
  imagePresent = false;
  await assert.rejects(waitImage(heroImage, hero), /Core thumbnail must render/);
  imagePresent = true;
  decoded = false;
  await assert.rejects(waitImage(heroImage, hero), /Core thumbnail must render/);
}
void test("serialized local artwork fallback preserves generated identity and geometry", () => {
  assert.match(runContract(), /ARTWORK_CONTRACT_OK/u);
  assert.match(runContract({ alias: "readArtworkFallback" }), /ARTWORK_CONTRACT_OK/u);
  assert.match(runContract({ alias: "readArtworkGeometry" }), /ARTWORK_CONTRACT_OK/u);
  assert.match(runContract({ alias: "waitForArtworkImage" }), /ARTWORK_CONTRACT_OK/u);
});
void test("artwork observations reject disabled production callbacks by their behavioral assertions", () => {
  for (const [disabled, expected] of [
    ["readArtworkFallback", "Generated artwork fallback observation"],
    ["readArtworkGeometry", "Measured artwork geometry"],
    ["waitForArtworkImage", "Reveal actual lazy hero before reading its foreground"],
  ] as const) {
    assert.match(runContract({ disabled, expected }), /ARTWORK_EXPECTED_BEHAVIORAL_REJECTION/u);
  }
});
