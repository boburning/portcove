/** Joins the existing private setup-byte custody to an actual installed local
 * scheduler. This is parent-boundary provenance, never a native result. */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  readPinnedLocalNativeSetup,
  requirePinnedLocalNativeSetup,
  observeActualLinuxNativeScheduler,
  requireActualLinuxNativeScheduler,
  inspectLocalNativeSetup,
  inspectLocalNativeTransport,
} from "./release-local-native-setup.mts";
import {
  observeActualNativeScheduler,
  requireActualNativeSchedulerObservation,
} from "./release-native-scheduler.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { inspectReleaseAuthorityConfiguration } from "./release-authority-configuration.mts";
import { inspectNativeWslBoundary } from "./release-native-wsl-boundary.mts";

type Setup = Awaited<ReturnType<typeof requirePinnedLocalNativeSetup>>;
/** Reserve thirty seconds inside the existing 35-minute installed task limit.
 * This clock belongs to the original fixed Node action; source acquisition,
 * resource admission and every later child consume the same finite budget. */
export function remainingNativeParentBudget(maximum = 2070000, elapsed = performance.now()) {
  const left = Math.floor(Math.min(maximum, 2070000 - elapsed));
  if (
    !Number.isFinite(maximum) ||
    maximum < 1 ||
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    left < 1
  )
    throw new Error("original native parent lifetime exhausted; retain and reconcile its attempt");
  return left;
}
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("native parent fixed setup join differs");
}
function samePath(left: unknown, right: string) {
  return (
    typeof left === "string" &&
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  );
}

/** Pure wiring inspection. Only the actual setup/scheduler factories below can
 * establish parent provenance; this function cannot appoint incoming JSON. */
