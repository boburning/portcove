import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import type { WebDriver } from "selenium-webdriver";
import { readInstalledUpdateStatus } from "./desktop-installed-update-harness.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";

// A separate module instance keeps controlled locators out of the canonical import cache.
async function importControlledJourney(
  moduleUrl: URL,
): Promise<typeof import("./desktop-application-update-journey.mts")> {
  const journey = new URL(moduleUrl);
  journey.searchParams.set("native-contract", "controlled-locators");
  let locatorImports = 0;
  const hooks = registerHooks({
    resolve(name, context, next) {
      if (name === "selenium-webdriver" && context.parentURL === journey.href) {
        locatorImports++;
        return {
          url:
            "data:text/javascript," +
            encodeURIComponent(`
            export const By = { css: value => ({ value }), xpath: value => ({ value }) };
            export const until = {
              elementLocated: value => value,
              elementIsVisible: value => ({ visible: value })
            };
          `),
          shortCircuit: true,
        };
      }
      return next(name, context);
    },
  });
  try {
    const drivers: unknown = await import(journey.href);
    assert.ok(isRecord(drivers));
    for (const name of [
      "openInstalledUpdateSettings",
      "driveInstalledUpdateToRestart",
      "driveInstalledBusyRestartRefusal",
      "driveInstalledStableWaiting",
      "driveInstalledFeedOutage",
      "driveInstalledUpdateRecovery",
      "driveInstalledForwardRepairToRestart",
    ])
      assert.equal(typeof drivers[name], "function", name);
    assert.equal(locatorImports, 1, "the actual journey imports its controlled locator dependency");
    return drivers as typeof import("./desktop-application-update-journey.mts");
  } finally {
    hooks.deregister();
  }
}
const drivers = await importControlledJourney(
  new URL("./desktop-application-update-journey.mts", import.meta.url),
);

const {
  openInstalledUpdateSettings,
  driveInstalledUpdateToRestart,
  driveInstalledBusyRestartRefusal,
  driveInstalledStableWaiting,
  driveInstalledFeedOutage,
  driveInstalledUpdateRecovery,
  driveInstalledForwardRepairToRestart,
} = drivers;

void test("ordinary updater selects the Updates category before using its mounted hidden panel", async () => {
  let settingsOpened = false,
    categorySelected = false,
    visibilityWaited = false;
  const panel = { id: "mounted-updater-panel" };
  const browser = {
    findElement: (locator: { value: string }) => {
      assert.match(locator.value, /Primary navigation/u);
      return {
        click: async () => {
          settingsOpened = true;
        },
      };
    },
    wait: async (condition: { value?: string; visible?: unknown }) => {
      assert.equal(settingsOpened, true);
      if (condition.value?.includes("Settings categories")) {
        assert.equal(
          condition.value,
          'nav[aria-label="Settings categories"] button[aria-controls="settings-updates"]',
        );
        return {
          click: async () => {
            categorySelected = true;
          },
        };
      }
      assert.equal(categorySelected, true, "a mounted hidden panel cannot select its category");
      if (condition.value) {
        assert.equal(
          condition.value,
          'article[aria-labelledby="application-update-settings-title"]',
        );
        return panel;
      }
      assert.equal(condition.visible, panel);
      visibilityWaited = true;
      return panel;
    },
  } as unknown as WebDriver;
  await openInstalledUpdateSettings(browser);
  assert.equal(visibilityWaited, true, "locating a mounted panel does not establish visibility");
});

void test("a hidden Updates panel preserves the navigation failure instead of driving hidden controls", async () => {
  const failure = new Error("Updates panel remained hidden");
  const browser = {
    findElement: () => ({ click: async () => {} }),
    wait: async (condition: { visible?: unknown }) => {
      if (Object.hasOwn(condition, "visible")) throw failure;
      return { click: async () => {} };
    },
  } as unknown as WebDriver;
  await assert.rejects(openInstalledUpdateSettings(browser), (error: unknown) => error === failure);
});

