/** Joins fixed native evidence. Pure reconstruction remains authority:none;
 * only the default parent/capture/source path may retain direct provenance. */
import { inspectHostedNativeWindowsHost } from "./release-hosted-native-windows-host.mts";
import { hostedWindowsContinuityPlatform } from "./release-native-qualification-contract.mts";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectNativeReleaseQualification } from "./release-native-qualification-contract.mts";
import { readActualNativeSourceDeclarations } from "./release-native-candidate.mts";
import { requireActualWindowsNativeCapture } from "./release-native-windows-capture.mts";
import { serializeNativeStageCapture } from "./release-native-stage-capture.mts";
import type { NativeStageRequest } from "./release-native-stage-capture.mts";
import type { inspectNativeCompatibilitySources } from "./release-native-source-contract.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { readNativeCapturedStream } from "./release-native-capture-files.mts";
import {
  isActualLinuxNativeStageReport,
  requireActualLinuxNativeStageReport,
} from "./release-native-linux-report.mts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function record(value: unknown) {
  if (!isRecord(value)) throw new Error("native stage evidence object missing");
  return value;
}
function text(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 2048)
    throw new Error("native stage evidence text missing");
  return value;
}
function instant(value: unknown) {
  const parsed = new Date(text(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error("native evidence chronology missing");
  return parsed.toISOString();
}
function version(value: unknown) {
  const input = text(value);
  if (!/^[0-9]{1,10}(?:[.][0-9]{1,10}){1,3}$/u.test(input))
    throw new Error("native observed version missing");
  return input.split(".").map(BigInt);
}
function atLeast(actual: unknown, minimum: unknown) {
  const left = version(actual),
    right = version(minimum);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? 0n,
      b = right[i] ?? 0n;
    if (a !== b) return a > b;
  }
  return true;
}
function requireEqual(actual: unknown, expected: unknown, message: string) {
  if (digest(actual) !== digest(expected)) throw new Error(message);
}

/** Source declarations are explicitly distinct from actual runtime observations.
 * No input success flag can replace any of the concrete joins below. */
function reconstructNativeWindowsStageReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
  hosted?: { host: unknown; nonce: string },
) {
  const input = record(raw),
    request = prepared.request;
  if (
    Object.keys(input).sort().join(",") !==
    "binding,binding_sha256,bridge,capture,driver,evidence_sha256,installer,installer_harness_sha256,native,process_snapshot,runtime,version"
  )
    throw new Error("native pre-sign evidence inventory differs");
  if (
    request.platform_label !== "windows-x86_64" ||
    (request.stage !== "payload-signing" && request.stage !== "release-publication")
  )
    throw new Error("Windows native stage report only");
  const driver = record(input.driver),
    installer = record(input.installer),
    runtime = record(input.runtime),
    native = record(input.native);
  const bridge = record(input.bridge),
    capture = record(input.capture),
    host = record(driver.host_observation);
  const expectedHost = record(request.expected.host),
    expectedAccount = record(expectedHost.account),
    engine = record(expectedHost.engine);
  const compatibility = record(request.expected.compatibility),
    library = record(compatibility.library);
  const details = record(installer.details),
    observation = record(installer.observation_identity),
    packageInputs = record(installer.package_inputs);
  if (
    driver.failure !== null ||
    driver.finish_attempted !== true ||
    bridge.phase !== "settled" ||
    bridge.invocation_id !== request.invocation_id ||
    capture.outcome !== "completed" ||
    installer.format !== 1 ||
    installer.phase !== "complete" ||
    installer.failure !== null ||
    observation.source_commit !== request.expected.producer.source_commit ||
    observation.source_tree !== request.expected.producer.source_tree ||
    observation.harness !== "scripts/test-windows-installer.ps1" ||
    observation.harness_sha256 !== input.installer_harness_sha256 ||
    details.installer_sha256 !== request.candidate.package.sha256 ||
    packageInputs.installer_sha256 !== request.candidate.package.sha256 ||
    details.install_exit_code !== 0 ||
    details.application_responding !== true ||
    details.application_exit_code !== 0 ||
    details.uninstall_exit_code !== 0 ||
    details.uninstall_registration_count !== 1 ||
    details.registered_version !== input.version ||
    details.persistent_data_preserved !== true ||
    details.managed_files_removed !== true ||
    details.registration_removed !== true
  )
    throw new Error("native install/launch/package/state evidence is incomplete");
  const registration = text(details.registration_path).toLowerCase();
  const sid = text(expectedAccount.qualification);
  if (
    Object.hasOwn(details, "registration_account_sid") &&
    details.registration_account_sid !== sid
  )
    throw new Error("native observed registration SID differs");
  if (
    !(
      registration.startsWith(
        "microsoft.powershell.core\\registry::hkey_current_user\\software\\microsoft\\windows\\currentversion\\uninstall\\",
      ) && details.registration_account_sid === sid
    ) &&
    !registration.startsWith(
      `microsoft.powershell.core\\registry::hkey_users\\${sid.toLowerCase()}\\software\\microsoft\\windows\\currentversion\\uninstall\\`,
    )
  )
    throw new Error("native registration belongs to another account hive");
  requireEqual(
    details.preservation_manifest_before_uninstall,
    details.preservation_manifest_after_uninstall,
    "native retained library manifest differs",
  );
  const preserved = record(details.preservation_manifest_before_uninstall);
  if (!Array.isArray(preserved.library) || preserved.library.length < 1)
    throw new Error("native retained library manifest is absent");
  if (
    native.outcome !== "passed" ||
    native.revision !== request.expected.producer.source_commit ||
    native.platform !== "win32" ||
    native.architecture !== "x64" ||
    !Array.isArray(native.checks) ||
    !native.checks.some(
      (value) =>
        isRecord(value) && value.scenario === "empty-library" && value.outcome === "passed",
    ) ||
    record(native.executable).sha256 !== details.installed_executable_sha256
  )
    throw new Error("actual installed ordinary-client observation is incomplete");
  const core = record(runtime.core),
    binding = record(input.binding);
  if (
    runtime.schema_version !== 1 ||
    runtime.authority !== "none" ||
    runtime.architecture !== "x64" ||
    runtime.account_binding_sha256 !== input.binding_sha256 ||
    binding.invocation_id !== request.invocation_id ||
    binding.account_sid !== sid ||
    core.product !== "Portcove" ||
    core.product_version !== input.version ||
    core.schema_version !== source.cli_protocol.min
  )
    throw new Error("actual installed Core protocol/source/account identity differs");
  requireEqual(
    compatibility.cli_protocol,
    source.cli_protocol,
    "configured CLI protocol differs from actual candidate declaration",
  );
  requireEqual(
    compatibility.catalog_formats,
    source.catalog_formats,
    "configured catalog formats differ from actual candidate declaration",
  );
  requireEqual(
    library,
    source.library,
    "configured library protocol differs from actual candidate declaration",
  );
  if (
    !Array.isArray(compatibility.required_capabilities) ||
    compatibility.required_capabilities.some(
      (value) => typeof value !== "string" || !source.available_capabilities.includes(value),
    )
  )
    throw new Error("configured native capabilities are not supplied by maintained source");
  if (hosted) {
    if (expectedHost.qualification_profile !== "fixed-hosted-native-v1")
      throw new Error("hosted Windows profile differs");
    const observed = inspectHostedNativeWindowsHost(
      hosted.host,
      hosted.nonce,
      expectedHost.minimum_platform as
        | "windows-11-26h2-x64"
        | typeof hostedWindowsContinuityPlatform,
      text(compatibility.minimum_os_version),
    );
    if (
      observed.broker_sid !== expectedAccount.broker ||
      observed.machine_id_sha256 !== expectedHost.machine_id_sha256 ||
      observed.machine_id_sha256 !== host.machine_id_sha256 ||
      observed.os.version !== host.os_version ||
      host.architecture !== "X64" ||
      version(host.os_version).slice(0, 3).join(".") !==
        version(runtime.operating_system).slice(0, 3).join(".")
    )
      throw new Error("actual hosted Windows host/account/runtime observation differs");
  } else {
    if (
      host.machine_id_sha256 !== expectedHost.machine_id_sha256 ||
      host.architecture !== "X64" ||
      expectedHost.minimum_platform !== "windows-11-26h2-x64" ||
      !atLeast(host.os_version, "10.0.26200") ||
      !atLeast(host.os_version, compatibility.minimum_os_version) ||
      version(host.os_version).slice(0, 3).join(".") !==
        version(runtime.operating_system).slice(0, 3).join(".")
    )
      throw new Error("actual minimum Windows host identity is unavailable or differs");
  }
  if (
    !Array.isArray(host.engine_images) ||
    host.engine_images.length < 1 ||
    host.engine_images.length > 4 ||
    !Array.isArray(runtime.loaded_engine_images)
  )
    throw new Error("actual loaded WebView identity is absent");
  const images = host.engine_images.map((value) => record(value));
  requireEqual(
    images.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    runtime.loaded_engine_images,
    "loaded WebView bytes differ from runtime snapshot",
  );
  const observedEngine = images[0]!;
  const snapshot = record(input.process_snapshot);
  if (
    !Array.isArray(snapshot.processes) ||
    snapshot.processes.length < 1 ||
    snapshot.processes.length > 64
  )
    throw new Error("actual owned process snapshot is absent or unbounded");
  const processes = snapshot.processes.map((value) => record(value));
  if (
    processes.some(
      (value) =>
        !Number.isSafeInteger(value.pid) ||
        Number(value.pid) < 1 ||
        !/^[1-9][0-9]+$/u.test(text(value.started_filetime)),
    )
  )
    throw new Error("actual owned process creation identity is incomplete");
  requireEqual(
    [
      ...new Set(
        processes
          .filter(
            (value) => path.win32.basename(text(value.path)).toLowerCase() === "msedgewebview2.exe",
          )
          .map((value) => text(value.path)),
      ),
    ].sort(),
    images.map((value) => text(value.path)).sort(),
    "loaded WebView paths differ from owned process snapshot",
  );
  if (
    images.some(
      (value) => value.sha256 !== observedEngine.sha256 || value.version !== observedEngine.version,
    ) ||
    !atLeast(observedEngine.version, engine.minimum_version) ||
    record(runtime.browser).version !== observedEngine.version ||
    engine.name !== "WebView2"
  )
    throw new Error("actual loaded WebView version is ambiguous, stale or below its floor");
  if (!Array.isArray(capture.roots)) throw new Error("native stage roots absent");
  const roots = capture.roots
    .map((value) => record(value))
    .filter((value) => value.role !== "profile-keeper");
  if (
    !roots.length ||
    !roots.some((value) => record(value.image).sha256 === request.candidate.package.sha256)
  )
    throw new Error("actual exact candidate package root is absent");
  roots.sort((left, right) => text(left.started_at).localeCompare(text(right.started_at)));
  const first = roots[0]!,
    group = record(capture.group),
    start = instant(first.started_at),
    end = instant(group.observed_at);
  if (
    group.empty !== true ||
    !Array.isArray(group.remaining_pids) ||
    group.remaining_pids.length !== 0 ||
    roots.some((value) => {
      const teardown = record(value.teardown);
      return (
        teardown.root_exited !== true ||
        teardown.job_empty !== true ||
        !Array.isArray(teardown.remaining_pids) ||
        teardown.remaining_pids.length !== 0
      );
    })
  )
    throw new Error("actual owned process groups are not positively settled");
  const evidenceSha = text(input.evidence_sha256),
    captureSha = digest(capture);
  const report = inspectNativeReleaseQualification({
    ...(request.stage === "release-publication"
      ? {
          schema_version: 2,
          native_prepublication_profile: request.native_prepublication_profile,
          pending_obligations: request.pending_obligations,
        }
      : { schema_version: 1 }),
    stage: request.stage,
    platform_label: "windows-x86_64",
    candidate: request.candidate,
    producer: {
      ...request.expected.producer,
      invocation_id: request.invocation_id,
      started_at: instant(driver.started_at),
    },
    host: {
      machine_id_sha256: host.machine_id_sha256,
      architecture: "x86_64",
      qualification_profile: expectedHost.qualification_profile,
      os_version: host.os_version,
      minimum_platform: expectedHost.minimum_platform,
      execution_context: hosted
        ? expectedHost.minimum_platform === hostedWindowsContinuityPlatform
          ? "native-windows-server-2022-hosted-isolated-account"
          : "native-windows-11-26h2-hosted-isolated-account"
        : "native-windows11-26h2-account",
      account: expectedAccount,
      loaded_engine: {
        name: "WebView2",
        version: observedEngine.version,
        sha256: observedEngine.sha256,
      },
    },
    runtime: {
      root_pid: record(first.image).pid,
      root_creation: first.creation,
      started_at: start,
      completed_at: end,
      capture_sha256: captureSha,
      teardown: {
        root_exited: true,
        tree_empty: true,
        remaining_pids: [],
        completed_at: end,
        capture_sha256: captureSha,
      },
    },
    compatibility: {
      minimum_os_version: compatibility.minimum_os_version,
      required_capabilities: compatibility.required_capabilities,
      cli_protocol: source.cli_protocol,
      catalog_formats: source.catalog_formats,
      library: source.library,
    },
    journey: request.journey,
    scenarios: request.required_scenarios.map((name) => ({
      name,
      outcome: "passed",
      started_at: start,
      completed_at: end,
      capture_sha256: evidenceSha,
    })),
  });
  return {
    report,
    authority: "none" as const,
    scope: "reconstruction only; direct parent provenance separately required" as const,
  };
}

