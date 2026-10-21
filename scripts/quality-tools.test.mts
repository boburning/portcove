import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findStaleConsumerPins, githubOutputs, validateQualityManifest } from "./quality-tools.mts";
import {
  parseAquaConfig,
  parseReleaseChecksumId,
  requireStableNonReleaseEntries,
  requireUnchangedInputs,
  validateAquaChecksumEntries,
  validateAquaChecksumLedger,
  verifyPublisherDigests,
} from "./aqua-integrity.mts";
import { isRecord } from "./runtime-values.mts";
import type { ActionlintRunner, ActionlintOptions } from "./run-actionlint.mts";
import { runActionlint } from "./run-actionlint.mts";
import { readToolPins } from "./tool-cache.mts";

const manifest: unknown = JSON.parse(
  await readFile(new URL("../.github/quality-tools.json", import.meta.url), "utf8"),
);

validateQualityManifest(manifest);
function requiredFixture<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}

void test("quality manifest owns exact unique Rust pins and workflow outputs", () => {
  assert.doesNotThrow(() => validateQualityManifest(manifest));
  assert.deepEqual(githubOutputs(manifest), {
    required_prebuilt: "just@1.58.0,cargo-shear@1.13.4,cargo-deny@0.20.2,cargo-nextest@0.9.100",
    required_all:
      "just@1.58.0,cargo-shear@1.13.4,cargo-deny@0.20.2,rscheck-cli@0.1.0,cargo-nextest@0.9.100",
    rscheck_spec: "rscheck-cli@0.1.0",
  });
});

void test("quality manifest rejects non-string executable arguments before execution", () => {
  for (const command of [[42], ["cargo", false], [null]]) {
    const invalid: unknown = {
      ...manifest,
      tools: [{ ...manifest.tools[0], command }, ...manifest.tools.slice(1)],
    };
    assert.throws(() => validateQualityManifest(invalid), /non-empty command array/);
  }
});

void test("stale consumer detection rejects copied current or divergent pins", () => {
  assert.deepEqual(
    findStaleConsumerPins(manifest, {
      clean: "tool: ${{ steps.pins.outputs.required }}",
    }),
    [],
  );
  assert.deepEqual(
    findStaleConsumerPins(manifest, {
      stale: "tool: cargo-deny@0.20.2,cargo-deny@0.19.0",
    }),
    ["stale:1 duplicates cargo-deny pin 0.20.2", "stale:1 duplicates cargo-deny pin 0.19.0"],
  );
});

void test("actionlint receives the exact aqua-managed ShellCheck path", () => {
  const calls: { command: string; arguments_: readonly string[]; options: ActionlintOptions }[] =
    [];
  const run: ActionlintRunner = (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    if (arguments_[0] === "which") return { status: 0, stdout: "C:\\aqua\\shellcheck.exe\r\n" };
    return { status: 0 };
  };
  assert.equal(runActionlint(["workflow.yml"], run).status, 0);
  assert.deepEqual(requiredFixture(calls[1]).arguments_, [
    "exec",
    "--",
    "actionlint",
    "-shellcheck=C:\\aqua\\shellcheck.exe",
    "workflow.yml",
  ]);
  assert.throws(
    () => runActionlint([], () => ({ status: 1, stdout: "" })),
    /aqua-managed ShellCheck executable is unavailable/,
  );
});

