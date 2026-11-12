import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  corpusPath,
  enrollSelectionCase,
  inventoryFromObservation,
  main,
  type Corpus,
} from "./catalog-selection-enrollment.mts";

const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
const asset = (id: number, name: string, fill: string | null = "a") => ({
  id,
  name,
  browser_download_url: `https://downloads.example.invalid/${name}`,
  size: 10 + id,
  digest: fill === null ? null : digest(fill),
  state: "uploaded",
});
const observation = (portId = "demo-port") => ({
  configured_scope: { port_id: portId },
  observation: {
    facts: {
      repository: { id: 42, full_name: "example/demo" },
      releases: [
        {
          id: 3,
          tag_name: "v2",
          draft: false,
          prerelease: false,
          published_at: "2026-02-01T00:00:00Z",
          assets: [
            asset(31, "demo-2-windows.zip"),
            asset(32, "demo-2-macos.zip", "b"),
            asset(33, "demo-2-linux.tar.gz", "c"),
          ],
        },
        {
          id: 2,
          tag_name: "v1",
          draft: false,
          prerelease: false,
          published_at: "2026-01-01T00:00:00Z",
          assets: [
            asset(22, "demo-1-macos.zip", "b"),
            asset(21, "demo-1-windows.zip"),
            asset(23, "demo-1-linux.tar.gz", null),
          ],
        },
      ],
    },
  },
});
const emptyCorpus = (): Corpus => ({ cases: {}, inventories: {}, other_zip_assets: [] });

void test("transcribes observed releases oldest first with sorted assets", () => {
  const { repositoryId, releases } = inventoryFromObservation(observation(), "demo-port", [
    "v2",
    "v1",
  ]);
  assert.equal(repositoryId, 42);
  assert.deepEqual(
    releases.map((release) => release.tag_name),
    ["v1", "v2"],
  );
  assert.deepEqual(
    releases[0]!.assets.map((item) => item.name),
    ["demo-1-linux.tar.gz", "demo-1-macos.zip", "demo-1-windows.zip"],
  );
  assert.deepEqual(Object.keys(releases[0]!.assets[0]!), [
    "id",
    "name",
    "browser_download_url",
    "size",
    "digest",
  ]);
  assert.throws(
    () => inventoryFromObservation(observation("other"), "demo-port", ["v1", "v2"]),
    /belongs to other/u,
  );
  assert.throws(
    () => inventoryFromObservation(observation(), "demo-port", ["v1", "v3"]),
    /v3 must be observed exactly once/u,
  );
});

void test("enrolls the case and classifies only unselected ZIPs", () => {
  const { repositoryId, releases } = inventoryFromObservation(observation(), "demo-port", [
    "v1",
    "v2",
  ]);
  const corpus = enrollSelectionCase(emptyCorpus(), {
    portId: "demo-port",
    inventory: "demo",
    repositoryId,
    releases,
    selections: { "windows-x86-64": ["demo-1-windows.zip", "demo-2-windows.zip"] },
  });
  assert.deepEqual(corpus.cases["demo-port"], {
    inventory: "demo",
    repository_id: 42,
    selected_assets: ["demo-1-windows.zip", "demo-2-windows.zip"],
  });
  assert.deepEqual(corpus.other_zip_assets, [
    { inventory: "demo", release_index: 0, asset: "demo-1-macos.zip" },
    { inventory: "demo", release_index: 1, asset: "demo-2-macos.zip" },
  ]);

  // A second title reusing the identical inventory reclassifies its selected ZIPs.
  const shared = enrollSelectionCase(corpus, {
    portId: "demo-mac",
    inventory: "demo",
    repositoryId,
    releases,
    selections: {
      "windows-x86-64": ["demo-1-windows.zip", "demo-2-windows.zip"],
      "macos-aarch64": ["demo-1-macos.zip", "demo-2-macos.zip"],
    },
    channel: "stable",
  });
  assert.deepEqual(shared.other_zip_assets, []);
  assert.equal(shared.cases["demo-mac"]!.channel, "stable");
  assert.deepEqual(corpus.other_zip_assets.length, 2, "the input corpus is unchanged");
});

void test("refuses incomplete, unpublished or conflicting enrollments", () => {
  const { repositoryId, releases } = inventoryFromObservation(observation(), "demo-port", [
    "v1",
    "v2",
  ]);
  const base = {
    portId: "demo-port",
    inventory: "demo",
    repositoryId,
    releases,
    selections: { "windows-x86-64": ["demo-1-windows.zip", "demo-2-windows.zip"] },
  };
  assert.throws(
    () => enrollSelectionCase(emptyCorpus(), { ...base, selections: {} }),
    /Windows x86-64 selection is required/u,
  );
  assert.throws(
    () =>
      enrollSelectionCase(emptyCorpus(), {
        ...base,
        selections: { ...base.selections, "linux-x86-64": ["demo-1-linux.tar.gz"] },
      }),
    /exactly one selected asset/u,
  );
  assert.throws(
    () =>
      enrollSelectionCase(emptyCorpus(), {
        ...base,
        selections: {
          ...base.selections,
          "linux-x86-64": ["demo-1-linux.tar.gz", "demo-2-linux.tar.gz"],
        },
      }),
    /v1 demo-1-linux.tar.gz has no published SHA-256/u,
  );
  assert.throws(
    () =>
      enrollSelectionCase(emptyCorpus(), {
        ...base,
        selections: { "windows-x86-64": ["demo-1-windows.zip", "missing.zip"] },
      }),
    /v2 has no asset named missing.zip/u,
  );
  const enrolled = enrollSelectionCase(emptyCorpus(), base);
  assert.throws(() => enrollSelectionCase(enrolled, base), /already enrolled/u);
  assert.throws(
    () =>
      enrollSelectionCase(enrolled, {
        ...base,
        portId: "demo-other",
        releases: releases.slice().reverse(),
      }),
    /already holds different releases/u,
  );
  assert.throws(
    () => enrollSelectionCase(emptyCorpus(), { ...base, releases: releases.slice(0, 1) }),
    /at least two releases/u,
  );
});

void test("the command previews by default and writes only on request", () => {
  const root = mkdtempSync(join(tmpdir(), "portcove-selection-enrollment-"));
  try {
    const corpusFile = join(root, corpusPath);
    mkdirSync(dirname(corpusFile), { recursive: true });
    const original = `${JSON.stringify(emptyCorpus(), null, 2)}\n`;
    writeFileSync(corpusFile, original);
    const observationFile = join(root, "observation.json");
    writeFileSync(observationFile, JSON.stringify(observation()));
    const args = [
      "--observation",
      observationFile,
      "--port",
      "demo-port",
      "--tags",
      "v1,v2",
      "--select",
      "windows-x86-64=demo-1-windows.zip,demo-2-windows.zip",
    ];
    const preview = JSON.parse(main(args, root)) as { case: { inventory: string } };
    assert.equal(preview.case.inventory, "demo-port");
    assert.equal(readFileSync(corpusFile, "utf8"), original);
    assert.match(main([...args, "--write"], root), /vp fmt/u);
    const written = JSON.parse(readFileSync(corpusFile, "utf8")) as Corpus;
    assert.deepEqual(Object.keys(written.cases), ["demo-port"]);
    assert.throws(() => main([...args, "--select", "windows-x86-64=a,b"], root), /repeats/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
