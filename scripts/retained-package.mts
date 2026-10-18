import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fileIdentity } from "./development-evidence.mts";
import type { FileIdentity } from "./development-evidence.mts";
import { isRecord, errorCode, errorMessage } from "./runtime-values.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
export const ordinaryPackageCommand = [
  "pnpm",
  "--dir",
  "apps/desktop",
  "desktop:build",
  "--bundles",
  "nsis",
];
const configurationPaths = ["tauri.conf.json", "tauri.windows.conf.json", "Cargo.toml"].map(
  (file) => path.join(root, "apps/desktop/src-tauri", file),
);
const modulePath = fileURLToPath(import.meta.url);

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Retained package record required");
  return value;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string", "Retained package text required");
  return value as string;
}
function identities(value: unknown): FileIdentity[] {
  assert.ok(Array.isArray(value), "Package identity list required");
  return (value as unknown[]).map(identity);
}
function identity(value: unknown): FileIdentity {
  const entry = object(value);
  assert.ok(
    typeof entry.bytes === "number" && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0,
    "Exact byte count required",
  );
  assert.match(text(entry.sha256), /^[a-f0-9]{64}$/u);
  assert.ok(path.isAbsolute(text(entry.path)), "Absolute package identity required");
  return { path: text(entry.path), bytes: entry.bytes, sha256: text(entry.sha256) };
}
async function json(file: string): Promise<Record<string, unknown>> {
  const fd = await open(file, "r");
  try {
    assert.ok((await fd.stat()).isFile(), "Package receipt must be a file");
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
    let length = 0;
    for (;;) {
      const read = await fd.read(buffer, length, buffer.length - length, null);
      length += read.bytesRead;
      assert.ok(length < buffer.length, "Package receipt exceeds 8 MiB");
      if (!read.bytesRead) break;
    }
    return object(
      JSON.parse(
        buffer
          .subarray(0, length)
          .toString("utf8")
          .replace(/^\uFEFF/u, ""),
      ),
    );
  } finally {
    await fd.close();
  }
}
function within(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
async function ownedFile(output: string, file: string) {
  assert.ok(within(output, file) && output !== file, "Package input escaped its owned output");
  let current = output;
  for (const part of path.relative(output, file).split(path.sep)) {
    assert.ok(!(await lstat(current)).isSymbolicLink(), "Linked package ancestry refused");
    current = path.join(current, part);
  }
  assert.ok(!(await lstat(file)).isSymbolicLink(), "Linked package input refused");
}
async function verifyIdentity(expected: FileIdentity, output?: string) {
  if (output) await ownedFile(output, expected.path);
  const actual = await fileIdentity(expected.path, { maxBytes: expected.bytes });
  assert.deepEqual(actual, expected, "Retained package input changed");
  return actual;
}
async function writeNew(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
async function deriveOnce(file: string, value: unknown) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = await lstat(file);
    assert.ok(existing.isFile() && !existing.isSymbolicLink());
    assert.equal(
      existing.size,
      Buffer.byteLength(bytes),
      "Conflicting derived package evidence retained",
    );
    assert.equal(
      await readFile(file, "utf8"),
      bytes,
      "Conflicting derived package evidence retained",
    );
  }
}
function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, "Cannot observe package build source");
  return result.stdout.trim();
}
async function source() {
  const revision = git("rev-parse", "HEAD");
  assert.match(revision, /^[a-f0-9]{40}$/u);
  assert.equal(
    git("status", "--porcelain", "--untracked-files=normal"),
    "",
    "Package build requires a clean source checkout",
  );
  return {
    revision,
    clean: true,
    configuration: await Promise.all(configurationPaths.map((file) => fileIdentity(file))),
  };
}