void test("shipping status reader imports and executes outside dependency ancestry with Selenium unavailable", async (t) => {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "portcove-ordinary-updater-status-"));
  assert.equal(path.dirname(path.resolve(root)), parent);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "apps/desktop/scripts"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await copyFile(
    new URL("./desktop-installed-update-harness.mts", import.meta.url),
    path.join(root, "apps/desktop/scripts/desktop-installed-update-harness.mts"),
  );
  await copyFile(
    new URL("../../../scripts/runtime-values.mts", import.meta.url),
    path.join(root, "scripts/runtime-values.mts"),
  );
  await copyFile(
    new URL("./desktop-application-update-journey.mts", import.meta.url),
    path.join(root, "apps/desktop/scripts/desktop-application-update-journey.mts"),
  );
  const probe = path.join(root, "probe.mjs");
  await writeFile(
    probe,
    `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    import {isRecord} from './scripts/runtime-values.mts';
    ${importControlledJourney.toString()}
    assert.throws(() => import.meta.resolve('selenium-webdriver'), {code:'ERR_MODULE_NOT_FOUND'});
    const {readInstalledUpdateStatus} = await import('./apps/desktop/scripts/desktop-installed-update-harness.mts');
    const status = await readInstalledUpdateStatus({executeAsyncScript:async()=>JSON.stringify({ok:true,value:{recovery_required:[],apply:null,staged:null}})});
    assert.equal(status.staged,null);
    const journeyUrl = new URL('./apps/desktop/scripts/desktop-application-update-journey.mts', import.meta.url);
    const journey = await importControlledJourney(journeyUrl);
    let clicks=0;
    await journey.openInstalledUpdateSettings({
      findElement:()=>({click:async()=>{clicks++;}}),
      wait:async()=>({click:async()=>{clicks++;}}),
    });
    assert.equal(clicks,2);
    await assert.rejects(import(journeyUrl.href), {code:'ERR_MODULE_NOT_FOUND'});
    console.log('frontend-free actual reader executed');
    console.log('actual journey imported without changing canonical dependency resolution');
  `,
    { flag: "wx" },
  );
  const output = execFileSync(process.execPath, [probe], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.match(output, /frontend-free actual reader executed/u);
});

/** Controlled driver/IPC only, never an installed or public-feed observation. */
function fixture() {
  const before = {
    install_eligibility: "eligible",
    staged: null,
    apply: null,
    recovery_required: [],
  };
  const after = {
    ...before,
    staged: { version: "0.1.0-beta.2", channel: "preview", bytes: 123 },
  };
  const responses: unknown[] = [before, after];
  const calls: string[] = [];
  const browser = {
    manage: () => ({ setTimeouts: async () => {} }),
    wait: async (predicate: unknown) => {
      if (typeof predicate === "function")
        assert.equal(await (predicate as () => Promise<unknown>)(), true);
      return { click: async () => {} };
    },
    findElement: (locator: { value: string }) => ({
      click: async () => {
        calls.push(`click:${locator.value}`);
      },
    }),
    executeAsyncScript: (script: (...args: unknown[]) => unknown) =>
      new Promise<string>((resolve) => {
        runInNewContext(`(${script.toString()})(done)`, {
          done: resolve,
          window: {
            __TAURI_INTERNALS__: {
              invoke: async (command: string) => {
                calls.push(`invoke:${command}`);
                assert.equal(command, "get_application_update_status");
                return responses.shift();
              },
            },
          },
        });
      }),
  } as unknown as WebDriver;
  return { browser, responses, calls, before, after };
}

void test("actual ordinary updater driver reads exact staged version through the unmodified shipping status command", async () => {
  const f = fixture(),
    actions: string[] = [];
  const result = await driveInstalledUpdateToRestart(f.browser, actions, "0.1.0-beta.2");
  assert.equal(result.authority, "none");
  assert.deepEqual(result.before, f.before);
  assert.deepEqual(result.staged, f.after);
  assert.deepEqual(
    f.calls.filter((call) => call.startsWith("invoke:")),
    ["invoke:get_application_update_status", "invoke:get_application_update_status"],
  );
  assert.equal(f.calls.filter((call) => call.includes("Download and verify update")).length, 1);
  assert.ok(!f.calls.some((call) => call.includes("Restart to update")));
  assert.equal(actions.at(-1), "exact-installed-candidate-status-read-back");
});

void test("unconfigured, package-managed and retained-state holds refuse before the first UI mutation", async () => {
  for (const change of [
    { install_eligibility: "not-configured" },
    { install_eligibility: "package-managed-deb" },
    { staged: { version: "0.1.0-beta.2" } },
    { apply: { revision: 1 } },
    { recovery_required: [{ area: "staging" }] },
  ]) {
    const f = fixture();
    f.responses[0] = { ...f.before, ...change };
    await assert.rejects(driveInstalledUpdateToRestart(f.browser, [], "0.1.0-beta.2"));
    assert.equal(f.calls.filter((call) => call.startsWith("click:")).length, 0);
    assert.equal(f.responses.length, 1);
  }
});

