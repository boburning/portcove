import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { By, until } from "selenium-webdriver";
import { startEmbeddedInstalledSession } from "./desktop-windows-embedded-session.mjs";

const { values } = parseArgs({ options: { app: { type: "string" }, output: { type: "string" } } });
for (const name of ["app", "output"]) assert.ok(values[name] && path.isAbsolute(values[name]));
await mkdir(values.output, { recursive: false });
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  method: "installed-embedded-startup",
  outcome: "failed",
};
let session;
try {
  session = await startEmbeddedInstalledSession(values.app, values.output);
  const browser = await session.connect();
  report.executable = { path: values.app, ...session.identity };
  report.listener = session.listener;
  const bootstrap = await browser.executeAsyncScript((done) => {
    window.__TAURI_INTERNALS__
      .invoke("get_bootstrap_status")
      .then(done, (error) => done({ error: String(error) }));
  });
  assert.equal(path.resolve(bootstrap.library_root), path.resolve(process.env.PORTCOVE_LIBRARY));
  await browser.wait(
    until.elementLocated(By.xpath('//h1[normalize-space(.)="Port catalog"]')),
    15_000,
  );
  assert.ok((await browser.findElements(By.css("button.port-card-selectable"))).length > 0);
  await browser.findElement(By.xpath('//nav//button[contains(., "Library")]')).click();
  await browser.wait(until.elementLocated(By.css(".empty-state")), 15_000);
  assert.match(
    await browser.findElement(By.css(".empty-state")).getText(),
    /Your library is empty/,
  );
  await writeFile(
    path.join(values.output, "installed-startup.png"),
    await browser.takeScreenshot(),
    "base64",
  );
  report.outcome = "passed";
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (session) {
    try {
      if (session.browser)
        await Promise.race([
          session.browser.quit().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      report.cleanup = await session.close();
    } catch (error) {
      report.outcome = "failed";
      report.cleanup_failure = String(error.stack ?? error);
      process.exitCode = 1;
    }
  }
  report.interpretation =
    "Installed startup smoke only; not the full empty-library scenario or installed updater success.";
  await writeFile(
    path.join(values.output, "evidence.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
