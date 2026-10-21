import type { WebDriver } from "selenium-webdriver";
import { By, until } from "selenium-webdriver";
import assert from "node:assert/strict";
import { readInstalledUpdateStatus } from "./desktop-installed-update-harness.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";

/** Drive the installed application's ordinary controls up to a verified staged candidate. */
export async function driveInstalledUpdateToRestart(
  browser: WebDriver,
  actions: string[],
  candidateVersion: string,
) {
  assert.ok(
    typeof candidateVersion === "string" &&
      candidateVersion.length > 0 &&
      candidateVersion.length <= 128,
  );
  await browser.manage().setTimeouts({ script: 15_000 });
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 30_000);
  const before = await readInstalledUpdateStatus(browser);
  assert.equal(before.install_eligibility, "eligible", "ordinary installed updater is unavailable");
  assert.equal(before.staged, null, "an earlier staged update cannot satisfy this attempt");
  assert.equal(before.apply, null, "an earlier apply intent requires its existing recovery first");
  assert.equal(before.recovery_required.length, 0, "update state requires explicit recovery first");
  actions.push("installed-gui-opened");
  await browser
    .findElement(
      By.xpath(
        '//nav[@aria-label="Primary navigation"]//button[.//span[normalize-space(.)="Settings"]]',
      ),
    )
    .click();
  await browser.wait(
    until.elementLocated(By.css('article[aria-labelledby="application-update-settings-title"]')),
    15_000,
  );
  await browser
    .findElement(
      By.xpath(
        '//*[@aria-label="Settings sections"]//button[normalize-space(.)="Portcove & catalog updates"]',
      ),
    )
    .click();
  await browser
    .findElement(
      By.xpath(
        '//*[@aria-label="Application update channel"]//button[normalize-space(.)="Preview"]',
      ),
    )
    .click();
  await browser
    .findElement(
      By.xpath('//*[@aria-label="Application update mode"]//button[normalize-space(.)="Manual"]'),
    )
    .click();
  await browser
    .findElement(By.xpath('//button[normalize-space(.)="Save application update settings"]'))
    .click();
  await browser.wait(
    until.elementLocated(
      By.xpath('//button[normalize-space(.)="Check for updates" and not(@disabled)]'),
    ),
    15_000,
  );
  actions.push("preview-manual-settings-saved");
  await browser.findElement(By.xpath('//button[normalize-space(.)="Check for updates"]')).click();
  await browser.wait(
    until.elementLocated(By.xpath('//button[normalize-space(.)="Download and verify update"]')),
    45_000,
  );
  actions.push("signed-candidate-presented");
  await browser
    .findElement(By.xpath('//button[normalize-space(.)="Download and verify update"]'))
    .click();
  await browser.wait(
    until.elementLocated(By.xpath('//button[normalize-space(.)="Restart to update"]')),
    60_000,
  );
  const staged = await readInstalledUpdateStatus(browser);
  assert.equal(staged.install_eligibility, "eligible");
  assert.equal(staged.recovery_required.length, 0);
  assert.equal(staged.apply, null, "staging did not authorize an apply intent");
  assert.ok(isRecord(staged.staged));
  assert.equal(staged.staged.version, candidateVersion, "different public candidate was staged");
  assert.equal(staged.staged.channel, "preview");
  assert.ok(Number.isSafeInteger(staged.staged.bytes) && Number(staged.staged.bytes) > 0);
  actions.push("exact-installed-candidate-status-read-back");
  return { before, staged, authority: "none" as const, scope: "ordinary UI staging only" as const };
}
