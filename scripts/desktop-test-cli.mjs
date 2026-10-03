import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { readToolPins } from "./tool-cache.mjs";

const args = process.argv.slice(2);
if (args.includes("--current-installed") || args.includes("--verify-installed-admission")) {
  assert.equal(process.platform, "win32", "Current-installed NSIS boundary requires Windows");
  const { values } = parseArgs({
    options: {
      "current-installed": { type: "boolean" },
      "verify-installed-admission": { type: "string" },
      installer: { type: "string" },
      "package-evidence": { type: "string" },
      "expected-app": { type: "string" },
      "expected-version": { type: "string" },
      "test-base": { type: "string" },
      evidence: { type: "string" },
    },
  });
  assert.ok(Boolean(values["current-installed"]) !== Boolean(values["verify-installed-admission"]));
  for (const name of ["installer", "package-evidence", "expected-app"])
    assert.ok(values[name] && path.isAbsolute(values[name]), `--${name} requires an absolute path`);
  const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const { acquireNativeSessionLock, isProcessAlive } = await import("./native-session-lock.mjs");
  const { fileIdentity } = await import("./development-evidence.mjs");
  const { spawnCommand } = await import("./dev-storage.mjs");
  if (values["verify-installed-admission"])
    assert.ok(
      process.env.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN,
      "Current-installed boundary requires inherited native admission",
    );
  const lock = await acquireNativeSessionLock({
    workspace: root,
    scenarios: ["native-normal-package-webview-boundary"],
  });
  try {
    assert.ok(isProcessAlive(lock.owner.pid), "Native admission owner must still be running");
    const bindings = {
      installer: await fileIdentity(values.installer),
      manifest: await fileIdentity(values["package-evidence"]),
      expected_executable: await fileIdentity(values["expected-app"]),
    };
    if (values["verify-installed-admission"]) {
      const admission = JSON.parse(await readFile(values["verify-installed-admission"], "utf8"));
      assert.equal(lock.inherited, true);
      assert.equal(admission.owner_pid, lock.owner.pid);
      assert.equal(admission.owner_created_at, lock.owner.created_at);
      assert.equal(admission.workspace, root);
      assert.deepEqual(admission.bindings, bindings);
      assert.equal(admission.doctor_ok, true);
    } else {
      for (const name of ["test-base", "evidence"])
        assert.ok(
          values[name] && path.isAbsolute(values[name]),
          `--${name} requires an absolute path`,
        );
      assert.ok(values["expected-version"], "--expected-version is required");
      createRequire(path.join(root, "apps", "desktop", "package.json")).resolve(
        "selenium-webdriver",
      );
      const { collectDoctor } = await import("./dev-doctor.mjs");
      const doctor = await collectDoctor({ profile: "desktop" });
      await writeFile(`${values.evidence}.native-doctor.json`, JSON.stringify(doctor, null, 2), {
        flag: "wx",
      });
      assert.equal(
        doctor.ok,
        true,
        "Desktop doctor failed before installation; use the existing bootstrap remedy",
      );
      const admissionPath = `${values.evidence}.native-admission.json`;
      await writeFile(
        admissionPath,
        JSON.stringify(
          {
            owner_pid: lock.owner.pid,
            owner_created_at: lock.owner.created_at,
            workspace: root,
            bindings,
            doctor_ok: doctor.ok,
            doctor,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      const result = spawnCommand(
        "pwsh.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-File",
          path.join(root, "scripts", "test-windows-installer.ps1"),
          "-InstallerPath",
          values.installer,
          "-NormalPackageManifestPath",
          values["package-evidence"],
          "-NormalPackageAdmissionPath",
          admissionPath,
          "-ExpectedExecutablePath",
          values["expected-app"],
          "-ExpectedVersion",
          values["expected-version"],
          "-TestBase",
          values["test-base"],
          "-EvidencePath",
          values.evidence,
        ],
        {
          cwd: root,
          stdio: "inherit",
          windowsHide: true,
          env: { ...process.env, PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: lock.owner.token },
        },
      );
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } finally {
    await lock.release();
  }
} else if (args.includes("--help")) {
  console.log(
    "usage: just desktop-test --app ABSOLUTE --output ABSOLUTE [--driver ABSOLUTE] [--native-driver ABSOLUTE] [options]",
  );
  console.log("Cached drivers are used when --driver and --native-driver are omitted.");
  console.log("Select with --profile PROFILE or repeat --scenario ID for an exact series.");
  console.log(
    "Current-installed NSIS: --current-installed --installer ABS --package-evidence ABS --expected-app ABS --expected-version VERSION --test-base ABS --evidence ABS",
  );
  console.log(
    "Legacy focused modes remain: --accessibility-only, --artwork-only, --adoption-only.",
  );
} else {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    createRequire(path.join(root, "apps", "desktop", "package.json")).resolve("selenium-webdriver");
  } catch {
    throw new Error(
      `selenium-webdriver is unavailable; run node scripts/dev-storage.mjs run -- corepack ${readToolPins().packageManager} install --frozen-lockfile`,
    );
  }
  await import("../apps/desktop/scripts/desktop-test.mjs");
}
