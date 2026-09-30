// Opt-in signed metadata proof. Test key/solid-color images are public fixtures;
// all trust, catalog mutation and cached bytes belong to this run's owned library.
import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { By, Key, until } from "selenium-webdriver";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function artworkCorrectionScenario({
  browser,
  invoke,
  scenario,
  output,
  artifacts,
  command,
  confirmNative,
  restartApplication,
}) {
  await scenario("native-artwork-catalog-correction", async () => {
    const bootstrap = (await invoke("get_bootstrap_status")).value;
    const library = await realpath(bootstrap.library_root);
    const relative = path.relative(await realpath(output), library);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const portId = "shipwright";
    const baseline = await invoke("get_catalog");
    assert.equal(baseline.ok, true);
    const catalog = JSON.parse(
      await readFile(
        new URL("../../../crates/portcove-core/catalog/catalog.json", import.meta.url),
        "utf8",
      ),
    );
    const originalPort = structuredClone(catalog.ports.find((port) => port.id === portId));
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
    const mappings = {};
    for (const color of ["red", "blue"]) {
      const bytes = await readFile(
        new URL(`testdata/catalog-artwork-${color}.jpg`, import.meta.url),
      );
      const identity = digest(bytes);
      await writeFile(path.join(cache, `${identity}.jpg`), bytes, { flag: "wx" });
      mappings[color] = {
        ...originalPort.presentation.artwork,
        image_id: `portcovetest${color}`,
        image_sha256: identity,
      };
    }
    const signed = async (sequence, mapping, name) => {
      const document = structuredClone(catalog);
      document.ports.find((port) => port.id === portId).presentation.artwork = mapping;
      const source = path.join(output, `${name}-catalog.json`);
      const envelope = path.join(output, `${name}-signed.json`);
      await writeFile(source, JSON.stringify(document), { flag: "wx" });
      const now = Math.floor(Date.now() / 1000);
      const result = spawnCommand(
        process.execPath,
        [
          fileURLToPath(new URL("../../../scripts/sign-catalog.mjs", import.meta.url)),
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
      return { envelope, ...JSON.parse(result.stdout) };
    };
    const red = await signed(1, mappings.red, "red");
    const blue = await signed(2, mappings.blue, "blue");
    const status = async () => {
      const result = await invoke("get_catalog_status");
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.value;
    };
    const button = (label) => By.xpath(`//button[normalize-space(.)="${label}"]`);
    const click = async (locator) => {
      const element = await browser.wait(until.elementLocated(locator), 10000);
      await browser.executeScript(
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
    const review = async (file) => {
      const field = await browser.findElement(By.id("catalog-update-location"));
      await field.sendKeys(Key.CONTROL, "a", Key.NULL, file);
      await click(button("Review update"));
    };
    const apply = async (file, sequence) => {
      await open();
      await review(file);
      await browser.wait(
        until.elementLocated(By.css('[aria-label="Catalog update review"]')),
        10000,
      );
      const affected = await browser.findElement(By.css('[aria-label="Affected ports"]')).getText();
      assert.ok(affected.includes(originalPort.name));
      await click(button("Apply catalog update"));
      await browser.wait(async () => (await status()).provenance.sequence === sequence, 10000);
      await close();
    };
    const render = async (source) => {
      await click(By.xpath('//nav//button[contains(., "Port catalog")]'));
      const search = await browser.wait(until.elementLocated(By.id("port-search")), 10000);
      await search.sendKeys(Key.CONTROL, "a", Key.NULL, originalPort.name);
      const selector = `[data-detail-origin="catalog:card:${portId}"] .card-art`;
      await browser.wait(
        () =>
          browser.executeScript(
            (selector, source) => {
              const frame = document.querySelector(selector);
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
      return browser.executeScript((selector) => {
        const frame = document.querySelector(selector);
        const image = frame.querySelector("img");
        let pixel = null;
        if (image) {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          canvas.getContext("2d").drawImage(image, 0, 0, 1, 1);
          pixel = [...canvas.getContext("2d").getImageData(0, 0, 1, 1).data];
        }
        return { source: frame.dataset.artworkSource, image: image?.src ?? null, pixel };
      }, selector);
    };
    const capture = async (name) => {
      const filename = path.join(output, `${name}.png`);
      await writeFile(filename, await browser.takeScreenshot(), { encoding: "base64", flag: "wx" });
      artifacts.push(filename);
    };
    const artwork = () => command(["artwork", "show", portId], library);
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
    assert.ok(first.pixel[0] > first.pixel[2] + 100);
    assert.deepEqual(artwork().resolved_source.artwork, mappings.red);
    await capture("artwork-correction-red-fixture");
    const localPath = path.join(output, "owned-override.png");
    const localBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQCFgAAAGMAQm4OT/aAAAAAElFTkSuQmCC",
      "base64",
    );
    await writeFile(localPath, localBytes, { flag: "wx" });
    const imported = command(
      ["artwork", "import", portId, localPath, "--expected-revision", "0"],
      library,
    );
    await apply(blue.envelope, 2);
    const local = await render("local_import");
    assert.deepEqual(artwork().choice, imported.choice);
    await capture("artwork-correction-local-override");
    command(["artwork", "reset", portId, "--expected-revision", "1"], library);
    await browser.navigate().refresh();
    const corrected = await render("igdb_cover");
    assert.ok(corrected.pixel[2] > corrected.pixel[0] + 100);
    assert.notEqual(corrected.image, first.image);
    assert.deepEqual(artwork().resolved_source.artwork, mappings.blue);
    await capture("artwork-correction-blue-fixture");
    browser = await restartApplication();
    assert.deepEqual(
      await render("igdb_cover"),
      corrected,
      "Verified cached corrected pixels survive app restart",
    );
    const before = (await status()).state_sha256;
    const invalid = path.join(output, "invalid-signature.json");
    const fresh = await signed(3, mappings.red, "fresh-signature");
    const tampered = JSON.parse(await readFile(fresh.envelope, "utf8"));
    tampered.signature = "00".repeat(64);
    await writeFile(invalid, JSON.stringify(tampered), { flag: "wx" });
    artifacts.push(invalid);
    await open();
    await review(invalid);
    await browser.wait(
      until.elementLocated(By.css('.catalog-update-dialog [role="alert"]')),
      10000,
    );
    const signatureError = await browser
      .findElement(By.css('.catalog-update-dialog [role="alert"]'))
      .getText();
    assert.match(signatureError, /catalog signature verification failed/i);
    assert.equal((await status()).state_sha256, before);
    await close();
    const stale = await signed(3, mappings.red, "stale");
    await open();
    await review(stale.envelope);
    await browser.wait(until.elementLocated(By.css('[aria-label="Catalog update review"]')), 10000);
    const replacement = await signed(4, mappings.red, "replacement");
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
    const staleError = await browser
      .findElement(By.css('.catalog-update-dialog [role="alert"]'))
      .getText();
    assert.match(staleError, /catalog candidate or trust changed/i);
    assert.equal((await status()).state_sha256, before);
    await close();
    assert.deepEqual(await render("igdb_cover"), corrected);
    const withdrawal = await signed(5, null, "withdrawal");
    await apply(withdrawal.envelope, 5);
    assert.equal((await render("generated_fallback")).image, null);
    assert.equal(artwork().resolved_source.kind, "generated_fallback");
    assert.deepEqual(await readFile(localPath), localBytes);
    assert.deepEqual(
      await readFile(path.join(library, "artwork", imported.choice.asset_sha256)),
      localBytes,
    );
    await capture("artwork-correction-withdrawn-fallback");
    const finalCatalog = (await invoke("get_catalog")).value;
    const finalPort = finalCatalog.ports.find((port) => port.id === portId);
    assert.equal(finalPort.presentation.artwork, null);
    finalPort.presentation.artwork = baseline.value.ports.find(
      (port) => port.id === portId,
    ).presentation.artwork;
    assert.deepEqual(
      finalCatalog,
      baseline.value,
      "Artwork correction must preserve every non-artwork catalog contract",
    );
    const report = path.join(output, "artwork-correction-result.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          scope:
            "unchanged Windows native development application; public test signing and owned cached solid-color fixtures, not live publication/provider/installed/gameplay evidence",
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
