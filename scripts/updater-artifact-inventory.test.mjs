import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactName,
  loadPackagePolicy,
  packagesForPlatform,
  releaseLabels,
} from "./release-package-policy.mjs";
import {
  stageUpdaterInventory,
  updaterIdentity,
  verifyUpdaterInventory,
} from "./updater-artifact-inventory.mjs";

const policy = await loadPackagePolicy();
const version = "0.3.0";
const revision = "a".repeat(40);

async function fixture(t, label = "windows-x86_64") {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-updater-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release"));
  await writeFile(path.join(root, "release/package-policy.json"), JSON.stringify(policy));
  await writeFile(path.join(root, "Cargo.toml"), `[workspace.package]\nversion = "${version}"\n`);
  for (const entry of packagesForPlatform(policy, label)) {
    const directory =
      entry.interface === "cli" ? "release-assets" : `target/release/bundle/${entry.format}`;
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(
      path.join(root, directory, artifactName(entry, version)),
      `${entry.id} final bytes`,
    );
  }
  const identity = updaterIdentity(policy, label, version);
  const bundle = path.join(root, "target/release/bundle", identity.bundle_directory);
  await mkdir(bundle, { recursive: true });
  const source = path.join(bundle, identity.source_filename);
  if (identity.format === "app.tar.gz") await writeFile(source, "mac final archive");
  await writeFile(`${source}.sig`, "signature fixture");
  const publicKey = path.join(root, "test-public.key");
  await writeFile(publicKey, "public key fixture");
  let verified = 0;
  const options = {
    projectRoot: root,
    label,
    revision,
    publicKey,
    output: path.join(root, "staged"),
    input: path.join(root, "staged"),
    // This seam tests inventory ownership only; Rust tests and native rehearsal
    // exercise the real Minisign implementation, including wrong-key signatures.
    verifySignature: async (_verifier, artifact, signature, key, expected) => {
      assert.equal((await readFile(artifact)).length, expected.bytes);
      assert.equal(await readFile(signature, "utf8"), "signature fixture");
      verified += 1;
      return createHash("sha256")
        .update(await readFile(key))
        .digest("hex");
    },
  };
  return { root, source, identity, options, verified: () => verified };
}

for (const label of releaseLabels(policy)) {
  test(`stages and independently rechecks all required ${label} packages`, async (t) => {
    const f = await fixture(t, label);
    const staged = await stageUpdaterInventory(f.options);
    assert.deepEqual(await verifyUpdaterInventory(f.options), staged);
    assert.equal(f.verified(), 2);
    assert.equal(staged.packages.length, packagesForPlatform(policy, label).length);
    assert.equal(staged.updater.target, label.replace("macos", "darwin"));
    await assert.rejects(stageUpdaterInventory(f.options), /EEXIST/);
  });
}

test("missing signatures and failed verification never produce successful evidence", async (t) => {
  const f = await fixture(t);
  await rm(`${f.source}.sig`);
  await assert.rejects(stageUpdaterInventory(f.options), /ENOENT/);
  await writeFile(`${f.source}.sig`, "signature fixture");
  f.options.verifySignature = async () => {
    throw new Error("wrong signing key");
  };
  await assert.rejects(stageUpdaterInventory(f.options), /wrong signing key/);
  await assert.rejects(readFile(path.join(f.options.output, "updater-inventory.json")), /ENOENT/);
});

test("changing any final package or the public key invalidates recorded evidence", async (t) => {
  const f = await fixture(t);
  const inventory = await stageUpdaterInventory(f.options);
  const cli = inventory.packages.find((entry) => entry.id.startsWith("cli-"));
  const file = path.join(f.options.output, cli.filename);
  const original = await readFile(file);
  await writeFile(file, "changed companion");
  await assert.rejects(verifyUpdaterInventory(f.options), /checksum mismatch/);
  await writeFile(file, original);
  await writeFile(f.options.publicKey, "substituted key");
  await assert.rejects(verifyUpdaterInventory(f.options), /public key mismatch/);
});

