import type { WebDriver } from "selenium-webdriver";
import { By, until } from "selenium-webdriver";
import assert from "node:assert/strict";
import { readInstalledUpdateStatus } from "./desktop-installed-update-harness.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";

async function openInstalledUpdateSettings(browser: WebDriver) {
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
}

/** Exercise one existing, explicitly selected recovery control. Callers retain
 * raw fault preimages before startup; status queries can reconcile product state. */
export async function driveInstalledUpdateRecovery(
  browser: WebDriver,
  actions: string[],
  area: "schedule" | "staging" | "apply",
) {
  const labels = {
    schedule: "Reset update-check history",
    staging: "Delete damaged update download",
    apply: "Clear pending update request",
  };
  assert.ok(Object.hasOwn(labels, area), "unknown recovery area");
  await browser.manage().setTimeouts({ script: 15_000 });
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 30_000);
  const before = await readInstalledUpdateStatus(browser);
  assert.equal(before.install_eligibility, "eligible");
  const otherHolds = before.recovery_required.filter((entry) => {
    assert.ok(isRecord(entry) && Object.hasOwn(labels, String(entry.area)));
    return entry.area !== area;
  });
  assert.ok(
    before.recovery_required.some((entry) => isRecord(entry) && entry.area === area),
    "selected recovery hold is absent",
  );
  await openInstalledUpdateSettings(browser);
  const locator = By.xpath(`//button[normalize-space(.)="${labels[area]}" and not(@disabled)]`);
  await browser.wait(until.elementLocated(locator), 15_000);
  await browser.findElement(locator).click();
  actions.push(`ordinary-${area}-recovery-clicked`);
  let after: Awaited<ReturnType<typeof readInstalledUpdateStatus>> | undefined;
  await browser.wait(async () => {
    const observed = await readInstalledUpdateStatus(browser);
    assert.equal(observed.install_eligibility, "eligible");
    assert.deepEqual(
      observed.recovery_required.filter((entry) => !(isRecord(entry) && entry.area === area)),
      otherHolds,
      "recovery changed an unrelated hold",
    );
    if (area !== "staging") assert.deepEqual(observed.staged, before.staged);
    if (area !== "apply") assert.deepEqual(observed.apply, before.apply);
    if (observed.recovery_required.some((entry) => isRecord(entry) && entry.area === area))
      return false;
    if (area === "staging") assert.equal(observed.staged, null);
    if (area === "apply") assert.equal(observed.apply, null);
    after = observed;
    return true;
  }, 15_000);
  assert.ok(after, "recovery result was not observed");
  actions.push(`ordinary-${area}-recovery-read-back`);
  return {
    before,
    after,
    area,
    authority: "none" as const,
    scope: "ordinary UI recovery only" as const,
  };
}

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
  await openInstalledUpdateSettings(browser);
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