/** All case aliases are removed before the child receives ordinary build inputs. */
export function ordinaryPackageEnvironment(environment: NodeJS.ProcessEnv) {
  const excluded =
    /^(?:TAURI_(?:SIGNING_.*|CONFIG|CLI_CONFIG|CLI_FEATURES)|WINDOWS_CERTIFICATE.*|CSC_.*|APPLE_.*|GH_TOKEN|GITHUB_TOKEN|IGDB_.*|VITE_.*|PORTCOVE_RETAINED_PACKAGE_INSTALLER|PORTCOVE_.*(?:QUALIFICATION|PRIVATE_KEY|SIGNING).*|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_BUILD_TARGET|NODE_ENV)$/iu;
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !excluded.test(name)));
}
async function command(
  output: string,
  phase: string,
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd = root,
) {
  const { spawnCommand } = await import("./dev-storage.mts");
  const stdout = path.join(output, `${phase}.stdout.log`),
    stderr = path.join(output, `${phase}.stderr.log`);
  const out = openSync(stdout, "wx"),
    err = openSync(stderr, "wx");
  const started = new Date().toISOString();
  try {
    const result = spawnCommand(executable, args, {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", out, err],
    });
    const receipt = {
      executable,
      arguments: args,
      cwd,
      started_at: started,
      finished_at: new Date().toISOString(),
      status: result.status,
      signal: result.signal,
      error_code: errorCode(result.error) ?? null,
      stdout: await fileIdentity(stdout),
      stderr: await fileIdentity(stderr),
    };
    await writeNew(path.join(output, `${phase}.process.json`), receipt);
    assert.equal(
      result.error,
      undefined,
      `${phase} failed to start; retained process evidence has the reason`,
    );
    assert.equal(
      result.status,
      0,
      `${phase} exited unsuccessfully; inspect retained logs and process evidence`,
    );
    assert.equal(result.signal, null);
    return receipt;
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

export async function retainedPackageBuild(output: string) {
  assert.equal(process.platform, "win32", "Ordinary retained NSIS preparation requires Windows");
  const initial = await json(path.join(output, "preparation.json"));
  const capturedSource = await source();
  assert.deepEqual(initial.source, capturedSource, "Source changed before package build");
  const { getPaths, preflight, minimumFreeGiB, childEnvironment } =
    await import("./dev-storage.mts");
  const paths = getPaths();
  assert.equal(
    paths.target_directory,
    initial.target_directory,
    "Cargo target changed after admission",
  );
  const storage = preflight({ ...paths, retained_package_output: output }, minimumFreeGiB());
  const environment = {
    ...ordinaryPackageEnvironment({ ...process.env, ...childEnvironment(storage.paths) }),
    NODE_ENV: "production",
  };
  const { nativeBuildCommand } = await import("./native-build.mts");
  const build = nativeBuildCommand(["--bundles", "nsis"]);
  const processReceipt = await command(
    output,
    "build",
    build.executable,
    build.args,
    environment,
    build.cwd,
  );
  assert.deepEqual(await source(), capturedSource, "Source/configuration changed during build");
  const config = await json(configurationPaths[0]!);
  const version = text(config.version);
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u);
  assert.ok(paths.target_directory);
  const release = path.join(paths.target_directory, "release");
  const { readdir } = await import("node:fs/promises");
  const nsis = path.join(release, "bundle/nsis");
  assert.ok(
    process.arch === "x64" || process.arch === "arm64",
    "Unsupported Windows package architecture",
  );
  const installers = (await readdir(nsis)).filter(
    (name) => name === `Portcove_${version}_${process.arch}-setup.exe`,
  );
  assert.equal(installers.length, 1, "Expected exactly one version-bound NSIS artifact");
  const builtInstaller = path.join(nsis, installers[0]!);
  assert.ok(
    (await lstat(builtInstaller)).mtimeMs >= Date.parse(processReceipt.started_at),
    "NSIS output was not produced by the current build; retain logs rather than selecting an old artifact",
  );
  await mkdir(path.join(output, "package"));
  const installer = path.join(output, "package/installer.exe"),
    raw = path.join(output, "package/unbundled-portcove.exe");
  const { constants } = await import("node:fs");
  await copyFile(builtInstaller, installer, constants.COPYFILE_EXCL);
  await copyFile(path.join(release, "portcove-desktop.exe"), raw, constants.COPYFILE_EXCL);
  await command(
    output,
    "signature",
    "pwsh.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "(Get-AuthenticodeSignature -LiteralPath $env:PORTCOVE_RETAINED_PACKAGE_INSTALLER).Status.ToString()",
    ],
    { ...environment, PORTCOVE_RETAINED_PACKAGE_INSTALLER: installer },
  );
  const signature = (await readFile(path.join(output, "signature.stdout.log"), "utf8"))
    .replace(/^\uFEFF/u, "")
    .trim();
  assert.equal(signature, "NotSigned", "Ordinary retained package must be unsigned");
  const receipt = {
    format_version: 1,
    source: capturedSource,
    version,
    build_command: ordinaryPackageCommand,
    actual_build: build,
    qualification_features: [],
    process: processReceipt,
    process_evidence: await fileIdentity(path.join(output, "build.process.json")),
    signature_process: await fileIdentity(path.join(output, "signature.process.json")),
    installer: await fileIdentity(installer),
    raw_executable: await fileIdentity(raw),
    configuration: capturedSource.configuration,
    signature_status: signature,
    environment_policy:
      "ordinary child; signing/credential/qualification/config overrides removed by name without retaining values",
  };
  await writeNew(path.join(output, "build-result.json"), receipt);
}

