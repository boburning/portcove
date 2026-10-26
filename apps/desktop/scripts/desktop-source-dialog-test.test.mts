import assert from "node:assert/strict";
import { it } from "vite-plus/test";
import {
  selectedSetupGeneration,
  selectedSetupRead,
  selectedSetupScenario,
  selectedSetupScanCompleted,
  sourceProfileLabel,
} from "./desktop-source-dialog-test.mts";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInstallFixture } from "./desktop-install-fixture.mts";
import { fixtureObject as object } from "./desktop-scenario-state.mts";
import { Session, WebDriver, WebElement } from "selenium-webdriver";
import { runInNewContext } from "node:vm";
import type { GameFileScanSnapshot } from "../src/transport-types.generated.d.ts";
import { clickVisible, selectGameFilesSettings } from "./desktop-review-controls.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";

function offscreenReviewControl(mode: "normal" | "hidden" | "disabled" | "occluded") {
  const state = { scrolled: false, clicks: 0, visibilityChecks: 0, enabledChecks: 0, hits: 0 };
  const control = {
    outerHTML: '<button role="tab">Tasks</button>',
    parentElement: null,
    closest: () => null,
    getAnimations: () => [],
    focus: () => {},
    scrollIntoView: () => {
      if (mode !== "hidden") state.scrolled = true;
    },
    getBoundingClientRect: () => ({
      x: 96,
      y: state.scrolled ? 20 : -295,
      width: 130,
      height: 40,
    }),
    contains: (hit: unknown) => hit === control,
  };
  const document = {
    activeElement: control,
    elementFromPoint: () => {
      state.hits++;
      return state.scrolled && mode !== "occluded" ? control : null;
    },
  };
  const browser = new WebDriver(new Session(`offscreen-review-${mode}`, {}), {
    execute: async (command) => {
      switch (command.getName()) {
        case "executeScript": {
          const parameters: unknown = command.getParameters();
          assert.ok(isRecord(parameters) && typeof parameters.script === "string");
          assert.ok(Array.isArray(parameters.args) && parameters.args.length === 1);
          // Execute the helper's actual serialized callbacks against the recorded
          // offscreen shape; do not replace scrolling/hit testing with a stub true.
          const result: unknown = runInNewContext(
            `(function(){${parameters.script}}).apply(null, args)`,
            { args: [control], document, window: { innerWidth: 960, innerHeight: 640 } },
          );
          return result;
        }
        case "isElementDisplayed":
          state.visibilityChecks++;
          if (mode !== "hidden")
            assert.ok(
              state.scrolled,
              "scroll the offscreen target before native visibility polling",
            );
          return mode !== "hidden";
        case "isElementEnabled":
          state.enabledChecks++;
          return mode !== "disabled";
        case "clickElement":
          state.clicks++;
          return;
        default:
          assert.fail(`Unexpected review interaction command: ${command.getName()}`);
      }
    },
  });
  return { browser, element: new WebElement(browser, "review-tab"), state };
}

it("scrolls an offscreen native review target before asking the driver for visibility", async () => {
  const { browser, element, state } = offscreenReviewControl("normal");
  await clickVisible(browser, element);
  assert.equal(state.clicks, 1);
  assert.ok(state.visibilityChecks > 0 && state.enabledChecks > 0 && state.hits > 0);
});

for (const mode of ["hidden", "disabled", "occluded"] as const)
  it(`scrolling a ${mode} native review control never grants click permission`, async () => {
    const { browser, element, state } = offscreenReviewControl(mode);
    const refusal = {
      hidden: /Waiting until element is visible/,
      disabled: /Waiting until element is enabled/,
      occluded: /The reviewed control must receive the pointer before clicking/,
    }[mode];
    await assert.rejects(clickVisible(browser, element), refusal);
    assert.equal(state.clicks, 0);
    if (mode !== "hidden") assert.ok(state.scrolled);
  }, 10_000);