export function inspectWindowsNativeParentSetup(raw: unknown) {
  exact(
    raw,
    isRecord(raw) &&
      isRecord(raw.descriptor) &&
      raw.descriptor.platform_label === "windows-x86_64" &&
      isRecord(raw.descriptor.public_journey)
      ? "authority_configuration,boundary_configuration,configuration_path,controller_root,controller_tree,descriptor,descriptor_sha256,installation_path,installation_record,public_boundary_configuration,transport_configuration"
      : "authority_configuration,boundary_configuration,configuration_path,controller_root,controller_tree,descriptor,descriptor_sha256,installation_path,installation_record,transport_configuration",
  );
  const descriptor = inspectLocalNativeSetup(raw.descriptor);
  if (
    descriptor.scheduler_identity.kind !== "windows-task" ||
    !isRecord(raw.authority_configuration)
  )
    throw new Error("native Windows parent platform/global authority differs");
  const authorities = inspectReleaseAuthorityConfiguration(raw.authority_configuration);
  const fixed = authorities.native[descriptor.platform_label];
  const transport = inspectLocalNativeTransport(
    raw.transport_configuration,
    descriptor.platform_label,
    "windows-task",
  );
  if (descriptor.public_journey) {
    const contained = (file: string) => {
      const relative = path.win32.relative(String(raw.controller_root), file);
      return !!relative && !relative.startsWith("..") && !path.win32.isAbsolute(relative);
    };
    if (
      !transport.post_sign_verifier ||
      !contained(transport.post_sign_verifier.path) ||
      (transport.public_signature_control && !contained(transport.public_signature_control.path)) ||
      (descriptor.platform_label === "windows-x86_64" &&
        (!transport.windows_tools?.git || !contained(transport.windows_tools.git.path)))
    )
      throw new Error(
        "public source tools must be staged inside the actual protected controller tree",
      );
  }
  if (
    !isRecord(fixed) ||
    !isRecord(fixed.producer) ||
    !isRecord(fixed.host) ||
    !isRecord(fixed.host.account)
  )
    throw new Error("native Windows producer/account configuration absent");
  let boundary;
  if (descriptor.platform_label === "windows-x86_64") {
    exact(
      raw.boundary_configuration,
      "account_name,account_sid,broker_sid,capture_root,controller_root,helper_sha256,profile_root,schema_version,work_root",
    );
    boundary = raw.boundary_configuration;
    if (
      boundary.schema_version !== 1 ||
      boundary.broker_sid !== fixed.host.account.broker ||
      boundary.account_sid !== fixed.host.account.qualification ||
      fixed.host.account.kind !== "windows-sid" ||
      !samePath(boundary.controller_root, String(raw.controller_root)) ||
      !samePath(boundary.capture_root, String(descriptor.capture_root))
    )
      throw new Error("native Windows boundary differs from appointed producer/account");
  } else {
    boundary = inspectNativeWslBoundary(
      raw.boundary_configuration,
      fixed.host.account,
      String(raw.controller_root),
      String(descriptor.capture_root),
    );
  }
  let publicBoundary;
  if (descriptor.public_journey && descriptor.platform_label === "windows-x86_64") {
    const nativeBoundary = raw.boundary_configuration;
    exact(
      nativeBoundary,
      "account_name,account_sid,broker_sid,capture_root,controller_root,helper_sha256,profile_root,schema_version,work_root",
    );
    const reference = descriptor.public_journey.public_account_boundary;
    if (!reference) throw new Error("separate protected Windows public account boundary required");
    const relative = path.win32.relative(String(raw.controller_root), reference.path);
    if (!relative || relative.startsWith("..") || path.win32.isAbsolute(relative))
      throw new Error("public account boundary must be inside protected controller staging");
    exact(
      raw.public_boundary_configuration,
      "account_name,account_sid,broker_sid,capture_root,controller_root,helper_sha256,profile_root,purpose,schema_version,work_root",
    );
    const value = raw.public_boundary_configuration;
    if (
      value.schema_version !== 2 ||
      value.purpose !== "ordinary-public-proof" ||
      value.broker_sid !== nativeBoundary.broker_sid ||
      value.account_sid === nativeBoundary.account_sid ||
      value.account_sid === nativeBoundary.broker_sid ||
      typeof value.account_sid !== "string" ||
      !/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/u.test(value.account_sid) ||
      typeof value.account_name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{1,31}$/u.test(value.account_name) ||
      value.account_sid.slice(0, value.account_sid.lastIndexOf("-")) !==
        String(nativeBoundary.account_sid).slice(
          0,
          String(nativeBoundary.account_sid).lastIndexOf("-"),
        ) ||
      value.account_name.toLowerCase() === String(nativeBoundary.account_name).toLowerCase() ||
      value.helper_sha256 !== nativeBoundary.helper_sha256 ||
      !samePath(value.controller_root, String(raw.controller_root)) ||
      !samePath(value.capture_root, descriptor.capture_root)
    )
      throw new Error(
        "public account must be distinct with the same fixed broker/helper/controller/capture",
      );
    for (const pathname of [value.work_root, value.profile_root])
      if (
        typeof pathname !== "string" ||
        !/^[A-Za-z]:\\/u.test(pathname) ||
        path.win32.normalize(pathname) !== pathname ||
        /[\r\n\0]/u.test(pathname)
      )
        throw new Error("public account roots must be canonical local Windows paths");
    const roots = [
      nativeBoundary.work_root,
      nativeBoundary.profile_root,
      value.work_root,
      value.profile_root,
      raw.controller_root,
      descriptor.capture_root,
    ];
    for (let i = 0; i < roots.length; i++)
      for (let j = i + 1; j < roots.length; j++) {
        const a = roots[i],
          b = roots[j];
        if (
          typeof a !== "string" ||
          typeof b !== "string" ||
          !/^[A-Za-z]:\\/u.test(a) ||
          !/^[A-Za-z]:\\/u.test(b) ||
          [path.win32.relative(a, b), path.win32.relative(b, a)].some(
            (difference) =>
              difference === "" ||
              (!difference.startsWith("..") && !path.win32.isAbsolute(difference)),
          )
        )
          throw new Error(
            "public account work/profile must not overlap native or protected custody",
          );
      }
    publicBoundary = structuredClone(value);
  }
  if (
    fixed.producer.source_commit !== descriptor.controller_revision ||
    fixed.producer.source_tree !== raw.controller_tree
  )
    throw new Error("native producer execution source differs from appointed source");
  if (!isRecord(raw.installation_record)) throw new Error("native parent installation absent");
  const scheduler = raw.installation_record.scheduler;
  if (
    !isRecord(scheduler) ||
    !isRecord(scheduler.action) ||
    !isRecord(scheduler.protected_paths) ||
    !isRecord(descriptor.authority_configuration) ||
    !isRecord(descriptor.native_boundary_configuration) ||
    !isRecord(descriptor.scheduler_identity)
  )
    throw new Error("native parent scheduler installation absent");
  const expectedPaths = {
    descriptor: raw.configuration_path,
    installation: raw.installation_path,
    authorities: descriptor.authority_configuration.path,
    boundary: descriptor.native_boundary_configuration.path,
    controller: raw.controller_root,
    capture: descriptor.capture_root,
    native_issuer: transport.native_issuer.private_key,
    source_reader: transport.source_read_token,
    source_tool: transport.github_cli.path,
    ...(publicBoundary
      ? { public_boundary: descriptor.public_journey!.public_account_boundary!.path }
      : {}),
  };
  if (
    publicBoundary &&
    digest(scheduler.public_account) !==
      digest({
        account_name: publicBoundary.account_name,
        account_sid: publicBoundary.account_sid,
        profile_root: publicBoundary.profile_root,
        work_root: publicBoundary.work_root,
      })
  )
    throw new Error("installed scheduler must bind the separately appointed public account roots");
  // The hash-pinned installed action supplies this immutable descriptor. Its
  // argument strings cannot select a candidate report or alternate worker.
  const script = path.win32.join(String(raw.controller_root), "scripts/release-native-worker.mts");
  const args = `"${script}" "${String(raw.configuration_path)}" ${String(raw.descriptor_sha256)}`;
  if (
    scheduler.task_path !== descriptor.scheduler_identity.name ||
    scheduler.broker_sid !== boundary.broker_sid ||
    scheduler.action.arguments !== args ||
    !samePath(scheduler.action.working_directory, String(raw.controller_root)) ||
    digest(scheduler.protected_paths) !== digest(expectedPaths)
  )
    throw new Error("native installed task does not bind the fixed loader/descriptor/custody");
  return {
    scheduler: structuredClone(scheduler),
    boundary: structuredClone(boundary),
    ...(publicBoundary ? { public_boundary: publicBoundary } : {}),
    scope: "integrity-only" as const,
    authority: "none" as const,
  };
}