void test("standalone lint pins use aqua checksums and PSResourceGet data", async () => {
  const aquaVersion = (await readFile(new URL("../.aqua-version", import.meta.url), "utf8")).trim();
  assert.match(aquaVersion, /^v\d+\.\d+\.\d+$/u);

  const aqua = await readFile(new URL("../aqua.yaml", import.meta.url), "utf8");
  assert.match(aqua, /^checksum:\r?\n {2}enabled: true\r?\n {2}require_checksum: true$/mu);
  const packages = [...aqua.matchAll(/^ {2}- name: ([^@\s]+)@([^\s]+)$/gmu)].map(
    ([, name, version]) => ({ name, version }),
  );
  assert.deepEqual(
    packages.map(({ name }) => name),
    ["astral-sh/ruff", "rhysd/actionlint", "koalaman/shellcheck"],
  );
  for (const { version } of packages) assert.match(requiredFixture(version), /^v?\d+\.\d+\.\d+$/u);

  const lock: unknown = JSON.parse(
    await readFile(new URL("../aqua-checksums.json", import.meta.url), "utf8"),
  );
  validateAquaChecksumEntries(lock);
  validateAquaChecksumLedger(parseAquaConfig(aqua), lock);
  const ids = lock.checksums.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of lock.checksums) {
    assert.match(entry.checksum, /^[A-F0-9]{64}$/u);
    assert.equal(entry.algorithm, "sha256");
  }
  for (const identity of ["astral-sh/ruff", "rhysd/actionlint", "koalaman/shellcheck"])
    for (const platform of ["windows", "linux", "darwin"])
      assert.ok(
        ids.some(
          (id: string) =>
            id.includes(identity) &&
            (id.includes(platform) ||
              (identity === "koalaman/shellcheck" &&
                platform === "windows" &&
                id.endsWith(".zip"))),
        ),
        `${identity} has no ${platform} checksum`,
      );

  const resources = await readFile(
    new URL("../.config/powershell-resources.psd1", import.meta.url),
    "utf8",
  );
  assert.match(resources, /PSScriptAnalyzer/u);
  assert.match(resources, /version\s*=\s*'\d+\.\d+\.\d+'/u);

  const manager = await readFile(new URL("./quality-tools.mts", import.meta.url), "utf8");
  assert.doesNotMatch(manager, /install-managed|PORTCOVE_QUALITY_TOOLS_DIR|managedToolPath/u);
});