test("rejects duplicate packages, wrong target/version/revision and extra assets", async (t) => {
  const f = await fixture(t);
  const inventory = await stageUpdaterInventory(f.options);
  const manifest = path.join(f.options.output, "updater-inventory.json");
  const mutations = [
    (data) => data.packages.push(data.packages[0]),
    (data) => {
      data.updater.target = "darwin-aarch64";
    },
    (data) => {
      data.version = "0.2.0";
    },
    (data) => {
      data.source_commit = "b".repeat(40);
    },
    (data) => {
      data.packages[0].filename = "../outside";
    },
    (data) => {
      data.updater.signature.filename = "other.sig";
    },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(inventory);
    mutate(data);
    await writeFile(manifest, JSON.stringify(data));
    await assert.rejects(verifyUpdaterInventory(f.options), /mismatch|duplicate/);
  }
  await writeFile(manifest, JSON.stringify(inventory));
  await copyFile(f.source, path.join(f.options.output, "unexpected.exe"));
  await assert.rejects(verifyUpdaterInventory(f.options), /staged files mismatch/);
});

test("rejects overlapping staging paths and version override inheritance", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    stageUpdaterInventory({
      ...f.options,
      output: path.join(f.root, "target/release/bundle/new"),
    }),
    /overlap/,
  );
  await stageUpdaterInventory(f.options);
  await assert.rejects(
    verifyUpdaterInventory({ ...f.options, version: "0.1.0" }),
    /identity mismatch/,
  );
  await assert.rejects(
    verifyUpdaterInventory({ ...f.options, revision: "HEAD" }),
    /exact source commit/,
  );
});

test("release-only overlay preserves ordinary secret-free builds and updater package baseline", async () => {
  const base = JSON.parse(
    await readFile(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url)),
  );
  const overlay = JSON.parse(
    await readFile(new URL("../release/tauri.updater.conf.json", import.meta.url)),
  );
  assert.equal(base.bundle.createUpdaterArtifacts, false);
  assert.equal(overlay.bundle.createUpdaterArtifacts, true);
  assert.equal(overlay.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(overlay.bundle.macOS.signingIdentity, "-");
  assert.equal(overlay.plugins.updater.windows.installMode, "passive");
  assert.equal(overlay.identifier, undefined);
  assert.equal(overlay.plugins.updater.endpoints, undefined);
  assert.equal(overlay.plugins.updater.pubkey, undefined);
});