export async function retainedPackageInstall(output: string) {
  const build = await json(path.join(output, "build-result.json"));
  const installer = await verifyIdentity(identity(build.installer), output);
  const raw = await verifyIdentity(identity(build.raw_executable), output);
  assert.equal(build.signature_status, "NotSigned");
  const { acquireNativeSessionLock } = await import("./native-session-lock.mts");
  const lock = await acquireNativeSessionLock({
    workspace: root,
    scenarios: ["ordinary-retained-package-install"],
  });
  try {
    const { collectDoctor } = await import("./dev-doctor.mts");
    const doctor = await collectDoctor({ profile: "desktop" });
    await writeNew(path.join(output, "native-doctor.json"), doctor);
    assert.equal(doctor.ok, true, "Desktop prerequisites failed before installation");
    await mkdir(path.join(output, "preserved-library"));
    await mkdir(path.join(output, "installer-runs"));
    await command(
      output,
      "installer",
      "pwsh.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-File",
        path.join(root, "scripts/test-windows-installer.ps1"),
        "-InstallerPath",
        installer.path,
        "-ExpectedExecutablePath",
        raw.path,
        "-ExpectedVersion",
        text(build.version),
        "-TestBase",
        path.join(output, "installer-runs"),
        "-RetainedLibraryRoot",
        path.join(output, "preserved-library"),
        "-RetainExecutablePath",
        path.join(output, "retained-installed-portcove.exe"),
        "-EvidencePath",
        path.join(output, "installer-evidence.json"),
      ],
      {
        ...ordinaryPackageEnvironment(process.env),
        PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: lock.owner.token,
      },
    );
  } finally {
    await lock.release();
  }
}

