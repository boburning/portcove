import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireCatalogReleaseAttestation } from "./catalog-released-reader.mts";
import { fileIdentity } from "./development-evidence.mts";
import { parseSha256Sums, windowsAssetNames } from "./hosted-installed-update.mts";
import { acquireNativeSessionLock } from "./native-session-lock.mts";
import { resourceEntrypoint } from "./resource-command.mts";
import { isRecord } from "./runtime-values.mts";
import { cachedDesktopDrivers } from "./tool-cache.mts";

const repository = "boburning/portcove";
const scenario = "native-library-recovery-bundle";
const root = fileURLToPath(new URL("../", import.meta.url));
const packageLimit = 128 * 1024 * 1024;

export function recoveryPreviewVersion(tag: string) {
  const matched = /^nightly-(\d{1,3}\.\d{1,3}\.\d{1,3}-preview\.[1-9]\d{0,3})$/u.exec(tag);
  assert.ok(matched, "Supply an exact published Portcove Preview tag");
  return matched[1]!;
}

function command(
  program: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeout = 60_000,
) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    env: environment,
    cwd: root,
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

async function run(tag: string, version: string, temporary: string) {
  const installation = path.join(temporary, "installed");
  const output = path.join(root, "work", "published-windows-recovery-evidence");
  const native = path.join(output, "native");
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

  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await mkdir(temporary);
  const retain = (name: string, value: unknown) =>
    writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  await retain("host.json", {
    source: currentRevision,
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

  const lock = await acquireNativeSessionLock({ workspace: root, scenarios: [scenario] });
  try {
    assert.deepEqual(registry(childEnvironment), [], "Refusing an existing Portcove registration");
    const installer = path.join(temporary, assets.installer);
    assert.deepEqual(await fileIdentity(installer), identity[assets.installer]);
    command(installer, ["/S", `/D=${installation}`], childEnvironment, 10 * 60_000);
    const registration = registry(childEnvironment);
    assert.ok(Array.isArray(registration) && registration.length === 1);
    const entry = registration[0] as Record<string, unknown>;
    assert.equal(entry.DisplayVersion, version);
    assert.match(String(entry.PSPath), /HKEY_CURRENT_USER/iu);
    assert.equal(
      path.normalize(String(entry.InstallLocation)).replace(/\\+$/u, "").toLowerCase(),
      installation.toLowerCase(),
    );
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
        cwd: root,
        env: { ...childEnvironment, PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: lock.owner.token },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, "Installed recovery scenario failed");
    const observation: unknown = JSON.parse(
      await readFile(path.join(native, "evidence.json"), "utf8"),
    );
    assert.ok(isRecord(observation) && isRecord(observation.executable));
    assert.equal(observation.revision, currentRevision);
    assert.equal(observation.outcome, "passed");
    assert.equal(observation.executable.sha256, executable.sha256);
    assert.deepEqual(observation.selected_scenarios, [scenario]);
    assert.ok(Array.isArray(observation.restart_cycles) && observation.restart_cycles.length === 1);
    const recoveryResult = await fileIdentity(
      path.join(native, "native-recovery-bundle-result.json"),
    );
    assert.deepEqual(await fileIdentity(application), executable);
    assert.deepEqual(registry(childEnvironment), registration);
    await retain("installed-after.json", {
      registration,
      executable,
      recovery_result: recoveryResult,
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
  const tag = process.env.PORTCOVE_PUBLISHED_RECOVERY_TAG ?? "";
  const version = recoveryPreviewVersion(tag);
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  assert.ok(
    path.isAbsolute(runnerTemp) && !/\s/u.test(runnerTemp),
    "Require isolated runner storage",
  );
  process.exitCode = await resourceEntrypoint("browser", () =>
    run(tag, version, path.join(runnerTemp, "portcove-published-recovery")),
  );
}
