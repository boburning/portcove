/** Fixed credential-free guest driver. Only the installed Windows parent can
 * retain invocation provenance; this process emits observations, never a grant. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, lstat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectIsolatedNativeLinuxBinding,
  inspectNativeLinuxHomeMount,
} from "../apps/desktop/scripts/native-linux-isolated-plan.mts";
import { isRecord, errorMessage, errorCode } from "./runtime-values.mts";
import { runResourceCommand } from "./resource-command.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { replaceNativeLinuxPackage } from "./release-native-linux-package.mts";
import {
  inspectNativeQualificationCandidate,
  inspectNativeQualificationJourney,
  nativePrepublicationProfile,
} from "./release-native-qualification-contract.mts";
import { inspectPublicNativeLinuxBinding } from "../apps/desktop/scripts/native-linux-public-plan.mts";
export { inspectNativeLinuxHomeMount } from "../apps/desktop/scripts/native-linux-isolated-plan.mts";
export const nativeLinuxPreSignHarnessScenarios = Object.freeze([
  "empty-library",
  "appearance-restart",
] as const);
/** A fixed local execution recipe only. Parent capture and configured native
 * authority are established outside the guest; this parser cannot appoint them. */
export function inspectNativeLinuxStagePlan(raw: unknown) {
  assert.ok(isRecord(raw));
  const keys =
    raw.schema_version === 2
      ? "binding,invocation_id,predecessor,schema_version,stage,stage_request,stage_request_sha256"
      : "binding,invocation_id,schema_version,stage,stage_request_sha256";
  assert.equal(Object.keys(raw).sort().join(","), keys);
  assert.ok(raw.schema_version === 1 || raw.schema_version === 2);
  const binding = inspectIsolatedNativeLinuxBinding(raw.binding);
  assert.equal(raw.invocation_id, binding.invocation_id);
  assert.match(String(raw.stage_request_sha256), /^[a-f0-9]{64}$/u);
  if (raw.schema_version === 1) {
    assert.equal(raw.stage, "payload-signing");
    return {
      binding,
      stage: "payload-signing" as const,
      steps: [{ id: "desktop", version: null, binding }],
      journey: null,
    };
  }
  assert.equal(raw.stage, "release-publication");
  assert.ok(isRecord(raw.stage_request));
  const request = raw.stage_request;
  assert.equal(releaseCanonicalDigest(request), raw.stage_request_sha256);
  assert.equal(request.native_report_schema_version, 2);
  assert.equal(request.native_prepublication_profile, nativePrepublicationProfile);
  assert.equal(request.invocation_id, binding.invocation_id);
  assert.equal(request.stage, raw.stage);
  assert.equal(request.platform_label, "linux-x86_64");
  const candidate = inspectNativeQualificationCandidate(request.candidate);
  assert.equal(candidate.package.bytes, binding.application.bytes);
  assert.equal(candidate.package.sha256, binding.application.sha256);
  const journey = inspectNativeQualificationJourney(
    request.journey,
    "release-publication",
    candidate,
    true,
  );
  assert.ok(journey);
  if ("kind" in journey) {
    assert.equal(raw.predecessor, null);
    return {
      binding,
      stage: "release-publication" as const,
      steps: [{ id: "candidate", version: null, binding }],
      journey,
    };
  }
  assert.ok(
    isRecord(raw.predecessor) &&
      Object.keys(raw.predecessor).sort().join(",") === "bytes,sha256,version",
  );
  assert.equal(raw.predecessor.bytes, journey.predecessor.package.bytes);
  assert.equal(raw.predecessor.sha256, journey.predecessor.package.sha256);
  assert.ok(
    typeof raw.predecessor.version === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(raw.predecessor.version) &&
      raw.predecessor.version.length <= 128,
  );
  const prior = inspectIsolatedNativeLinuxBinding({
    ...binding,
    application: {
      path: binding.application.path,
      bytes: raw.predecessor.bytes,
      sha256: raw.predecessor.sha256,
    },
  });
  return {
    binding,
    stage: "release-publication" as const,
    steps: [
      { id: "predecessor", version: raw.predecessor.version, binding: prior },
      { id: "candidate", version: null, binding },
      { id: "rollback", version: raw.predecessor.version, binding: prior },
    ],
    journey,
  };
}
/** Explicit ordinary-public plan; legacy native stage plans never select it. */
export function inspectNativeLinuxPublicStagePlan(raw: unknown) {
  assert.ok(isRecord(raw) && raw.schema_version === 3 && raw.stage === "ordinary-public-update");
  assert.equal(
    Object.keys(raw).sort().join(","),
    "binding,invocation_id,public_journey,schema_version,stage,stage_request_sha256",
  );
  assert.match(String(raw.stage_request_sha256), /^[a-f0-9]{64}$/u);
  const journey = raw.public_journey;
  assert.ok(
    isRecord(journey) &&
      Object.keys(journey).sort().join(",") ===
        "candidate,network,phase,profile_id,retained_state_bytes,source,versions",
  );
  const binding = inspectPublicNativeLinuxBinding({
    schema_version: 1,
    session: raw.binding,
    candidate: journey.candidate,
    network: journey.network,
    phase: journey.phase,
    profile_id: journey.profile_id,
    retained_state_bytes: journey.retained_state_bytes,
    source: journey.source,
  });
  assert.equal(raw.invocation_id, binding.session.invocation_id);
  assert.ok(
    isRecord(journey.versions) &&
      Object.keys(journey.versions).sort().join(",") === "candidate,prior",
  );
  const prior = journey.versions.prior,
    candidate = journey.versions.candidate;
  assert.ok(
    typeof prior === "string" &&
      typeof candidate === "string" &&
      prior.length <= 128 &&
      candidate.length <= 128,
  );
  assert.match(prior, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u);
  assert.match(candidate, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u);
  assert.notEqual(prior, candidate);
  return {
    binding,
    versions: { prior, candidate },
    raw_binding: structuredClone({
      schema_version: 1,
      session: raw.binding,
      candidate: journey.candidate,
      network: journey.network,
      phase: journey.phase,
      profile_id: journey.profile_id,
      retained_state_bytes: journey.retained_state_bytes,
      source: journey.source,
    }),
  };
}
export async function requireFreshNativeLinuxOutput(filename: string) {
  try {
    await lstat(filename);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return filename;
    throw error;
  }
  throw new Error("native desktop output already exists; retain it without reuse");
}

