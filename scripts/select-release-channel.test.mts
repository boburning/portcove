import assert from "node:assert/strict";
import test from "node:test";

import { selectReleaseForChannel } from "./select-release-channel.mts";

function required<Value>(value: Value | null): Value {
  assert.ok(value !== null);
  return value;
}
const releases = [
  {
    tag_name: "v2.0.0-beta.2",
    draft: false,
    prerelease: true,
    published_at: "2026-09-05T12:00:00Z",
  },
  {
    tag_name: "v2.0.0-beta.3",
    draft: true,
    prerelease: true,
    published_at: "2026-09-06T12:00:00Z",
  },
  {
    tag_name: "v1.5.0",
    draft: false,
    prerelease: false,
    published_at: "2026-08-01T12:00:00Z",
  },
  {
    tag_name: "v2.0.0-beta.1",
    draft: false,
    prerelease: true,
    published_at: "2026-09-01T12:00:00Z",
  },
];

void test("selects the newest published preview without returning a draft or older stable", () => {
  assert.equal(required(selectReleaseForChannel(releases, "preview")).tag_name, "v2.0.0-beta.2");
});

void test("selects stable independently when a newer preview exists", () => {
  assert.equal(selectReleaseForChannel(releases, "stable"), null);
  const eligibility = {
    "v1.5.0": {
      version: "1.5.0",
      preview_eligible: true,
      production_eligible: true,
    },
  };
  assert.equal(
    required(selectReleaseForChannel(releases, "stable", { eligibility })).tag_name,
    "v1.5.0",
  );
});

void test("supports preview-only repositories and reports absent stable", () => {
  const previewOnly = releases.filter((release) => release.prerelease);
  assert.equal(required(selectReleaseForChannel(previewOnly, "preview")).tag_name, "v2.0.0-beta.2");
  assert.equal(selectReleaseForChannel(previewOnly, "stable"), null);
});

void test("rejects unknown channels", () => {
  assert.throws(() => selectReleaseForChannel(releases, "latest"), /unknown release channel/);
});

void test("rejects a published channel candidate without a trustworthy publication timestamp", () => {
  const malformed = [
    {
      tag_name: "v2.0.0-beta.4",
      draft: false,
      prerelease: true,
      published_at: "not-a-date",
    },
  ];
  assert.throws(() => selectReleaseForChannel(malformed, "preview"), /invalid published timestamp/);
});
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

void test("native release selector CLI preserves arguments, JSON output and absent-channel exit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-release-selector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "releases.json");
  const evidence = path.join(root, "eligibility.json");
  await writeFile(input, JSON.stringify(releases));
  await writeFile(
    evidence,
    JSON.stringify({
      "v1.5.0": {
        version: "1.5.0",
        preview_eligible: true,
        production_eligible: true,
        targets: ["windows-x86_64"],
      },
    }),
  );
  const script = fileURLToPath(new URL("./select-release-channel.mts", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
  const selected = run(
    "--channel",
    "stable",
    "--input",
    input,
    "--eligibility",
    evidence,
    "--current-version",
    "1.0.0",
    "--target",
    "windows-x86_64",
  );
  assert.equal(selected.status, 0, selected.stderr);
  const value: unknown = JSON.parse(selected.stdout);
  assert.deepEqual(
    value,
    releases.find((release) => release.tag_name === "v1.5.0"),
  );
  const absent = run("--channel", "stable", "--input", input);
  assert.equal(absent.status, 4);
  assert.equal(absent.stdout, "");
  assert.equal(absent.stderr.trim(), "No published stable release is available.");
  for (const args of [
    ["--channel", "preview", "--channel", "stable", "--input", input],
    ["--channel", "preview", "--input"],
    ["--unknown", "preview", "--input", input],
  ]) {
    const invalid = run(...args);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /invalid or duplicate release selection argument/);
    assert.equal(invalid.stdout, "");
  }
  await writeFile(input, "{}");
  const malformed = run("--channel", "preview", "--input", input);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /release response must be an array/);
});