export function reconstructNativePreSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
) {
  if (prepared.request.stage !== "payload-signing") throw new Error("Windows pre-sign report only");
  return reconstructNativeWindowsStageReport(prepared, raw, source);
}
/** Pure hosted reconstruction keeps observed Server continuity separate from client acceptance. */
export function reconstructHostedNativeWindowsPreSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
  host: unknown,
  nonce: string,
) {
  if (prepared.request.stage !== "payload-signing")
    throw new Error("hosted Windows pre-sign report only");
  return reconstructNativeWindowsStageReport(prepared, raw, source, { host, nonce });
}

/** Pure report2 reconstruction still has no provenance. The actual parent must
 * supply its privately retained successful payload verifier result separately. */
function reconstructWindowsPostSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
  rawCrypto: unknown,
  hosted?: { host: unknown; nonce: string },
) {
  const request = prepared.request,
    crypto = record(rawCrypto),
    input = record(raw),
    details = record(record(input.installer).details);
  if (
    request.stage !== "release-publication" ||
    request.native_report_schema_version !== 2 ||
    !request.journey ||
    crypto.signed_context_sha256 !== request.journey.signed_context_sha256 ||
    crypto.signatures_sha256 !== request.journey.signatures_sha256 ||
    typeof crypto.result_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(crypto.result_sha256) ||
    crypto.sha256 !== request.candidate.package.sha256 ||
    crypto.bytes !== request.candidate.package.bytes
  )
    throw new Error("post-sign native report requires exact private crypto/package journey");
  if ("kind" in request.journey) {
    if (
      request.journey.kind !== "initial-empty-feed" ||
      details.upgrade !== null ||
      details.package_rollback !== null ||
      details.update_path !== "explicit_bootstrap_destination"
    )
      throw new Error("initial native package stage cannot claim predecessor/update observations");
  } else {
    const predecessor = request.journey.predecessor,
      upgrade = record(details.upgrade),
      rollback = record(details.package_rollback),
      smoke = record(rollback.smoke),
      previousSmoke = record(upgrade.predecessor_smoke);
    if (
      details.update_path !== "registered_nsis_update" ||
      upgrade.predecessor_installer_sha256 !== predecessor.package.sha256 ||
      rollback.predecessor_installer_sha256 !== predecessor.package.sha256 ||
      typeof upgrade.predecessor_executable_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(upgrade.predecessor_executable_sha256) ||
      rollback.executable_sha256 !== upgrade.predecessor_executable_sha256 ||
      rollback.install_exit_code !== 0 ||
      rollback.registration_count !== 1 ||
      smoke.responding !== true ||
      smoke.exit_code !== 0 ||
      previousSmoke.responding !== true ||
      previousSmoke.exit_code !== 0 ||
      rollback.database_present !== true ||
      typeof rollback.sentinel_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(rollback.sentinel_sha256) ||
      typeof rollback.registered_version !== "string" ||
      typeof crypto.predecessor_version !== "string" ||
      rollback.registered_version !== crypto.predecessor_version ||
      rollback.scope !==
        "signed-package compatibility only; ordinary public updater journey remains pending"
    )
      throw new Error("post-sign native predecessor/rollback observations incomplete");
    const capture = record(input.capture);
    if (
      !Array.isArray(capture.roots) ||
      !capture.roots.some(
        (root) =>
          isRecord(root) &&
          isRecord(root.image) &&
          root.image.sha256 === predecessor.package.sha256,
      )
    )
      throw new Error("actual predecessor package launch root missing");
    const manifest = record(rollback.manifest_before_install);
    if (!Array.isArray(manifest.library) || !manifest.library.length)
      throw new Error("native rollback retained state absent");
    requireEqual(
      rollback.manifest_before_install,
      rollback.manifest_after_install,
      "native rollback installer changed retained state",
    );
    requireEqual(
      rollback.manifest_after_launch,
      details.preservation_manifest_before_uninstall,
      "native rollback post-launch state not preserved by uninstall",
    );
    const sid = text(record(request.expected.host.account).qualification).toLowerCase();
    if (
      Object.hasOwn(rollback, "registration_account_sid") &&
      text(rollback.registration_account_sid).toLowerCase() !== sid
    )
      throw new Error("native rollback observed registration SID differs");
    if (
      !(
        text(rollback.registration_path)
          .toLowerCase()
          .startsWith(
            "microsoft.powershell.core\\registry::hkey_current_user\\software\\microsoft\\windows\\currentversion\\uninstall\\",
          ) && text(rollback.registration_account_sid).toLowerCase() === sid
      ) &&
      !text(rollback.registration_path)
        .toLowerCase()
        .startsWith(
          `microsoft.powershell.core\\registry::hkey_users\\${sid}\\software\\microsoft\\windows\\currentversion\\uninstall\\`,
        )
    )
      throw new Error("native rollback registration belongs to another account");
  }
  return reconstructNativeWindowsStageReport(prepared, raw, source, hosted);
}