/** File-only join; this function never invokes Git, a doctor, build, install or resource admission. */
export async function finalizeRetainedPackage(requested: string) {
  assert.ok(path.isAbsolute(requested), "--output requires an absolute path");
  assert.ok(!(await lstat(requested)).isSymbolicLink(), "Linked package root refused");
  const output = await realpath(requested);
  const buildFile = path.join(output, "build-result.json"),
    installerFile = path.join(output, "installer-evidence.json");
  await ownedFile(output, buildFile);
  await ownedFile(output, installerFile);
  const build = await json(buildFile),
    receipt = await json(installerFile);
  assert.equal(build.format_version, 1);
  const captured = object(build.source);
  const revision = text(captured.revision);
  assert.match(revision, /^[a-f0-9]{40}$/u);
  assert.equal(captured.clean, true);
  assert.deepEqual(build.build_command, ordinaryPackageCommand);
  assert.deepEqual(build.qualification_features, []);
  const processReceipt = object(build.process);
  const actualBuild = object(build.actual_build);
  assert.ok(Array.isArray(actualBuild.args) && actualBuild.args.length === 4);
  assert.ok(path.isAbsolute(text(actualBuild.args[0])));
  assert.deepEqual(actualBuild.args.slice(1), ["build", "--bundles", "nsis"]);
  assert.equal(actualBuild.cwd, path.join(root, "apps/desktop"));
  assert.deepEqual(processReceipt.arguments, actualBuild.args);
  assert.equal(processReceipt.executable, actualBuild.executable);
  assert.equal(processReceipt.cwd, actualBuild.cwd);
  assert.equal(processReceipt.status, 0);
  assert.equal(processReceipt.signal, null);
  assert.equal(processReceipt.error_code, null);
  const buildProcessIdentity = await verifyIdentity(identity(build.process_evidence), output);
  assert.deepEqual(await json(buildProcessIdentity.path), processReceipt);
  for (const entry of [processReceipt.stdout, processReceipt.stderr])
    await verifyIdentity(identity(entry), output);
  const signatureProcessIdentity = await verifyIdentity(identity(build.signature_process), output);
  const signatureProcess = await json(signatureProcessIdentity.path);
  assert.equal(signatureProcess.status, 0);
  assert.equal(signatureProcess.signal, null);
  assert.equal(signatureProcess.error_code, null);
  for (const entry of [signatureProcess.stdout, signatureProcess.stderr])
    await verifyIdentity(identity(entry), output);
  assert.equal(
    (await readFile(identity(signatureProcess.stdout).path, "utf8")).replace(/^\uFEFF/u, "").trim(),
    "NotSigned",
  );
  const installer = await verifyIdentity(identity(build.installer), output);
  const raw = await verifyIdentity(identity(build.raw_executable), output);
  const configuration = identities(build.configuration);
  assert.deepEqual(
    configuration.map((entry) => entry.path),
    configurationPaths,
  );
  assert.deepEqual(captured.configuration, configuration);
  for (const entry of configuration) await verifyIdentity(entry);
  const retained = await fileIdentity(path.join(output, "retained-installed-portcove.exe"));
  await ownedFile(output, retained.path);
  assert.equal(
    receipt.phase,
    "complete",
    "Only a completed original installer run can be finalized",
  );
  assert.equal(receipt.failure, null);
  assert.equal(receipt.unverified_child_capture_failed, false);
  assert.deepEqual(receipt.unverified_child_observations, []);
  assert.ok(
    Array.isArray(receipt.process_runs) && receipt.process_runs.length >= 3,
    "Installer process journals required",
  );
  for (const value of receipt.process_runs as unknown[]) {
    const run = object(value);
    assert.equal(run.status, "exit_observed", "Positive owned process exit required");
    assert.equal(run.exit_code, 0);
    assert.ok(typeof run.pid === "number" && run.pid > 0);
    assert.ok(text(run.start_time));
    assert.ok(text(run.exit_observation));
  }
  const details = object(receipt.details),
    expected = object(details.expected_executable);
  assert.equal(details.installer_sha256, installer.sha256);
  assert.equal(build.signature_status, "NotSigned");
  assert.equal(details.signature_status, "NotSigned");
  assert.equal(details.update_path, "explicit_bootstrap_destination");
  assert.equal(details.install_exit_code, 0);
  assert.equal(details.uninstall_exit_code, 0);
  assert.equal(details.uninstall_registration_count, 1);
  assert.equal(details.registered_version, build.version);
  const bundled = await expectedBundledIdentity(raw.path);
  assert.equal(expected.raw_sha256, raw.sha256);
  assert.equal(bundled.raw_sha256, raw.sha256);
  assert.equal(bundled.bundled_sha256, retained.sha256);
  assert.equal(bundled.bundle_slot_patched, expected.bundle_slot_patched);
  assert.equal(expected.bundled_sha256, retained.sha256);
  assert.equal(details.installed_executable_sha256, retained.sha256);
  assert.equal(
    raw.bytes,
    retained.bytes,
    "NSIS marker replacement must preserve executable length",
  );
  assert.equal(typeof expected.bundle_slot_patched, "boolean");
  assert.equal(expected.bundle_slot_patched, raw.sha256 !== retained.sha256);
  assert.deepEqual(
    details.preservation_manifest_before_uninstall,
    details.preservation_manifest_after_uninstall,
  );
  assert.ok(
    isRecord(details.preservation_manifest_before_uninstall),
    "Recursive preservation evidence required",
  );
  const doctorFile = path.join(output, "native-doctor.json");
  await ownedFile(output, doctorFile);
  assert.equal((await json(doctorFile)).ok, true);
  const installerProcessFile = path.join(output, "installer.process.json");
  await ownedFile(output, installerProcessFile);
  const installerProcess = await json(installerProcessFile);
  assert.equal(installerProcess.status, 0);
  assert.equal(installerProcess.signal, null);
  assert.equal(installerProcess.error_code, null);
  const installerLogs = await Promise.all(
    [installerProcess.stdout, installerProcess.stderr].map((entry) =>
      verifyIdentity(identity(entry), output),
    ),
  );
  const manifest = {
    revision,
    build_command: ordinaryPackageCommand,
    qualification_features: [],
    configuration,
    installer,
    installer_evidence: await fileIdentity(installerFile),
    execution_context: "retained-installed-bytes",
  };
  const manifestFile = path.join(output, "ordinary-package-manifest.json");
  await deriveOnce(manifestFile, manifest);
  const { verifyNormalPackageEvidence } =
    await import("../apps/desktop/scripts/desktop-main-webview-boundary.mts");
  const verified = await verifyNormalPackageEvidence(manifestFile, revision, retained, root);
  const result = {
    format_version: 1,
    revision,
    execution_context: verified.execution_context,
    manifest: await fileIdentity(manifestFile),
    build_evidence: await fileIdentity(buildFile),
    installer_evidence: manifest.installer_evidence,
    installer_process: await fileIdentity(installerProcessFile),
    installer_logs: installerLogs,
    doctor: await fileIdentity(doctorFile),
    executable: retained,
    interpretation:
      "Ordinary unsigned Windows build/install/smoke/preservation/uninstall observations; retained installed bytes after uninstall. No current registration, publication or native consumer acceptance inferred.",
  };
  await deriveOnce(path.join(output, "finalization-result.json"), result);
  return result;
}

