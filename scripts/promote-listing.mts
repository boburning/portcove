import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Promotes a reviewed listing-only port to a managed native-portable route.
 *
 * It performs only the mechanical edits every such route repeats: the
 * `integration` block from the listing's asset hints and Core's package-layout
 * inspection, the listing's remaining platforms, the sorted legacy-additions
 * fixture, the port's download test and the superseded listing-only player
 * test. Player copy, warnings, rights notes and review stay with the author, so
 * the managed preparation text and, when files are kept, the save ownership are
 * required inputs rather than guesses.
 */

export const PLATFORMS = [
  "windows-x86-64",
  "linux-x86-64",
  "macos-x86-64",
  "macos-aarch64",
] as const;
export type Platform = (typeof PLATFORMS)[number];
const RUST_PLATFORM: Record<Platform, string> = {
  "windows-x86-64": "Platform::WindowsX86_64",
  "linux-x86-64": "Platform::LinuxX86_64",
  "macos-x86-64": "Platform::MacosX86_64",
  "macos-aarch64": "Platform::MacosAarch64",
};
export type SavesAndSettings = "external-user-owned" | "portcove-managed";

export interface Layout {
  directories: string[];
  executables: string[];
}

export interface PromoteOptions {
  platforms: Platform[];
  executables: Partial<Record<Platform, string>>;
  layouts: Partial<Record<Platform, Layout>>;
  preparation: string;
  repository?: string | undefined;
  channel?: "stable" | "beta" | undefined;
  persistentPaths?: string[] | undefined;
  savesAndSettings?: SavesAndSettings | undefined;
  launchEnvironment?: Record<string, string> | undefined;
  launchArguments?: string[] | undefined;
  originalGameTitle?: string | undefined;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** GitHub `owner/name` from a release or project URL, or undefined for another host. */
export function githubRepository(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/u.exec(url);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** The repository releases come from: the release URL when there is one, else the project URL. */
function releaseRepository(listing: Json) {
  if (typeof listing.release_url === "string") return githubRepository(listing.release_url);
  return githubRepository(listing.project_url);
}

// Mirrors Core's repository summary check, so a refused summary stops before any write.
const STRUCTURED_SUMMARY_TERMS = [
  "opt-in",
  " beta ",
  " rolling ",
  " portable ",
  " managed ",
  " verified ",
  " checksum",
  " release",
];

/** The authored port with its managed integration added. */
export function promotePort(port: unknown, options: PromoteOptions): Json {
  if (!isRecord(port) || !isRecord(port.listing)) throw new Error("Port file has no listing.");
  if ("integration" in port) throw new Error("This port already has an integration.");
  const listing = port.listing;
  if (listing.download_block_reason !== undefined)
    throw new Error(
      "The listing has a download_block_reason, which a managed route cannot keep; remove it once the route resolves that condition, and rewrite the listing guide to match.",
    );
  if (typeof listing.summary === "string") {
    const summary = ` ${listing.summary.toLowerCase()} `;
    const term = STRUCTURED_SUMMARY_TERMS.find((candidate) => summary.includes(candidate));
    if (term)
      throw new Error(
        `The listing summary mentions '${term.trim()}'; keep that in structured fields and describe the player outcome instead.`,
      );
  }
  if (!options.platforms.length) throw new Error("Name at least one managed platform.");
  if (new Set(options.platforms).size !== options.platforms.length)
    throw new Error("Each managed platform may be named once.");
  if (!options.preparation.trim())
    throw new Error("Write the managed preparation text the player will see.");
  const persistentPaths = options.persistentPaths ?? [];
  // Save ownership follows where normal saves live, not whether some files are kept.
  if (persistentPaths.length && !options.savesAndSettings)
    throw new Error(
      "Kept paths need --saves: portcove-managed when the kept paths hold the normal saves, external-user-owned when they live in a profile outside the copy.",
    );
  if (
    options.originalGameTitle !== undefined &&
    typeof listing.original_game_title === "string" &&
    listing.original_game_title !== options.originalGameTitle
  )
    throw new Error(
      `The listing already names its original game "${listing.original_game_title}"; edit it in the port file instead.`,
    );
  const title = options.originalGameTitle ?? listing.original_game_title;
  if (typeof title !== "string" || !title.trim())
    throw new Error(
      "A managed port needs listing.original_game_title; pass --original-game-title.",
    );
  const hints = isRecord(listing.download_asset_hints) ? listing.download_asset_hints : {};
  const repository = options.repository ?? releaseRepository(listing);
  if (!repository)
    throw new Error(
      "Name the GitHub repository; the listing's release URL is not a GitHub repository. Other hosts need an exactly pinned direct-manifest archive, written by hand.",
    );
  const assetHints: Json = {};
  const executableHints: Json = {};
  const layouts: Json = {};
  for (const platform of options.platforms) {
    const hint = hints[platform];
    if (!Array.isArray(hint) || !hint.length)
      throw new Error(`The listing has no download asset hints for ${platform}.`);
    const executable = options.executables[platform];
    if (!executable) throw new Error(`Name the executable for ${platform}.`);
    const layout = options.layouts[platform];
    if (!layout) throw new Error(`Inspect the ${platform} package first.`);
    const program = executable.toLowerCase();
    const matches = layout.executables.filter(
      (entry) => entry === program || entry.endsWith(`/${program}`),
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `${executable} appears more than once in the inspected ${platform} package.`
          : `${executable} is not a program in the inspected ${platform} package.`,
      );
    assetHints[platform] = hint;
    executableHints[platform] = [executable];
    layouts[platform] = { directories: layout.directories, executables: layout.executables };
  }
  const channel =
    options.channel ?? (listing.recommended_download_channel === "beta" ? "beta" : "stable");
  const integration: Json = {
    support_tier: "beta",
    channels: [channel],
    platforms: [...options.platforms],
    adapter: "native-portable",
    release: { provider: "github", repository, asset_hints: assetHints },
    executable_hints: executableHints,
  };
  if (options.launchArguments?.length) integration.launch_arguments = [...options.launchArguments];
  if (options.launchEnvironment && Object.keys(options.launchEnvironment).length)
    integration.launch_environment = options.launchEnvironment;
  integration.persistent_paths = persistentPaths;
  integration.presentation = {
    installation_method: "portable-package",
    source_requirements: [],
    saves_and_settings: options.savesAndSettings ?? "external-user-owned",
    manual_preparation: options.preparation.trim(),
  };
  integration.reviewed_package_layouts = layouts;

  const promotedListing: Json = {};
  for (const [key, value] of Object.entries(listing)) {
    promotedListing[key] = value;
    if (key === "summary" && !("original_game_title" in listing))
      promotedListing.original_game_title = title.trim();
  }
  if (!("original_game_title" in promotedListing))
    promotedListing.original_game_title = title.trim();
  if (Array.isArray(listing.platforms)) {
    const remaining = listing.platforms.filter(
      (platform: unknown) => !options.platforms.includes(platform as Platform),
    );
    if (remaining.length) promotedListing.platforms = remaining;
    else delete promotedListing.platforms;
  }
  return { ...port, listing: promotedListing, integration };
}

/** The fixture text with `id` inserted into its sorted port list. */
export function insertSortedPortId(fixtureText: string, id: string) {
  const fixture: unknown = JSON.parse(fixtureText);
  if (!isRecord(fixture) || !Array.isArray(fixture.port_ids))
    throw new Error("Malformed legacy additions fixture.");
  const ids = fixture.port_ids as string[];
  if (ids.includes(id)) return { text: fixtureText, changed: false };
  return {
    text: `${JSON.stringify({ ...fixture, port_ids: [...ids, id].sort() }, null, 2)}\n`,
    changed: true,
  };
}

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Flip the port's listing download test to expect the managed route. */
export function expectManagedDownload(testsText: string, id: string, platforms: Platform[]) {
  const pattern = new RegExp(
    `("${escaped(id)}",\\n(\\s+)"[^"\\n]*",\\n\\s+"[^"\\n]*",\\n)\\s+None,\\n\\s+&\\[\\],\\n`,
    "gu",
  );
  let count = 0;
  const text = testsText.replace(pattern, (_match, head: string, indent: string) => {
    count++;
    // Formatting is left to rustfmt, which the command runs afterwards.
    return `${head}${indent}Some(crate::AdapterKind::NativePortable),\n${indent}&[${platforms
      .map((platform) => RUST_PLATFORM[platform])
      .join(", ")}],\n`;
  });
  return { text, changed: count };
}

/** Drop the tests whose only statement asserts the port stays listing-only. */
export function removeListingOnlyTests(testsText: string, id: string) {
  const pattern = new RegExp(
    `    #\\[test\\]\\n    fn [a-z0-9_]+\\(\\)\\s*\\{\\n        assert_listing_only_player_route\\(\\s*"${escaped(id)}",\\s*Some\\((?:true|false)\\),?\\s*\\);\\n    \\}\\n\\n?`,
    "gu",
  );
  let count = 0;
  const text = testsText.replace(pattern, () => {
    count++;
    return "";
  });
  return { text, changed: count };
}

/** Core's reviewed layout for one official archive. */
export function inspectLayout(cli: string, archive: string, platform: Platform, sha256?: string) {
  const bytes = readFileSync(archive);
  const local = createHash("sha256").update(bytes).digest("hex");
  // Without an independently obtained publisher digest, Core can only confirm the local hash.
  if (sha256 && sha256.toLowerCase() !== local)
    throw new Error(`The ${platform} archive does not match the publisher digest.`);
  let output: string;
  try {
    output = execFileSync(
      cli,
      [
        "catalog",
        "inspect-package-layout",
        "--platform",
        platform,
        "--size",
        String(statSync(archive).size),
        "--sha256",
        sha256?.toLowerCase() ?? local,
        resolve(archive),
        "--json",
      ],
      { encoding: "utf8", cwd: dirname(resolve(archive)) },
    );
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    throw new Error(
      `Core could not inspect the ${platform} package${typeof stdout === "string" && stdout.trim() ? `: ${stdout.trim()}` : "."}`,
    );
  }
  const report: unknown = JSON.parse(output);
  if (!isRecord(report) || report.ok !== true || !isRecord(report.data))
    throw new Error(`Core refused the ${platform} package: ${output.trim()}`);
  const { directories, executables } = report.data;
  if (!Array.isArray(directories) || !Array.isArray(executables))
    throw new Error("Core returned an unexpected package layout.");
  return {
    layout: { directories: directories as string[], executables: executables as string[] },
    independent: Boolean(sha256),
  };
}

const VALUE_FLAGS = new Set([
  "--port",
  "--archive",
  "--executable",
  "--sha256",
  "--preparation",
  "--repository",
  "--channel",
  "--persistent",
  "--saves",
  "--env",
  "--launch-arg",
  "--cli",
  "--original-game-title",
]);
const REPEATED = new Set([
  "--archive",
  "--executable",
  "--sha256",
  "--persistent",
  "--env",
  "--launch-arg",
]);

const isChannel = (value: string): value is "stable" | "beta" =>
  value === "stable" || value === "beta";
const isSaves = (value: string): value is SavesAndSettings =>
  value === "external-user-owned" || value === "portcove-managed";

/** Parse flags strictly: unknown flags, missing values and repeated single flags are errors. */
export function parseArguments(args: string[]) {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown option ${flag}.`);
    // A launch argument is passed through verbatim, so it may itself start with "--",
    // but never as one of this command's own options, which would hide a missing value.
    if (
      value === undefined ||
      !value ||
      (value.startsWith("--") && (flag !== "--launch-arg" || VALUE_FLAGS.has(value)))
    )
      throw new Error(`${flag} needs a value.`);
    const list = values.get(flag) ?? [];
    if (list.length && !REPEATED.has(flag)) throw new Error(`${flag} may be given once.`);
    values.set(flag, [...list, value]);
  }
  const all = (flag: string) => values.get(flag) ?? [];
  const one = (flag: string) => values.get(flag)?.[0];
  const pairs = (flag: string) => {
    const result: Partial<Record<Platform, string>> = {};
    for (const value of all(flag)) {
      const at = value.indexOf("=");
      const platform = value.slice(0, at) as Platform;
      if (at < 1 || !PLATFORMS.includes(platform)) throw new Error(`Use ${flag} PLATFORM=VALUE.`);
      if (result[platform] !== undefined) throw new Error(`${flag} names ${platform} twice.`);
      result[platform] = value.slice(at + 1);
    }
    return result;
  };
  const id = one("--port");
  if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))
    throw new Error("Name the port with --port ID.");
  const archives = pairs("--archive");
  const platforms = PLATFORMS.filter((platform) => archives[platform]);
  const executables = pairs("--executable");
  const digests = pairs("--sha256");
  for (const platform of [...Object.keys(executables), ...Object.keys(digests)])
    if (!archives[platform as Platform]) throw new Error(`No --archive was given for ${platform}.`);
  const channel = one("--channel");
  if (channel !== undefined && !isChannel(channel)) throw new Error("--channel is stable or beta.");
  const saves = one("--saves");
  if (saves !== undefined && !isSaves(saves))
    throw new Error("--saves is external-user-owned or portcove-managed.");
  const environment: Record<string, string> = {};
  for (const value of all("--env")) {
    const at = value.indexOf("=");
    if (at < 1) throw new Error("Use --env NAME=VALUE.");
    environment[value.slice(0, at)] = value.slice(at + 1);
  }
  return {
    id,
    archives,
    digests,
    cli: one("--cli"),
    options: {
      platforms,
      executables,
      preparation: one("--preparation") ?? "",
      repository: one("--repository"),
      channel: channel,
      persistentPaths: all("--persistent"),
      savesAndSettings: saves,
      launchEnvironment: environment,
      launchArguments: all("--launch-arg"),
      originalGameTitle: one("--original-game-title"),
    },
  };
}

const CHECKLIST = [
  "Still yours to do:",
  "- make the first manual_setup step the real original-file step, true for both routes;",
  "- review the listing summary, original_game_title and warnings, and scope self-managed steps and references to 'a copy you manage yourself';",
  "- name every rights note (fonts, art, unlicensed forks or DLLs) in the warnings;",
  "- review saves_and_settings and the kept paths against where normal saves actually live;",
  "- confirm the provider digest or checksum sidecar, writes beside the executable and process lifetime;",
  "- check any other test that still expects this port to stay listing-only, then run the catalog tests and get an independent review.",
].join("\n");

function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(
      `${(error as Error).message}\nUsage: node scripts/promote-listing.mts --port ID --archive PLATFORM=PATH --executable PLATFORM=NAME --preparation TEXT [--sha256 PLATFORM=HEX] [--repository OWNER/NAME] [--channel stable|beta] [--persistent PATH ... --saves external-user-owned|portcove-managed] [--env NAME=VALUE ...] [--launch-arg VALUE ...] [--original-game-title TEXT] [--cli PATH]`,
    );
    process.exit(2);
  }
  const { id, archives, digests, options } = parsed;
  const cli = resolve(
    parsed.cli ?? process.env.PORTCOVE_CLI ?? join(root, "target/debug/portcove"),
  );
  const layouts: Partial<Record<Platform, Layout>> = {};
  const unverified: Platform[] = [];
  for (const platform of options.platforms) {
    const inspected = inspectLayout(cli, archives[platform]!, platform, digests[platform]);
    layouts[platform] = inspected.layout;
    if (!inspected.independent) unverified.push(platform);
  }
  const portPath = join(root, "crates/portcove-core/catalog/ports", `${id}.json`);
  const promoted = promotePort(JSON.parse(readFileSync(portPath, "utf8")), { ...options, layouts });

  // Every refusal above happens before the first write.
  const fixturePath = join(
    root,
    "crates/portcove-core/catalog/catalog-legacy-additions-fixture.json",
  );
  const downloadPath = join(root, "crates/portcove-core/src/service/catalog_download_tests.rs");
  const selectedPath = join(root, "crates/portcove-core/src/service/user_selected.rs");
  const fixture = insertSortedPortId(readFileSync(fixturePath, "utf8"), id);
  const download = expectManagedDownload(readFileSync(downloadPath, "utf8"), id, options.platforms);
  const selected = removeListingOnlyTests(readFileSync(selectedPath, "utf8"), id);
  writeFileSync(portPath, `${JSON.stringify(promoted, null, 2)}\n`);
  if (fixture.changed) writeFileSync(fixturePath, fixture.text);
  if (download.changed) writeFileSync(downloadPath, download.text);
  if (selected.changed) writeFileSync(selectedPath, selected.text);
  const edited = [
    portPath,
    ...(fixture.changed ? [fixturePath] : []),
    ...(download.changed ? [downloadPath] : []),
    ...(selected.changed ? [selectedPath] : []),
  ].map((path) => path.slice(root.length + 1));
  console.log(
    [
      `- ports/${id}.json: integration for ${options.platforms.join(", ")}`,
      fixture.changed
        ? "- legacy additions fixture: ID inserted"
        : "- legacy additions fixture: ID already present",
      `- download tests flipped to the managed route: ${download.changed}${download.changed ? "" : " (WARNING: check for a download test that still expects the listing)"}`,
      `- listing-only player tests removed: ${selected.changed}${selected.changed ? "" : " (WARNING: check for a test that still expects the listing)"}`,
      ...(unverified.length
        ? [
            `- WARNING: no --sha256 for ${unverified.join(", ")}; Core checked the local hash only, so confirm the publisher digest yourself.`,
          ]
        : []),
    ].join("\n"),
  );
  try {
    execFileSync(process.execPath, [join(root, "scripts/run-viteplus.mts"), "fmt", portPath], {
      cwd: root,
      stdio: "inherit",
    });
    const rustFiles = [downloadPath, selectedPath].filter((_path, index) =>
      index === 0 ? download.changed : selected.changed,
    );
    if (rustFiles.length)
      execFileSync("rustfmt", ["--edition", "2024", ...rustFiles], { cwd: root, stdio: "inherit" });
    execFileSync(process.execPath, [join(root, "scripts/generate-catalog.mts")], {
      cwd: root,
      stdio: "inherit",
    });
  } catch (error) {
    console.error(
      [
        `Formatting or catalog generation failed after these files were edited: ${edited.join(", ")}.`,
        "Fix the reported problem and run `node scripts/generate-catalog.mts`, or restore those files with `git checkout -- <file>` and rerun this command.",
      ].join("\n"),
    );
    throw error;
  }
  console.log(CHECKLIST);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