void test("Aqua integrity rejects stale, incomplete, unexpected and untrusted package checksums", async () => {
  const aqua = await readFile(new URL("../aqua.yaml", import.meta.url), "utf8");
  const config = parseAquaConfig(aqua);
  const ledger: unknown = JSON.parse(
    await readFile(new URL("../aqua-checksums.json", import.meta.url), "utf8"),
  );
  validateAquaChecksumEntries(ledger);
  const entries = validateAquaChecksumLedger(config, ledger);
  const ruff = config.packages.find(({ name }) => name === "astral-sh/ruff");
  assert.ok(ruff, "Ruff must remain in the maintained Aqua package inventory");
  assert.throws(
    () =>
      parseAquaConfig(
        aqua.replace(
          "    ref:",
          "  - name: alternate\n    type: local\n    path: ./alternate-registry.yaml\n  - type: standard\n    ref:",
        ),
      ),
    /default package authority only/u,
  );
  assert.throws(
    () =>
      parseAquaConfig(
        aqua.replace(
          `  - name: ${ruff.name}@${ruff.version}`,
          `  - name: ${ruff.name}@${ruff.version}\n    registry: alternate`,
        ),
      ),
    /default package authority only/u,
  );

  const missing = structuredClone(ledger);
  missing.checksums.splice(0, 1);
  assert.throws(() => validateAquaChecksumLedger(config, missing), /missing:/u);

  const stale = structuredClone(ledger);
  const staleVersion = "0.0.0";
  requiredFixture(stale.checksums[0]).id = requiredFixture(stale.checksums[0]).id.replace(
    `/${ruff.version}/`,
    `/${staleVersion}/`,
  );
  assert.doesNotThrow(() => validateAquaChecksumEntries(stale));
  assert.throws(
    () => validateAquaChecksumLedger(config, stale),
    (error) =>
      error instanceof Error &&
      error.message.includes(`/${ruff.version}/`) &&
      error.message.includes(`/${staleVersion}/`),
  );

  const duplicate = structuredClone(ledger);
  duplicate.checksums.push(structuredClone(requiredFixture(duplicate.checksums[0])));
  assert.throws(() => validateAquaChecksumLedger(config, duplicate), /contains duplicates/u);

  const unexpected = structuredClone(ledger);
  unexpected.checksums.push({
    id: "github_release/github.com/astral-sh/ruff/0.16.7/ruff-unreviewed-platform.zip",
    checksum: "A".repeat(64),
    algorithm: "sha256",
  });
  assert.throws(() => validateAquaChecksumLedger(config, unexpected), /unexpected:/u);

  const releases: Record<string, { tag_name: string; assets: { name: string; digest: string }[] }> =
    {};
  for (const entry of entries) {
    const identity = parseReleaseChecksumId(entry.id);
    assert.ok(identity);
    const key = `${identity.name}@${identity.version}`;
    releases[key] ??= { tag_name: identity.version, assets: [] };
    requiredFixture(releases[key]).assets.push({
      name: identity.asset,
      digest: `sha256:${entry.checksum.toLowerCase()}`,
    });
  }
  assert.doesNotThrow(() => verifyPublisherDigests(entries, releases));
  requiredFixture(requiredFixture(releases[`${ruff.name}@${ruff.version}`]).assets[0]).digest =
    `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => verifyPublisherDigests(entries, releases),
    /publisher SHA-256 digest differs/u,
  );

  const changedRegistry = structuredClone(ledger);
  requiredFixture(changedRegistry.checksums.at(-1)).checksum = "B".repeat(64);
  assert.throws(
    () => requireStableNonReleaseEntries(ledger, changedRegistry),
    /review it separately/u,
  );

  const captured = { configText: aqua, ledgerText: JSON.stringify(ledger) };
  assert.doesNotThrow(() => requireUnchangedInputs(captured, structuredClone(captured)));
  assert.throws(
    () => requireUnchangedInputs(captured, { ...captured, configText: `${aqua}\n` }),
    /aqua\.yaml changed/u,
  );
  assert.throws(
    () => requireUnchangedInputs(captured, { ...captured, ledgerText: "{}" }),
    /aqua-checksums\.json changed/u,
  );
});

void test("Aqua checksum entries reject absent, non-text and empty retained identities", () => {
  for (const id of [undefined, 1, "", null, {}]) {
    assert.throws(
      () =>
        validateAquaChecksumEntries({
          checksums: [{ id, algorithm: "sha256", checksum: "A".repeat(64) }],
        }),
      /checksum identity/,
    );
  }
});

void test("bootstrap pins use verified official Windows download origins", () => {
  const pins = readToolPins();
  assert.ok(pins.bootstrap.aqua && pins.bootstrap.desktop);
  assert.equal(
    pins.bootstrap.aqua.release_base,
    "https://github.com/aquaproj/aqua/releases/download",
  );
  assert.equal(pins.bootstrap.desktop.edge_driver_base, "https://msedgedriver.microsoft.com");
  assert.match(pins.bootstrap.desktop.tauri_driver, /^\d+\.\d+\.\d+$/u);
  for (const artifact of Object.values(pins.bootstrap.aqua.artifacts))
    assert.match(artifact.sha256, /^[A-F0-9]{64}$/u);
});

void test("EdgeDriver callers share a signature-first version boundary", async () => {
  const source = await readFile(new URL("./bootstrap-quality-tools.ps1", import.meta.url), "utf8");
  const helper = source.slice(
    source.indexOf("function Test-VerifiedEdgeDriver"),
    source.indexOf("function Install-DesktopTools"),
  );
  assert.ok(helper.indexOf("Get-AuthenticodeSignature") < helper.indexOf("Test-ReportedVersion"));
  assert.match(helper, /Status -ne "Valid"/u);
  assert.match(helper, /Subject -notmatch "Microsoft Corporation"/u);
  assert.match(source, /Test-VerifiedEdgeDriver \$nativeDriver \$runtimeVersion/u);
  assert.match(source, /Test-VerifiedEdgeDriver \$candidate \$runtimeVersion/u);
  assert.doesNotMatch(source, /& \$(?:nativeDriver|candidate) --version/u);
});

void test(
  "bootstrap refresh preserves an existing provider shim and its argument forwarding",
  { skip: process.platform !== "win32" },
  () => {
    const source = fileURLToPath(new URL("./bootstrap-quality-tools.ps1", import.meta.url));
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_SHIM_FIXTURE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$definition = @($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-CommandShim'}, $true))
if ($definition.Count -ne 1) { throw 'Expected one production shim writer' }
. ([scriptblock]::Create($definition[0].Extent.Text))
$temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixture = [IO.Path]::GetFullPath((Join-Path $temporary ('portcove-bootstrap-shim-' + [guid]::NewGuid())))
if (-not $fixture.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped temporary root' }
$shimDirectory = Join-Path $fixture 'bin'
try {
  Write-CommandShim 'pnpm' $env:PORTCOVE_SHIM_FIXTURE_NODE @('-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','--','prefix value')
  $shim = Join-Path $shimDirectory 'pnpm.cmd'
  $before = [IO.File]::ReadAllText($shim)
  $first = & $shim '--version' 'literal space'
  if ($LASTEXITCODE -ne 0 -or $first -cne '["prefix value","--version","literal space"]') { throw 'Initial argument forwarding failed' }
  Write-CommandShim 'pnpm' $shim
  if ([IO.File]::ReadAllText($shim) -cne $before) { throw 'Existing provider was overwritten during refresh' }
  $second = & $shim '--version' 'literal space'
  if ($LASTEXITCODE -ne 0 -or $second -cne $first) { throw 'Refreshed argument forwarding failed' }
  $rejected = $false
  try { Write-CommandShim 'pnpm' $shim @('different prefix') } catch { $rejected = $true }
  if (-not $rejected -or [IO.File]::ReadAllText($shim) -cne $before) { throw 'Self-wrapping prefix was not refused without mutation' }
  $missing = Join-Path $shimDirectory 'missing.cmd'
  $rejected = $false
  try { Write-CommandShim 'missing' $missing } catch { $rejected = $true }
  if (-not $rejected -or (Test-Path -LiteralPath $missing)) { throw 'Missing self-target was not refused' }
  'provider-refresh-passed'
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      env: {
        ...process.env,
        PORTCOVE_SHIM_FIXTURE_SOURCE: source,
        PORTCOVE_SHIM_FIXTURE_NODE: process.execPath,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /provider-refresh-passed/u);
  },
);

void test(
  "bootstrap retires only recognized legacy runtime shims without changing provider or quality tools",
  { skip: spawnSync("pwsh", ["--version"], { timeout: 5_000 }).status !== 0 },
  () => {
    const source = fileURLToPath(new URL("./bootstrap-quality-tools.ps1", import.meta.url));
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_SHIM_FIXTURE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Write-CommandShim','Remove-LegacyRuntimeShims')) {
  $definition = @($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true))
  if ($definition.Count -ne 1) { throw "Expected one production function $name" }
  . ([scriptblock]::Create($definition[0].Extent.Text))
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('portcove legacy shims ' + [guid]::NewGuid())
$shimDirectory = Join-Path $fixture 'checkout shims'
$sharedRoot = Join-Path $fixture 'shared'
$toolPaths = @{statePath=(Join-Path $shimDirectory 'tool-state.json')}
$state = @{format_version=1;shared_root=$sharedRoot;shim_directory=$shimDirectory;node=(Join-Path $fixture 'old node/node.exe');corepack=(Join-Path $fixture 'old node/corepack.cmd');package_manager='pnpm@12.4.1'}
try {
  New-Item -ItemType Directory -Force $shimDirectory | Out-Null
  $state | ConvertTo-Json | Set-Content -LiteralPath $toolPaths.statePath
  $stateBefore = [IO.File]::ReadAllText($toolPaths.statePath)
  $quality = Join-Path $shimDirectory 'aqua.cmd'
  [IO.File]::WriteAllText($quality, 'retained quality shim')
  $provider = Join-Path $fixture 'pnpm.cmd'
  [IO.File]::WriteAllText($provider, 'external provider')
  Write-CommandShim 'node' $state.node
  Write-CommandShim 'corepack' $state.corepack
  Write-CommandShim 'pnpm' $state.corepack @($state.package_manager)
  Remove-LegacyRuntimeShims
  foreach ($name in @('node','corepack','pnpm')) {
    if (Test-Path -LiteralPath (Join-Path $shimDirectory "$name.cmd")) { throw "Legacy $name shim survived" }
  }
  if ([IO.File]::ReadAllText($quality) -cne 'retained quality shim' -or [IO.File]::ReadAllText($provider) -cne 'external provider' -or [IO.File]::ReadAllText($toolPaths.statePath) -cne $stateBefore) { throw 'Unrelated quality tool, provider or state changed' }
  Write-CommandShim 'pnpm' $provider
  Remove-LegacyRuntimeShims
  if (Test-Path -LiteralPath (Join-Path $shimDirectory 'pnpm.cmd')) { throw 'Legacy direct pnpm shim survived' }
  Write-CommandShim 'node' $state.node
  Write-CommandShim 'corepack' $state.corepack
  $foreign = Join-Path $shimDirectory 'pnpm.cmd'
  [IO.File]::WriteAllText($foreign, '@echo custom provider')
  $before = @('node','corepack','pnpm') | ForEach-Object { [IO.File]::ReadAllText((Join-Path $shimDirectory "$_.cmd")) }
  $rejected = $false
  try { Remove-LegacyRuntimeShims } catch { $rejected = $_.Exception.Message -like 'Unrecognized checkout runtime shim*' }
  if (-not $rejected) { throw 'Foreign replacement was not refused' }
  $after = @('node','corepack','pnpm') | ForEach-Object { [IO.File]::ReadAllText((Join-Path $shimDirectory "$_.cmd")) }
  if (Compare-Object $before $after) { throw 'Partial cleanup occurred before recognizing all shims' }
  Write-CommandShim 'pnpm' $provider
  $state.shim_directory = Join-Path $fixture 'other checkout'
  $state | ConvertTo-Json | Set-Content -LiteralPath $toolPaths.statePath
  $rejected = $false
  try { Remove-LegacyRuntimeShims } catch { $rejected = $_.Exception.Message -like 'Unrecognized legacy runtime shim state*' }
  if (-not $rejected -or -not (Test-Path -LiteralPath $foreign)) { throw 'Foreign checkout state was not preserved' }
  'legacy-retirement-passed'
} finally {
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, PORTCOVE_SHIM_FIXTURE_SOURCE: source },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /legacy-retirement-passed/u);
  },
);

void test(
  "cached and downloaded EdgeDriver rejection never reaches the executable probe",
  { skip: process.platform !== "win32", timeout: 20_000 },
  () => {
    const script = fileURLToPath(new URL("./bootstrap-quality-tools.ps1", import.meta.url));
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:PORTCOVE_EDGE_FIXTURE_SOURCE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Assert-UnderRoot','Test-VerifiedEdgeDriver','Install-DesktopTools')) {
    $definition = @($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true))
    if ($definition.Count -ne 1) { throw "Expected one production function $name" }
    . ([scriptblock]::Create($definition[0].Extent.Text))
}
$runningOnWindows = $true
$bootstrapManifest = @{desktop=@{tauri_driver='2.0.6';edge_driver_base='https://msedgedriver.microsoft.com'}}
function Install-CachedTauriDriver { return $PSHOME + '\pwsh.exe' }
function Get-WebViewRuntimeVersion { return '1.2.3.4' }
function Write-CommandShim { }
function Write-Information { }
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile)
    if ($Uri -notlike 'https://msedgedriver.microsoft.com/1.2.3.4/edgedriver_*.zip') { throw 'Origin changed' }
    Set-Content -LiteralPath $OutFile -Value 'inert archive fixture'
}
function Expand-Archive {
    param($LiteralPath, $DestinationPath)
    New-Item -ItemType Directory -Force $DestinationPath | Out-Null
    Set-Content -LiteralPath (Join-Path $DestinationPath 'msedgedriver.exe') -Value 'inert downloaded fixture'
}
function Get-AuthenticodeSignature {
    param($LiteralPath)
    $downloaded = $LiteralPath -like '*\.staging\*'
    $role = if ($downloaded) {'downloaded'} else {'cached'}
    $events.Add("signature:$role")
    $trust = if ($downloaded) {$case.downloaded} else {$case.cached}
    return @{Status=$trust.status;SignerCertificate=@{Subject=$trust.publisher}}
}
function Test-ReportedVersion {
    param($Executable, $Arguments, $Version)
    if ($Arguments.Count -ne 1 -or $Arguments[0] -ne '--version' -or $Version -ne '1.2.3.4') { throw 'Probe contract changed' }
    $downloaded = $Executable -like '*\.staging\*'
    $role = if ($downloaded) {'downloaded'} else {'cached'}
    $events.Add("probe:$role")
    $trust = if ($downloaded) {$case.downloaded} else {$case.cached}
    if ($trust.status -ne 'Valid' -or $trust.publisher -notmatch 'Microsoft Corporation') { throw 'UNTRUSTED EXECUTION' }
    return $trust.match
}
$valid = @{status='Valid';publisher='CN=Microsoft Corporation';match=$true}
$invalid = @{status='HashMismatch';publisher='CN=Microsoft Corporation';match=$true}
$unsigned = @{status='NotSigned';publisher='';match=$true}
$wrongPublisher = @{status='Valid';publisher='CN=Other Publisher';match=$true}
$wrongVersion = @{status='Valid';publisher='CN=Microsoft Corporation';match=$false}
$cases = @(
    @{name='cached accepted';cached=$valid;downloaded=$invalid;expected=@('signature:cached','probe:cached');fails=$false},
    @{name='invalid cache';cached=$invalid;downloaded=$valid;expected=@('signature:cached','signature:downloaded','probe:downloaded');fails=$false},
    @{name='unsigned cache';cached=$unsigned;downloaded=$valid;expected=@('signature:cached','signature:downloaded','probe:downloaded');fails=$false},
    @{name='wrong publisher cache';cached=$wrongPublisher;downloaded=$valid;expected=@('signature:cached','signature:downloaded','probe:downloaded');fails=$false},
    @{name='wrong version cache';cached=$wrongVersion;downloaded=$valid;expected=@('signature:cached','probe:cached','signature:downloaded','probe:downloaded');fails=$false},
    @{name='invalid download';cached=$invalid;downloaded=$invalid;expected=@('signature:cached','signature:downloaded');fails=$true},
    @{name='unsigned download';cached=$invalid;downloaded=$unsigned;expected=@('signature:cached','signature:downloaded');fails=$true},
    @{name='wrong publisher download';cached=$invalid;downloaded=$wrongPublisher;expected=@('signature:cached','signature:downloaded');fails=$true},
    @{name='wrong version download';cached=$invalid;downloaded=$wrongVersion;expected=@('signature:cached','signature:downloaded','probe:downloaded');fails=$true}
)
$results = @()
foreach ($case in $cases) {
    $sharedRoot = Join-Path ([IO.Path]::GetTempPath()) ('portcove-edge-fixture-' + [guid]::NewGuid())
    $events = [Collections.Generic.List[string]]::new()
    try {
        $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
        $cached = Join-Path $sharedRoot "desktop\msedgedriver\1.2.3.4\$architecture\msedgedriver.exe"
        New-Item -ItemType Directory -Force (Split-Path -Parent $cached) | Out-Null
        Set-Content -LiteralPath $cached -Value 'inert cached fixture'
        $failed = $false; $message = ''
        try { $receipt = Install-DesktopTools }
        catch { $failed = $true; $message = $_.Exception.Message }
        if ($message -like '*UNTRUSTED EXECUTION*') { throw $message }
        if ($failed -ne $case.fails) { throw "Unexpected result for $($case.name): $message" }
        if (($events -join ',') -ne ($case.expected -join ',')) { throw "Unexpected events for $($case.name): $events" }
        if ($case.name -eq 'wrong version download' -and $message -notlike '*exactly match WebView2*') { throw 'Wrong-version rejection lost' }
        if ($failed -and (Get-Content -LiteralPath $cached -Raw).Trim() -ne 'inert cached fixture') { throw 'Rejected candidate was promoted' }
        if (-not $failed -and $receipt.webview2_version -ne '1.2.3.4') { throw 'Receipt changed' }
        $results += @{name=$case.name;events=$events.ToArray();failed=$failed}
    } finally { Remove-Item -LiteralPath $sharedRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
$results | ConvertTo-Json -Depth 6 -Compress
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 18_000,
      env: { ...process.env, PORTCOVE_EDGE_FIXTURE_SOURCE: script },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const cases: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(cases));
    const observations: unknown[] = cases;
    assert.equal(cases.length, 9);
    assert.equal(observations.filter((entry) => isRecord(entry) && entry.failed).length, 4);
  },
);
