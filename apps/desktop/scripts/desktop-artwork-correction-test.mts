import {
  fixtureSuccess as success,
  requiredFixtureValue as required,
  fixtureObject as object,
} from "./desktop-scenario-state.mts";
import type { BinaryLike } from "node:crypto";
import type { Locator, WebDriver } from "selenium-webdriver";
import type { ScenarioContext } from "./desktop-scenario-context.mts";
import type { ScenarioInvoke } from "./desktop-scenario-context.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { nativeConfirmation } from "./desktop-native-confirmation.mts";
import { transportValue } from "./transport-values.mts";
interface CorrectionContext extends ScenarioContext {
  invoke: ScenarioInvoke;
  command: FixtureCommand;
  confirmNative: ReturnType<typeof nativeConfirmation>;
  restartApplication: (name: string) => Promise<WebDriver>;
}
interface CorrectionWindow extends Window {
  __TAURI_INTERNALS__?: {
    transformCallback(callback: () => void): number;
    unregisterCallback(callback: number): void;
    invoke(command: string, args: unknown): Promise<unknown>;
  };
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function jsonObject(value: string) {
  const parsed: unknown = JSON.parse(value);
  return object(parsed);
}
function ports(value: unknown) {
  const entries = object(value).ports;
  assert.ok(Array.isArray(entries));
  const items: unknown[] = entries;
  return items.map(object);
}
import { executeBrowserScript } from "./browser-script.mts";
// Opt-in signed metadata proof. Test key/solid-color images are public fixtures;
// all trust, catalog mutation and cached bytes belong to this run's owned library.
import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { By, Key, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mts";

const digest = (bytes: BinaryLike) => createHash("sha256").update(bytes).digest("hex");

export async function artworkCorrectionScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  command,
  confirmNative,
  restartApplication,
}: CorrectionContext) {
  await scenario("native-artwork-catalog-correction", async () => {
    const bootstrap = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    );
    const library = await realpath(required(bootstrap.library_root));
    const relative = path.relative(await realpath(output), library);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const portId = "shipwright";
    const baseline = transportValue("catalog", success(await invoke("get_catalog")));
    const catalog = jsonObject(
      await readFile(
        new URL("../../../crates/portcove-core/catalog/catalog.json", import.meta.url),
        "utf8",
      ),
    );
    const originalPort = structuredClone(
      required(ports(catalog).find((port) => port.id === portId)),
    );
    const originalName = text(originalPort.name);
    const keyPath = path.join(output, "public-test-signing-key.pem");
    // Reuse signed_catalog_tests.rs's [7;32] public test seed, never a publisher key.
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.alloc(32, 7),
      ]),
      format: "der",
      type: "pkcs8",
    });
    await writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx" });
    const cache = path.join(library, "artwork-cache");
    await mkdir(cache, { recursive: true });
    const mappings = new Map<string, Record<string, unknown>>();
    for (const color of ["red", "blue"]) {
      const bytes = await readFile(
        new URL(`testdata/catalog-artwork-${color}.jpg`, import.meta.url),
      );
      const identity = digest(bytes);
      await writeFile(path.join(cache, `${identity}.jpg`), bytes, { flag: "wx" });
      mappings.set(color, {
        ...object(object(originalPort.presentation).artwork),
        image_id: `portcovetest${color}`,
        image_sha256: identity,
      });
    }
    const signed = async (
      sequence: number,
      mapping: Record<string, unknown> | null,
      name: string,
    ) => {
      const document = structuredClone(catalog);
      object(required(ports(document).find((port) => port.id === portId)).presentation).artwork =
        mapping;
      const source = path.join(output, `${name}-catalog.json`);
      const envelope = path.join(output, `${name}-signed.json`);
      await writeFile(source, JSON.stringify(document), { flag: "wx" });
      const now = Math.floor(Date.now() / 1000);
      const result = spawnCommand(
        process.execPath,
        [
          fileURLToPath(new URL("../../../scripts/sign-catalog.mts", import.meta.url)),
          "--catalog",
          source,
          "--key",
          keyPath,
          "--sequence",
          String(sequence),
          "--issued-at",
          String(now - 60),
          "--expires-at",
          String(now + 3600),
          "--output",
          envelope,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 5000 },
      );
      assert.equal(result.status, 0, result.stderr);
      artifacts.push(source, envelope);
      const resultValue = jsonObject(result.stdout);
      return {
        envelope,
        public_key: text(resultValue.public_key),
        key_id: text(resultValue.key_id),
      };
    };
    const red = await signed(1, required(mappings.get("red")), "red");
    const blue = await signed(2, required(mappings.get("blue")), "blue");
    const status = async () => {
      return transportValue("catalog_status", success(await invoke("get_catalog_status")));
    };
    const button = (label: string) => By.xpath(`//button[normalize-space(.)="${label}"]`);
    const click = async (locator: Locator) => {
      const element = await browser.wait(until.elementLocated(locator), 10000);
      await executeBrowserScript(
        browser,
        (element) => element.scrollIntoView({ block: "center" }),
        element,
      );
      await browser.wait(until.elementIsEnabled(element), 5000);
      await element.click();
    };
    const dialog = By.css('[aria-labelledby="catalog-update-title"]');
    const open = async () => {
      await click(By.xpath('//nav//button[contains(., "Settings")]'));
      await click(button("Manage catalog updates"));
      await browser.wait(until.elementLocated(dialog), 10000);
      await browser.wait(until.elementLocated(By.id("catalog-public-key")), 10000);
    };
    const close = async () => {
      await click(button("Close"));
      await browser.wait(async () => (await browser.findElements(dialog)).length === 0, 5000);
    };
    const review = async (file: string) => {
      const field = await browser.findElement(By.id("catalog-update-location"));
      await field.sendKeys(Key.CONTROL, "a", Key.NULL, file);
      await click(button("Review update"));
    };
    const apply = async (file: string, sequence: number) => {
      await open();
      await review(file);
      await browser.wait(
        until.elementLocated(By.css('[aria-label="Catalog update review"]')),
        10000,
      );
      const affected = await browser.findElement(By.css('[aria-label="Affected ports"]')).getText();
      assert.ok(affected.includes(originalName));
      await click(button("Apply catalog update"));
      await browser.wait(async () => (await status()).provenance.sequence === sequence, 10000);
      await close();
    };
    const render = async (source: string) => {
      await click(By.xpath('//nav//button[contains(., "Discover")]'));
      const search = await browser.wait(until.elementLocated(By.id("port-search")), 10000);
      await search.sendKeys(Key.CONTROL, "a", Key.NULL, originalName);
      const selector = `[data-detail-origin="catalog:card:${portId}"] .collection-art`;
      await browser.wait(
        () =>
          executeBrowserScript(
            browser,
            (selector, source) => {
              const frame = document.querySelector<HTMLElement>(selector);
              const image = frame?.querySelector("img");
              return (
                frame?.dataset.artworkSource === source &&
                (source === "generated_fallback"
                  ? !image
                  : image?.complete && image.naturalWidth > 0)
              );
            },
            selector,
            source,
          ),
        15000,
        `Corrected artwork did not render: ${source}`,
      );
      return executeBrowserScript(
        browser,
        (selector) => {
          const frame = document.querySelector<HTMLElement>(selector);
          if (!frame) throw new Error("Artwork frame unavailable");
          const image = frame.querySelector("img");
          let pixel: number[] | null = null;
          if (image) {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Canvas context unavailable");
            context.drawImage(image, 0, 0, 1, 1);
            pixel = [...context.getImageData(0, 0, 1, 1).data];
          }
          return { source: frame.dataset.artworkSource, image: image?.src ?? null, pixel };
        },
        selector,
      );
    };
    const capture = async (name: string) => {
      const filename = path.join(output, `${name}.png`);
      await writeFile(filename, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
      artifacts.push(filename);
    };
    const artwork = () =>
      transportValue("artwork_state", command(["artwork", "show", portId], library));
    await open();
    await browser.findElement(By.id("catalog-public-key")).sendKeys(red.public_key);
    await click(button("Trust publisher"));
    await confirmNative(
      "Trust catalog publisher",
      "Trust publisher",
      red.key_id,
      "artwork-fixture-publisher",
    );
    await browser.wait(async () => (await status()).trusted_keys.length === 1, 10000);
    await close();
    await apply(red.envelope, 1);
    const first = await render("igdb_cover");
    assert.ok(required(required(first.pixel)[0]) > required(required(first.pixel)[2]) + 100);
    assert.deepEqual(object(artwork().resolved_source).artwork, required(mappings.get("red")));
    await capture("artwork-correction-red-fixture");
    const localPath = path.join(output, "owned-override.png");
    const localBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQCFgAAAGMAQm4OT/aAAAAAElFTkSuQmCC",
      "base64",
    );
    await writeFile(localPath, localBytes, { flag: "wx" });
    const imported = transportValue(
      "artwork_state",
      command(["artwork", "import", portId, localPath, "--expected-revision", "0"], library),
    );
    await apply(blue.envelope, 2);
    const local = await render("local_import");
    assert.deepEqual(artwork().choice, imported.choice);
    await capture("artwork-correction-local-override");
    command(["artwork", "reset", portId, "--expected-revision", "1"], library);
    await browser.navigate().refresh();
    const corrected = await render("igdb_cover");
    assert.ok(
      required(required(corrected.pixel)[2]) > required(required(corrected.pixel)[0]) + 100,
    );
    assert.notEqual(corrected.image, first.image);
    assert.deepEqual(object(artwork().resolved_source).artwork, required(mappings.get("blue")));
    await capture("artwork-correction-blue-fixture");
    browser = await restartApplication("artwork-correction");
    assert.deepEqual(
      await render("igdb_cover"),
      corrected,
      "Verified cached corrected pixels survive app restart",
    );
    const before = (await status()).state_sha256;
    const invalid = path.join(output, "invalid-signature.json");
    const fresh = await signed(3, required(mappings.get("red")), "fresh-signature");
    const tampered = jsonObject(await readFile(fresh.envelope, "utf8"));
    tampered.signature = "00".repeat(64);
    await writeFile(invalid, JSON.stringify(tampered), { flag: "wx" });
    artifacts.push(invalid);
    await open();
    await review(invalid);
    await browser.wait(
      until.elementLocated(By.css('.catalog-update-dialog [role="alert"]')),
      10000,
    );
    // The UI intentionally presents a general summary. Independently attribute
    // the same immutable rejected input through the existing read-only command.
    const signatureResult = object(
      await invoke("plan_catalog_update", {
        source: { kind: "file", value: invalid },
      }),
    );
    assert.equal(signatureResult.ok, false);
    const signatureError = object(signatureResult.error);
    assert.equal(signatureError.code, "verification");
    assert.match(text(signatureError.message), /catalog signature verification failed/i);
    assert.equal((await status()).state_sha256, before);
    await close();
    const stale = await signed(3, required(mappings.get("red")), "stale");
    await open();
    await review(stale.envelope);
    await browser.wait(until.elementLocated(By.css('[aria-label="Catalog update review"]')), 10000);
    const reviewedPlan = transportValue(
      "catalog_update_plan",
      success(
        await invoke("plan_catalog_update", {
          source: { kind: "file", value: stale.envelope },
        }),
      ),
    );
    const replacement = await signed(4, required(mappings.get("red")), "replacement");
    const reviewedBytes = await readFile(stale.envelope);
    const reviewedCopy = path.join(output, "stale-reviewed-envelope.json");
    await writeFile(reviewedCopy, reviewedBytes, { flag: "wx" });
    artifacts.push(reviewedCopy);
    await writeFile(stale.envelope, await readFile(replacement.envelope));
    await click(button("Apply catalog update"));
    await browser.wait(
      until.elementLocated(By.css('.catalog-update-dialog [role="alert"]')),
      10000,
    );
    // Repeat only the exact rejected stale intent to retain its machine reason;
    // the valid replacement is never supplied with fresh mutation authorization.
    const staleResult = jsonObject(
      text(
        await browser.executeAsyncScript<unknown>(
          (source: unknown, expectedPlan: string, done: (value: string) => void) => {
            const internals = (window as CorrectionWindow).__TAURI_INTERNALS__;
            if (!internals) throw new Error("Native bridge unavailable");
            const callback = internals.transformCallback(() => {});
            void internals
              .invoke("apply_catalog_update", {
                source,
                expectedPlan,
                onEvent: `__CHANNEL__:${callback}`,
              })
              .then(
                (value: unknown) => done(JSON.stringify({ ok: true, value })),
                (error: unknown) => done(JSON.stringify({ ok: false, error })),
              )
              .finally(() => internals.unregisterCallback(callback));
          },
          reviewedPlan.source,
          reviewedPlan.plan_sha256,
        ),
      ),
    );
    assert.equal(staleResult.ok, false);
    const staleError = object(staleResult.error);
    assert.equal(staleError.code, "conflict");
    assert.match(text(staleError.message), /catalog candidate or trust changed/i);
    assert.equal((await status()).state_sha256, before);
    await close();
    assert.deepEqual(await render("igdb_cover"), corrected);
    const withdrawal = await signed(5, null, "withdrawal");
    await apply(withdrawal.envelope, 5);
    assert.equal((await render("generated_fallback")).image, null);
    assert.equal(artwork().resolved_source.kind, "generated_fallback");
    assert.deepEqual(await readFile(localPath), localBytes);
    assert.deepEqual(
      await readFile(path.join(library, "artwork", required(imported.choice.asset_sha256))),
      localBytes,
    );
    await capture("artwork-correction-withdrawn-fallback");
    const finalCatalog = transportValue("catalog", success(await invoke("get_catalog")));
    const finalPort = required(finalCatalog.ports.find((port) => port.id === portId));
    const finalPresentation = required(finalPort.presentation);
    assert.equal(Object.hasOwn(finalPresentation, "artwork"), false);
    const baselineArtwork = required(
      required(baseline.ports.find((port) => port.id === portId)).presentation,
    ).artwork;
    assert.ok(baselineArtwork !== undefined);
    finalPresentation.artwork = baselineArtwork;
    assert.deepEqual(
      finalCatalog,
      baseline,
      "Artwork correction must preserve every non-artwork catalog contract",
    );
    const report = path.join(output, "artwork-correction-result.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          scope:
            "unchanged Windows native application; public test signing and owned cached solid-color fixtures. Package/installation provenance requires an independently joined outer receipt; no live publication/provider/minimum/gameplay claim",
          portId,
          first,
          local,
          corrected,
          finalSequence: (await status()).provenance.sequence,
          nonArtworkCatalogUnchanged: true,
          localChoicePreserved: true,
          localOriginalPreserved: true,
          invalidSignatureRejected: true,
          signatureError,
          changedReviewRejected: true,
          staleError,
          reviewedEnvelopeSha256: digest(reviewedBytes),
          replacementEnvelopeSha256: digest(await readFile(stale.envelope)),
          withdrawalUsesFallback: true,
          cachedPixelsSurviveRestart: true,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(report);
  });
}
