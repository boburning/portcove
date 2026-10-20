/** Joins fixed native evidence. Pure reconstruction remains authority:none;
 * only the default parent/capture/source path may retain direct provenance. */
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
export function reconstructNativePreSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
) {
  const input = record(raw),
    request = prepared.request;
  if (
    Object.keys(input).sort().join(",") !==
    "binding,binding_sha256,bridge,capture,driver,evidence_sha256,installer,installer_harness_sha256,native,process_snapshot,runtime,version"
  )
    throw new Error("native pre-sign evidence inventory differs");
  if (request.stage !== "payload-signing" || request.platform_label !== "windows-x86_64")
    throw new Error("Windows pre-sign report only");
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
    schema_version: 1,
    stage: "payload-signing",
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
      execution_context: "native-windows11-26h2-account",
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
    journey: null,
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
export async function prepareActualNativePreSignReport(captured: object) {
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
  const stream = async (id: string, name: string) => {
    const value = await bytes(`${id}.${name}.bin`, 4 * 1024 * 1024);
    return { path: `${id}.${name}.bin`, bytes: value.byteLength, sha256: hash(value) };
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
  const prepared = reconstructNativePreSignReport(
    actual.request,
    {
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
    },
    source.declaration,
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
    kind: "actual-direct-native-pre-sign-report",
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

export async function requireActualNativePreSignReport(receipt: object) {
  const retained = reports.get(receipt);
  if (!retained) throw new Error("actual direct native pre-sign report required");
  const actual = await requireActualWindowsNativeCapture(retained.capture);
  await readActualNativeSourceDeclarations(actual.source_selection);
  for (const file of retained.files) {
    const bytes = await readBoundedPublicBuildInputFile(
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
