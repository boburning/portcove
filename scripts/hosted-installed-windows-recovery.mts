import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireCatalogReleaseAttestation } from "./catalog-released-reader.mts";
import { fileIdentity, type FileIdentity } from "./development-evidence.mts";
import { parseSha256Sums, windowsAssetNames, windowsPathKey } from "./hosted-installed-update.mts";
import { acquireNativeSessionLock } from "./native-session-lock.mts";
import { resourceEntrypoint } from "./resource-command.mts";
import { isRecord } from "./runtime-values.mts";
import { cachedDesktopDrivers } from "./tool-cache.mts";

const repository = "boburning/portcove";
const recoveryScenario = "native-library-recovery-bundle";
const organizationScenario = "native-library-organization-restart";
const gameChoiceScenario = "native-game-first-choice-and-restart";
type InstalledScenario =
  | typeof recoveryScenario
  | typeof organizationScenario
  | typeof gameChoiceScenario;
type ProductInputs = Record<"app" | "preparation-cli" | "preparation-tool", FileIdentity>;
const root = fileURLToPath(new URL("../", import.meta.url));
const packageLimit = 128 * 1024 * 1024;
const resultLeaf = "native-recovery-bundle-result.json";
const restartLeaf = "restored-library-explicitly-opened-restart.json";

export function recoveryPreviewVersion(tag: string) {
  const matched = /^nightly-(\d{1,3}\.\d{1,3}\.\d{1,3}-preview\.[1-9]\d{0,3})$/u.exec(tag);
  assert.ok(matched, "Supply an exact published Portcove Preview tag");
  return matched[1]!;
}

export function publishedWindowsScenario(operation: string) {
  if (operation === "windows-installed-library-recovery") return recoveryScenario;
  if (operation === "windows-installed-library-organization") return organizationScenario;
  if (operation === "windows-installed-game-choice") return gameChoiceScenario;
  throw new Error("Supply one fixed Windows installed observation operation");
}

async function installedObservation(
  native: string,
  revision: string,
  inputs: ProductInputs,
  scenario: InstalledScenario,
) {
  const json = async (leaf: string): Promise<unknown> =>
    JSON.parse(await readFile(path.join(native, leaf), "utf8"));
  const observation = await json("evidence.json");
  assert.ok(isRecord(observation) && isRecord(observation.executable));
  assert.equal(observation.revision, revision);
  assert.equal(observation.outcome, "passed");
  assert.equal(observation.executable.path, inputs.app.path);
  assert.equal(observation.executable.sha256, inputs.app.sha256);
  assert.deepEqual(observation.selected_scenarios, [scenario]);
  assert.ok(Array.isArray(observation.checks) && observation.checks.length === 1);
  const checks: readonly unknown[] = observation.checks;
  const [check] = checks;
  assert.ok(isRecord(check) && check.scenario === scenario && check.outcome === "passed");

  const binding = observation.execution_binding;
  assert.ok(isRecord(binding) && Array.isArray(binding.product_artifacts));
  const productArtifacts: readonly unknown[] = binding.product_artifacts;
  for (const [role, expected] of Object.entries(inputs)) {
    const matches = productArtifacts.filter((input) => isRecord(input) && input.role === role);
    const [match] = matches;
    assert.ok(matches.length === 1 && isRecord(match), `Expected one observed ${role}`);
    assert.equal(match.sha256, expected.sha256);
    assert.equal(match.bytes, expected.bytes);
  }
  assert.ok(Array.isArray(observation.artifacts));
  const artifacts: readonly unknown[] = observation.artifacts;
  const boundFile = async (leaf: string) => {
    const expected = await fileIdentity(path.join(native, leaf));
    assert.deepEqual(
      artifacts.filter((entry) => isRecord(entry) && entry.path === expected.path),
      [expected],
    );
    return expected;
  };
  const boundRestart = async (leaf: string) => {
    const restart = await json(leaf);
    assert.ok(isRecord(restart) && isRecord(restart.exited));
    assert.ok(typeof restart.exited.exited_at === "string");
    assert.ok(
      typeof restart.exited.observed_processes === "number" &&
        restart.exited.observed_processes > 1,
    );
    return boundFile(leaf);
  };
  return { json, boundFile, boundRestart };
}