/** Same unique UNK -> NSS transform as the installer verifier, with bounded streaming memory. */
export async function expectedBundledIdentity(file: string) {
  const marker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii");
  const replacement = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS", "ascii");
  const raw = createHash("sha256"),
    bundled = createHash("sha256");
  let pending = Buffer.alloc(0),
    matches = 0;
  for await (const chunk of createReadStream(file)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    raw.update(bytes);
    pending = Buffer.concat([pending, bytes]);
    let offset = pending.indexOf(marker);
    while (offset !== -1) {
      assert.equal(++matches, 1, "Ambiguous Tauri bundle marker refused");
      bundled.update(pending.subarray(0, offset));
      bundled.update(replacement);
      pending = pending.subarray(offset + marker.length);
      offset = pending.indexOf(marker);
    }
    const consumed = Math.max(0, pending.length - marker.length + 1);
    bundled.update(pending.subarray(0, consumed));
    pending = pending.subarray(consumed);
  }
  bundled.update(pending);
  return {
    raw_sha256: raw.digest("hex"),
    bundled_sha256: bundled.digest("hex"),
    bundle_slot_patched: matches === 1,
  };
}

export async function requireExternalPackageOutput(output: string, target: string) {
  // Resolve an existing ancestor even when a custom target has not been created yet.
  async function canonical(requested: string): Promise<string> {
    try {
      return await realpath(requested);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(requested);
      assert.notEqual(parent, requested);
      return path.join(await canonical(parent), path.basename(requested));
    }
  }
  const actualTarget = await canonical(target);
  const actualOutput = await canonical(output);
  assert.ok(
    !within(actualTarget, actualOutput) && !within(actualOutput, actualTarget),
    "Retained package output must not overlap the Cargo target directory",
  );
}

export async function prepareRetainedPackage(requested: string) {
  assert.equal(process.platform, "win32", "Ordinary retained NSIS preparation requires Windows");
  assert.ok(path.isAbsolute(requested), "--output requires an absolute path");
  assert.ok(
    !Object.keys(process.env).some((name) =>
      /^(?:PORTCOVE_RESOURCE_RESERVATION|PORTCOVE_NATIVE_SESSION_LOCK_TOKEN)$/iu.test(name),
    ),
    "Preparation must start outside an inherited resource/native session",
  );
  const output = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  assert.notEqual(output, path.parse(output).root);
  assert.ok(
    !within(root, output) && !within(output, root),
    "Retained package output must be outside the source checkout",
  );
  const captured = await source();
  const { getPaths } = await import("./dev-storage.mts");
  const target = getPaths("rust").target_directory;
  assert.ok(target, "Cargo target directory required");
  await requireExternalPackageOutput(output, target);
  await mkdir(output); // exclusive new owner; never reuse a prior attempt implicitly
  await writeNew(path.join(output, "preparation.json"), {
    format_version: 1,
    source: captured,
    target_directory: target,
  });
  const { runResourceCommand } = await import("./resource-command.mts");
  const { frontendOutputResource } = await import("./resource-capacity.mts");
  for (const phase of ["build", "install"] as const) {
    const status = await runResourceCommand(
      phase === "build" ? "rust" : "browser",
      process.execPath,
      [modulePath, phase, output],
      {
        cwd: root,
        exclusive:
          phase === "build"
            ? [frontendOutputResource(root), frontendOutputResource(target)]
            : [frontendOutputResource(root)],
      },
    );
    assert.equal(
      status,
      0,
      `Retained package ${phase} failed; preserve output and inspect original evidence before resuming`,
    );
  }
  return finalizeRetainedPackage(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const [phase, output, ...rest] = process.argv.slice(2);
    assert.ok(
      output &&
        path.isAbsolute(output) &&
        !rest.length &&
        (phase === "build" || phase === "install"),
      "Internal retained package phase requires build|install ABS",
    );
    const { resourceEntrypoint } = await import("./resource-command.mts");
    const { frontendOutputResource } = await import("./resource-capacity.mts");
    const initial = await json(path.join(output, "preparation.json"));
    const target = text(initial.target_directory);
    process.exitCode = await resourceEntrypoint(
      phase === "build" ? "rust" : "browser",
      async () => {
        if (phase === "build") await retainedPackageBuild(output);
        else await retainedPackageInstall(output);
        return 0;
      },
      {
        cwd: root,
        exclusive:
          phase === "build"
            ? [frontendOutputResource(root), frontendOutputResource(target)]
            : [frontendOutputResource(root)],
      },
    );
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