it("selects the Game files category and waits for its mounted panel to become visible", async () => {
  let selected = false;
  let headingVisibilityChecks = 0;
  const browser = new WebDriver(new Session("settings-category", {}), {
    execute: async (command) => {
      const parameters: unknown = command.getParameters();
      assert.ok(isRecord(parameters));
      switch (command.getName()) {
        case "findElements":
          assert.ok(typeof parameters.value === "string");
          if (parameters.value.includes("game-file-libraries-heading")) {
            assert.equal(selected, true, "select the category before using its mounted panel");
            return [{ ELEMENT: "heading" }];
          }
          assert.match(parameters.value, /Settings categories/);
          return [{ ELEMENT: "category" }];
        case "executeScript":
        case "isElementEnabled":
          return true;
        case "isElementDisplayed":
        case "clickElement": {
          assert.ok(isRecord(parameters.id));
          const handle: Record<string, string> = {};
          for (const [key, value] of Object.entries(parameters.id)) {
            assert.ok(typeof value === "string");
            handle[key] = value;
          }
          assert.ok(WebElement.isId(handle));
          const id = WebElement.extractId(handle);
          if (command.getName() === "isElementDisplayed")
            return id === "heading" ? ++headingVisibilityChecks > 1 : true;
          assert.equal(id, "category");
          selected = true;
          return;
        }
        default:
          assert.fail(`Unexpected settings navigation command: ${command.getName()}`);
      }
    },
  });
  await selectGameFilesSettings(browser);
  assert.equal(selected, true);
  assert.ok(headingVisibilityChecks >= 2, "a located but hidden panel is not ready");
});

it("preserves Settings navigation failures before using a hidden Game files panel", async () => {
  const failure = new Error("Settings category unavailable");
  const browser = new WebDriver(new Session("settings-category-refusal", {}), {
    execute: async (command) => {
      assert.equal(command.getName(), "findElements");
      const parameters: unknown = command.getParameters();
      assert.ok(isRecord(parameters));
      assert.ok(typeof parameters.value === "string");
      assert.match(parameters.value, /Settings categories/);
      throw failure;
    },
  });
  await assert.rejects(selectGameFilesSettings(browser), (error: unknown) => error === failure);
});

it("waits for the native scan control before reading newly completed activity", async () => {
  let release: ((enabled: boolean) => void) | undefined;
  let activityReads = 0;
  const enabled = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const pending = selectedSetupScanCompleted(
    () => enabled,
    () => {
      activityReads++;
      return [{ id: "new", operation: "discover_sources", status: "succeeded" }];
    },
    new Set(),
  );
  await Promise.resolve();
  assert.equal(activityReads, 0, "a pending WebDriver result cannot count as enabled");
  assert.ok(release);
  release(false);
  assert.equal(await pending, false);
  assert.equal(activityReads, 0, "disabled scan controls must continue waiting");
});

it("requires a new successful discovery after the control becomes enabled", async () => {
  const previous = new Set(["old"]);
  for (const record of [
    { id: "old", operation: "discover_sources", status: "succeeded" },
    { id: "new", operation: "discover_sources", status: "running" },
    { id: "new", operation: "register_source", status: "succeeded" },
  ] as const) {
    assert.equal(
      await selectedSetupScanCompleted(
        async () => true,
        () => [record],
        previous,
      ),
      false,
    );
  }
  assert.equal(
    await selectedSetupScanCompleted(
      async () => true,
      () => [{ id: "new", operation: "discover_sources", status: "succeeded" }],
      previous,
    ),
    true,
  );
});

it("preserves driver and activity failures rather than treating them as completion", async () => {
  const failure = new Error("owned scan failure");
  await assert.rejects(
    selectedSetupScanCompleted(
      async () => {
        throw failure;
      },
      () => assert.fail("driver refusal must short circuit activity reads"),
      new Set(),
    ),
    (error: unknown) => error === failure,
  );
  await assert.rejects(
    selectedSetupScanCompleted(
      async () => true,
      () => {
        throw failure;
      },
      new Set(),
    ),
    (error: unknown) => error === failure,
  );
});

it("reads the real raw qualification catalog label before Core fills output defaults", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "portcove-raw-source-label-"));
  let fixture: Awaited<ReturnType<typeof createInstallFixture>> | undefined;
  try {
    fixture = await createInstallFixture({
      root: fileURLToPath(new URL("../../../", import.meta.url)),
      output,
      sourceJourney: true,
      preliminaryJourney: true,
      revision: "a".repeat(40),
    });
    assert.ok(fixture.preliminaryJourney);
    const text = await readFile(fixture.catalogPath, "utf8");
    const catalog: unknown = JSON.parse(text);
    assert.ok(sourceProfileLabel(catalog, fixture.preliminaryJourney.profile).length > 0);
    assert.equal(
      await readFile(fixture.catalogPath, "utf8"),
      text,
      "label lookup must not fill or rewrite defaults",
    );
    for (const malformed of [
      null,
      {},
      { source_catalog: { identities: null } },
      { source_catalog: { identities: [null] } },
      { source_catalog: { identities: [{ id: "owned", label: ["coercible"] }] } },
    ]) {
      assert.throws(() => sourceProfileLabel(malformed, "owned"));
    }
    assert.throws(() => sourceProfileLabel(catalog, "missing-profile"));
  } finally {
    await fixture?.close();
    assert.equal(path.dirname(output), tmpdir());
    await rm(output, { recursive: true, force: true });
  }
});

