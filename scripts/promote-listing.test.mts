import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  expectManagedDownload,
  githubRepository,
  insertSortedPortId,
  promotePort,
  removeListingOnlyTests,
} from "./promote-listing.mts";

const listing = () => ({
  format_version: 1,
  listing: {
    id: "example-recomp",
    name: "Example",
    platforms: ["windows-x86-64", "linux-x86-64"],
    release_url: "https://github.com/Owner/example-recomp/releases",
    download_asset_hints: {
      "windows-x86-64": ["Example-", "-windows.zip"],
      "linux-x86-64": ["Example-", "-linux.tar.gz"],
    },
    recommended_download_channel: "beta",
  },
});
const layout = { directories: ["assets"], executables: ["example.exe"] };
const options = {
  platforms: ["windows-x86-64" as const],
  executables: { "windows-x86-64": "Example.exe" },
  layouts: { "windows-x86-64": layout },
  preparation: "On first Play, choose your own original.",
};

void test("promotion writes the managed route from the listing and inspected layout", () => {
  const promoted = promotePort(listing(), options);
  assert.deepEqual(promoted.integration, {
    support_tier: "beta",
    channels: ["beta"],
    platforms: ["windows-x86-64"],
    adapter: "native-portable",
    release: {
      provider: "github",
      repository: "Owner/example-recomp",
      asset_hints: { "windows-x86-64": ["Example-", "-windows.zip"] },
    },
    executable_hints: { "windows-x86-64": ["Example.exe"] },
    persistent_paths: [],
    presentation: {
      installation_method: "portable-package",
      source_requirements: [],
      saves_and_settings: "external-user-owned",
      manual_preparation: "On first Play, choose your own original.",
    },
    reviewed_package_layouts: { "windows-x86-64": layout },
  });
  // Linux stays on the listing until it is managed too.
  assert.deepEqual((promoted.listing as { platforms: string[] }).platforms, ["linux-x86-64"]);
  const both = promotePort(listing(), {
    ...options,
    platforms: ["windows-x86-64", "linux-x86-64"],
    executables: { "windows-x86-64": "Example.exe", "linux-x86-64": "Example" },
    layouts: {
      "windows-x86-64": layout,
      "linux-x86-64": { directories: [], executables: ["example"] },
    },
    persistentPaths: ["saves"],
    launchEnvironment: { EXAMPLE_PORTABLE: "1" },
  });
  assert.equal("platforms" in (both.listing as object), false);
  const integration = both.integration as Record<string, unknown>;
  assert.deepEqual(integration.launch_environment, { EXAMPLE_PORTABLE: "1" });
  assert.equal(
    (integration.presentation as Record<string, unknown>).saves_and_settings,
    "portcove-managed",
  );
});

void test("promotion refuses incomplete or inconsistent inputs", () => {
  assert.throws(
    () => promotePort({ ...listing(), integration: {} }, options),
    /already has an integration/,
  );
  assert.throws(() => promotePort(listing(), { ...options, preparation: " " }), /preparation text/);
  assert.throws(
    () => promotePort(listing(), { ...options, executables: { "windows-x86-64": "Other.exe" } }),
    /not a program in the inspected/,
  );
  assert.throws(
    () => promotePort(listing(), { ...options, layouts: {} }),
    /Inspect the windows-x86-64 package/,
  );
  assert.throws(
    () =>
      promotePort(listing(), {
        ...options,
        platforms: ["macos-aarch64"],
        executables: { "macos-aarch64": "x" },
      }),
    /no download asset hints for macos-aarch64/,
  );
  const unlinked = listing();
  unlinked.listing.release_url = "https://example.invalid/releases";
  assert.throws(() => promotePort(unlinked, options), /Name the GitHub repository/);
});

void test("GitHub repositories come from release or project URLs", () => {
  assert.equal(githubRepository("https://github.com/a/b/releases"), "a/b");
  assert.equal(githubRepository("https://github.com/a/b.git"), "a/b");
  assert.equal(githubRepository("https://github.com/a/b"), "a/b");
  assert.equal(githubRepository("https://gitlab.com/a/b"), undefined);
});

void test("fixture insertion keeps the reviewed list sorted and is idempotent", () => {
  const text = `${JSON.stringify({ source_profile_ids: ["p"], port_ids: ["a-port", "c-port"] }, null, 2)}\n`;
  const inserted = insertSortedPortId(text, "b-port");
  assert.equal(inserted.changed, true);
  const fixture = JSON.parse(inserted.text) as { port_ids: string[]; source_profile_ids: string[] };
  assert.deepEqual(fixture.port_ids, ["a-port", "b-port", "c-port"]);
  assert.deepEqual(fixture.source_profile_ids, ["p"]);
  assert.equal(insertSortedPortId(inserted.text, "b-port").changed, false);
});

void test("the real test files contain the shapes the promotion edits", () => {
  const selected = readFileSync("crates/portcove-core/src/service/user_selected.rs", "utf8");
  // One-line and wrapped listing-only assertions.
  for (const id of [
    "dahsidiabdallah-conkerbfdreloaded",
    "castlevania-symphony-of-the-night-ps1-symphonyrecomp",
  ]) {
    const removed = removeListingOnlyTests(selected, id);
    assert.equal(removed.changed, 1, id);
    assert.equal(removed.text.includes(`"${id}"`), false, id);
    assert.equal(removed.text.length < selected.length, true);
  }
  assert.equal(removeListingOnlyTests(selected, "no-such-port").changed, 0);

  const downloads = readFileSync(
    "crates/portcove-core/src/service/catalog_download_tests.rs",
    "utf8",
  );
  const flipped = expectManagedDownload(downloads, "dahsidiabdallah-conkerbfdreloaded", [
    "windows-x86-64",
    "linux-x86-64",
  ]);
  assert.equal(flipped.changed, 1);
  assert.match(
    flipped.text,
    /"dahsidiabdallah-conkerbfdreloaded",\n\s+"[^"]+",\n\s+"[^"]+",\n\s+Some\(crate::AdapterKind::NativePortable\),\n\s+&\[Platform::WindowsX86_64, Platform::LinuxX86_64\],\n/u,
  );
  assert.equal(expectManagedDownload(downloads, "no-such-port", ["windows-x86-64"]).changed, 0);
});