async function boundedJson(filename: string, expected: string) {
  assert.match(expected, /^[a-f0-9]{64}$/u);
  const before = await lstat(filename);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size > 0 &&
      before.size <= 128 * 1024,
  );
  assert.equal(before.uid, process.getuid?.());
  assert.equal(before.mode & 0o077, 0);
  const bytes = await readFile(filename);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  const after = await lstat(filename);
  for (const name of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
    assert.equal(after[name], before[name]);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}
export async function runNativeLinuxDriver(
  planPath: string,
  planSha256: string,
  unitBindingPath: string,
) {
  assert.equal(process.platform, "linux");
  const raw = await boundedJson(planPath, planSha256);
  assert.ok(isRecord(raw));
  const publicPlan = raw.schema_version === 3 ? inspectNativeLinuxPublicStagePlan(raw) : null;
  const stagePlan = publicPlan ? null : inspectNativeLinuxStagePlan(raw);
  assert.ok(
    typeof raw.stage_request_sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(raw.stage_request_sha256),
  );
  assert.ok(isRecord(raw.binding));
  const root = path.posix.dirname(path.posix.dirname(planPath));
  assert.equal(path.posix.basename(planPath), "plan.json");
  assert.equal(path.posix.basename(root), "invocations");
  const directory = path.posix.dirname(planPath);
  assert.equal(unitBindingPath, `${directory}/capture/unit-binding.json`);
  const unitInfo = await lstat(unitBindingPath);
  assert.ok(
    unitInfo.isFile() &&
      !unitInfo.isSymbolicLink() &&
      unitInfo.nlink === 2 &&
      unitInfo.size <= 32768 &&
      unitInfo.uid === process.getuid?.() &&
      (unitInfo.mode & 0o077) === 0,
  );
  const unit: unknown = JSON.parse(await readFile(unitBindingPath, "utf8"));
  assert.ok(
    isRecord(unit) &&
      Object.keys(unit).sort().join(",") ===
        "deadline_utc,invocation_id,kind,nonce,schema_version,unit" &&
      unit.schema_version === 1 &&
      unit.kind === "native-driver-admitted" &&
      typeof unit.nonce === "string" &&
      /^[a-f0-9]{64}$/u.test(unit.nonce) &&
      unit.invocation_id === raw.invocation_id &&
      isRecord(unit.unit),
  );
  const binding = inspectIsolatedNativeLinuxBinding({ ...raw.binding, unit: unit.unit });
  assert.equal(raw.invocation_id, binding.invocation_id);
  assert.equal(unit.deadline_utc, binding.deadline_utc);
  assert.equal(directory, `${binding.linux_root}/invocations/${binding.invocation_id}`);
  assert.equal(
    fileURLToPath(import.meta.url),
    `${binding.controller.root}/scripts/release-native-linux-driver.mts`,
  );
  assert.equal(process.execPath, binding.tools.node?.path);
  assert.equal(process.getuid?.(), binding.account.uid);
  assert.equal(process.getgid?.(), binding.account.gid);
  assert.equal(
    (await readFile("/proc/self/cgroup", "utf8")).trim(),
    `0::${binding.unit.control_group}`,
  );
  const filesystem = await statfs(binding.home);
  const mount = inspectNativeLinuxHomeMount(
    await readFile("/proc/self/mountinfo", "utf8"),
    binding.home,
    filesystem,
  );
  const bindingPath = `${binding.capture_root}/linux-binding.json`,
    bytes = Buffer.from(JSON.stringify(binding));
  await writeFile(bindingPath, bytes, { flag: "wx", mode: 0o600 });
  await writeFile(`${binding.capture_root}/home-mount.json`, JSON.stringify(mount), {
    flag: "wx",
    mode: 0o600,
  });
  const started_at = new Date().toISOString();
  if (publicPlan) {
    const configuration = {
      schema_version: 1,
      kind: "ordinary-linux-public-update",
      binding: { ...publicPlan.raw_binding, session: binding },
      versions: publicPlan.versions,
    };
    const filename = `${binding.capture_root}/public-linux-configuration.json`,
      bytes = Buffer.from(JSON.stringify(configuration));
    await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
    let status: number | null = null,
      failure: string | null = null;
    try {
      const remaining = Math.min(
        1750000,
        Math.floor(Date.parse(binding.deadline_utc) - Date.now()),
      );
      assert.ok(remaining > 0);
      status = await runResourceCommand(
        "analysis",
        process.execPath,
        [
          `${binding.controller.root}/apps/desktop/scripts/desktop-linux-public-update.mts`,
          "--configuration",
          filename,
          "--configuration-sha256",
          createHash("sha256").update(bytes).digest("hex"),
          "--remaining-ms",
          String(remaining),
        ],
        {
          cwd: binding.controller.root,
          environment: {
            PATH: `${binding.linux_root}/tools:/usr/bin:/bin`,
            HOME: `/home/${binding.linux_root.split("/")[2]}`,
            LANG: "C.UTF-8",
          },
          exclusive: [`native-linux:${binding.account.uid}`],
        },
      );
      assert.equal(status, 0, "Actual ordinary public AppImage harness failed");
    } catch (error) {
      failure = errorMessage(error);
      throw error;
    } finally {
      await writeFile(
        `${binding.capture_root}/linux-driver-result.json`,
        JSON.stringify({
          schema_version: 1,
          invocation_id: binding.invocation_id,
          stage_request_sha256: raw.stage_request_sha256,
          stage: "ordinary-public-update",
          started_at,
          completed_at: new Date().toISOString(),
          status,
          failure,
          home_mount: mount,
          authority: "none",
          native_acceptance: "not-established",
        }),
        { flag: "wx", mode: 0o600 },
      );
    }
    return;
  }
  assert.ok(stagePlan);
  const lifecycle: {
    id: string;
    binding_sha256: string;
    package: { bytes: number; sha256: string };
    replacement: Awaited<ReturnType<typeof replaceNativeLinuxPackage>> | null;
    before_preferences_sha256: string | null;
    after_preferences_sha256: string;
    preferences_capture: string;
    started_at: string;
    completed_at: string;
  }[] = [];
  let status: number | null = null,
    failure: string | null = null;
  try {
    assert.ok(Date.parse(binding.deadline_utc) > Date.now());
    for (const step of stagePlan.steps) {
      assert.ok(Date.parse(binding.deadline_utc) > Date.now());
      let beforePreferences: Buffer | null = null;
      try {
        beforePreferences = await readBoundedPublicBuildInputFile(
          binding.home,
          "preferences.json",
          65536,
        );
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      const beforeSha = beforePreferences
        ? createHash("sha256").update(beforePreferences).digest("hex")
        : null;
      if (lifecycle.length)
        assert.equal(
          beforeSha,
          lifecycle.at(-1)!.after_preferences_sha256,
          "package transition changed retained preferences before launch",
        );
      const stepStarted = new Date().toISOString();
      const replacement =
        stagePlan.stage === "release-publication"
          ? await replaceNativeLinuxPackage({
              attempt: directory,
              slot: step.id === "candidate" ? "candidate" : "predecessor",
              step: step.id as "predecessor" | "candidate" | "rollback",
              expected: {
                bytes: step.binding.application.bytes,
                sha256: step.binding.application.sha256,
              },
              previous: lifecycle.length ? lifecycle.at(-1)!.package : null,
            })
          : null;
      if (replacement) {
        await writeFile(
          `${binding.capture_root}/package-${step.id}-replacement.json`,
          JSON.stringify(replacement),
          { flag: "wx", mode: 0o600 },
        );
        let afterInstall: Buffer | null = null;
        try {
          afterInstall = await readBoundedPublicBuildInputFile(
            binding.home,
            "preferences.json",
            65536,
          );
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        assert.equal(
          afterInstall ? createHash("sha256").update(afterInstall).digest("hex") : null,
          beforeSha,
          "portable replacement changed retained data",
        );
      }
      const current = inspectIsolatedNativeLinuxBinding({ ...step.binding, unit: unit.unit });
      const output = `${binding.capture_root}/${step.id}`;
      await requireFreshNativeLinuxOutput(output); // Harness owns CreateNew.
      const stepBytes = Buffer.from(JSON.stringify(current));
      const stepPath =
        stagePlan.stage === "payload-signing"
          ? bindingPath
          : `${binding.capture_root}/linux-binding-${step.id}.json`;
      if (stepPath !== bindingPath)
        await writeFile(stepPath, stepBytes, { flag: "wx", mode: 0o600 });
      const environment: NodeJS.ProcessEnv = {
        PATH: `${binding.linux_root}/tools:/usr/bin:/bin`,
        HOME: `/home/${binding.linux_root.split("/")[2]}`,
        LANG: "C.UTF-8",
        PORTCOVE_NATIVE_LINUX_BINDING: stepPath,
        PORTCOVE_NATIVE_LINUX_BINDING_SHA256: createHash("sha256").update(stepBytes).digest("hex"),
      };
      status = await runResourceCommand(
        "analysis",
        process.execPath,
        [
          `${binding.controller.root}/apps/desktop/scripts/desktop-test.mts`,
          "--app",
          current.application.path,
          "--output",
          output,
          "--driver",
          binding.tools.driver!.path,
          "--native-driver",
          binding.tools.webkit_driver!.path,
          ...nativeLinuxPreSignHarnessScenarios.flatMap((name) => ["--scenario", name]),
        ],
        {
          cwd: binding.controller.root,
          environment,
          exclusive: [`native-linux:${binding.account.uid}`],
        },
      );
      assert.equal(status, 0, "actual isolated desktop harness failed");
      if (step.version !== null) {
        const observed: unknown = JSON.parse(
          await readFile(`${output}/linux-native-core-capabilities.json`, "utf8"),
        );
        assert.ok(isRecord(observed) && isRecord(observed.core));
        assert.equal(
          observed.core.product_version,
          step.version,
          "actual predecessor package version differs",
        );
      }
      const afterPreferences = await readBoundedPublicBuildInputFile(
        binding.home,
        "preferences.json",
        65536,
      );
      const afterSha = createHash("sha256").update(afterPreferences).digest("hex");
      if (lifecycle.length)
        assert.equal(
          afterSha,
          lifecycle[0]!.after_preferences_sha256,
          "package launch changed retained preference bytes",
        );
      const preferencesCapture = `package-${step.id}.preferences.bin`;
      await writeFile(`${binding.capture_root}/${preferencesCapture}`, afterPreferences, {
        flag: "wx",
        mode: 0o600,
      });
      lifecycle.push({
        id: step.id,
        binding_sha256: createHash("sha256").update(stepBytes).digest("hex"),
        package: { bytes: current.application.bytes, sha256: current.application.sha256 },
        replacement,
        before_preferences_sha256: beforeSha,
        after_preferences_sha256: afterSha,
        preferences_capture: preferencesCapture,
        started_at: stepStarted,
        completed_at: new Date().toISOString(),
      });
    }
  } catch (error) {
    failure = errorMessage(error);
    throw error;
  } finally {
    await writeFile(
      `${binding.capture_root}/linux-driver-result.json`,
      JSON.stringify({
        schema_version: 1,
        invocation_id: binding.invocation_id,
        stage_request_sha256: raw.stage_request_sha256,
        started_at,
        completed_at: new Date().toISOString(),
        status,
        failure,
        home_mount: mount,
        authority: "none",
        native_acceptance: "not-established",
        package_lifecycle: lifecycle,
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
}
async function cli() {
  const [flag, plan, shaFlag, sha, unitFlag, unit, ...rest] = process.argv.slice(2);
  assert.ok(
    flag === "--plan" &&
      plan &&
      shaFlag === "--plan-sha256" &&
      sha &&
      unitFlag === "--unit-binding" &&
      unit &&
      !rest.length,
  );
  await runNativeLinuxDriver(plan, sha, unit);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await cli();
