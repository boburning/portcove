/** Unbranded same-job diagnostic data only. No protected admission or receipts. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { hashNativeCapturedFile } from "./release-native-capture-files.mts";
import { verifyUpdaterInventory } from "./updater-artifact-inventory.mts";
import { inspectSupportedHostedWindowsRuntimeInput } from "./hosted-windows-runtime-input.mts";
import { toolCachePaths } from "./tool-cache.mts";
import { windowsOwnerEnvironment } from "./release-windows-owner-mechanism.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  windowsSourceSystemExecutables,
} from "./release-native-runtime-custody.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const diagnosticVersions = ["1.0.0-rc.2", "1.0.0"] as const;
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const fixtureMetadata = [
  "Cargo.toml",
  "Cargo.lock",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];

/** Data join only. The reviewed producer captures its actual command ordering;
 * this does not attest reproducible builds or authenticate an upstream author. */
export function inspectDiagnosticFixtureDerivation(
  value: unknown,
  context: { source: string; tree: string; run_id: string; workflow: string },
  expected: ReadonlyMap<string, { path: string; bytes: number; sha256: string }>,
) {
  assert.ok(isRecord(value));
  assert.equal(
    Object.keys(value).sort().join(","),
    "attempt,authority,native_rehearsal_passed,platform,private_inputs_absent,producer,restored,run_id,schema_version,scope,source,stages,transition_profile,tree,workflow",
  );
  assert.equal(value.schema_version, 1);
  for (const key of ["source", "tree", "run_id", "workflow"] as const)
    assert.equal(value[key], context[key]);
  assert.equal(value.attempt, "1");
  assert.equal(value.platform, "windows-x86_64");
  assert.equal(value.transition_profile, "preview-final");
  assert.equal(value.private_inputs_absent, true);
  assert.equal(value.native_rehearsal_passed, true);
  assert.equal(value.authority, "none");
  assert.equal(
    value.scope,
    "observed same-job maintained fixture producer; not reproducible-build attestation or publisher authentication",
  );
  const identity = (raw: unknown, name: string, observed: boolean) => {
    assert.ok(isRecord(raw));
    assert.equal(Object.keys(raw).sort().join(","), "bytes,path,sha256");
    assert.equal(raw.path, name);
    assert.ok(
      Number.isSafeInteger(raw.bytes) &&
        Number(raw.bytes) > 0 &&
        Number(raw.bytes) <= 512 * 1024 ** 2,
    );
    assert.ok(typeof raw.sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.sha256));
    if (observed)
      assert.deepEqual(raw, expected.get(name), "Actual fixture derivation bytes changed");
  };
  const state = (raw: unknown, restored: boolean) => {
    assert.ok(isRecord(raw));
    assert.equal(Object.keys(raw).sort().join(","), "metadata,source,tracked_changes,tree");
    assert.equal(raw.source, context.source);
    assert.equal(raw.tree, context.tree);
    assert.ok(Array.isArray(raw.tracked_changes));
    assert.ok(
      raw.tracked_changes.length <= 4 &&
        new Set(raw.tracked_changes).size === raw.tracked_changes.length &&
        raw.tracked_changes.every(
          (name: unknown) => typeof name === "string" && fixtureMetadata.includes(name),
        ),
    );
    if (restored) assert.equal(raw.tracked_changes.length, 0);
    assert.ok(Array.isArray(raw.metadata) && raw.metadata.length === 4);
    for (const [index, name] of fixtureMetadata.entries())
      identity(raw.metadata[index], name, restored);
  };
  identity(value.producer, "scripts/rehearse-updater-artifacts.ps1", true);
  state(value.restored, true);
  assert.ok(Array.isArray(value.stages) && value.stages.length === 2);
  for (const [index, version] of diagnosticVersions.entries()) {
    const stage: unknown = value.stages[index];
    assert.ok(isRecord(stage));
    assert.equal(
      Object.keys(stage).sort().join(","),
      "after,artifacts,before,commands,commands_successful,generator,inventory,patch,public_key,verifier,version",
    );
    assert.equal(stage.version, version);
    assert.equal(stage.generator, "Set-FixtureVersion");
    assert.equal(stage.commands_successful, true);
    assert.ok(
      Array.isArray(stage.commands) &&
        stage.commands.length === 4 &&
        stage.commands.every((command: unknown) => isRecord(command) && command.success === true),
    );
    assert.deepEqual(
      stage.commands.map((command: unknown) => {
        assert.ok(isRecord(command));
        return command.program;
      }),
      ["cargo", "pnpm", "node", "node"],
    );
    for (const [ordinal, command] of stage.commands.entries()) {
      assert.ok(isRecord(command));
      assert.equal(
        Object.keys(command).sort().join(","),
        ordinal < 2 ? "arguments,program,success" : "operation,program,success",
      );
      if (ordinal === 0)
        assert.deepEqual(command.arguments, [
          "build",
          "--release",
          "-p",
          "portcove-cli",
          "-p",
          "portcove-release-tools",
          "--target-dir",
          path.join(project, `target/updater-rehearsal-cli-${version}`),
        ]);
      if (ordinal === 1)
        assert.deepEqual(command.arguments, [
          "--dir",
          "apps/desktop",
          "tauri",
          "build",
          "--bundles",
          "nsis",
          "--config",
          path.join(project, "work/updater-rehearsal/rehearsal-config.json"),
          "--ci",
          "--features",
          "application-update-qualification",
        ]);
      if (ordinal > 1)
        assert.equal(
          command.operation,
          ordinal === 2 ? "updater-inventory-stage" : "updater-inventory-verify",
        );
    }
    state(stage.before, false);
    state(stage.after, false);
    const directory = `work/updater-rehearsal/${version}-windows-x86_64/`;
    identity(stage.inventory, directory + "updater-inventory.json", true);
    identity(stage.patch, `work/updater-rehearsal/${version}-fixture.patch`, true);
    identity(stage.public_key, "work/updater-rehearsal/disposable.key.pub", true);
    identity(
      stage.verifier,
      `target/updater-rehearsal-cli-${version}/release/portcove-release-tools.exe`,
      true,
    );
    assert.ok(Array.isArray(stage.artifacts));
    const artifacts = [...expected.keys()]
      .filter((name) => name.startsWith(directory) && !name.endsWith("/updater-inventory.json"))
      .sort();
    assert.equal(stage.artifacts.length, artifacts.length);
    assert.deepEqual(
      stage.artifacts
        .map((row: unknown) => {
          assert.ok(isRecord(row));
          assert.ok(typeof row.path === "string");
          return row.path;
        })
        .sort(),
      artifacts,
    );
    for (const name of artifacts)
      identity(
        stage.artifacts.find((row: unknown) => isRecord(row) && row.path === name),
        name,
        true,
      );
  }
  return {
    authority: "none" as const,
    scope: value.scope,
    source: context.source,
    tree: context.tree,
  };
}

