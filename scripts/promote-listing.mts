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
 * the managed preparation text is a required input rather than a placeholder.
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
  savesAndSettings?: "external-user-owned" | "portcove-managed" | undefined;
  launchEnvironment?: Record<string, string> | undefined;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** GitHub `owner/name` from a listing's release or project URL. */
export function githubRepository(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/u.exec(url);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** The authored port with its managed integration added. */
export function promotePort(port: unknown, options: PromoteOptions): Json {
  if (!isRecord(port) || !isRecord(port.listing)) throw new Error("Port file has no listing.");
  if ("integration" in port) throw new Error("This port already has an integration.");
  const listing = port.listing;
  if (!options.platforms.length) throw new Error("Name at least one managed platform.");
  if (new Set(options.platforms).size !== options.platforms.length)
    throw new Error("Each managed platform may be named once.");
  if (!options.preparation.trim())
    throw new Error("Write the managed preparation text the player will see.");
  const hints = isRecord(listing.download_asset_hints) ? listing.download_asset_hints : {};
  const repository =
    options.repository ??
    githubRepository(listing.release_url) ??
    githubRepository(listing.project_url);
  if (!repository) throw new Error("Name the GitHub repository; the listing does not link one.");
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
    if (!layout.executables.some((entry) => entry === program || entry.endsWith(`/${program}`)))
      throw new Error(`${executable} is not a program in the inspected ${platform} package.`);
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
  if (options.launchEnvironment && Object.keys(options.launchEnvironment).length)
    integration.launch_environment = options.launchEnvironment;
  integration.persistent_paths = options.persistentPaths ?? [];
  integration.presentation = {
    installation_method: "portable-package",
    source_requirements: [],
    saves_and_settings:
      options.savesAndSettings ??
      ((options.persistentPaths ?? []).length ? "portcove-managed" : "external-user-owned"),
    manual_preparation: options.preparation.trim(),
  };
  integration.reviewed_package_layouts = layouts;

  const promotedListing: Json = { ...listing };
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
    return `${head}${indent}Some(crate::AdapterKind::NativePortable),\n${indent}&[${platforms
      .map((platform) => RUST_PLATFORM[platform])
      .join(", ")}],\n`;
  });
  return { text, changed: count };
}

