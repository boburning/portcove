import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  expectManagedDownload,
  githubRepository,
  insertSortedPortId,
  parseArguments,
  promotePort,
  removeListingOnlyTests,
} from "./promote-listing.mts";

const listing = () => ({
  format_version: 1,
  listing: {
    id: "example-recomp",
    name: "Example",
    summary: "An example.",
    original_game_title: "Example",
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
    savesAndSettings: "portcove-managed",
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

void test("a missing original game title can be supplied and lands after the summary", () => {
  const untitled = listing();
  delete (untitled.listing as { original_game_title?: string }).original_game_title;
  assert.throws(() => promotePort(untitled, options), /original_game_title/);
  const promoted = promotePort(untitled, { ...options, originalGameTitle: "Example Game" });
  const keys = Object.keys(promoted.listing as object);
  assert.equal(keys[keys.indexOf("summary") + 1], "original_game_title");
  assert.equal(
    (promoted.listing as { original_game_title: string }).original_game_title,
    "Example Game",
  );
  assert.throws(
    () => promotePort(listing(), { ...options, originalGameTitle: "Other" }),
    /already names its original game/,
  );
});

void test("promotion refuses incomplete, ambiguous or inconsistent inputs", () => {
  assert.throws(
    () => promotePort({ ...listing(), integration: {} }, options),
    /already has an integration/,
  );
  assert.throws(() => promotePort(listing(), { ...options, preparation: " " }), /preparation text/);
  // Kept files do not imply that Portcove owns the normal saves.
  assert.throws(
    () => promotePort(listing(), { ...options, persistentPaths: ["logs"] }),
    /need --saves/,
  );
  assert.throws(
    () => promotePort(listing(), { ...options, executables: { "windows-x86-64": "Other.exe" } }),
    /not a program in the inspected/,
  );
  assert.throws(
    () =>
      promotePort(listing(), {
        ...options,
        layouts: {
          "windows-x86-64": { directories: [], executables: ["a/example.exe", "b/example.exe"] },
        },
      }),
    /appears more than once/,
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
  // A non-GitHub release location must not fall back to the project URL's repository.
  const elsewhere = listing();
  (elsewhere.listing as { project_url?: string }).project_url = "https://github.com/Owner/other";
  elsewhere.listing.release_url = "https://example.invalid/releases";
  assert.throws(() => promotePort(elsewhere, options), /Name the GitHub repository/);
  // Core refuses both of these after generation; the promotion stops before any write.
  const blocked = listing();
  (blocked.listing as { restrictions?: unknown }).restrictions = [
    {
      id: "download",
      effect: "hold",
      operations: ["download"],
      reason: "package-facts-unresolved",
      explanation: "Use the ZIP.",
    },
  ];
  assert.throws(() => promotePort(blocked, options), /hold Download/);
  const channelSummary = listing();
  channelSummary.listing.summary = "Try the Windows beta with your own game.";
  assert.throws(() => promotePort(channelSummary, options), /summary mentions 'beta'/);
});

void test("launch arguments are written in order", () => {
  const promoted = promotePort(listing(), {
    ...options,
    launchArguments: ["--hdi", "game.hdi", "-tft"],
  });
  assert.deepEqual((promoted.integration as { launch_arguments?: string[] }).launch_arguments, [
    "--hdi",
    "game.hdi",
    "-tft",
  ]);
  const plain = promotePort(listing(), options);
  assert.equal("launch_arguments" in (plain.integration as object), false);
});

void test("arguments are parsed strictly", () => {
  const base = [
    "--port",
    "example-recomp",
    "--archive",
    "windows-x86-64=a.zip",
    "--preparation",
    "x",
  ];
  const parsed = parseArguments([
    ...base,
    "--executable",
    "windows-x86-64=Example.exe",
    "--persistent",
    "saves",
    "--persistent",
    "logs",
    "--saves",
    "portcove-managed",
  ]);
  assert.deepEqual(parsed.options.platforms, ["windows-x86-64"]);
  assert.deepEqual(parsed.options.persistentPaths, ["saves", "logs"]);
  assert.throws(() => parseArguments([...base, "--persistant", "saves"]), /Unknown option/);
  assert.throws(() => parseArguments([...base, "--channel", "nightly"]), /stable or beta/);
  assert.throws(() => parseArguments([...base, "--saves", "mine"]), /external-user-owned or/);
  assert.throws(() => parseArguments([...base, "--port", "again"]), /given once/);
  assert.throws(
    () => parseArguments([...base, "--executable", "linux-x86-64=x"]),
    /No --archive was given for linux-x86-64/,
  );
  assert.throws(
    () => parseArguments([...base, "--archive", "windows-x86-64=b.zip"]),
    /names windows-x86-64 twice/,
  );
  assert.throws(() => parseArguments([...base, "--cli"]), /needs a value/);
  assert.throws(() => parseArguments([...base, "--channel", "--saves"]), /needs a value/);
  assert.deepEqual(
    parseArguments([...base, "--launch-arg", "--hdi", "--launch-arg", "game.hdi"]).options
      .launchArguments,
    ["--hdi", "game.hdi"],
  );
  assert.throws(() => parseArguments([...base, "--launch-arg", ""]), /needs a value/);
  assert.throws(() => parseArguments([...base, "--launch-arg", "--channel"]), /needs a value/);
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

void test("listing-only test removal handles one-line, wrapped-call and wrapped-name shapes", () => {
  const text = [
    "    #[test]",
    "    fn short_route_1() {",
    '        assert_listing_only_player_route("short-port", Some(false));',
    "    }",
    "",
    "    #[test]",
    "    fn a_very_long_route_name_that_rustfmt_wraps_before_its_opening_brace_2()",
    "    {",
    '        assert_listing_only_player_route("long-port", Some(true));',
    "    }",
    "",
    "    #[test]",
    "    fn wrapped_call_3() {",
    "        assert_listing_only_player_route(",
    '            "wrapped-port",',
    "            Some(false),",
    "        );",
    "    }",
    "",
    "    #[test]",
    "    fn keeps_other_statements_4() {",
    '        assert_listing_only_player_route("busy-port", Some(false));',
    "        extra();",
    "    }",
    "",
  ].join("\n");
  for (const id of ["short-port", "long-port", "wrapped-port"]) {
    const removed = removeListingOnlyTests(text, id);
    assert.equal(removed.changed, 1, id);
    assert.equal(removed.text.includes(`"${id}"`), false, id);
  }
  assert.equal(removeListingOnlyTests(text, "busy-port").changed, 0);
});

void test("the real test files contain the shapes the promotion edits", () => {
  const selected = readFileSync("crates/portcove-core/src/service/user_selected.rs", "utf8");
  const listingOnly = [
    ...selected.matchAll(
      /assert_listing_only_player_route\(\s*"([a-z0-9-]+)",\s*Some\((?:true|false)\),?\s*\);\n {4}\}/gu,
    ),
  ].map((match) => match[1]!);
  assert.ok(listingOnly.length > 50);
  for (const id of new Set(listingOnly)) {
    const removed = removeListingOnlyTests(selected, id);
    assert.ok(removed.changed >= 1, id);
  }
  assert.equal(removeListingOnlyTests(selected, "no-such-port").changed, 0);

  const downloads = readFileSync(
    "crates/portcove-core/src/service/catalog_download_tests.rs",
    "utf8",
  );
  const listingDownloads = [
    ...downloads.matchAll(/"([a-z0-9-]+)",\n\s+"[^"\n]*",\n\s+"[^"\n]*",\n\s+None,\n\s+&\[\],\n/gu),
  ].map((match) => match[1]!);
  assert.ok(listingDownloads.length > 0);
  const id = listingDownloads[0]!;
  const flipped = expectManagedDownload(downloads, id, ["windows-x86-64", "linux-x86-64"]);
  assert.equal(flipped.changed, 1);
  assert.match(
    flipped.text,
    new RegExp(
      `"${id}",\\n\\s+"[^"]+",\\n\\s+"[^"]+",\\n\\s+Some\\(crate::AdapterKind::NativePortable\\),\\n\\s+&\\[Platform::WindowsX86_64, Platform::LinuxX86_64\\],\\n`,
      "u",
    ),
  );
  assert.equal(expectManagedDownload(downloads, "no-such-port", ["windows-x86-64"]).changed, 0);
});