test("manual rehearsal retains the complete matrix without production credentials or publication", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|contents: write|actions: write|gh release|pull_request_target/,
  );
  assert.match(workflow, /default: all/);
  assert.match(workflow, /transition_profile:/);
  assert.match(workflow, /default: legacy-skipped/);
  assert.match(workflow, /options: \[legacy-skipped, preview-final\]/);
  assert.match(workflow, /-TransitionProfile '\$\{\{ inputs\.transition_profile \}\}'/);
  const matrix = JSON.parse(workflow.match(/label:.*fromJSON\('([^']+)'\)/)[1]);
  assert.deepEqual(matrix.all.toSorted(), releaseLabels(policy).toSorted());
  for (const label of releaseLabels(policy)) assert.deepEqual(matrix[label], [label]);
  assert.match(workflow, /retention-days: 1/);
  assert.doesNotMatch(workflow, /updater-rehearsal\/\*\*|\.key\b/);
  assert.match(workflow, /linux-appimage-qualification\/application-update-evidence\.json/);
  assert.match(workflow, /state\/update-state\/\*\.json/);
  assert.match(workflow, /state\/library\/logs\/portcove-desktop\.jsonl\*/);
  assert.doesNotMatch(workflow, /linux-appimage-qualification\/(?:private|state)\/\*\*/);
  const lifecycle = await readFile(
    new URL("./test-windows-installer.ps1", import.meta.url),
    "utf8",
  );
  assert.match(lifecycle, /\$InstallMode -eq "Passive".*"\/P"/);
  assert.match(lifecycle, /\$predecessor.*"\/UPDATE"/);
  assert.doesNotMatch(lifecycle, /@\(\$installFlag, "\/D=\$installRoot"\).*candidate_installer/);
  assert.match(lifecycle, /DisplayVersion -ne \$ExpectedVersion/);
  assert.match(lifecycle, /HKEY_CURRENT_USER/);
  const rehearsal = await readFile(
    new URL("./rehearse-updater-artifacts.ps1", import.meta.url),
    "utf8",
  );
  // A DMG-only Tauri build creates the bootstrap disk image but does not return
  // an app bundle target for updater archive/signature generation.
  assert.match(rehearsal, /else \{ "app,dmg" \}/);
  assert.match(rehearsal, /test-linux-appimage-update\.ps1/);
  assert.match(rehearsal, /ValidateSet\("legacy-skipped", "preview-final"\)/);
  assert.match(rehearsal, /"1\.0\.0-rc\.2"/);
  assert.match(rehearsal, /"1\.0\.0"/);
  assert.match(rehearsal, /-PredecessorVersion/);
  assert.match(rehearsal, /-CandidateVersion/);
  assert.match(rehearsal, /application-update-qualification/);
  assert.match(rehearsal, /Remove-Item -LiteralPath \(Join-Path \$fixtureRoot "private"\)/);
  const linuxHarness = await readFile(
    new URL("./test-linux-appimage-update.ps1", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(linuxHarness, /WEBKIT_DISABLE_COMPOSITING_MODE/);
  assert.match(linuxHarness, /PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE/);
  assert.match(linuxHarness, /PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT/);
  assert.match(linuxHarness, /schema_version = 11/);
  assert.match(linuxHarness, /\$PredecessorVersion = "0\.1\.0"/);
  assert.match(linuxHarness, /\$CandidateVersion = "0\.3\.0"/);
  assert.match(linuxHarness, /truncated_payload_expected_bytes/);
  assert.match(linuxHarness, /truncated_payload_bytes/);
  assert.match(linuxHarness, /truncated_payload_exit_code/);
  assert.match(linuxHarness, /truncated_payload_rejected/);
  assert.match(linuxHarness, /truncated_payload_stable_preserved/);
  assert.match(linuxHarness, /truncated_payload_staging_empty/);
  assert.match(linuxHarness, /truncated_payload_data_preserved/);
  assert.match(linuxHarness, /\/usr\/bin\/truncate --size=-1/);
  assert.match(linuxHarness, /payload length mismatch/);
  assert.ok(
    linuxHarness.indexOf("truncated-payload-preparing") <
      linuxHarness.indexOf("truncated-payload-rejected") &&
      linuxHarness.indexOf("truncated-payload-rejected") <
        linuxHarness.indexOf('Write-Evidence "prepared"'),
    "truncated payload rejection must precede successful staging and replacement",
  );
  assert.match(linuxHarness, /interruption_exit_code/);
  assert.match(linuxHarness, /interruption_recovery_exit_code/);
  assert.match(linuxHarness, /interruption_recovery_display/);
  assert.match(linuxHarness, /interruption_recovered/);
  assert.match(linuxHarness, /incompatible_schema_version = 99/);
  assert.match(linuxHarness, /incompatible_schema_supported_version/);
  assert.match(linuxHarness, /incompatible_schema_exit_code/);
  assert.match(linuxHarness, /incompatible_schema_predecessor_restart_observed/);
  assert.match(linuxHarness, /incompatible_schema_state_preserved/);
  assert.match(linuxHarness, /read_only_state_enforced/);
  assert.match(linuxHarness, /read_only_state_exit_code/);
  assert.match(linuxHarness, /read_only_state_predecessor_restart_observed/);
  assert.match(linuxHarness, /read_only_state_preserved/);
  assert.match(linuxHarness, /read_only_state_write_restored/);
  assert.match(linuxHarness, /full_disk_state_enforced/);
  assert.match(linuxHarness, /full_disk_state_available_bytes/);
  assert.match(linuxHarness, /full_disk_state_exit_code/);
  assert.match(linuxHarness, /full_disk_state_predecessor_restart_observed/);
  assert.match(linuxHarness, /full_disk_state_preserved/);
  assert.match(linuxHarness, /full_disk_state_write_restored/);
  assert.match(linuxHarness, /full_appimage_filesystem_enforced/);
  assert.match(linuxHarness, /full_appimage_filesystem_available_bytes/);
  assert.match(linuxHarness, /full_appimage_filesystem_exit_code/);
  assert.match(linuxHarness, /full_appimage_filesystem_predecessor_restart_observed/);
  assert.match(linuxHarness, /full_appimage_filesystem_stable_preserved/);
  assert.match(linuxHarness, /full_appimage_filesystem_staging_preserved/);
  assert.match(linuxHarness, /full_appimage_filesystem_failed_revision/);
  assert.match(linuxHarness, /full_appimage_filesystem_retry_revision/);
  assert.match(linuxHarness, /full_appimage_filesystem_retryable_journal/);
  assert.match(linuxHarness, /full_appimage_filesystem_write_restored/);
  assert.match(linuxHarness, /fullAppImageStableModeAfter -ne \$fullAppImageStableMode/);
  assert.match(linuxHarness, /\$applyPath -Algorithm SHA256\)\.Hash -ne \$readOnlyApplyHash/);
  assert.match(linuxHarness, /native_replacement\.source_path -ne \$fullAppImageStable/);
  assert.match(linuxHarness, /native_replacement\.backup_path -ne \$fullAppImageSwap/);
  assert.match(linuxHarness, /fullAppImageRetryApply\.native_launch/);
  assert.match(linuxHarness, /appImageRetryEntryChanges\.Count -ne 0/);
  assert.match(linuxHarness, /runtime_contention_helper_blocked/);
  assert.match(linuxHarness, /runtime_contention_stable_preserved/);
  assert.match(linuxHarness, /runtime_contention_journal_preserved/);
  assert.match(linuxHarness, /post_exchange_exit_code/);
  assert.match(linuxHarness, /post_exchange_backup_preserved/);
  assert.match(linuxHarness, /post_exchange_reconciled/);
  assert.match(linuxHarness, /-ne 86/);
  assert.match(linuxHarness, /-ne 87/);
  assert.match(linuxHarness, /after-exchange-sync/);
  assert.match(linuxHarness, /--application-update-recovery recover interrupted-appimage/);
  assert.match(linuxHarness, /Remove-Item Env:DISPLAY/);
  assert.match(linuxHarness, /flock --shared 9/);
  assert.match(linuxHarness, /flock --exclusive --nonblock/);
  assert.match(linuxHarness, /chmod --recursive u-w/);
  assert.match(linuxHarness, /chmod \$entry\.Mode -- \$entry\.Path/);
  assert.match(linuxHarness, /restoredMode -ne \$entry\.Mode/);
  assert.match(linuxHarness, /\/usr\/bin\/mount -t tmpfs/);
  assert.match(linuxHarness, /\/usr\/bin\/dd if=\/dev\/zero/);
  assert.match(linuxHarness, /availableBytes -ne 0/);
  assert.match(linuxHarness, /\/usr\/bin\/umount -- \$Path/);
  assert.match(linuxHarness, /Mount-BoundedTmpfs/);
  assert.match(linuxHarness, /Set-BoundedFilesystemFull/);
  assert.match(linuxHarness, /Restore-BoundedFilesystemWrites/);
  assert.match(linuxHarness, /Dismount-BoundedTmpfs/);
  assert.match(linuxHarness, /\.ArgumentList\.Add\(\$argument\)/);
  assert.ok(
    linuxHarness.indexOf("incompatible-schema-preserved") <
      linuxHarness.indexOf("read-only-state-starting") &&
      linuxHarness.indexOf("read-only-state-starting") <
        linuxHarness.indexOf("read-only-state-preserved") &&
      linuxHarness.indexOf("read-only-state-preserved") <
        linuxHarness.indexOf("read-only-state-recovered") &&
      linuxHarness.indexOf("read-only-state-recovered") <
        linuxHarness.indexOf("full-disk-state-starting") &&
      linuxHarness.indexOf("full-disk-state-starting") <
        linuxHarness.indexOf("full-disk-state-preserved") &&
      linuxHarness.indexOf("full-disk-state-preserved") <
        linuxHarness.indexOf("full-disk-state-recovered") &&
      linuxHarness.indexOf("full-disk-state-recovered") <
        linuxHarness.indexOf("full-appimage-filesystem-starting") &&
      linuxHarness.indexOf("full-appimage-filesystem-starting") <
        linuxHarness.indexOf("full-appimage-filesystem-preserved") &&
      linuxHarness.indexOf("full-appimage-filesystem-preserved") <
        linuxHarness.indexOf("full-appimage-filesystem-retryable") &&
      linuxHarness.indexOf("full-appimage-filesystem-retryable") <
        linuxHarness.indexOf("full-appimage-filesystem-recovered") &&
      linuxHarness.indexOf("full-appimage-filesystem-recovered") <
        linuxHarness.indexOf("runtime-contention-starting"),
    "read-only, full-state, and full-AppImage filesystems must fail closed before runtime contention and replacement",
  );
  assert.ok(
    linuxHarness.indexOf("incompatible-schema-starting") <
      linuxHarness.indexOf("incompatible-schema-preserved") &&
      linuxHarness.indexOf("incompatible-schema-preserved") <
        linuxHarness.indexOf("runtime-contention-starting"),
    "future apply schemas must fail closed before runtime contention and replacement",
  );
  assert.ok(
    linuxHarness.indexOf("command-recovery-starting") <
      linuxHarness.indexOf('Start-Process -FilePath "Xvfb"'),
    "interrupted AppImage recovery must complete before any GUI session starts",
  );
  assert.ok(
    linuxHarness.indexOf("$updateHelperStart.FileName = $stable") <
      linuxHarness.indexOf("runtime-contention-observed") &&
      linuxHarness.indexOf("runtime-contention-observed") <
        linuxHarness.indexOf("post-exchange-interrupted"),
    "a live runtime peer must block the packaged helper before replacement",
  );
  assert.ok(
    linuxHarness.indexOf(
      'PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_INTERRUPT = "after-exchange-sync"',
    ) < linuxHarness.indexOf("candidate-restart-complete"),
    "post-exchange interruption must precede candidate startup reconciliation",
  );
  const linuxAdapter = await readFile(
    new URL("../apps/desktop/src-tauri/src/application_update_linux.rs", import.meta.url),
    "utf8",
  );
  const launch = linuxAdapter.slice(
    linuxAdapter.indexOf("impl LinuxAppImageUpdateAdmission"),
    linuxAdapter.indexOf("/// Adds direct, user-owned AppImage replacement authority"),
  );
  assert.ok(
    launch.indexOf("sync_parent(&plan.source)") <
      launch.indexOf("interrupt_qualification_after_exchange_sync()") &&
      launch.indexOf("interrupt_qualification_after_exchange_sync()") <
        launch.indexOf("launch.record_succeeded()"),
    "post-exchange interruption must follow directory sync and precede journal success",
  );
  assert.match(linuxAdapter, /feature = "application-update-qualification"/);
  assert.match(linuxAdapter, /Some\(std::ffi::OsStr::new\("after-exchange-sync"\)\)/);
  assert.match(linuxAdapter, /std::process::exit\(87\)/);
  assert.match(rehearsal, /Invoke-Checked "dbus-run-session"/);
});