export async function verifyPublishedRecoveryObservation(
  native: string,
  revision: string,
  inputs: ProductInputs,
) {
  const { json, boundFile, boundRestart } = await installedObservation(
    native,
    revision,
    inputs,
    recoveryScenario,
  );

  const result = await json(resultLeaf);
  assert.ok(
    isRecord(result) &&
      isRecord(result.initial) &&
      isRecord(result.afterRestore) &&
      isRecord(result.opened),
  );
  assert.equal(result.source, path.join(native, "library"));
  assert.equal(result.destination, path.join(native, "restored-library"));
  assert.ok(typeof result.initial.id === "string" && result.initial.id.length > 0);
  assert.equal(result.afterRestore.id, result.initial.id);
  assert.ok(typeof result.opened.id === "string" && result.opened.id.length > 0);
  assert.notEqual(result.opened.id, result.initial.id);
  assert.ok(
    typeof result.opened.generation === "number" &&
      typeof result.afterRestore.generation === "number" &&
      result.opened.generation > result.afterRestore.generation,
  );
  return { result: await boundFile(resultLeaf), restart: await boundRestart(restartLeaf) };
}

export async function verifyPublishedOrganizationObservation(
  native: string,
  revision: string,
  inputs: ProductInputs,
) {
  const { json, boundFile, boundRestart } = await installedObservation(
    native,
    revision,
    inputs,
    organizationScenario,
  );
  const leaf = "library-organization-result.json";
  const result = await json(leaf);
  assert.ok(isRecord(result) && result.port_id === "opengoal-jak1");
  assert.ok(typeof result.collection_id === "string" && result.collection_id.length > 0);
  assert.equal(result.host_restart_preserved_preferences, true);
  assert.equal(result.installed_versions_sources_backups_preserved, true);
  const { initial, persisted, final } = result;
  assert.ok(isRecord(initial) && isRecord(persisted) && isRecord(final));
  assert.ok(Array.isArray(initial.saved_game_ids) && Array.isArray(persisted.saved_game_ids));
  const favorite = "game-jak-and-daxter-the-precursor-legacy";
  const previousFavorites: readonly unknown[] = initial.saved_game_ids;
  const savedFavorites: readonly unknown[] = persisted.saved_game_ids;
  assert.ok(!previousFavorites.includes(favorite));
  assert.deepEqual(new Set(savedFavorites), new Set([...previousFavorites, favorite]));
  assert.equal(savedFavorites.length, previousFavorites.length + 1);
  assert.deepEqual(final.saved_game_ids, initial.saved_game_ids);
  assert.ok(isRecord(initial.collections) && isRecord(persisted.collections));
  assert.equal(initial.collections[result.collection_id], undefined);
  const collection = persisted.collections[result.collection_id];
  assert.ok(isRecord(collection));
  assert.deepEqual(collection.port_ids, [result.port_id]);
  assert.deepEqual(final.collections, initial.collections);
  return {
    result: await boundFile(leaf),
    restart: await boundRestart("native-organization-persisted-restart.json"),
  };
}

export async function verifyPublishedGameChoiceObservation(
  native: string,
  revision: string,
  inputs: ProductInputs,
) {
  const { json, boundFile, boundRestart } = await installedObservation(
    native,
    revision,
    inputs,
    gameChoiceScenario,
  );
  const leaf = "game-first-choice-result.json";
  const result = await json(leaf);
  assert.ok(isRecord(result) && isRecord(result.identity) && Array.isArray(result.readbacks));
  assert.equal(result.scenario, gameChoiceScenario);
  assert.equal(result.outcome, "interactions-complete");
  assert.equal(result.failure, null);
  const game = "the-legend-of-zelda-majoras-mask";
  const ports = ["2ship2harkinian", "zelda64-recomp"];
  assert.equal(result.identity.game_id, game);
  assert.deepEqual(result.identity.port_ids, ports);

  const readbacks: readonly unknown[] = result.readbacks;
  const organizationAt = (phase: string) => {
    const matches = readbacks.filter((row) => isRecord(row) && row.phase === phase);
    const [match] = matches;
    assert.ok(matches.length === 1 && isRecord(match) && isRecord(match.organization));
    return match.organization;
  };
  const chosen = organizationAt("chosen");
  const restarted = organizationAt("restarted");
  assert.ok(isRecord(chosen.preferred_port_by_game));
  const selected = chosen.preferred_port_by_game[game];
  assert.ok(typeof selected === "string" && ports.includes(selected));
  assert.deepEqual(restarted, chosen);
  return {
    result: await boundFile(leaf),
    restart: await boundRestart(`${gameChoiceScenario}-restart.json`),
    game,
    selected,
  };
}