void test("a restart control alone cannot qualify wrong, absent, incompatible or damaged staged state", async () => {
  for (const change of [
    { staged: null },
    { staged: { ...fixture().after.staged, version: "0.1.0-beta.3" } },
    { staged: { ...fixture().after.staged, channel: "stable" } },
    { staged: { ...fixture().after.staged, bytes: 0 } },
    { install_eligibility: "unavailable" },
    { apply: { revision: 1 } },
    { recovery_required: [{ area: "apply" }] },
  ]) {
    const f = fixture(),
      actions: string[] = [];
    f.responses[1] = { ...f.after, ...change };
    await assert.rejects(driveInstalledUpdateToRestart(f.browser, actions, "0.1.0-beta.2"));
    assert.ok(!actions.includes("exact-installed-candidate-status-read-back"));
    assert.ok(!f.calls.some((call) => call.includes("Restart to update")));
  }
});

void test("forward staging preserves the exact prior pre-native restart request and uses ordinary V2 controls", async () => {
  const f = fixture();
  const expectedPrior = {
    apply: {
      revision: 2,
      request: "restart-to-apply",
      termination: "restart-to-apply",
      native_launch: null,
    },
    staged: { version: "0.1.0-beta.1", channel: "preview", bytes: 120 },
  };
  f.responses.splice(
    0,
    2,
    { ...f.before, ...expectedPrior },
    { ...f.after, apply: expectedPrior.apply },
  );
  const actions: string[] = [];
  const observed = await driveInstalledForwardRepairToRestart(
    f.browser,
    actions,
    "0.1.0-beta.2",
    expectedPrior,
  );
  assert.equal(observed.authority, "none");
  assert.deepEqual(observed.staged, { ...f.after, apply: expectedPrior.apply });
  assert.equal(f.calls.filter((call) => call.includes("Download and verify update")).length, 1);
  assert.equal(f.calls.filter((call) => call.startsWith("invoke:")).length, 2);
  assert.ok(!f.calls.some((call) => call.includes("Clear pending update request")));
  assert.ok(
    !f.calls.some((call) => call.includes("Retry restart to update")),
    "staging cannot authorize a restart",
  );
});

void test("forward staging refuses ambiguous, unrelated or changed old intent before UI mutation", async () => {
  const expectedPrior = {
    apply: {
      revision: 2,
      request: "restart-to-apply",
      termination: "restart-to-apply",
      native_launch: null,
    },
    staged: { version: "0.1.0-beta.1", channel: "preview", bytes: 120 },
  };
  for (const change of [
    { apply: { ...expectedPrior.apply, native_launch: "starting" } },
    { apply: { ...expectedPrior.apply, request: "safe-exit" } },
    { apply: { ...expectedPrior.apply, termination: "crash" } },
    { staged: { ...expectedPrior.staged, version: "0.1.0-beta.2" } },
  ]) {
    const f = fixture();
    const altered = { ...expectedPrior, ...change };
    await assert.rejects(
      driveInstalledForwardRepairToRestart(f.browser, [], "0.1.0-beta.2", altered),
    );
    assert.equal(f.calls.length, 0);
  }
  for (const change of [
    { apply: { ...expectedPrior.apply, revision: 3 } },
    { staged: { ...expectedPrior.staged, bytes: 121 } },
    { recovery_required: [{ area: "apply" }] },
  ]) {
    const f = fixture();
    f.responses[0] = { ...f.before, ...expectedPrior, ...change };
    await assert.rejects(
      driveInstalledForwardRepairToRestart(f.browser, [], "0.1.0-beta.2", expectedPrior),
    );
    assert.equal(f.calls.filter((call) => call.startsWith("click:")).length, 0);
  }
  const f = fixture();
  f.responses.splice(
    0,
    2,
    { ...f.before, ...expectedPrior },
    { ...f.after, apply: { ...expectedPrior.apply, revision: 3 } },
  );
  await assert.rejects(
    driveInstalledForwardRepairToRestart(f.browser, [], "0.1.0-beta.2", expectedPrior),
  );
  assert.ok(!f.calls.some((call) => call.includes("Retry restart to update")));
});