function projectWindowsSetup(setup: Setup) {
  return {
    authority_configuration: setup.authority_configuration,
    boundary_configuration: setup.boundary_configuration,
    configuration_path: setup.configuration_path,
    controller_root: setup.controller_root,
    controller_tree: setup.controller_tree,
    descriptor: setup.descriptor,
    descriptor_sha256: setup.descriptor_sha256,
    installation_path: setup.installation_path,
    installation_record: setup.installation_record,
    transport_configuration: setup.transport_configuration,
    ...("public_boundary_configuration" in setup
      ? { public_boundary_configuration: setup.public_boundary_configuration }
      : {}),
  };
}

async function requireHarness(setup: Setup) {
  const fixed = setup.authority_configuration.native[setup.descriptor.platform_label].producer;
  if (
    fixed.source_commit !== setup.descriptor.controller_revision ||
    fixed.source_tree !== setup.controller_tree
  )
    throw new Error("native fixed harness source/tree differs from actual parent");
  const file = path.resolve(setup.controller_root, fixed.harness.path);
  if (path.relative(setup.controller_root, file).startsWith(".."))
    throw new Error("native harness escaped fixed controller");
  const bytes = await readBoundedPublicBuildInputFile(
    setup.controller_root,
    fixed.harness.path,
    4 * 1024 * 1024,
  );
  if (createHash("sha256").update(bytes).digest("hex") !== fixed.harness.sha256)
    throw new Error("native fixed harness changed during parent qualification");
}

const parents = new WeakMap<
  object,
  { setup: object; scheduler: object; windows: boolean; windowsIdentity: string | null }