/** Drop the tests that assert the port stays listing-only. */
export function removeListingOnlyTests(testsText: string, id: string) {
  const pattern = new RegExp(
    `    #\\[test\\]\\n    fn [a-z0-9_]+\\(\\) \\{\\n        assert_listing_only_player_route\\(\\s*"${escaped(id)}",\\s*Some\\((?:true|false)\\),?\\s*\\);\\n    \\}\\n\\n?`,
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
export function inspectLayout(cli: string, archive: string, platform: Platform): Layout {
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const output = execFileSync(
    cli,
    [
      "catalog",
      "inspect-package-layout",
      "--platform",
      platform,
      "--size",
      String(statSync(archive).size),
      "--sha256",
      sha256,
      resolve(archive),
      "--json",
    ],
    { encoding: "utf8", cwd: dirname(resolve(archive)) },
  );
  const report: unknown = JSON.parse(output);
  if (!isRecord(report) || report.ok !== true || !isRecord(report.data))
    throw new Error(`Core refused the ${platform} package: ${output.trim()}`);
  const { directories, executables } = report.data;
  if (!Array.isArray(directories) || !Array.isArray(executables))
    throw new Error("Core returned an unexpected package layout.");
  return { directories: directories as string[], executables: executables as string[] };
}

function pairs(values: string[], label: string) {
  const result: Partial<Record<Platform, string>> = {};
  for (const value of values) {
    const at = value.indexOf("=");
    const platform = value.slice(0, at) as Platform;
    if (at < 1 || !PLATFORMS.includes(platform)) throw new Error(`Use ${label} PLATFORM=VALUE.`);
    result[platform] = value.slice(at + 1);
  }
  return result;
}

function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const args = process.argv.slice(2);
  const all = (flag: string) =>
    args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []));
  const one = (flag: string) => all(flag).at(-1);
  const id = one("--port");
  if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
    console.error(
      "Usage: node scripts/promote-listing.mts --port ID --archive PLATFORM=PATH --executable PLATFORM=NAME --preparation TEXT [--repository OWNER/NAME] [--channel stable|beta] [--persistent PATH ...] [--saves external-user-owned|portcove-managed] [--env NAME=VALUE ...] [--cli PATH]",
    );
    process.exit(2);
  }
  const archives = pairs(all("--archive"), "--archive");
  const platforms = PLATFORMS.filter((platform) => archives[platform]);
  const cli = one("--cli") ?? process.env.PORTCOVE_CLI ?? join(root, "target/debug/portcove");
  const layouts: Partial<Record<Platform, Layout>> = {};
  for (const platform of platforms)
    layouts[platform] = inspectLayout(cli, archives[platform]!, platform);
  const environment = Object.fromEntries(
    all("--env").map((value) => {
      const at = value.indexOf("=");
      if (at < 1) throw new Error("Use --env NAME=VALUE.");
      return [value.slice(0, at), value.slice(at + 1)];
    }),
  );
  const portPath = join(root, "crates/portcove-core/catalog/ports", `${id}.json`);
  const channel = one("--channel");
  const saves = one("--saves");
  const promoted = promotePort(JSON.parse(readFileSync(portPath, "utf8")), {
    platforms,
    executables: pairs(all("--executable"), "--executable"),
    layouts,
    preparation: one("--preparation") ?? "",
    repository: one("--repository"),
    channel: channel === "beta" || channel === "stable" ? channel : undefined,
    persistentPaths: all("--persistent"),
    savesAndSettings:
      saves === "external-user-owned" || saves === "portcove-managed" ? saves : undefined,
    launchEnvironment: environment,
  });
  writeFileSync(portPath, `${JSON.stringify(promoted, null, 2)}\n`);

  const edits: string[] = [`ports/${id}.json: integration for ${platforms.join(", ")}`];
  const fixturePath = join(
    root,
    "crates/portcove-core/catalog/catalog-legacy-additions-fixture.json",
  );
  const fixture = insertSortedPortId(readFileSync(fixturePath, "utf8"), id);
  if (fixture.changed) writeFileSync(fixturePath, fixture.text);
  edits.push(
    fixture.changed
      ? "legacy additions fixture: ID inserted"
      : "legacy additions fixture: ID already present",
  );
  const downloadPath = join(root, "crates/portcove-core/src/service/catalog_download_tests.rs");
  const download = expectManagedDownload(readFileSync(downloadPath, "utf8"), id, platforms);
  if (download.changed) writeFileSync(downloadPath, download.text);
  edits.push(`download tests flipped to the managed route: ${download.changed}`);
  const selectedPath = join(root, "crates/portcove-core/src/service/user_selected.rs");
  const selected = removeListingOnlyTests(readFileSync(selectedPath, "utf8"), id);
  if (selected.changed) writeFileSync(selectedPath, selected.text);
  edits.push(`listing-only player tests removed: ${selected.changed}`);

  execFileSync("pnpm", ["exec", "vp", "fmt", portPath], { cwd: root, stdio: "ignore" });
  execFileSync(process.execPath, [join(root, "scripts/generate-catalog.mts")], {
    cwd: root,
    stdio: "inherit",
  });
  console.log(edits.map((edit) => `- ${edit}`).join("\n"));
  console.log(
    [
      "Still yours to do:",
      "- make the first manual_setup step the real original-file step, true for both routes;",
      "- scope self-managed steps and references to 'a copy you manage yourself';",
      "- name every rights note (fonts, art, unlicensed forks or DLLs) in the warnings;",
      "- confirm the provider digest or checksum sidecar, writes beside the executable and process lifetime;",
      "- check any other test that still expects this port to stay listing-only, then run the catalog tests and get an independent review.",
    ].join("\n"),
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