void test("named ordinary recovery clears only its hold through one fixed UI action", async () => {
  const labels = {
    schedule: "Reset update-check history",
    staging: "Delete damaged update download",
    apply: "Clear pending update request",
  };
  for (const area of ["schedule", "staging", "apply"] as const) {
    const f = fixture(),
      actions: string[] = [];
    const staged = { version: "0.1.0-beta.2" },
      apply = { revision: 1 };
    const others = [{ area: area === "schedule" ? "apply" : "schedule" }];
    f.responses.splice(
      0,
      2,
      { ...f.before, staged, apply, recovery_required: [{ area }, ...others] },
      {
        ...f.before,
        staged: area === "staging" ? null : staged,
        apply: area === "apply" ? null : apply,
        recovery_required: others,
      },
    );
    const result = await driveInstalledUpdateRecovery(f.browser, actions, area);
    assert.equal(result.authority, "none");
    assert.equal(f.calls.filter((call) => call.includes(labels[area])).length, 1);
    assert.equal(f.calls.filter((call) => call.startsWith("invoke:")).length, 2);
    assert.equal(actions.at(-1), `ordinary-${area}-recovery-read-back`);
  }
});

void test("recovery refuses absent or unknown holds and never erases unrelated state", async () => {
  for (const before of [[], [{ area: "unrecognized" }]]) {
    const f = fixture();
    f.responses[0] = { ...f.before, recovery_required: before };
    await assert.rejects(driveInstalledUpdateRecovery(f.browser, [], "staging"));
    assert.equal(f.calls.filter((call) => call.startsWith("click:")).length, 0);
  }
  for (const changed of [
    { recovery_required: [] },
    { apply: null },
    { staged: { version: "wrong" } },
  ]) {
    const f = fixture();
    const before = {
      ...f.before,
      apply: { revision: 1 },
      staged: { version: "original" },
      recovery_required: [{ area: "schedule" }, { area: "apply" }],
    };
    f.responses.splice(0, 2, before, {
      ...before,
      recovery_required: [{ area: "apply" }],
      ...changed,
    });
    await assert.rejects(driveInstalledUpdateRecovery(f.browser, [], "schedule"));
    assert.equal(f.calls.filter((call) => call.includes("Reset update-check history")).length, 1);
  }
});

void test("ordinary query callback refuses missing bridge, command failure and oversized status without exposing errors", async () => {
  for (const mode of ["missing", "rejected", "oversized"]) {
    let retained = "";
    const browser = {
      executeAsyncScript: (script: (...args: unknown[]) => unknown) =>
        new Promise<string>((resolve) => {
          runInNewContext(`(${script.toString()})(done)`, {
            done: (value: string) => {
              retained = value;
              resolve(value);
            },
            window:
              mode === "missing"
                ? {}
                : {
                    __TAURI_INTERNALS__: {
                      invoke: async () => {
                        if (mode === "rejected") throw new Error("private backend details");
                        return { unbounded: "x".repeat(17000) };
                      },
                    },
                  },
          });
        }),
    } as unknown as WebDriver;
    await assert.rejects(readInstalledUpdateStatus(browser));
    assert.equal(retained, '{"ok":false}');
  }
});

void test("installed Stable waiting requires fresh UI result without advancing automatic cadence", async () => {
  for (const change of [null, "staged", "apply", "current", "offer", "stale", "offline"] as const) {
    const f = fixture();
    const after = { ...f.before, schedule: { last_success_unix_seconds: null } };
    const responses: unknown[] = [
      f.before,
      change === "staged"
        ? { ...after, staged: { version: "0.2.0" } }
        : change === "apply"
          ? { ...after, apply: { revision: 1 } }
          : after,
    ];
    const calls: string[] = [];
    const browser = {
      manage: () => ({ setTimeouts: async () => {} }),
      wait: async (condition: unknown) => {
        if (typeof condition === "function")
          assert.equal(await (condition as () => Promise<unknown>)(), true);
        return {
          click: async () => {},
          getText: async () =>
            change === "offline"
              ? "Couldn't check for updates"
              : "No update can be offered on this channel.",
        };
      },
      findElement: (locator: { value: string }) => ({
        click: async () => {
          calls.push(locator.value);
        },
      }),
      findElements: async (locator: { value: string }) => {
        if (change === "stale" && locator.value.includes("One-time check · Stable")) return [{}];
        if (
          (change === "current" && locator.value.includes("Portcove is current")) ||
          (change === "offer" && locator.value.includes("Download and verify update"))
        )
          return [{}];
        return [];
      },
      executeAsyncScript: async () => JSON.stringify({ ok: true, value: responses.shift() }),
    } as unknown as WebDriver;
    const actions: string[] = [];
    if (change) {
      await assert.rejects(driveInstalledStableWaiting(browser, actions));
      assert.ok(!actions.includes("stable-waiting-without-staging-or-current-claim"));
    } else {
      const result = await driveInstalledStableWaiting(browser, actions);
      assert.equal(result.authority, "none");
      assert.equal(result.after.staged, null);
      assert.equal(calls.filter((x) => x.includes("Check for updates")).length, 1);
      assert.ok(calls.some((x) => x.includes("One-time update channel") && x.includes("Stable")));
      assert.equal(actions.at(-1), "stable-waiting-without-staging-or-current-claim");
    }
  }
});