it("binds native saved-scan harness reads to their captured bootstrap generation", async () => {
  let currentGeneration = 7;
  const invoke = async (name: string, args?: Record<string, unknown>) => {
    if (name === "get_bootstrap_status")
      return {
        ok: true,
        value: {
          ready: true,
          generation: currentGeneration,
          library_root: null,
          selection: null,
          error: null,
        },
      };
    assert.equal(name, "get_game_file_scan_snapshot");
    assert.equal(args?.generation, 7, "the old intention must not resolve the new bootstrap");
    return { ok: false, error: "open library changed" };
  };
  const generation = await selectedSetupGeneration(invoke);
  const read = selectedSetupRead(invoke, generation);
  currentGeneration = 8;
  await assert.rejects(read("get_game_file_scan_snapshot"), /open library changed/);
});

it.each([
  ["preliminary", "preliminary-source-review.json"],
  ["preliminary-setup", "preliminary-selected-setup.json"],
  ["hash-resume", "saved-folder-hash-resume.json"],
  ["saved-folder", "selected-setup-journey.json"],
] as const)(
  "retains %s bootstrap failures with original inputs and report custody",
  async (mode, reportName) => {
    const output = await mkdtemp(path.join(tmpdir(), "portcove-source-bootstrap-failure-"));
    const fixture = await createInstallFixture({
      root: fileURLToPath(new URL("../../../", import.meta.url)),
      output,
      sourceJourney: true,
      preliminaryJourney: mode === "preliminary" || mode === "preliminary-setup",
      preliminarySetupJourney: mode === "preliminary-setup",
      hashResumeJourney: mode === "hash-resume",
      revision: "a".repeat(40),
    });
    const owned = fixture.sourceJourney;
    assert.ok(owned);
    const root = {
      id: "owned-root",
      path: owned.directory,
      availability: "available" as const,
      created_at: 1,
      updated_at: 1,
    };
    const hashResumeInitial: GameFileScanSnapshot = {
      format_version: 12,
      catalog_sha256: "a".repeat(64),
      completed_at: 1,
      freshness: "inputs_match",
      roots: [root],
      limits: {
        max_entries: 10_000,
        max_depth: 6,
        max_file_bytes: 2 * 1024 ** 3,
        max_hash_bytes: 16 * 1024 ** 3,
        max_candidates: 64,
      },
      report: {
        searched_roots: [root.path],
        searched_profiles: [],
        candidates: [],
        entries_examined: 0,
        files_hashed: 0,
        hash_bytes: 0,
        symlinks_skipped: 0,
        limits_reached: [],
        issues: [],
        issues_omitted: 0,
      },
    };
    const browser = new WebDriver(new Session("bootstrap-refusal", {}), {
      execute: async () => {
        throw new Error("read-only failure-state capture unavailable");
      },
    });
    const preliminary = fixture.preliminaryJourney;
    const originals: readonly (readonly [string, string])[] = preliminary
      ? [[preliminary.path, preliminary.before]]
      : [
          [owned.gamePath, owned.gameBefore],
          [owned.biosPath, owned.biosBefore],
        ];
    try {
      for (const [index, failure] of [false, 0, "", null, undefined].entries()) {
        const reportDirectory = path.join(output, `failure-${index}`);
        await mkdir(reportDirectory);
        const artifacts: string[] = [];
        await assert.rejects(
          selectedSetupScenario({
            browser,
            fixture: { ...fixture, sourceJourney: { ...owned, root }, hashResumeInitial },
            output: reportDirectory,
            artifacts,
            library: path.join(output, "library"),
            cli: process.execPath,
            invoke: (name) => {
              assert.equal(name, "get_bootstrap_status");
              return Promise.reject(failure);
            },
            scenario: async (_name, execute) => execute(),
          }),
          (error: unknown) => Object.is(error, failure),
        );
        const artifact = path.join(reportDirectory, reportName);
        const rawReport: unknown = JSON.parse(await readFile(artifact, "utf8"));
        const report = object(rawReport);
        assert.equal(report.failure, String(failure));
        if (mode === "saved-folder") assert.equal(report.original_inputs_restored, true);
        assert.deepEqual(artifacts, [artifact]);
        for (const [actual, original] of originals)
          assert.deepEqual(await readFile(actual), await readFile(original));
        assert.equal(fixture.requests.length, 0);
      }
    } finally {
      await fixture.close();
      await rm(output, { recursive: true, force: true });
    }
  },
);
