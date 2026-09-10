import assert from "node:assert/strict";
import test from "node:test";

import { artifactName, loadPackagePolicy } from "./release-package-policy.mjs";
import {
  mergeDownloadSection,
  renderDownloadSection,
} from "./generate-release-downloads.mjs";

const policy = await loadPackagePolicy();
const version = "0.1.0-alpha.2";
const tag = `v${version}`;
const inventory = {
  schema_version: 1,
  repository: policy.repository,
  version,
  tag,
  checksum_manifest: policy.checksum_manifest,
  checksum_url: `https://github.com/${policy.repository}/releases/download/${tag}/${policy.checksum_manifest}`,
  packages: policy.packages.map((entry, index) => {
    const filename = artifactName(entry, version);
    return {
      ...entry,
      filename,
      bytes: index + 1,
      sha256: `${index}`.padStart(64, "0"),
      download_url: `https://github.com/${policy.repository}/releases/download/${tag}/${filename}`,
    };
  }),
};

test("renders desktop first with readable labels and exact tag-bound links", () => {
  const section = renderDownloadSection(inventory);
  assert(
    section.indexOf("## Download the desktop app") <
      section.indexOf("## Command-line tools"),
  );
  assert(
    section.indexOf("## Command-line tools") <
      section.indexOf("## Verify your download"),
  );
  assert.match(section, /Windows — Intel\/AMD 64-bit/);
  assert.match(section, /Mac — Apple silicon \(experimental\)/);
  assert.match(section, /Mac — Intel \(experimental\)/);
  assert.match(section, /portcove-cli-0\.1\.0-alpha\.2-windows-x86_64\.zip/);
  assert.match(
    section,
    /releases\/download\/v0\.1\.0-alpha\.2\/Portcove_0\.1\.0-alpha\.2_x64-setup\.exe/,
  );
  assert.doesNotMatch(section, /releases\/latest|latest\/download/);
});

test("explains independent desktop, CLI, source, AppImage, and checksum boundaries", () => {
  const section = renderDownloadSection(inventory);
  assert.match(section, /desktop app is complete on its own/);
  assert.match(section, /not a portable graphical app/);
  assert.match(section, /Source code.*require the development toolchain/s);
  assert.match(
    section,
    /not a universal Linux or Steam Deck compatibility claim/,
  );
  assert.match(section, /does not independently prove publisher identity/);
});

test("generation is idempotent and preserves reviewed prose and categorized changes", () => {
  const body =
    "# Portcove 0.1.0-alpha.2\n\nReviewed introduction.\n\n## Features\n\n- Kept change.\n\n## Known limitations\n\n- Kept limitation.\n";
  const once = mergeDownloadSection(body, inventory);
  const twice = mergeDownloadSection(once, inventory);
  assert.equal(twice, once);
  assert.equal((once.match(/portcove-downloads:start/g) ?? []).length, 1);
  assert.match(once, /Reviewed introduction/);
  assert.match(once, /## Features\n\n- Kept change/);
  assert.match(once, /## Known limitations\n\n- Kept limitation/);
});

test("regeneration removes only the marked section and preserves historical links", () => {
  const historical =
    "Historical Alpha 1: https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.1\n";
  const merged = mergeDownloadSection(
    `${renderDownloadSection(inventory)}\n\n${historical}`,
    inventory,
  );
  assert.match(merged, /releases\/tag\/v0\.1\.0-alpha\.1/);
  assert.equal((merged.match(/portcove-downloads:start/g) ?? []).length, 1);
});

test("refuses malformed or duplicate generated sections instead of discarding reviewed prose", () => {
  assert.throws(
    () =>
      mergeDownloadSection(
        `Reviewed.\n${"<!-- portcove-downloads:start -->"}\npartial`,
        inventory,
      ),
    /incomplete or duplicate/,
  );
  const section = renderDownloadSection(inventory);
  assert.throws(
    () =>
      mergeDownloadSection(`${section}\n\nReviewed.\n\n${section}`, inventory),
    /incomplete or duplicate/,
  );
});
