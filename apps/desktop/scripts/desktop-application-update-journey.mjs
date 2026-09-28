import { By, until } from "selenium-webdriver";

/** Drive the installed application's ordinary controls up to a verified staged candidate. */
export async function driveInstalledUpdateToRestart(browser, actions) {
  await browser.manage().setTimeouts({ script: 15_000 });
  await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 30_000);
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
}
