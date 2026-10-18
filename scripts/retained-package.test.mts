import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fileIdentity } from "./development-evidence.mts";
import {
  finalizeRetainedPackage,
  expectedBundledIdentity,
  requireExternalPackageOutput,
  ordinaryPackageCommand,
  ordinaryPackageEnvironment,
} from "./retained-package.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
async function fixture() {
  const output = await mkdtemp(path.join(tmpdir(), "retained-package-"));
  await mkdir(path.join(output, "package"));
  const save = async (file: string, value: unknown) =>
    writeFile(path.join(output, file), encode(value));
  await writeFile(path.join(output, "package/installer.exe"), "inert installer fixture");
  await writeFile(
    path.join(output, "package/unbundled-portcove.exe"),
    "inert __TAURI_BUNDLE_TYPE_VAR_UNK fixture",
  );
  await writeFile(
    path.join(output, "retained-installed-portcove.exe"),
    "inert __TAURI_BUNDLE_TYPE_VAR_NSS fixture",
  );
  const installer = await fileIdentity(path.join(output, "package/installer.exe"));
  const raw = await fileIdentity(path.join(output, "package/unbundled-portcove.exe"));
  const retained = await fileIdentity(path.join(output, "retained-installed-portcove.exe"));
  const configuration = await Promise.all(
    ["tauri.conf.json", "tauri.windows.conf.json", "Cargo.toml"].map((file) =>
      fileIdentity(path.join(root, "apps/desktop/src-tauri", file)),
    ),
  );
  const actualBuild = {
    executable: process.execPath,
    args: [path.join(root, "inert-tauri-fixture.js"), "build", "--bundles", "nsis"],
    cwd: path.join(root, "apps/desktop"),
  };
  const processFixture = async (phase: string, stdout = "") => {
    await writeFile(path.join(output, `${phase}.stdout.log`), stdout);
    await writeFile(path.join(output, `${phase}.stderr.log`), "");
    const record = {
      status: 0,
      signal: null,
      error_code: null,
      executable: actualBuild.executable,
      arguments: actualBuild.args,
      cwd: actualBuild.cwd,
      stdout: await fileIdentity(path.join(output, `${phase}.stdout.log`)),
      stderr: await fileIdentity(path.join(output, `${phase}.stderr.log`)),
    };
    await save(`${phase}.process.json`, record);
    return record;
  };
  const buildProcess = await processFixture("build");
  await processFixture("signature", "NotSigned\n");
  await processFixture("installer");
  await save("native-doctor.json", { ok: true });
  const build = {
    format_version: 1,
    source: { revision: "a".repeat(40), clean: true, configuration },
    version: "0.1.0-alpha.2",
    build_command: ordinaryPackageCommand,
    actual_build: actualBuild,
    qualification_features: [],
    process: buildProcess,
    process_evidence: await fileIdentity(path.join(output, "build.process.json")),
    signature_process: await fileIdentity(path.join(output, "signature.process.json")),
    installer,
    raw_executable: raw,
    configuration,
    signature_status: "NotSigned",
  };
  const receipt = {
    phase: "complete",
    failure: null,
    unverified_child_capture_failed: false,
    unverified_child_observations: [],
    process_runs: ["install", "smoke", "uninstall"].map((role, index) => ({
      role,
      status: "exit_observed",
      exit_code: 0,
      pid: index + 1,
      start_time: "retained fixture timestamp",
      exit_observation: "Observed through retained launch handle",
    })),
    details: {
      installer_sha256: installer.sha256,
      installed_executable_sha256: retained.sha256,
      expected_executable: {
        raw_sha256: raw.sha256,
        bundled_sha256: retained.sha256,
        bundle_slot_patched: true,
      },
      signature_status: "NotSigned",
      update_path: "explicit_bootstrap_destination",
      install_exit_code: 0,
      uninstall_exit_code: 0,
      registered_version: build.version,
      uninstall_registration_count: 1,
      application_responding: true,
      application_exit_code: 0,
      persistent_data_preserved: true,
      managed_files_removed: true,
      registration_removed: true,
      preservation_manifest_before_uninstall: { files: ["inert save"] },
      preservation_manifest_after_uninstall: { files: ["inert save"] },
    },
  };
  await save("build-result.json", build);
  await save("installer-evidence.json", receipt);
  return { output, build, receipt, retained, save };
}