>();
async function readParent(
  setupReceipt: object,
  schedulerReceipt?: object,
  originalWindowsIdentity?: string | null,
) {
  remainingNativeParentBudget();
  const setup = await requirePinnedLocalNativeSetup(setupReceipt);
  const script = path.join(setup.controller_root, "scripts/release-native-worker.mts");
  if (
    process.execArgv.length ||
    JSON.stringify(process.argv) !==
      JSON.stringify([
        process.execPath,
        script,
        setup.configuration_path,
        setup.descriptor_sha256,
      ]) ||
    [
      "NODE_OPTIONS",
      "NODE_PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "TAURI_SIGNING_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY_PATH",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    ].some((key) => process.env[key])
  )
    throw new Error("native parent must be the fixed credential-free installed loader");
  await requireHarness(setup);
  const windows = setup.descriptor.scheduler_identity.kind === "windows-task";
  let scheduler: object,
    windowsIdentity: string | null = null;
  if (windows) {
    const expected = inspectWindowsNativeParentSetup(projectWindowsSetup(setup));
    scheduler = await observeActualNativeScheduler(expected.scheduler);
    const observed = requireActualNativeSchedulerObservation(scheduler);
    windowsIdentity = digest({
      instance: observed.task.instance,
      parent: observed.chain[0],
      descriptor_sha256: setup.descriptor_sha256,
    });
    if (originalWindowsIdentity && originalWindowsIdentity !== windowsIdentity)
      throw new Error("native installed scheduler/parent changed across stage boundary");
  } else {
    scheduler = schedulerReceipt ?? (await observeActualLinuxNativeScheduler(setupReceipt));
    await requireActualLinuxNativeScheduler(scheduler);
  }
  await setup.recheck();
  remainingNativeParentBudget();
  return { setup, scheduler, windows, windowsIdentity };
}

/** Only an actual default scheduler observation joined to private byte custody
 * can enter this map. No JSON, test provider or native result is accepted. */
export async function establishActualNativeParent(
  configurationPath: string,
  configurationSha256: string,
) {
  const setupReceipt = await readPinnedLocalNativeSetup(configurationPath, configurationSha256);
  const value = await readParent(setupReceipt);
  const receipt = Object.freeze({
    kind: "actual-fixed-native-parent",
    authority: "none",
    scope: "installed parent boundary; native capture still required",
  });
  parents.set(receipt, {
    setup: setupReceipt,
    scheduler: value.scheduler,
    windows: value.windows,
    windowsIdentity: value.windowsIdentity,
  });
  return receipt;
}
export async function requireActualNativeParent(receipt: object) {
  const retained = parents.get(receipt);
  if (!retained) throw new Error("actual installed native parent provenance required");
  const value = await readParent(
    retained.setup,
    retained.windows ? undefined : retained.scheduler,
    retained.windowsIdentity,
  );
  return {
    ...value.setup,
    recheck: async () => {
      await requireActualNativeParent(receipt);
    },
    scheduler_observation: retained.windows
      ? requireActualNativeSchedulerObservation(value.scheduler)
      : await requireActualLinuxNativeScheduler(value.scheduler),
    authority: "none" as const,
    scope: "actual fixed parent boundary; native result still required" as const,
  };
}

/** A public run never casts the primary qualification account into this role.
 * The actual scheduler's separately pinned file/ACL custody is checked by the
 * ordinary parent before this closed public boundary is exposed. */
export async function requireActualWindowsPublicParent(receipt: object) {
  const parent = await requireActualNativeParent(receipt);
  const projection = inspectWindowsNativeParentSetup(projectWindowsSetup(parent));
  const reference = parent.descriptor.public_journey?.public_account_boundary;
  if (
    parent.descriptor.platform_label !== "windows-x86_64" ||
    !projection.public_boundary ||
    !reference
  )
    throw new Error("actual separate Windows public account boundary required");
  return {
    ...parent,
    boundary_configuration: projection.public_boundary,
    public_boundary_reference: reference,
    scope:
      "actual separately appointed public account boundary; no native Check authority" as const,
  };
}
