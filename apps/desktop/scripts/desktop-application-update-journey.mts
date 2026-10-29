import type { WebDriver } from "selenium-webdriver";
import { By, until } from "selenium-webdriver";
import assert from "node:assert/strict";
import {
  readInstalledUpdateStatus,
  readInstalledUpdatePreferences,
} from "./desktop-installed-update-harness.mts";
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
  const save = await browser.findElement(
    By.xpath('//button[normalize-space(.)="Save application update settings"]'),
  );
  const savedStableManual = (value: Record<string, unknown>) =>
    isRecord(value.choice) && value.choice.channel === "stable" && value.choice.mode === "manual";
  let shouldSave = false;
  await browser.wait(async () => {
    shouldSave = await save.isEnabled();
    return shouldSave || savedStableManual(await readInstalledUpdatePreferences(browser));
  }, 15_000);
  if (shouldSave) await save.click();
  // A disabled Save is also possible while unavailable. The authoritative
  // choice and the enabled Check below must both agree before a fresh check.
  await browser.wait(
    async () => savedStableManual(await readInstalledUpdatePreferences(browser)),
    15_000,
  );
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
  actions.push(
    shouldSave ? "stable-manual-settings-saved" : "stable-manual-settings-already-saved",
  );
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

/** A file-feed reachability fault, never OS-offline, HTTP, or production-feed proof. */
export async function driveInstalledFeedOutage(
  browser: WebDriver,
  actions: string[],
  configuration: string,
  configurationSha256: string,
) {
  const { withInstalledFeedOutage } = await import("./desktop-installed-feed-outage.mts");
  // Finish explicit settings changes before capturing the fault-interval choices.
  const healthy = await driveInstalledStableWaiting(browser, actions);
  const preferencesBefore = await readInstalledUpdatePreferences(browser);
  const failed = await withInstalledFeedOutage(configuration, configurationSha256, async () => {
    const checkedAt = new Date().toISOString();
    await browser.findElement(By.xpath('//button[normalize-space(.)="Check for updates"]')).click();
    const message = "The online request could not be completed.";
    const alert = await browser.wait(
      until.elementLocated(
        By.xpath(
          `//section[@aria-labelledby="application-check-title"]//p[@role="alert" and normalize-space(.)="${message}"]`,
        ),
      ),
      45_000,
    );
    assert.equal(await alert.getText(), message);
    await browser.wait(
      until.elementLocated(
        By.xpath('//button[normalize-space(.)="Check for updates" and not(@disabled)]'),
      ),
      15_000,
    );
    for (const text of [
      "Download and verify update",
      "Restart to update",
      "Retry restart to update",
    ])
      assert.equal(
        (await browser.findElements(By.xpath(`//button[normalize-space(.)="${text}"]`))).length,
        0,
      );
    assert.equal(
      (
        await browser.findElements(
          By.xpath(
            '//section[@aria-labelledby="application-check-title"]//*[contains(.,"Portcove is current")]',
          ),
        )
      ).length,
      0,
    );
    const status = await readInstalledUpdateStatus(browser);
    assert.equal(status.install_eligibility, healthy.after.install_eligibility);
    assert.deepEqual(status.staged, healthy.after.staged);
    assert.deepEqual(status.apply, healthy.after.apply);
    assert.deepEqual(status.recovery_required, healthy.after.recovery_required);
    const preferences = await readInstalledUpdatePreferences(browser);
    assert.deepEqual(
      preferences,
      preferencesBefore,
      "A failed check changed saved updater choices",
    );
    actions.push("owned-file-feed-unreachable-without-current-or-new-intent");
    return { checked_at: checkedAt, message, status, preferences };
  });
  actions.push("owned-file-feed-original-inode-and-bytes-restored");
  const retry = await driveInstalledStableWaiting(browser, actions);
  actions.push("owned-file-feed-explicit-retry-completed");
  return {
    configuration_sha256: configurationSha256,
    healthy,
    preferences_before: preferencesBefore,
    failed,
    retry,
    authority: "none" as const,
    scope:
      "owned local file-feed reachability failure and ordinary UI retry only; scheduling failure/retry counters may change" as const,
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

/** A real externally owned Core activity must reach Tauri's idle guard. A
 * disabled control or a local Desktop invocation conflict is not this proof.
 * Callers separately retain native executable/staging/marker identities, then
 * settle their holder before making a fresh explicit Restart click. */
export async function driveInstalledBusyRestartRefusal(
  browser: WebDriver,
  actions: string[],
  assertActivityHeld: () => Promise<void>,
) {
  const before = await readInstalledUpdateStatus(browser);
  const preferencesBefore = await readInstalledUpdatePreferences(browser);
  assert.equal(before.install_eligibility, "eligible");
  assert.ok(isRecord(before.staged), "A verified candidate must already be staged");
  assert.equal(before.apply, null);
  assert.deepEqual(before.recovery_required, []);
  const message =
    "The selection changed or another operation is using it. Review its current state.";
  const conflictAlert = By.xpath(
    `//article[@aria-labelledby="application-update-settings-title"]//p[@role="alert" and normalize-space(.)="${message}"]`,
  );
  assert.equal(
    (await browser.findElements(conflictAlert)).length,
    0,
    "An existing Conflict alert cannot establish a fresh busy refusal",
  );
  const restart = By.xpath('//button[normalize-space(.)="Restart to update" and not(@disabled)]');
  await browser.wait(until.elementLocated(restart), 15_000);
  await assertActivityHeld();
  const requestedAt = new Date().toISOString();
  await browser.findElement(restart).click();
  actions.push("ordinary-restart-requested-while-real-core-activity-held");
  const alert = await browser.wait(until.elementLocated(conflictAlert), 30_000);
  assert.equal(await alert.getText(), message);
  await browser.wait(until.elementLocated(restart), 15_000);
  const after = await readInstalledUpdateStatus(browser);
  assert.equal(after.install_eligibility, before.install_eligibility);
  assert.deepEqual(after.staged, before.staged);
  assert.equal(after.apply, null, "Busy refusal must precede any apply intent");
  assert.deepEqual(after.recovery_required, []);
  const preferences = await readInstalledUpdatePreferences(browser);
  assert.deepEqual(preferences, preferencesBefore);
  await assertActivityHeld();
  assert.equal(
    (
      await browser.findElements(
        By.xpath(
          '//section[@aria-labelledby="application-check-title"]//*[contains(.,"Portcove is current")]',
        ),
      )
    ).length,
    0,
  );
  assert.equal(
    (await browser.findElements(By.xpath('//button[normalize-space(.)="Retry restart to update"]')))
      .length,
    0,
  );
  actions.push("real-core-busy-restart-refused-without-apply-intent");
  return {
    before,
    after,
    preferences,
    requested_at: requestedAt,
    message,
    authority: "none" as const,
    scope: "ordinary UI conflict while independently owned Core activity remains held" as const,
  };
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