async function readOriginalDiagnosticDrivers(version: string, deadline: number) {
  const paths = toolCachePaths({ projectRoot: project }),
    stateBytes = await readControllerToolFile(paths.statePath, 65536),
    state: unknown = JSON.parse(stateBytes.toString("utf8"));
  assert.ok(isRecord(state) && isRecord(state.desktop));
  assert.equal(state.pin_fingerprint, paths.pins.fingerprint);
  assert.equal(state.shared_root, paths.sharedRoot);
  const pins = paths.pins.bootstrap.desktop;
  assert.ok(pins);
  const desktop = state.desktop,
    native = path.join(paths.sharedRoot, "desktop/msedgedriver", version, "x64/msedgedriver.exe"),
    tauri = path.join(paths.cargoRoot, "tauri-driver", pins.tauri_driver, "bin/tauri-driver.exe"),
    policy = path.join(project, "scripts/windows-webview-driver-policy.psm1");
  assert.equal(desktop.native_driver, native);
  assert.equal(desktop.native_driver_version, version);
  assert.equal(desktop.webview2_version, version);
  assert.equal(desktop.tauri_driver, tauri);
  assert.equal(desktop.tauri_driver_version, pins.tauri_driver);
  const files = [native, tauri, policy, paths.statePath],
    custody = inspectNativeRuntimeCustody(files),
    identities = await Promise.all(
      [native, tauri].map((filename) =>
        hashNativeCapturedFile(
          paths.sharedRoot,
          path.relative(paths.sharedRoot, filename),
          128 * 1024 ** 2,
          deadline,
        ),
      ),
    );
  assert.equal(identities[0]!.sha256.toUpperCase(), desktop.native_driver_sha256);
  assert.equal(identities[1]!.sha256.toUpperCase(), desktop.tauri_driver_sha256);
  const input = Buffer.from(JSON.stringify({ policy, native, version })).toString("base64"),
    script = `$ErrorActionPreference='Stop';$v=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json;Import-Module -Name $v.policy -Force;if((Get-WebViewRuntimeVersion) -cne $v.version -or -not (Test-VerifiedEdgeDriver $v.native $v.version)){throw 'Original runtime/driver join differs'};$s=Get-AuthenticodeSignature -LiteralPath $v.native;[ordered]@{version=([Diagnostics.FileVersionInfo]::GetVersionInfo($v.native).FileVersion -split ' ')[0];status=[string]$s.Status;subject=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress`;
  assert.ok(performance.now() < deadline);
  const observed: unknown = JSON.parse(
    execFileSync(
      windowsSourceSystemExecutables.powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        cwd: project,
        env: windowsOwnerEnvironment(project),
        timeout: Math.max(1, Math.min(15000, Math.floor(deadline - performance.now()))),
        maxBuffer: 16384,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  assert.ok(isRecord(observed));
  assert.equal(observed.version, version);
  assert.equal(observed.status, "Valid");
  assert.ok(
    typeof observed.subject === "string" && observed.subject.includes("Microsoft Corporation"),
  );
  assert.ok(typeof observed.thumbprint === "string" && /^[A-F0-9]{40}$/u.test(observed.thumbprint));
  recheckNativeRuntimeCustody(files, custody);
  assert.ok(stateBytes.equals(await readControllerToolFile(paths.statePath, 65536)));
  return {
    native: { ...identities[0]!, path: native, configured_version: version, signature: observed },
    tauri: {
      ...identities[1]!,
      path: tauri,
      configured_version: pins.tauri_driver,
      publisher_authentication: "not-established",
    },
    custody,
    files,
    authority: "none" as const,
  };
}

/** Read observations from the one maintained rehearsal's fixed output paths.
 * This is neither an admitted candidate nor authority to execute its bytes.
 * The separately held controller calls it only after the rehearsal has restored
 * the original tracked checkout and removed the disposable private key. */
export async function readOriginalHostedWindowsDiagnosticInputs() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.GITHUB_JOB, "installed-prerequisite");
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.GITHUB_REPOSITORY, "boburning/portcove");
  assert.equal(process.env.PORTCOVE_HOSTED_PLATFORM, "windows-x86_64");
  assert.equal(process.env.PORTCOVE_HOSTED_OBSERVATION_ONLY, "false");
  assert.equal(process.env.PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC, "true");
  const source = process.env.GITHUB_SHA,
    workflow = process.env.GITHUB_WORKFLOW_REF,
    run_id = process.env.GITHUB_RUN_ID;
  assert.match(source ?? "", /^[a-f0-9]{40}$/u);
  assert.match(run_id ?? "", /^[1-9][0-9]{0,15}$/u);
  assert.match(
    workflow ?? "",
    /^boburning\/portcove\/[.]github\/workflows\/hosted-native-continuity[.]yml@refs\/heads\/(?:main|feature\/534-[A-Za-z0-9-]+)$/u,
  );
  const routeNames = [
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_EVENT_NAME",
    "GITHUB_JOB",
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
    "GITHUB_REPOSITORY",
    "PORTCOVE_HOSTED_PLATFORM",
    "PORTCOVE_HOSTED_OBSERVATION_ONLY",
    "PORTCOVE_HOSTED_CONNECTED_DIAGNOSTIC",
  ];
  const route = routeNames.map((name) => process.env[name]);
  const deadline = performance.now() + 300000;
  const active = () => {
    assert.ok(performance.now() < deadline, "Diagnostic input deadline exhausted");
    assert.deepEqual(
      routeNames.map((name) => process.env[name]),
      route,
      "Original diagnostic route changed",
    );
  };
  const git = (args: string[]) => {
    active();
    return execFileSync(windowsSourceSystemExecutables.git, args, {
      cwd: project,
      timeout: Math.min(10000, Math.max(1, Math.floor(deadline - performance.now()))),
      maxBuffer: 65536,
      encoding: "utf8",
    });
  };
  const checkout = () => {
    assert.equal(path.resolve(git(["rev-parse", "--show-toplevel"]).trim()), path.resolve(project));
    assert.equal(git(["rev-parse", "HEAD"]).trim(), source);
    git(["diff", "--quiet", "HEAD", "--"]);
    return git(["rev-parse", "HEAD^{tree}"]).trim();
  };
  const tree = checkout();
  assert.match(tree, /^[a-f0-9]{40}$/u);
  const root = path.join(project, "work/updater-rehearsal");
  const absent = async (filename: string) => {
    try {
      await lstat(filename);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }
    assert.fail("Disposable private signing input remains; diagnostic refuses");
  };
  await absent(path.join(root, "disposable.key"));
  const evidence = new Map<string, Buffer>();
  const read = async (name: string, maximum = 65536) => {
    active();
    const filename = path.join(project, name),
      bytes = await readControllerToolFile(filename, maximum);
    const identity = await hashNativeCapturedFile(project, name, maximum, deadline);
    assert.deepEqual(
      { bytes: bytes.length, sha256: digest(bytes) },
      { bytes: identity.bytes, sha256: identity.sha256 },
    );
    active();
    evidence.set(filename, bytes);
    return bytes;
  };
  const result: unknown = JSON.parse(
    (await read("work/updater-rehearsal/rehearsal-result.json")).toString("utf8"),
  );
  assert.ok(isRecord(result));
  assert.equal(result.source_commit, source);
  assert.equal(result.platform, "windows-x86_64");
  assert.equal(result.status, "passed");
  assert.equal(result.transition_profile, "preview-final");
  assert.equal(result.production_signing, false);
  assert.deepEqual(result.fixture_versions, diagnosticVersions);
  const runtimeBytes = await read("work/hosted-continuity-evidence/windows-runtime.json"),
    floorBytes = await read("apps/desktop/src-tauri/src/runtime_support.rs"),
    runtime = inspectSupportedHostedWindowsRuntimeInput(floorBytes, runtimeBytes, {
      source,
      workflow,
      run_id,
      attempt: "1",
    });
  const drivers = await readOriginalDiagnosticDrivers(runtime.observed, deadline);
  const publicKey = path.join(root, "disposable.key.pub");
  await read("work/updater-rehearsal/disposable.key.pub", 16384);
  const stages = [];
  const files: Awaited<ReturnType<typeof hashNativeCapturedFile>>[] = [];
  for (const version of diagnosticVersions) {
    const input = path.join(root, `${version}-windows-x86_64`),
      verifier = path.join(
        project,
        `target/updater-rehearsal-cli-${version}/release/portcove-release-tools.exe`,
      );
    const names = await readdir(input);
    assert.ok(names.length > 0 && names.length <= 8);
    for (const name of names) {
      assert.ok(/^[A-Za-z0-9_.-]{1,128}$/u.test(name));
      const entry = await hashNativeCapturedFile(
        project,
        path.relative(project, path.join(input, name)),
        512 * 1024 ** 2,
        deadline,
      );
      assert.ok(entry.bytes > 0);
      files.push(entry);
      assert.ok(
        files.reduce((sum, row) => sum + row.bytes, 0) <= 1024 ** 3,
        "Diagnostic staged input exceeds one GiB",
      );
    }
    const verifierIdentity = await hashNativeCapturedFile(
      project,
      path.relative(project, verifier),
      128 * 1024 ** 2,
      deadline,
    );
    const patch = await read(`work/updater-rehearsal/${version}-fixture.patch`, 512 * 1024),
      native: unknown = JSON.parse(
        (await read(`work/updater-rehearsal/${version}-native.json`)).toString("utf8"),
      );
    assert.ok(isRecord(native));
    assert.equal(native.source_commit, source);
    assert.equal(native.version, version);
    assert.equal(native.platform, "windows-x86_64");
    assert.equal(native.signing, "disposable test key");
    assert.equal(native.process_architecture, "X64");
    const custody = inspectNativeRuntimeCustody([
      verifier,
      ...names.map((name) => path.join(input, name)),
      publicKey,
    ]);
    const inventory = await verifyUpdaterInventory({
      projectRoot: project,
      input,
      label: "windows-x86_64",
      publicKey,
      revision: source!,
      version,
      verifier,
    });
    active();
    recheckNativeRuntimeCustody(
      [verifier, ...names.map((name) => path.join(input, name)), publicKey],
      custody,
    );
    const selected = files.filter(
      (entry) => path.dirname(path.join(project, entry.path)) === input,
    );
    for (const before of selected)
      assert.deepEqual(
        await hashNativeCapturedFile(project, before.path, 512 * 1024 ** 2, deadline),
        before,
      );
    assert.deepEqual(
      await hashNativeCapturedFile(project, verifierIdentity.path, 128 * 1024 ** 2, deadline),
      verifierIdentity,
    );
    stages.push({
      version,
      inventory,
      package_path: path.join(input, inventory.updater.filename),
      verifier: verifierIdentity,
      fixture_patch: { bytes: patch.length, sha256: digest(patch) },
    });
  }
  for (const name of [...fixtureMetadata, "scripts/rehearse-updater-artifacts.ps1"])
    await read(name, name === "scripts/rehearse-updater-artifacts.ps1" ? 131072 : 4 * 1024 ** 2);
  const derivation = JSON.parse(
    (await read("work/updater-rehearsal/windows-fixture-derivation.json")).toString("utf8"),
  ) as unknown;
  const observed = new Map(
    [
      ...files,
      ...stages.map((stage) => stage.verifier),
      ...[...evidence].map(([filename, bytes]) => ({
        path: path.relative(project, filename),
        bytes: bytes.length,
        sha256: digest(bytes),
      })),
    ].map((row) => {
      const name = row.path.replaceAll("\\", "/");
      return [name, { ...row, path: name }] as const;
    }),
  );
  const fixture = inspectDiagnosticFixtureDerivation(
    derivation,
    { source: source!, tree, run_id: run_id!, workflow: workflow! },
    observed,
  );
  for (const [filename, bytes] of evidence)
    assert.ok(
      bytes.equals(await readControllerToolFile(filename, Math.max(bytes.length, 1))),
      "Original diagnostic input changed",
    );
  await absent(path.join(root, "disposable.key"));
  recheckNativeRuntimeCustody(drivers.files, drivers.custody);
  assert.equal(checkout(), tree);
  active();
  return {
    source: source!,
    tree,
    run_id: run_id!,
    workflow: workflow!,
    stages,
    runtime,
    drivers,
    fixture,
    files,
    evidence: [...evidence].map(([filename, bytes]) => ({
      path: path.relative(project, filename),
      bytes: bytes.length,
      sha256: digest(bytes),
    })),
    authority: "none" as const,
    scope:
      "same-job disposable-key rehearsal observations; no admission, publisher authentication or execution authority",
  };
}