void test("completed original inputs finalize through the real verifier; repeat is unchanged and spawns nothing", async () => {
  const f = await fixture();
  try {
    const original = await readFile(path.join(f.output, "installer-evidence.json"));
    const result = await finalizeRetainedPackage(f.output);
    assert.equal(result.execution_context, "retained-installed-bytes");
    assert.equal(result.executable.sha256, f.retained.sha256);
    const manifest = path.join(f.output, "ordinary-package-manifest.json");
    const before = await stat(manifest);
    assert.deepEqual(await finalizeRetainedPackage(f.output), result);
    assert.equal((await stat(manifest)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await readFile(path.join(f.output, "installer-evidence.json")), original);
    const probe = `
      import childProcess from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      childProcess.spawnSync=()=>{throw new Error('NO_PROCESS_ALLOWED')};
      childProcess.spawn=()=>{throw new Error('NO_PROCESS_ALLOWED')};
      childProcess.execFileSync=()=>{throw new Error('NO_PROCESS_ALLOWED')};
      syncBuiltinESMExports();
      const {finalizeRetainedPackage}=await import(${JSON.stringify(new URL("./retained-package.mts", import.meta.url).href)});
      await finalizeRetainedPackage(${JSON.stringify(f.output)});
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(child.status, 0, child.stderr);
  } finally {
    await rm(f.output, { recursive: true, force: true });
  }
});

void test("finalization refuses partial, changed and mismatched evidence without replacing originals", async () => {
  for (const mutation of [
    "partial",
    "nonzero",
    "bytes",
    "raw",
    "signature",
    "preservation",
    "process",
    "configuration",
    "features",
    "actual-command",
    "doctor",
    "missing",
    "logs",
  ] as const) {
    const f = await fixture();
    try {
      switch (mutation) {
        case "partial":
          f.receipt.phase = "candidate_verified";
          break;
        case "nonzero":
          f.build.process.status = 1;
          break;
        case "bytes":
          f.build.installer.bytes++;
          break;
        case "raw":
          f.receipt.details.expected_executable.raw_sha256 = "0".repeat(64);
          break;
        case "signature":
          f.receipt.details.signature_status = "Valid";
          break;
        case "preservation":
          f.receipt.details.preservation_manifest_after_uninstall.files = ["changed"];
          break;
        case "process":
          f.receipt.process_runs[0]!.status = "running";
          break;
        case "configuration":
          f.build.configuration.reverse();
          break;
        case "features":
          (f.build.qualification_features as string[]).push("qualification-fixtures");
          break;
        case "actual-command":
          f.build.actual_build.args.push("--features=qualification-fixtures");
          break;
        case "doctor":
          await f.save("native-doctor.json", { ok: false });
          break;
        case "missing":
          await rm(path.join(f.output, "retained-installed-portcove.exe"));
          break;
        case "logs":
          await writeFile(path.join(f.output, "build.stdout.log"), "changed log");
          break;
      }
      await f.save("build-result.json", f.build);
      await f.save("installer-evidence.json", f.receipt);
      const before = await readFile(path.join(f.output, "installer-evidence.json"));
      await assert.rejects(
        finalizeRetainedPackage(f.output),
        (error: unknown) => error instanceof Error,
        mutation,
      );
      assert.deepEqual(await readFile(path.join(f.output, "installer-evidence.json")), before);
    } finally {
      await rm(f.output, { recursive: true, force: true });
    }
  }
});

void test("ordinary environment removes case aliases and launcher rejects mixed modes before admission", () => {
  assert.deepEqual(
    ordinaryPackageEnvironment({
      Path: "retained",
      tauri_signing_private_key: "secret",
      TAURI_CONFIG: "override",
      Gh_Token: "secret",
      VITE_TEST: "override",
      CARGO_ENCODED_RUSTFLAGS: "override",
      PORTCOVE_QUALIFICATION: "override",
      CARGO_TARGET_DIR: "owned",
    }),
    { Path: "retained", CARGO_TARGET_DIR: "owned" },
  );
  for (const args of [
    ["--prepare-retained-package", "--finalize-retained-package", "--output", tmpdir()],
    ["--finalize-retained-package", "--output", "relative"],
    ["--prepare-retained-package", "--output", tmpdir(), "--app", "anything"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/desktop-test-cli.mts"), ...args],
      { encoding: "utf8", windowsHide: true },
    );
    assert.notEqual(result.status, 0);
    assert(!result.stderr.includes("[resource]"));
    assert(!result.stderr.includes("selenium"));
  }
});

void test("package output excludes custom Cargo targets in both directions", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "package-overlap-"));
  try {
    await assert.rejects(
      requireExternalPackageOutput(path.join(base, "target/evidence"), path.join(base, "target")),
    );
    await assert.rejects(requireExternalPackageOutput(base, path.join(base, "target")));
    await assert.rejects(
      requireExternalPackageOutput(path.join(base, "target"), path.join(base, "target")),
    );
    await requireExternalPackageOutput(path.join(base, "evidence"), path.join(base, "target"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

void test("finalizer independently derives zero, unique boundary-spanning and ambiguous bundle markers", async () => {
  for (const variant of ["none", "boundary", "duplicate", "unrelated"] as const) {
    const f = await fixture();
    try {
      const marker = "__TAURI_BUNDLE_TYPE_VAR_UNK";
      const raw =
        variant === "none"
          ? "no marker fixture"
          : "x".repeat(65530) + marker + (variant === "duplicate" ? marker : "tail");
      const bundled =
        variant === "none"
          ? raw
          : variant === "unrelated"
            ? "z".repeat(raw.length)
            : raw.replace(marker, "__TAURI_BUNDLE_TYPE_VAR_NSS");
      await writeFile(f.build.raw_executable.path, raw);
      await writeFile(f.retained.path, bundled);
      f.build.raw_executable = await fileIdentity(f.build.raw_executable.path);
      const retained = await fileIdentity(f.retained.path);
      f.receipt.details.expected_executable = {
        raw_sha256: f.build.raw_executable.sha256,
        bundled_sha256: retained.sha256,
        bundle_slot_patched: variant !== "none",
      };
      f.receipt.details.installed_executable_sha256 = retained.sha256;
      await f.save("build-result.json", f.build);
      await f.save("installer-evidence.json", f.receipt);
      if (variant === "duplicate" || variant === "unrelated")
        await assert.rejects(finalizeRetainedPackage(f.output));
      else {
        assert.deepEqual(
          await expectedBundledIdentity(f.build.raw_executable.path),
          f.receipt.details.expected_executable,
        );
        assert.equal((await finalizeRetainedPackage(f.output)).executable.sha256, retained.sha256);
      }
    } finally {
      await rm(f.output, { recursive: true, force: true });
    }
  }
});

void test("existing conflicting derived output is bounded and preserved", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.output, "ordinary-package-manifest.json");
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
    const before = await fileIdentity(file);
    await assert.rejects(finalizeRetainedPackage(f.output), /Conflicting derived/);
    assert.deepEqual(await fileIdentity(file), before);
  } finally {
    await rm(f.output, { recursive: true, force: true });
  }
});