void test("owned feed outage restores exact bytes after observation failure and supports outer retry", async (t) => {
  const { prepareInstalledFeedOutage, withInstalledFeedOutage, restoreInstalledFeedOutage } =
    await import("./desktop-installed-feed-outage.mts");
  const root = await mkdtemp(path.join(tmpdir(), "portcove-installed-feed-outage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = path.join(root, "metadata");
  await mkdir(metadata);
  const timestamp = path.join(metadata, "timestamp.json"),
    bytes = Buffer.from('{"signed":{"version":3},"signatures":[]}\n');
  await writeFile(timestamp, bytes);
  const control = await prepareInstalledFeedOutage(metadata, path.join(root, "control"));
  const failure = new Error("real driver failed after the timestamp became unavailable");
  await assert.rejects(
    withInstalledFeedOutage(control.configuration, control.sha256, async () => {
      const { access } = await import("node:fs/promises");
      await assert.rejects(access(timestamp), { code: "ENOENT" });
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  const { readFile, lstat } = await import("node:fs/promises");
  assert.deepEqual(await readFile(timestamp), bytes);
  assert.equal((await lstat(timestamp)).nlink, 1);
  assert.equal(
    (await restoreInstalledFeedOutage(control.configuration, control.sha256)).phase,
    "restored",
  );
});

void test("outer feed restoration survives abrupt driver exit without executing its finally", async (t) => {
  const { prepareInstalledFeedOutage, restoreInstalledFeedOutage } =
    await import("./desktop-installed-feed-outage.mts");
  const root = await mkdtemp(path.join(tmpdir(), "portcove-installed-feed-killed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = path.join(root, "metadata");
  await mkdir(metadata);
  const timestamp = path.join(metadata, "timestamp.json"),
    bytes = Buffer.from('{"signed":{"version":4}}\n');
  await writeFile(timestamp, bytes);
  const control = await prepareInstalledFeedOutage(metadata, path.join(root, "control"));
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const {withInstalledFeedOutage}=await import(${JSON.stringify(new URL("./desktop-installed-feed-outage.mts", import.meta.url).href)});await withInstalledFeedOutage(${JSON.stringify(control.configuration)},${JSON.stringify(control.sha256)},async()=>process.exit(86));`,
    ],
    { timeout: 15_000, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 86, result.stderr);
  const { access, readFile } = await import("node:fs/promises");
  await assert.rejects(access(timestamp), { code: "ENOENT" });
  await restoreInstalledFeedOutage(control.configuration, control.sha256);
  assert.deepEqual(await readFile(timestamp), bytes);
});

void test("feed recovery refuses a foreign destination and retains both original failures", async (t) => {
  const { prepareInstalledFeedOutage, withInstalledFeedOutage } =
    await import("./desktop-installed-feed-outage.mts");
  const root = await mkdtemp(path.join(tmpdir(), "portcove-installed-feed-foreign-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = path.join(root, "metadata");
  await mkdir(metadata);
  const timestamp = path.join(metadata, "timestamp.json"),
    bytes = Buffer.from('{"signed":{"version":5}}\n');
  await writeFile(timestamp, bytes);
  const control = await prepareInstalledFeedOutage(metadata, path.join(root, "control"));
  const originalFailure = new Error("original UI check failed");
  await assert.rejects(
    withInstalledFeedOutage(control.configuration, control.sha256, async () => {
      await writeFile(timestamp, "foreign writer", { flag: "wx" });
      throw originalFailure;
    }),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors[0] === originalFailure &&
      /foreign timestamp/u.test(String(error.errors[1])),
  );
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(timestamp, "utf8"), "foreign writer");
  assert.deepEqual(await readFile(path.join(root, "control", "timestamp-preimage.json")), bytes);
});

void test("feed outage rejects changed retained bytes and replaced directory identities before mutation", async (t) => {
  const { prepareInstalledFeedOutage, withInstalledFeedOutage } =
    await import("./desktop-installed-feed-outage.mts");
  const { readFile, rename } = await import("node:fs/promises");
  for (const fault of ["preimage", "metadata-directory", "withheld-directory"]) {
    const root = await mkdtemp(path.join(tmpdir(), "portcove-installed-feed-identity-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const metadata = path.join(root, "metadata");
    await mkdir(metadata);
    const timestamp = path.join(metadata, "timestamp.json"),
      bytes = Buffer.from('{"signed":{"version":6}}\n');
    await writeFile(timestamp, bytes);
    const control = await prepareInstalledFeedOutage(metadata, path.join(root, "control"));
    const config = JSON.parse(await readFile(control.configuration, "utf8")) as {
      withheld: string;
    };
    if (fault === "preimage")
      await writeFile(
        path.join(root, "control", "timestamp-preimage.json"),
        "altered retained input",
      );
    else if (fault === "metadata-directory") {
      await rename(metadata, path.join(root, "original-metadata"));
      await mkdir(metadata);
      await writeFile(timestamp, bytes);
    } else {
      await rename(config.withheld, config.withheld + "-retained");
      await mkdir(config.withheld);
    }
    let observed = false;
    await assert.rejects(
      withInstalledFeedOutage(control.configuration, control.sha256, async () => {
        observed = true;
      }),
      /Timestamp|directory identity/u,
    );
    assert.equal(observed, false);
    assert.deepEqual(await readFile(timestamp), bytes);
  }
});

void test("outer restoration completes an interrupted no-replace publication of the original inode", async (t) => {
  const { prepareInstalledFeedOutage, restoreInstalledFeedOutage } =
    await import("./desktop-installed-feed-outage.mts");
  const { readFile, lstat } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(path.join(tmpdir(), "portcove-installed-feed-published-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = path.join(root, "metadata");
  await mkdir(metadata);
  const timestamp = path.join(metadata, "timestamp.json"),
    bytes = Buffer.from('{"signed":{"version":7}}\n');
  await writeFile(timestamp, bytes);
  const original = await lstat(timestamp, { bigint: true });
  const control = await prepareInstalledFeedOutage(metadata, path.join(root, "control"));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import{link,readFile}from'node:fs/promises';import path from'node:path';const{withInstalledFeedOutage}=await import(${JSON.stringify(new URL("./desktop-installed-feed-outage.mts", import.meta.url).href)});const config=JSON.parse(await readFile(${JSON.stringify(control.configuration)},'utf8'));await withInstalledFeedOutage(${JSON.stringify(control.configuration)},${JSON.stringify(control.sha256)},async()=>{await link(path.join(config.withheld,'timestamp.json'),path.join(config.metadata,'timestamp.json'));process.exit(87)});`,
    ],
    { timeout: 15_000, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 87, result.stderr);
  assert.equal((await lstat(timestamp)).nlink, 2);
  await restoreInstalledFeedOutage(control.configuration, control.sha256);
  const restored = await lstat(timestamp, { bigint: true });
  assert.equal(restored.nlink, 1n);
  assert.equal(restored.ino, original.ino);
  assert.equal(restored.uid, original.uid);
  assert.equal(restored.mode, original.mode);
  assert.equal(restored.mtimeNs, original.mtimeNs);
  assert.deepEqual(await readFile(timestamp), bytes);
});

void test("feed ownership refuses adjacent uint64 inode identities even when Number would collide", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "portcove-installed-feed-uint64-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = path.join(root, "metadata");
  await mkdir(metadata);
  const timestamp = path.join(metadata, "timestamp.json"),
    bytes = Buffer.from('{"signed":{"version":8}}\n');
  await writeFile(timestamp, bytes);
  const moduleUrl = new URL(
    "./desktop-installed-feed-outage.mts?native-contract=uint64-inodes",
    import.meta.url,
  );
  const hooks = registerHooks({
    resolve(name, context, next) {
      if (name === "node:fs/promises" && context.parentURL === moduleUrl.href)
        return {
          url:
            "data:text/javascript," +
            encodeURIComponent(
              `export * from 'node:fs/promises';import{lstat as original}from'node:fs/promises';const ids=new Map();export async function lstat(path,options){if(options?.bigint!==true)throw new Error('physical identities require bigint stats');const value=await original(path,options);const key=value.dev+':'+value.ino;if(!ids.has(key))ids.set(key,2n**60n+BigInt(ids.size));value.ino=ids.get(key);return value;}`,
            ),
          shortCircuit: true,
        };
      return next(name, context);
    },
  });
  try {
    const { prepareInstalledFeedOutage, withInstalledFeedOutage } = (await import(
      moduleUrl.href
    )) as typeof import("./desktop-installed-feed-outage.mts");
    const control = await prepareInstalledFeedOutage(metadata, path.join(root, "control"));
    await assert.rejects(
      withInstalledFeedOutage(control.configuration, control.sha256, async () => {
        await writeFile(timestamp, bytes, { flag: "wx" });
      }),
      (error: unknown) => {
        assert.ok(isRecord(error) && isRecord(error.actual) && isRecord(error.expected));
        assert.notEqual(error.actual.ino, error.expected.ino);
        assert.equal(Number(error.actual.ino), Number(error.expected.ino));
        return /foreign timestamp/u.test(String(error.message));
      },
    );
  } finally {
    hooks.deregister();
  }
});

void test("installed outage uses ordinary check, truthful failure, unchanged choices and exact restored-feed retry", async (t) => {
  const { prepareInstalledFeedOutage } = await import("./desktop-installed-feed-outage.mts");
  const { access, readFile } = await import("node:fs/promises");
  for (const change of [null, "staged", "preferences", "current", "wrong-alert"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "portcove-installed-feed-journey-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const metadata = path.join(root, "metadata");
    await mkdir(metadata);
    const timestamp = path.join(metadata, "timestamp.json"),
      bytes = Buffer.from('{"signed":{"version":9}}\n');
    await writeFile(timestamp, bytes);
    const control = await prepareInstalledFeedOutage(metadata, path.join(root, "control"));
    let unavailable = false;
    const checks: boolean[] = [],
      actions: string[] = [];
    const choices = { revision: 3, choice: { channel: "stable", mode: "manual" } };
    const status = { ...fixture().before, schedule: { consecutive_failures: 0 } };
    const message = "The online request could not be completed.";
    const browser = {
      manage: () => ({ setTimeouts: async () => {} }),
      wait: async (condition: { value?: string } | (() => Promise<unknown>)) => {
        if (typeof condition === "function") {
          assert.equal(await condition(), true);
          return {};
        }
        const alert = condition.value?.includes('role="alert"');
        if (alert)
          assert.equal(
            unavailable,
            true,
            "Failure UI must be observed while the real fixture file is absent",
          );
        return {
          click: async () => {},
          getText: async () =>
            alert
              ? change === "wrong-alert"
                ? "Portcove is current"
                : message
              : "No eligible release is published for the selected channel.",
        };
      },
      findElement: (locator: { value: string }) => ({
        click: async () => {
          if (locator.value.includes('normalize-space(.)="Check for updates"')) {
            unavailable = await access(timestamp).then(
              () => false,
              () => true,
            );
            checks.push(!unavailable);
          }
        },
      }),
      findElements: async (locator: { value: string }) =>
        change === "current" && unavailable && locator.value.includes("Portcove is current")
          ? [{}]
          : [],
      executeAsyncScript: async (query: unknown) => {
        const preferences = String(query).includes("get_application_update_preferences");
        assert.ok(preferences || String(query).includes("get_application_update_status"));
        return JSON.stringify({
          ok: true,
          value: preferences
            ? unavailable && change === "preferences"
              ? { ...choices, revision: 4 }
              : choices
            : {
                ...status,
                schedule: { consecutive_failures: unavailable ? 1 : 0 },
                ...(unavailable && change === "staged" ? { staged: { version: "0.3.0" } } : {}),
              },
        });
      },
    } as unknown as WebDriver;
    if (change)
      await assert.rejects(
        driveInstalledFeedOutage(browser, actions, control.configuration, control.sha256),
      );
    else {
      const result = await driveInstalledFeedOutage(
        browser,
        actions,
        control.configuration,
        control.sha256,
      );
      assert.deepEqual(checks, [true, false, true]);
      assert.equal(result.failed.message, message);
      assert.equal(result.failed.status.staged, null);
      assert.equal(
        result.failed.status.schedule && isRecord(result.failed.status.schedule)
          ? result.failed.status.schedule.consecutive_failures
          : null,
        1,
      );
      assert.equal(actions.at(-1), "owned-file-feed-explicit-retry-completed");
    }
    assert.deepEqual(
      await readFile(timestamp),
      bytes,
      "Every failed oracle still restores the original feed",
    );
  }
});

void test("feed restoration refuses a live faulting driver before restoring its source", async (t) => {
  const { prepareInstalledFeedOutage, withInstalledFeedOutage, restoreInstalledFeedOutage } =
    await import("./desktop-installed-feed-outage.mts");
  const { access, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "portcove-installed-feed-live-writer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = path.join(root, "metadata");
  await mkdir(metadata);
  const timestamp = path.join(metadata, "timestamp.json"),
    bytes = Buffer.from('{"signed":{"version":10}}\n');
  await writeFile(timestamp, bytes);
  const control = await prepareInstalledFeedOutage(metadata, path.join(root, "control"));
  await withInstalledFeedOutage(control.configuration, control.sha256, async () => {
    await assert.rejects(restoreInstalledFeedOutage(control.configuration, control.sha256), {
      code: "PORTCOVE_RESOURCE_BUSY",
    });
    await assert.rejects(access(timestamp), { code: "ENOENT" });
  });
  assert.deepEqual(await readFile(timestamp), bytes);
});

void test("parent feed recovery seals out a late driver that has not started its fault window", async (t) => {
  const { prepareInstalledFeedOutage, withInstalledFeedOutage, restoreInstalledFeedOutage } =
    await import("./desktop-installed-feed-outage.mts");
  const { readFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "portcove-installed-feed-late-writer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = path.join(root, "metadata");
  await mkdir(metadata);
  const timestamp = path.join(metadata, "timestamp.json"),
    bytes = Buffer.from('{"signed":{"version":11}}\n');
  await writeFile(timestamp, bytes);
  const control = await prepareInstalledFeedOutage(metadata, path.join(root, "control"));
  await restoreInstalledFeedOutage(control.configuration, control.sha256);
  let observed = false;
  await assert.rejects(
    withInstalledFeedOutage(control.configuration, control.sha256, async () => {
      observed = true;
    }),
    /closed to new fault writers/u,
  );
  assert.equal(observed, false);
  assert.deepEqual(await readFile(timestamp), bytes);
});

for (const stale of [false, true]) {
  void test(`busy restart ${stale ? "rejects stale Conflict text before clicking" : "requires a fresh Conflict after the enabled ordinary click"}`, async () => {
    const message =
      "The selection changed or another operation is using it. Review its current state.";
    const status = {
      install_eligibility: "eligible",
      staged: { version: "0.3.0", sha256: "a".repeat(64) },
      apply: null,
      recovery_required: [],
    };
    const preferences = {
      revision: 1,
      choice: { channel: "preview", mode: "manual", paused: false },
    };
    let clicked = false,
      heldChecks = 0;
    const browser = {
      executeAsyncScript: async (query: unknown) =>
        JSON.stringify({
          ok: true,
          value: String(query).includes("get_application_update_preferences")
            ? preferences
            : status,
        }),
      findElements: async (locator: { value: string }) =>
        locator.value.includes('role="alert"') && (stale || clicked) ? [{}] : [],
      findElement: (locator: { value: string }) => ({
        click: async () => {
          assert.match(locator.value, /Restart to update/u);
          clicked = true;
        },
      }),
      wait: async (condition: { value: string }) => {
        if (condition.value.includes('role="alert"')) assert.equal(clicked, true);
        else assert.match(condition.value, /Restart to update.*not\(@disabled\)/u);
        return { getText: async () => message };
      },
    } as unknown as WebDriver;
    const actions: string[] = [];
    const observe = () =>
      driveInstalledBusyRestartRefusal(browser, actions, async () => {
        heldChecks++;
      });
    if (stale) {
      await assert.rejects(observe(), /stale|already|existing|fresh/iu);
      assert.equal(clicked, false);
      assert.deepEqual(actions, []);
    } else {
      const result = await observe();
      assert.equal(clicked, true);
      assert.equal(heldChecks, 2);
      assert.deepEqual(result.before.staged, result.after.staged);
      assert.equal(result.after.apply, null);
      assert.equal(result.message, message);
      assert.deepEqual(actions, [
        "ordinary-restart-requested-while-real-core-activity-held",
        "real-core-busy-restart-refused-without-apply-intent",
      ]);
    }
  });
}
