import type { WebDriver } from "selenium-webdriver";
import { By, until } from "selenium-webdriver";
import assert from "node:assert/strict";
import { readInstalledUpdateStatus } from "./desktop-installed-update-harness.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";

export async function openInstalledUpdateSettings(browser: WebDriver) {
  await browser
    .findElement(
      By.xpath(
        '//nav[@aria-label="Primary navigation"]//button[.//span[normalize-space(.)="Settings"]]',
      ),
    )
    .click();
  const category = await browser.wait(
    until.elementLocated(
      By.css('nav[aria-label="Settings categories"] button[aria-controls="settings-updates"]'),
    ),
    15_000,
  );
  await category.click();
  // Settings panels remain mounted while hidden. Select the category before
  // waiting for its ordinary update controls to become usable.
  const panel = await browser.wait(
    until.elementLocated(By.css('article[aria-labelledby="application-update-settings-title"]')),
    15_000,
  );
  await browser.wait(until.elementIsVisible(panel), 15_000);
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

/** Observe a fresh ordinary Stable check with no eligible Stable fixture release.
 * This is an opt-in qualification assertion, never a production eligibility rule. */
export async function driveInstalledStableWaiting(browser: WebDriver, actions: string[]) {
  await browser.manage().setTimeouts({ script: 15_000 });
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 30_000);
  const before = await readInstalledUpdateStatus(browser);
  assert.equal(before.install_eligibility, "eligible");
  assert.equal(before.staged, null);
  assert.equal(before.apply, null);
  assert.equal(before.recovery_required.length, 0);
  await openInstalledUpdateSettings(browser);
  for (const [label, value] of [
    ["Application update channel", "Stable"],
    ["Application update mode", "Manual"],
  ])
    await browser
      .findElement(By.xpath(`//*[@aria-label="${label}"]//button[normalize-space(.)="${value}"]`))
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
  // Changing the one-time channel invalidates an earlier bound result. The
  // resulting caption distinguishes this manual check from saved automatic activity.
  for (const channel of ["Preview", "Stable"])
    await browser
      .findElement(
        By.xpath(
          `//*[@aria-label="One-time update channel"]//button[normalize-space(.)="${channel}"]`,
        ),
      )
      .click();
  const caption = By.xpath(
    '//section[@aria-labelledby="application-check-title"]//p[normalize-space(.)="One-time check · Stable"]',
  );
  await browser.wait(async () => (await browser.findElements(caption)).length === 0, 15_000);
  actions.push("stable-manual-settings-saved");
  const checkedAt = new Date().toISOString();
  await browser.findElement(By.xpath('//button[normalize-space(.)="Check for updates"]')).click();
  await browser.wait(until.elementLocated(caption), 45_000);
  const waiting = await browser.wait(
    until.elementLocated(
      By.xpath(
        '//section[@aria-labelledby="application-check-title"]//p[normalize-space(.)="No update can be offered on this channel." or normalize-space(.)="No eligible release is published for the selected channel."]',
      ),
    ),
    15_000,
  );
  const message = await waiting.getText();
  assert.ok(
    [
      "No update can be offered on this channel.",
      "No eligible release is published for the selected channel.",
    ].includes(message),
  );
  for (const text of ["Download and verify update", "Restart to update", "Retry restart to update"])
    assert.equal(
      (await browser.findElements(By.xpath(`//button[normalize-space(.)="${text}"]`))).length,
      0,
    );
  assert.equal(
    (
      await browser.findElements(
        By.xpath(
          '//section[@aria-labelledby="application-check-title"]//p[contains(.,"Portcove is current")]',
        ),
      )
    ).length,
    0,
  );
  const after = await readInstalledUpdateStatus(browser);
  assert.equal(after.install_eligibility, "eligible");
  assert.equal(after.staged, null);
  assert.equal(after.apply, null);
  assert.equal(after.recovery_required.length, 0);
  actions.push("stable-waiting-without-staging-or-current-claim");
  return {
    before,
    after,
    checked_at: checkedAt,
    message,
    authority: "none" as const,
    scope: "ordinary Stable waiting UI only" as const,
  };
}

/** Drive the installed application's ordinary controls up to a verified staged candidate. */
export async function driveInstalledUpdateToRestart(
  browser: WebDriver,
  actions: string[],
  candidateVersion: string,
) {
  return stageInstalledUpdate(browser, actions, candidateVersion);
}

/** UI staging after an independently captured old-restart refusal. The parent
 * must establish actual installed identity, raw intent and helper settlement;
 * sanitized status and this helper establish none of those predicates. */
export async function driveInstalledForwardRepairToRestart(
  browser: WebDriver,
  actions: string[],
  candidateVersion: string,
  expectedPrior: { apply: Record<string, unknown>; staged: Record<string, unknown> },
) {
  assert.ok(
    isRecord(expectedPrior) && isRecord(expectedPrior.apply) && isRecord(expectedPrior.staged),
  );
  const apply = expectedPrior.apply;
  assert.ok(Number.isSafeInteger(apply.revision) && Number(apply.revision) > 0);
  assert.equal(apply.request, "restart-to-apply");
  assert.equal(apply.termination, "restart-to-apply");
  assert.equal(apply.native_launch, null, "native effects require their own reconciliation");
  assert.ok(typeof expectedPrior.staged.version === "string");
  assert.notEqual(expectedPrior.staged.version, candidateVersion);
  assert.equal(expectedPrior.staged.channel, "preview");
  return stageInstalledUpdate(browser, actions, candidateVersion, expectedPrior);
}

async function stageInstalledUpdate(
  browser: WebDriver,
  actions: string[],
  candidateVersion: string,
  expectedPrior?: { apply: Record<string, unknown>; staged: Record<string, unknown> },
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
  if (expectedPrior) {
    assert.deepEqual(before.staged, expectedPrior.staged, "retained prior staging changed");
    assert.deepEqual(before.apply, expectedPrior.apply, "retained prior apply request changed");
  } else {
    assert.equal(before.staged, null, "an earlier staged update cannot satisfy this attempt");
    assert.equal(
      before.apply,
      null,
      "an earlier apply intent requires its existing recovery first",
    );
  }
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
  await browser
    .findElement(
      By.xpath('//*[@aria-label="One-time update channel"]//button[normalize-space(.)="Preview"]'),
    )
    .click();
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
  const restartLabel = expectedPrior ? "Retry restart to update" : "Restart to update";
  await browser.wait(
    until.elementLocated(
      By.xpath(`//button[normalize-space(.)="${restartLabel}" and not(@disabled)]`),
    ),
    60_000,
  );
  const staged = await readInstalledUpdateStatus(browser);
  assert.equal(staged.install_eligibility, "eligible");
  assert.equal(staged.recovery_required.length, 0);
  assert.deepEqual(staged.apply, expectedPrior?.apply ?? null, "staging changed apply authority");
  assert.ok(isRecord(staged.staged));
  assert.equal(staged.staged.version, candidateVersion, "different public candidate was staged");
  assert.equal(staged.staged.channel, "preview");
  assert.ok(Number.isSafeInteger(staged.staged.bytes) && Number(staged.staged.bytes) > 0);
  actions.push("exact-installed-candidate-status-read-back");
  return { before, staged, authority: "none" as const, scope: "ordinary UI staging only" as const };
}
