import type { FileIdentity } from "./development-evidence.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import { resourceEntrypoint } from "./resource-command.mts";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
async function executeDesktopTest() {
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
    assert.ok(
      Boolean(values["current-installed"]) !== Boolean(values["verify-installed-admission"]),
    );
    assertAbsoluteArguments(values, ["installer", "package-evidence", "expected-app"] as const);
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const { acquireNativeSessionLock, isProcessAlive } = await import("./native-session-lock.mts");
    const { fileIdentity } = await import("./development-evidence.mts");
    const { spawnCommand } = await import("./dev-storage.mts");
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
        const admission: unknown = JSON.parse(
          await readFile(values["verify-installed-admission"], "utf8"),
        );
        assert.ok(isRecord(admission));
        assert.equal(lock.inherited, true);
        assert.equal(admission.owner_pid, lock.owner.pid);
        assert.equal(admission.owner_created_at, lock.owner.created_at);
        assert.equal(admission.workspace, root);
        assert.deepEqual(admission.bindings, bindings);
        assert.equal(admission.doctor_ok, true);
      } else {
        assertAbsoluteArguments(values, ["test-base", "evidence"] as const);
        assert.ok(values["expected-version"], "--expected-version is required");
        createRequire(path.join(root, "apps", "desktop", "package.json")).resolve(
          "selenium-webdriver",
        );
        const { collectDoctor } = await import("./dev-doctor.mts");
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
    console.log(
      "Ordinary retained NSIS: --prepare-retained-package --output ABS_NEW_EXTERNAL_DIRECTORY",
    );
    console.log("File-only recovery: --finalize-retained-package --output ABS_COMPLETED_DIRECTORY");
    console.log("Select with --profile PROFILE or repeat --scenario ID for an exact series.");
    console.log(
      "Picori only: --scenario native-game-first-installed-picori --preparation-cli ABS --game-first-inputs ABS --game-first-source ABS --game-first-runtime ABS --game-first-shapes ABS --game-first-logic ABS --game-first-archive ABS",
    );
    console.log(
      "Current-installed NSIS: --current-installed --installer ABS --package-evidence ABS --expected-app ABS --expected-version VERSION --test-base ABS --evidence ABS",
    );
    console.log(
      "Legacy focused modes remain: --accessibility-only, --artwork-only, --adoption-only.",
    );
  } else {
    try {
      const root = fileURLToPath(new URL("..", import.meta.url));
      createRequire(path.join(root, "apps", "desktop", "package.json")).resolve(
        "selenium-webdriver",
      );
    } catch {
      throw new Error(
        `selenium-webdriver is unavailable; run node scripts/dev-storage.mts run -- pnpm install --frozen-lockfile`,
      );
    }
    if (!["win32", "linux"].includes(process.platform)) {
      await import("../apps/desktop/scripts/desktop-test.mts");
    } else {
      const root = fileURLToPath(new URL("..", import.meta.url));
      const { parseDesktopHarnessOptions, resolveDesktopHarnessSelection, planDesktopExecution } =
        await import("./desktop-execution-plan.mts");
      const { cachedDesktopDrivers } = await import("./tool-cache.mts");
      const { getPaths } = await import("./dev-storage.mts");
      const { retainedEvidenceRoot, ensureRetainedEvidenceStore, retainedExecutableCanLaunch } =
        await import("./retained-evidence.mts");
      const { captureDesktopReceiptInputs } = await import("./native-helper-dependencies.mts");
      const { acquireNativeSessionLock } = await import("./native-session-lock.mts");
      const {
        values,
      }: {
        values: ReturnType<typeof parseDesktopHarnessOptions>["values"] &
          Record<string, string | boolean | string[] | undefined>;
      } = parseDesktopHarnessOptions(args);
      const drivers = cachedDesktopDrivers();
      if (values.driver === undefined && drivers) values.driver = drivers.driver;
      if (values["native-driver"] === undefined && drivers)
        values["native-driver"] = drivers.nativeDriver;
      for (const name of ["app", "output", "driver", "native-driver"] as const)
        if (!values[name] || !path.isAbsolute(values[name]))
          throw new Error(`--${name} requires an absolute path or verified cached driver`);
      assert.ok(typeof values.app === "string");
      const selection = resolveDesktopHarnessSelection(values);
      const { desktopHarnessDeadlineMs } = await import("./desktop-scenarios.mts");
      const lock = await acquireNativeSessionLock({
        workspace: root,
        profile: selection.profile,
        scenarios: selection.selected_scenarios,
      });
      const inherited = process.env.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN;
      const executionStarted = new Date();
      const captureSignal = AbortSignal.timeout(desktopHarnessDeadlineMs(selection));
      const manifestEnv = process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST;
      let captureOutput = null;
      let harnessRequested = false;
      try {
        const revisionResult = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
        });
        const revision = revisionResult.stdout.trim();
        if (revisionResult.status !== 0 || !/^[a-f0-9]{40}$/u.test(revision))
          throw new Error("Prelaunch source revision unavailable");
        const store = retainedEvidenceRoot(getPaths("tooling").output_root);
        await ensureRetainedEvidenceStore(store);
        captureOutput = path.join(store, "observations", randomUUID());
        await mkdir(captureOutput, { recursive: true, mode: 0o700 });
        const metadataOriginal = values["run-metadata"];
        const metadataBytes = metadataOriginal ? await readFile(metadataOriginal) : null;
        const metadata: unknown = metadataBytes ? JSON.parse(metadataBytes.toString("utf8")) : null;
        const retainedMetadata =
          isRecord(metadata) &&
          metadata.evidence_input_class === "non-secret-verification-metadata";
        const plan = planDesktopExecution(selection, { prelaunchCustody: true, retainedMetadata });
        if (retainedMetadata) {
          const inspect = (value: unknown): void => {
            if (isRecord(value) || Array.isArray(value)) {
              const entries: Record<string, unknown> | unknown[] = value;
              for (const [key, child] of Object.entries(entries)) {
                if (
                  /(?:^|_)(?:token|password|secret|cookie|credentials|private_key|authorization|xauthority)(?:$|_)/iu.test(
                    key,
                  )
                )
                  throw new Error(
                    "Declared verification metadata contains authentication/secret fields; refuse capture without redaction",
                  );
                inspect(child);
              }
            }
          };
          inspect(metadata);
          // Consume exactly the validated read, not a later reread of a mutable
          // original. Preserve its exact byte identity rather than redacting it.
          values["run-metadata"] = path.join(captureOutput, "declared-metadata-input.json");
          assert.ok(metadataBytes);
          await writeFile(values["run-metadata"], metadataBytes, { flag: "wx", mode: 0o600 });
        }
        const capturedInputs = await captureDesktopReceiptInputs({
          root,
          values: { ...values, app: values.app },
          plan,
          output: captureOutput,
          revision,
          retainedRoot: store,
          signal: captureSignal,
        });
        const inputs = capturedInputs.map((input) => {
          assert.ok(
            "retained" in input && "binding" in input && "kind" in input && "role" in input,
            "Prelaunch capture requires retained custody",
          );
          const record: typeof input & {
            original_read_observation?: FileIdentity;
            consumption_phase?: string;
          } = input;
          return record;
        });
        captureSignal.throwIfAborted();
        for (const input of inputs) {
          if (input.kind === "argument-file") {
            assert.ok(typeof metadataOriginal === "string" && metadataBytes);
            input.binding = "retained-metadata-read";
            input.original_read_observation = {
              path: path.resolve(metadataOriginal),
              bytes: metadataBytes.length,
              sha256: createHash("sha256").update(metadataBytes).digest("hex"),
            };
          }
          if (input.binding === "retained-artifact" && !retainedExecutableCanLaunch(input, drivers))
            input.binding = "live-path-checked-cooperative";
          input.consumption_phase =
            input.binding === "retained-artifact"
              ? "retained-artifact-launch"
              : input.role.startsWith("scripts/")
                ? "trusted-verifier-observation"
                : "before-target-import";
        }
        await importCapturedDesktop(
          {
            inputs,
            values,
            captureOutput,
            revision,
            root,
            selection,
            retainedMetadata,
            executionStarted,
            captureSignal,
            lockToken: lock.owner.token,
          },
          async () => {
            harnessRequested = true;
            await import("../apps/desktop/scripts/desktop-test.mts");
          },
        );
      } catch (error) {
        if (captureOutput) {
          try {
            await writeFile(
              path.join(captureOutput, "execution-failure.json"),
              JSON.stringify({
                captured_at: new Date().toISOString(),
                phase: harnessRequested ? "harness-requested" : "prelaunch",
                outcome: "failed",
                message: errorMessage(error),
                native_acceptance: "not-inferred",
              }),
              { flag: "wx", mode: 0o600 },
            );
          } catch {
            /* Preserve the original failure and already retained inputs. */
          }
        }
        throw error;
      } finally {
        if (inherited === undefined) delete process.env.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN;
        else process.env.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN = inherited;
        if (manifestEnv === undefined) delete process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST;
        else process.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST = manifestEnv;
        await lock.release();
      }
    }
  }

  return Number(process.exitCode ?? 0);
}
async function executeRetainedPackageCommand() {
  try {
    const { values } = parseArgs({
      args,
      options: {
        "prepare-retained-package": { type: "boolean" },
        "finalize-retained-package": { type: "boolean" },
        output: { type: "string" },
      },
    });
    assert.ok(
      Boolean(values["prepare-retained-package"]) !== Boolean(values["finalize-retained-package"]),
      "Select exactly one retained package mode",
    );
    assertAbsoluteArguments(values, ["output"] as const);
    const { prepareRetainedPackage, finalizeRetainedPackage } =
      await import("./retained-package.mts");
    const result = values["prepare-retained-package"]
      ? await prepareRetainedPackage(values.output)
      : await finalizeRetainedPackage(values.output);
    console.log(
      JSON.stringify({
        manifest: result.manifest.path,
        executable: result.executable.path,
        revision: result.revision,
        execution_context: result.execution_context,
      }),
    );
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
}

/** Finish captured-input preparation and reverify immediately before consuming target code. */
export async function importCapturedDesktop(
  {
    inputs,
    values,
    captureOutput,
    revision,
    root,
    selection,
    retainedMetadata,
    executionStarted,
    captureSignal,
    lockToken,
  }: {
    inputs: (import("./retained-evidence.mts").ConsumedInput & { role: string })[];
    values: Record<string, string | boolean | string[] | undefined>;
    captureOutput: string;
    revision: string;
    root: string;
    selection: { selected_scenarios: readonly string[] };
    retainedMetadata: boolean;
    executionStarted: Date;
    captureSignal: AbortSignal;
    lockToken: string;
  },
  importTarget: () => Promise<unknown>,
  {
    write = writeFile,
    runtime = process,
  }: {
    write?: typeof writeFile;
    runtime?: Pick<NodeJS.Process, "argv" | "env">;
  } = {},
): Promise<void> {
  const { verifyConsumedInputs } = await import("./retained-evidence.mts");
  for (const input of inputs.filter((input) =>
    ["retained-artifact", "retained-metadata-read"].includes(input.binding),
  ))
    values[input.role] = input.retained.path;
  const manifest = path.join(captureOutput, "prelaunch.json");
  await write(
    manifest,
    JSON.stringify({
      format_version: 1,
      revision,
      root,
      selected_scenarios: selection.selected_scenarios,
      inputs,
      retained_metadata: retainedMetadata,
      pre_import_for: "apps/desktop/scripts/desktop-test.mts",
      created_at: new Date().toISOString(),
      execution_started_at: executionStarted.toISOString(),
      limitations: [
        "Source helpers use cooperative live-path verification before import and after execution; retained copies alone do not prove loaded bytes",
        "The trusted launcher/verifier is reviewed separately; this record grants no execution or merge authority",
        "Path-sensitive or unestablished executable layouts use checked original paths; retained copies do not establish immutable consumption for those paths",
      ],
    }),
    { flag: "wx", mode: 0o600 },
  );
  assert.ok(runtime.argv[0] && runtime.argv[1]);
  runtime.argv = [
    runtime.argv[0],
    runtime.argv[1],
    ...Object.entries(values).flatMap(([name, value]) =>
      Array.isArray(value)
        ? value.flatMap((entry) => [`--${name}`, entry])
        : typeof value === "boolean"
          ? value
            ? [`--${name}`]
            : []
          : value === undefined
            ? []
            : [`--${name}`, String(value)],
    ),
  ];
  runtime.env.PORTCOVE_NATIVE_SESSION_LOCK_TOKEN = lockToken;
  runtime.env.PORTCOVE_NATIVE_PRELAUNCH_MANIFEST = manifest;
  // Remapping arguments and writing the manifest consume no target bytes.
  // One full verification here covers that preparation before target import.
  await verifyConsumedInputs(inputs, { signal: captureSignal });
  captureSignal.throwIfAborted();
  await importTarget();
}

// Preparation owns separate build and native phases; finalization is file-only.
// Neither may inherit the normal launcher's blanket browser admission.
const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invoked !== null && invoked === (await realpath(fileURLToPath(import.meta.url)))) {
  process.exitCode = args.includes("--help")
    ? await executeDesktopTest()
    : args.includes("--prepare-retained-package") || args.includes("--finalize-retained-package")
      ? await executeRetainedPackageCommand()
      : await resourceEntrypoint("browser", executeDesktopTest);
}

function assertAbsoluteArguments<Key extends string, Values extends Partial<Record<Key, unknown>>>(
  values: Values,
  keys: readonly Key[],
): asserts values is Values & Record<Key, string> {
  for (const key of keys) {
    const value = values[key];
    assert.ok(
      typeof value === "string" && value.length > 0 && path.isAbsolute(value),
      `--${key} requires an absolute path`,
    );
  }
}
