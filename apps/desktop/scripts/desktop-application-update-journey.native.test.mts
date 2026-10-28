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
      "driveInstalledStableWaiting",
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
  driveInstalledStableWaiting,
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
