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
import { Session, WebDriver } from "selenium-webdriver";
import type { GameFileScanSnapshot } from "../src/transport-types.generated.d.ts";

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