export function reconstructNativePostSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
  crypto: unknown,
) {
  return reconstructWindowsPostSignReport(prepared, raw, source, crypto);
}
export function reconstructHostedNativeWindowsPostSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
  crypto: unknown,
  host: unknown,
  nonce: string,
) {
  return reconstructWindowsPostSignReport(prepared, raw, source, crypto, { host, nonce });
}

const reports = new WeakMap<
  object,
  {
    capture: object;
    directory: string;
    files: { name: string; sha256: string; bytes: number }[];
    report_sha256: string;
  }
>();
/** Direct parent capture only. No injected reader, imported success report or
 * caller-provided semantic acceptance can enter this private map. */
export async function prepareActualNativeStageReport(captured: object) {
  const actual = await requireActualWindowsNativeCapture(captured);
  if (actual.status !== 0 || actual.result.failure !== null)
    throw new Error("actual native driver failed; preserve original capture before recovery");
  const directory = actual.capture_directory;
  const files: { name: string; sha256: string; bytes: number }[] = [];
  const bytes = async (name: string, bound = 128 * 1024) => {
    const value = await readBoundedPublicBuildInputFile(directory, name, bound);
    files.push({ name, sha256: hash(value), bytes: value.byteLength });
    return value;
  };
  const json = async (name: string, bound = 128 * 1024) =>
    JSON.parse((await bytes(name, bound)).toString("utf8")) as unknown;
  const bridge = record(await json("bridge-state.json")),
    driver = record(await json("driver-result.json"));
  const bindingBytes = await bytes("account-binding.json", 16384),
    binding = record(JSON.parse(bindingBytes.toString("utf8")));
  const installer = await json("installer.json"),
    runtimeBytes = await bytes("isolated-account-desktop/native-runtime-capabilities.json");
  const runtime: unknown = JSON.parse(runtimeBytes.toString("utf8"));
  if (hash(runtimeBytes) !== record(driver.host_observation).runtime_sha256)
    throw new Error("native runtime retained bytes changed");
  const native = await json("isolated-account-desktop/evidence.json");
  const processSnapshot = await json("isolated-account-desktop/native-runtime-processes.json");
  if (
    path.resolve(text(record(runtime).process_snapshot)) !==
    path.resolve(directory, "isolated-account-desktop/native-runtime-processes.json")
  )
    throw new Error("native process snapshot path differs from fixed capture");
  const installerHarness = await readBoundedPublicBuildInputFile(
    actual.parent.controller_root,
    "scripts/test-windows-installer.ps1",
    1024 * 1024,
  );
  const source = await readActualNativeSourceDeclarations(actual.source_selection);
  let cryptography: Record<string, unknown> | null = null;
  if (actual.request.request.stage === "release-publication") {
    const proof = actual.payload_cryptography;
    if (!proof) throw new Error("actual native post-sign cryptographic proof missing");
    const cryptoBytes = await readBoundedPublicBuildInputFile(
      actual.directory,
      proof.file,
      1024 * 1024,
    );
    if (hash(cryptoBytes) !== proof.sha256)
      throw new Error("actual native payload crypto result changed");
    const value = record(JSON.parse(cryptoBytes.toString("utf8"))),
      report = record(value.report);
    if (
      report.signature_verified !== true ||
      report.sha256 !== actual.request.request.candidate.package.sha256 ||
      report.bytes !== actual.request.request.candidate.package.bytes
    )
      throw new Error("actual payload crypto/package binding differs");
    await writeFile(path.join(directory, "payload-cryptography.json"), cryptoBytes, {
      flag: "wx",
      mode: 0o600,
    });
    await bytes("payload-cryptography.json", 1024 * 1024);
    cryptography = {
      signed_context_sha256: proof.signed_context_sha256,
      signatures_sha256: proof.signatures_sha256,
      result_sha256: proof.sha256,
      sha256: report.sha256,
      bytes: report.bytes,
      predecessor_version: actual.predecessor?.version ?? null,
    };
  }

  const stream = async (id: string, name: string) => {
    const filename = `${id}.${name}.bin`,
      value = await readNativeCapturedStream(directory, filename);
    files.push({ name: filename, sha256: hash(value), bytes: value.byteLength });
    return { path: filename, bytes: value.byteLength, sha256: hash(value) };
  };
  if (!Array.isArray(bridge.roots) || bridge.roots.length > 64)
    throw new Error("native bridge root inventory incomplete");
  const roots = [];
  for (const raw of bridge.roots) {
    const root = record(raw),
      id = text(root.id),
      teardown = record(root.teardown);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id)) throw new Error("native root capture path differs");
    roots.push({
      id,
      role:
        id === "profile-keeper"
          ? "profile-keeper"
          : root.sha256 === actual.request.request.candidate.package.sha256
            ? "candidate-package"
            : id.startsWith("account-driver-")
              ? "driver"
              : "application",
      image: { pid: root.pid, path: root.path, sha256: root.sha256 },
      creation: { kind: "windows-filetime", value: root.created_filetime },
      started_at: instant(root.started_at),
      stdout: await stream(id, "stdout"),
      stderr: await stream(id, "stderr"),
      teardown: {
        root_pid: teardown.root_pid,
        root_creation: { kind: "windows-filetime", value: teardown.root_created_filetime },
        root_exited: teardown.root_exited,
        job_empty: teardown.job_empty,
        remaining_pids: teardown.remaining_pids,
        exit_code: teardown.exit_code,
        observed_at: instant(teardown.observed_at),
      },
    });
  }
  const harnessStreams = {
    stdout: await stream("harness", "stdout"),
    stderr: await stream("harness", "stderr"),
  };
  const evidence = {
    schema_version: 1,
    inputs: files.map((file) => ({ ...file })),
    source: source.declaration.files,
    scope: "actual runtime observations and separate immutable source declarations",
    authority: "none",
  };
  const evidenceSha = digest(evidence),
    request = actual.request.request;
  const begin = roots
    .filter((root) => root.role !== "profile-keeper")
    .map((root) => root.started_at)
    .sort()[0];
  if (!begin) throw new Error("native actual candidate root missing");
  const end = instant(bridge.observed_at);
  const rawRequest = {
    schema_version: 1,
    stage: request.stage,
    platform_label: request.platform_label,
    candidate: request.candidate,
    journey: request.journey,
    invocation_id: request.invocation_id,
    setup_descriptor_sha256: request.setup_descriptor_sha256,
  };
  const stage = serializeNativeStageCapture(rawRequest, actual.parent.authority_configuration, {
    schema_version: 1,
    request_sha256: actual.request.request_sha256,
    outcome: "completed",
    started_at: instant(driver.started_at),
    completed_at: instant(driver.completed_at),
    failure: null,
    roots,
    harness: {
      ...request.expected.producer.harness,
      exit_code: 0,
      stdout: harnessStreams.stdout,
      stderr: harnessStreams.stderr,
    },
    group: {
      empty: Array.isArray(bridge.group_remaining_pids) && bridge.group_remaining_pids.length === 0,
      remaining_pids: bridge.group_remaining_pids,
      observed_at: end,
    },
    scenarios: request.required_scenarios.map((name) => ({
      name,
      outcome: "passed",
      started_at: begin,
      completed_at: end,
      capture_sha256: evidenceSha,
    })),
  });
  const evidenceInput = {
    driver,
    installer,
    installer_harness_sha256: hash(installerHarness),
    process_snapshot: processSnapshot,
    runtime,
    native,
    bridge,
    capture: stage.capture,
    binding,
    binding_sha256: hash(bindingBytes),
    version: actual.version,
    evidence_sha256: evidenceSha,
  };
  const prepared =
    actual.request.request.stage === "payload-signing"
      ? reconstructNativePreSignReport(actual.request, evidenceInput, source.declaration)
      : reconstructNativePostSignReport(
          actual.request,
          evidenceInput,
          source.declaration,
          cryptography,
        );
  const reportBytes = Buffer.from(JSON.stringify(prepared.report));
  await writeFile(path.join(directory, "stage-evidence.json"), JSON.stringify(evidence), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(path.join(directory, "capture.json"), stage.bytes, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(directory, "native-report.json"), reportBytes, {
    flag: "wx",
    mode: 0o600,
  });
  files.push(
    {
      name: "stage-evidence.json",
      sha256: hash(Buffer.from(JSON.stringify(evidence))),
      bytes: Buffer.byteLength(JSON.stringify(evidence)),
    },
    {
      name: "capture.json",
      sha256: hash(Buffer.from(stage.bytes)),
      bytes: Buffer.byteLength(stage.bytes),
    },
    { name: "native-report.json", sha256: hash(reportBytes), bytes: reportBytes.byteLength },
  );
  await requireActualWindowsNativeCapture(captured);
  const receipt = Object.freeze({
    kind: "actual-direct-native-stage-report",
    directory,
    report_sha256: digest(prepared.report),
    authority: "none",
    scope: "actual fixed parent stage capture; Check issuance and admission separately required",
  });
  reports.set(receipt, {
    capture: captured,
    directory,
    files,
    report_sha256: digest(prepared.report),
  });
  return receipt;
}

