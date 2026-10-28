import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { By, until } from "selenium-webdriver";
import {
  beginEmbeddedEvidence,
  startEmbeddedInstalledSession,
} from "./desktop-windows-embedded-session.mts";

import type { EmbeddedSession, EmbeddedCleanup } from "./desktop-windows-embedded-session.mts";
type EmbeddedBase = Awaited<ReturnType<typeof beginEmbeddedEvidence>>["report"];
interface EmbeddedStartupReport extends EmbeddedBase {
  executable?: { path: string; sha256: string; bytes: number };
  listener?: EmbeddedSession["listener"];
  failure?: string;
  cleanup_failure?: string;
  cleanup?: EmbeddedCleanup;
  interpretation?: string;
}
function failureText(error: unknown): string {
  const stack =
    error !== null && (typeof error === "object" || typeof error === "function") && "stack" in error
      ? error.stack
      : undefined;
  return String(stack ?? error);
}
const { values, report: baseReport } = await beginEmbeddedEvidence("installed-embedded-startup");
const report: EmbeddedStartupReport = { ...baseReport };
let session: EmbeddedSession | undefined;
try {
  session = await startEmbeddedInstalledSession(values.app, values.output);
  const browser = await session.connect();
  report.executable = { path: values.app, ...session.identity };
  report.listener = session.listener;
  const raw: unknown = await browser.executeAsyncScript<unknown>(
    (done: (value: unknown) => void) => {
      const native = (
        window as Window & { __TAURI_INTERNALS__?: { invoke(command: string): Promise<unknown> } }
      ).__TAURI_INTERNALS__;
      if (!native) throw new Error("Embedded bootstrap bridge missing");
      void native
        .invoke("get_bootstrap_status")
        .then(done, (error: unknown) => done({ error: String(error) }));
    },
  );
  assert.ok(
    raw !== null &&
      typeof raw === "object" &&
      "library_root" in raw &&
      typeof raw.library_root === "string",
  );
  const expectedLibrary = process.env.PORTCOVE_LIBRARY;
  assert.ok(expectedLibrary);
  assert.equal(path.resolve(raw.library_root), path.resolve(expectedLibrary));
  await browser.wait(until.elementLocated(By.xpath('//h1[normalize-space(.)="Discover"]')), 15_000);
  assert.ok((await browser.findElements(By.css("button.discover-game-identity"))).length > 0);
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
  report.failure = failureText(error);
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
      report.cleanup_failure = failureText(error);
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