export const hostedWindowsDiagnosticOwnerMilliseconds = 570000;
export const hostedWindowsDiagnosticCleanupMilliseconds = 30000;
/** A single fixed public provider read needs no account or role credential.
 * Provider/local clock disagreement refuses; the anchored monotonic deadline
 * never renews from a later Actions step or a replacement parent process. */
export async function readOrdinaryHostedWindowsDiagnosticDeadline(
  context: { source: string; run_id: string; attempt: string },
  transport: typeof fetch = fetch,
) {
  assert.match(context.source, /^[a-f0-9]{40}$/u);
  assert.match(context.run_id, /^[1-9][0-9]{0,15}$/u);
  assert.equal(context.attempt, "1");
  const started = performance.now();
  const response = await transport(
    `https://api.github.com/repos/boburning/portcove/actions/runs/${context.run_id}/attempts/1/jobs?per_page=1&page=1`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "portcove-fixed-connected-diagnostic",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    },
  );
  assert.equal(response.status, 200, "Original ordinary job provider read refused");
  const serverDate = Date.parse(response.headers.get("date") ?? "");
  const age = response.headers.get("age");
  assert.ok(age === null || /^[0-9]{1,3}$/u.test(age));
  const ageMilliseconds = Number(age ?? "0") * 1000;
  assert.ok(
    ageMilliseconds <= 30000 &&
      Number.isFinite(serverDate) &&
      Math.abs(Date.now() - serverDate - ageMilliseconds) <= 30000,
    "Original provider clock unavailable or stale",
  );
  const raw = await readBoundedDiagnosticProviderBody(response, 65536, started + 10000);
  const text = raw.toString("utf8");
  const inventory: unknown = JSON.parse(text);
  assert.ok(
    isRecord(inventory) &&
      inventory.total_count === 1 &&
      Array.isArray(inventory.jobs) &&
      inventory.jobs.length === 1,
    "Complete single ordinary job inventory required",
  );
  const job: unknown = inventory.jobs[0];
  assert.ok(
    isRecord(job) &&
      job.name === "installed-prerequisite" &&
      job.head_sha === context.source &&
      String(job.run_id) === context.run_id &&
      job.run_attempt === 1 &&
      job.status === "in_progress" &&
      job.conclusion === null &&
      typeof job.started_at === "string" &&
      Number.isSafeInteger(job.id) &&
      Number(job.id) > 0,
  );
  assert.ok(
    Array.isArray(job.labels) && job.labels.includes("windows-2022"),
    "Original standard Windows runner required",
  );
  const jobStart = Date.parse(job.started_at);
  assert.ok(Number.isFinite(jobStart) && jobStart <= serverDate + ageMilliseconds + 1000);
  const providerDeadline = jobStart + 90 * 60 * 1000;
  // Subtract the entire request elapsed interval and a finalizer margin. A
  // slow read, stale response or clock rollback can only shorten/refuse it.
  const remaining =
    providerDeadline - serverDate - ageMilliseconds - (performance.now() - started) - 60000;
  assert.ok(
    remaining >= hostedWindowsDiagnosticOwnerMilliseconds,
    "Original job cannot preserve the complete finite owner/recovery budget",
  );
  return {
    deadline: performance.now() + hostedWindowsDiagnosticOwnerMilliseconds,
    job_id: Number(job.id),
    job_started_at: job.started_at,
    provider_observed_at: new Date(serverDate).toISOString(),
    provider_response_bytes: raw.length,
    maximum_owner_milliseconds: hostedWindowsDiagnosticOwnerMilliseconds,
    cleanup_reserve_milliseconds: hostedWindowsDiagnosticCleanupMilliseconds,
    provider_finalizer_margin_milliseconds: 60000,
    authority: "none" as const,
  };
}

/** Bounded inert public provider bytes only; caller owns endpoint and identity. */
export async function readBoundedDiagnosticProviderBody(
  response: Response,
  maximum: number,
  deadline: number,
) {
  assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 65536);
  assert.ok(
    Number.isFinite(deadline) &&
      performance.now() < deadline &&
      deadline <= performance.now() + 10000,
  );
  const declared = response.headers.get("content-length");
  if (declared !== null) assert.ok(/^[0-9]{1,6}$/u.test(declared) && Number(declared) <= maximum);
  const reader = response.body?.getReader();
  assert.ok(reader);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      assert.ok(performance.now() < deadline, "Original provider read deadline exhausted");
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      assert.ok(chunk instanceof Uint8Array);
      bytes += chunk.byteLength;
      assert.ok(bytes <= maximum, "Original job provider response exceeds bound");
      chunks.push(chunk);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks),
    text = raw.toString("utf8");
  assert.ok(Buffer.from(text).equals(raw));
  return raw;
}