export async function requireActualNativeStageReport(receipt: object) {
  if (isActualLinuxNativeStageReport(receipt)) return requireActualLinuxNativeStageReport(receipt);
  const retained = reports.get(receipt);
  if (!retained) throw new Error("actual direct native stage report required");
  const actual = await requireActualWindowsNativeCapture(retained.capture);
  await readActualNativeSourceDeclarations(actual.source_selection);
  for (const file of retained.files) {
    const bytes = /\.(?:stdout|stderr)\.bin$/u.test(file.name)
      ? await readNativeCapturedStream(retained.directory, file.name)
      : await readBoundedPublicBuildInputFile(
          retained.directory,
          file.name,
          Math.max(file.bytes, 1),
        );
    if (bytes.byteLength !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("actual native report input changed");
  }
  const raw: unknown = JSON.parse(
    (
      await readBoundedPublicBuildInputFile(retained.directory, "native-report.json", 64 * 1024)
    ).toString("utf8"),
  );
  const report = inspectNativeReleaseQualification(raw);
  if (digest(report) !== retained.report_sha256) throw new Error("actual native report changed");
  return { ...actual, report, report_sha256: retained.report_sha256, authority: "none" as const };
}

/** Legacy pre-sign entrypoints retain their stage scope. */
export async function prepareActualNativePreSignReport(captured: object) {
  const actual = await requireActualWindowsNativeCapture(captured);
  if (actual.request.request.stage !== "payload-signing")
    throw new Error("actual pre-sign capture required");
  return prepareActualNativeStageReport(captured);
}
export async function requireActualNativePreSignReport(receipt: object) {
  if (!reports.has(receipt) && !isActualLinuxNativeStageReport(receipt))
    throw new Error("actual direct native pre-sign report required");
  const actual = await requireActualNativeStageReport(receipt);
  if (actual.report.stage !== "payload-signing")
    throw new Error("actual direct native pre-sign report required");
  return actual;
}

/** Failure retention cannot produce a Check or an acceptance brand. Incomplete
 * root identities/streams refuse serialization and leave original raw files in
 * place for readback; an empty group is never inferred from process failure. */
export async function retainActualFailedNativeStage(captured: object, failure: string) {
  const actual = await requireActualWindowsNativeCapture(captured);
  const directory = actual.capture_directory;
  await writeFile(
    path.join(directory, "stage-refusal.json"),
    JSON.stringify({
      schema_version: 1,
      request_sha256: actual.request.request_sha256,
      failure: failure.slice(0, 2048),
      observed_at: new Date().toISOString(),
      authority: "none",
    }),
    { flag: "wx", mode: 0o600 },
  );
  const raw: unknown = JSON.parse(
    (await readBoundedPublicBuildInputFile(directory, "bridge-state.json", 128 * 1024)).toString(
      "utf8",
    ),
  );
  const bridge = record(raw);
  if (
    bridge.invocation_id !== actual.request.request.invocation_id ||
    !Array.isArray(bridge.roots) ||
    bridge.roots.length > 64
  )
    throw new Error(
      "failed native original bridge identity missing; retain raw evidence for reconciliation",
    );
  const stream = async (id: string, kind: string) => {
    const file = `${id}.${kind}.bin`,
      bytes = await readNativeCapturedStream(directory, file);
    return { path: file, bytes: bytes.byteLength, sha256: hash(bytes) };
  };
  const roots = [];
  for (const rawRoot of bridge.roots) {
    const root = record(rawRoot),
      id = text(root.id);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id)) throw new Error("failed native root path differs");
    const teardown = root.teardown === null ? null : record(root.teardown);
    roots.push({
      id,
      role:
        id === "profile-keeper"
          ? "profile-keeper"
          : root.sha256 === actual.request.request.candidate.package.sha256
            ? "candidate-package"
            : id.startsWith("account-driver-")
              ? "driver"
              : "application",
      image: { pid: root.pid, path: root.path, sha256: root.sha256 },
      creation: { kind: "windows-filetime", value: root.created_filetime },
      started_at: instant(root.started_at),
      stdout: await stream(id, "stdout"),
      stderr: await stream(id, "stderr"),
      teardown:
        teardown === null
          ? null
          : {
              root_pid: teardown.root_pid,
              root_creation: { kind: "windows-filetime", value: teardown.root_created_filetime },
              root_exited: teardown.root_exited,
              job_empty: teardown.job_empty,
              remaining_pids: teardown.remaining_pids,
              exit_code: teardown.exit_code,
              observed_at: instant(teardown.observed_at),
            },
    });
  }
  const request = actual.request.request;
  const group = Array.isArray(bridge.group_remaining_pids)
    ? {
        empty: bridge.phase === "settled" && bridge.group_remaining_pids.length === 0,
        remaining_pids: bridge.group_remaining_pids,
        observed_at: instant(bridge.observed_at),
      }
    : null;
  const settled =
    group?.empty === true &&
    roots.every((root) => root.teardown?.root_exited === true && root.teardown.job_empty === true);
  const serialized = serializeNativeStageCapture(
    {
      schema_version: 1,
      stage: request.stage,
      platform_label: request.platform_label,
      candidate: request.candidate,
      journey: request.journey,
      invocation_id: request.invocation_id,
      setup_descriptor_sha256: request.setup_descriptor_sha256,
    },
    actual.parent.authority_configuration,
    {
      schema_version: 1,
      request_sha256: actual.request.request_sha256,
      outcome: settled ? "failed" : "ambiguous",
      started_at: instant(actual.result.started_at),
      completed_at: instant(actual.result.completed_at),
      roots,
      group,
      scenarios: [],
      harness: {
        ...request.expected.producer.harness,
        exit_code:
          actual.result.children.find((child) => child.role === "harness")?.exit_code ?? null,
        stdout: await stream("harness", "stdout"),
        stderr: await stream("harness", "stderr"),
      },
      failure: {
        phase: "fixed-native-stage",
        code: settled ? "stage-refused" : "settlement-unresolved",
        message: failure.slice(0, 2048) || "native stage refused",
      },
    },
  );
  await requireActualWindowsNativeCapture(captured);
  await writeFile(path.join(directory, "capture.json"), serialized.bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return Object.freeze({
    capture_sha256: serialized.capture_sha256,
    outcome: serialized.capture.outcome,
    authority: "none" as const,
    scope: "original failure and observed teardown only; no native acceptance or automatic retry",
  });
}