function command(
  program: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeout = 60_000,
  cwd = root,
) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    env: environment,
    cwd,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function registry(environment: NodeJS.ProcessEnv): unknown {
  return JSON.parse(
    command(
      "pwsh.exe",
      [
        "-NoProfile",
        "-Command",
        `$ErrorActionPreference = 'Stop'
        $roots = 'HKCU:\\Software','HKLM:\\Software'
        $branches = 'Microsoft\\Windows\\CurrentVersion\\Uninstall','WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        $matches = foreach ($hive in $roots) {
          foreach ($branch in $branches) {
            $key = Join-Path $hive $branch
            if (Test-Path -LiteralPath $key) {
              Get-ChildItem -LiteralPath $key | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
                Where-Object { $_.DisplayName -eq 'Portcove' } |
                Select-Object DisplayVersion,InstallLocation,PSPath
            }
          }
        }
        ConvertTo-Json -InputObject @($matches) -Compress`,
      ],
      environment,
    ),
  );
}

async function run(tag: string, version: string, temporary: string, scenario: InstalledScenario) {
  const installation = path.join(temporary, "installed");
  const output = path.join(root, "work", "installed-windows-recovery-evidence");
  const native = path.join(output, "desktop-verify", "installed", "native");
  const assets = windowsAssetNames(version);
  const names = [assets.installer, assets.cli, "SHA256SUMS"];
  const github = (args: string[]) =>
    command("gh.exe", [...args, "--repo", repository], process.env);
  const childEnvironment = { ...process.env };
  for (const name of Object.keys(childEnvironment)) {
    if (/^(GH|GITHUB)(?:_ENTERPRISE)?_TOKEN$/iu.test(name)) delete childEnvironment[name];
  }
  const currentRevision = command("git.exe", ["rev-parse", "HEAD"], childEnvironment);
  assert.equal(currentRevision, process.env.GITHUB_SHA, "Hosted harness source changed");
  const tagRefs = command(
    "git.exe",
    ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    childEnvironment,
  );
  const refs = new Map(
    tagRefs.split(/\r?\n/u).map((line) => {
      const [sha, ref] = line.split("\t");
      return [ref, sha] as const;
    }),
  );
  const tagObject = refs.get(`refs/tags/${tag}`);
  const source = refs.get(`refs/tags/${tag}^{}`);
  assert.ok(
    tagObject && source && /^[a-f0-9]{40}$/u.test(tagObject) && /^[a-f0-9]{40}$/u.test(source),
    "Expected an annotated release tag",
  );
  command("git.exe", ["merge-base", "--is-ancestor", source, "origin/main"], childEnvironment);

  await mkdir(path.dirname(native), { recursive: true });
  await mkdir(temporary);
  const retain = (name: string, value: unknown) =>
    writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  const gameChoice = scenario === gameChoiceScenario;
  const harnessRoot = gameChoice ? path.join(temporary, "release-source") : root;
  const harnessRevision = gameChoice ? source : currentRevision;
  await retain("host.json", {
    source: currentRevision,
    harness_source: harnessRevision,
    release_source: source,
    release_tag_object: tagObject,
    tag,
    scenario,
    runner_image: process.env.ImageVersion,
    scope: "Disposable Windows hosted runner and normal Preview NSIS registration",
  });
  github([
    "release",
    "download",
    tag,
    "--dir",
    temporary,
    ...names.flatMap((name) => ["--pattern", name]),
  ]);
  const identity = Object.fromEntries(
    await Promise.all(
      names.map(
        async (name) =>
          [
            name,
            await fileIdentity(path.join(temporary, name), {
              maxBytes: name === "SHA256SUMS" ? 64 * 1024 : packageLimit,
            }),
          ] as const,
      ),
    ),
  );
  const verified: unknown = JSON.parse(
    github([
      "release",
      "verify-asset",
      tag,
      path.join(temporary, assets.installer),
      "--format",
      "json",
    ]),
  );
  assert.ok(isRecord(verified) && isRecord(verified.verificationResult));
  const releaseId = requireCatalogReleaseAttestation(verified.verificationResult.statement, {
    tag,
    tagObject,
    subjects: Object.fromEntries(names.map((name) => [name, identity[name]!.sha256])),
  });
  const sums = parseSha256Sums(await readFile(path.join(temporary, "SHA256SUMS"), "utf8"));
  for (const name of [assets.installer, assets.cli]) {
    assert.equal(
      identity[name]!.sha256,
      sums.get(name),
      "Artifact differs from verified SHA256SUMS",
    );
  }
  await retain("release-custody.json", { identity, release_id: releaseId, verification: verified });
  if (gameChoice) {
    // This scenario asserts the complete embedded catalog against the release's
    // source files and independently reviewed relationships. Use the tagged harness.
    command(
      "git.exe",
      ["worktree", "add", "--detach", "--quiet", harnessRoot, source],
      childEnvironment,
    );
    command(
      "pwsh.exe",
      ["-NoProfile", "-Command", "pnpm install --frozen-lockfile; exit $LASTEXITCODE"],
      childEnvironment,
      5 * 60_000,
      harnessRoot,
    );
    assert.equal(
      command("git.exe", ["rev-parse", "HEAD"], childEnvironment, undefined, harnessRoot),
      source,
    );
    assert.equal(
      command(
        "git.exe",
        ["status", "--porcelain", "--untracked-files=no"],
        childEnvironment,
        undefined,
        harnessRoot,
      ),
      "",
      "Tagged Desktop harness source changed",
    );
  }

  const cliDirectory = path.join(temporary, "cli");
  command(
    "pwsh.exe",
    [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $env:PORTCOVE_FIXTURE_CLI_ZIP -DestinationPath $env:PORTCOVE_FIXTURE_CLI_DIRECTORY -ErrorAction Stop",
    ],
    {
      ...childEnvironment,
      PORTCOVE_FIXTURE_CLI_ZIP: path.join(temporary, assets.cli),
      PORTCOVE_FIXTURE_CLI_DIRECTORY: cliDirectory,
    },
  );
  const cli = path.join(cliDirectory, "portcove.exe");
  const cliIdentity = await fileIdentity(cli);
  const probe = path.join(temporary, "owned-recovery-probe.exe");
  command(
    "rustc.exe",
    [
      "--edition=2024",
      "--crate-name",
      "portcove_host_tool_fixture",
      "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
      "-o",
      probe,
    ],
    childEnvironment,
  );
  assert.ok(
    cachedDesktopDrivers(),
    "Verified cached Desktop drivers are required before installation",
  );

  const lock = await acquireNativeSessionLock({ workspace: harnessRoot, scenarios: [scenario] });
  try {
    assert.deepEqual(registry(childEnvironment), [], "Refusing an existing Portcove registration");
    const installer = path.join(temporary, assets.installer);
    assert.deepEqual(await fileIdentity(installer), identity[assets.installer]);
    command(installer, ["/S", `/D=${installation}`], childEnvironment, 10 * 60_000);
    const registration = registry(childEnvironment);
    await retain("registration-after-install.json", registration);
    assert.ok(Array.isArray(registration) && registration.length === 1);
    const entry = registration[0] as Record<string, unknown>;
    assert.equal(entry.DisplayVersion, version);
    assert.match(String(entry.PSPath), /HKEY_CURRENT_USER/iu);
    assert.ok(typeof entry.InstallLocation === "string");
    assert.equal(windowsPathKey(entry.InstallLocation), windowsPathKey(installation));
    const application = path.join(installation, "portcove-desktop.exe");
    const executable = await fileIdentity(application);
    await retain("installed-before.json", { registration, executable, cli: cliIdentity });

    const result = spawnSync(
      process.execPath,
      [
        "scripts/desktop-test-cli.mts",
        "--app",
        application,
        "--output",
        native,
        "--scenario",
        scenario,
        "--preparation-cli",
        cli,
        "--preparation-tool",
        probe,
      ],
      {
        cwd: harnessRoot,
        env: { ...childEnvironment, PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: lock.owner.token },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Installed scenario failed: ${scenario}`);
    const inputs = {
      app: executable,
      "preparation-cli": cliIdentity,
      "preparation-tool": await fileIdentity(probe),
    };
    let evidence;
    switch (scenario) {
      case recoveryScenario:
        evidence = {
          recovery_evidence: await verifyPublishedRecoveryObservation(
            native,
            harnessRevision,
            inputs,
          ),
        };
        break;
      case organizationScenario:
        evidence = {
          organization_evidence: await verifyPublishedOrganizationObservation(
            native,
            harnessRevision,
            inputs,
          ),
        };
        break;
      case gameChoiceScenario:
        evidence = {
          game_choice_evidence: await verifyPublishedGameChoiceObservation(
            native,
            harnessRevision,
            inputs,
          ),
        };
        break;
    }
    assert.deepEqual(await fileIdentity(application), executable);
    assert.deepEqual(registry(childEnvironment), registration);
    await retain("installed-after.json", {
      registration,
      executable,
      ...evidence,
      outcome: "passed",
    });
    return 0;
  } finally {
    await lock.release();
  }
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invoked !== null && invoked === (await realpath(fileURLToPath(import.meta.url)))) {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  const tag = process.env.PORTCOVE_INSTALLED_RECOVERY_TAG ?? "";
  const version = recoveryPreviewVersion(tag);
  const scenario = publishedWindowsScenario(process.env.PORTCOVE_INSTALLED_WINDOWS_OPERATION ?? "");
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  assert.ok(
    path.isAbsolute(runnerTemp) && !/\s/u.test(runnerTemp),
    "Require isolated runner storage",
  );
  process.exitCode = await resourceEntrypoint("browser", () =>
    run(tag, version, path.join(runnerTemp, "portcove-published-recovery"), scenario),
  );
}
