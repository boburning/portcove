/** Pure Linux evidence reconstruction. Fixtures/imported JSON never acquire
 * direct-parent, issuer, native acceptance or publication authority here. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectNativeReleaseQualification } from "./release-native-qualification-contract.mts";
import type { NativeStageRequest } from "./release-native-stage-capture.mts";
import type { inspectNativeCompatibilitySources } from "./release-native-source-contract.mts";
import { inspectIsolatedNativeLinuxBinding } from "../apps/desktop/scripts/native-linux-isolated-plan.mts";
import { inspectNativeWslGuestHost } from "./release-native-wsl-host.mts";
import { requireActualWslNativeCapture } from "./release-native-wsl-capture.mts";
import { readActualNativeSourceDeclarations } from "./release-native-candidate.mts";
import { serializeNativeStageCapture } from "./release-native-stage-capture.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { readNativeCapturedStream } from "./release-native-capture-files.mts";

function object(raw: unknown) {
  assert.ok(isRecord(raw));
  return raw;
}
function instant(raw: unknown) {
  assert.ok(
    typeof raw === "string" &&
      Number.isFinite(Date.parse(raw)) &&
      new Date(raw).toISOString() === raw,
  );
  return raw;
}
function text(raw: unknown) {
  assert.ok(typeof raw === "string" && raw.length > 0 && raw.length <= 2048);
  return raw;
}
function same(a: unknown, b: unknown) {
  assert.equal(digest(a), digest(b));
}
function atLeast(a: unknown, b: unknown) {
  const parse = (raw: unknown) => {
    assert.ok(typeof raw === "string" && /^[0-9]+(?:\.[0-9]+){1,3}$/u.test(raw));
    return raw.split(".").map(BigInt);
  };
  const left = parse(a),
    right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? 0n,
      y = right[index] ?? 0n;
    if (x !== y) return x > y;
  }
  return true;
}
/** Recompute actual kernel clock conversion; a copied started_at string alone
 * cannot replace the retained realtime/BOOTTIME/tick observations. */
export function inspectNativeLinuxCreation(raw: unknown) {
  const value = object(raw),
    clock = object(value.creation_clock);
  assert.ok(
    typeof value.creation_ticks === "string" && /^[1-9][0-9]{0,19}$/u.test(value.creation_ticks),
  );
  for (const field of ["realtime_ns", "boottime_ns"])
    assert.ok(typeof clock[field] === "string" && /^[1-9][0-9]{0,24}$/u.test(clock[field]));
  assert.ok(
    Number.isSafeInteger(clock.ticks_per_second) &&
      Number(clock.ticks_per_second) > 0 &&
      Number(clock.ticks_per_second) <= 1000000,
  );
  const realtime = BigInt(String(clock.realtime_ns)),
    boottime = BigInt(String(clock.boottime_ns)),
    ticks = BigInt(value.creation_ticks),
    frequency = BigInt(Number(clock.ticks_per_second));
  assert.ok((ticks * 1000000000n) / frequency <= boottime && boottime < realtime);
  const milliseconds = (realtime - boottime) / 1000000n + (ticks * 1000n) / frequency;
  assert.ok(milliseconds <= BigInt(Number.MAX_SAFE_INTEGER));
  const started_at = new Date(Number(milliseconds)).toISOString();
  assert.equal(clock.started_at, started_at);
  if ("started_at" in value) assert.equal(value.started_at, started_at);
  return Object.freeze({
    creation: { kind: "linux-starttime-ticks" as const, value: value.creation_ticks },
    started_at,
  });
}

export function reconstructNativeLinuxPreSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
) {
  const input = object(raw),
    request = prepared.request;
  assert.equal(request.platform_label, "linux-x86_64");
  assert.equal(request.stage, "payload-signing");
  const binding = inspectIsolatedNativeLinuxBinding(input.binding),
    outer = object(input.outer),
    driver = object(input.driver),
    native = object(input.native),
    runtime = object(input.runtime),
    observed = object(runtime.runtime),
    host = object(input.host),
    capture = object(input.capture);
  const expectedHost = object(request.expected.host),
    account = object(expectedHost.account),
    engine = object(expectedHost.engine),
    compatibility = object(request.expected.compatibility);
  assert.equal(account.kind, "windows-wsl-uid");
  assert.equal(binding.invocation_id, request.invocation_id);
  assert.equal(binding.account.uid, Number(account.qualification));
  assert.equal(binding.controller.source_commit, request.expected.producer.source_commit);
  assert.equal(binding.controller.source_tree, request.expected.producer.source_tree);
  assert.equal(binding.application.bytes, request.candidate.package.bytes);
  assert.equal(binding.application.sha256, request.candidate.package.sha256);
  assert.equal(
    input.binding_sha256,
    createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
  );
  assert.equal(outer.invocation_id, request.invocation_id);
  assert.equal(outer.stage_request_sha256, prepared.request_sha256);
  assert.equal(outer.unit, binding.unit.name);
  assert.equal(outer.unit_invocation_id, binding.unit.invocation_id);
  assert.equal(outer.capture_complete, true);
  assert.equal(outer.exit_code, 0);
  assert.equal(outer.cgroup_empty, true);
  assert.equal(outer.unit_settled, true);
  assert.equal(outer.forced_termination, false);
  assert.equal(outer.failure, null);
  same(outer.cleanup_errors, []);
  const cgroup = object(outer.cgroup_identity);
  assert.ok(
    Number.isSafeInteger(cgroup.device) &&
      Number(cgroup.device) >= 0 &&
      Number.isSafeInteger(cgroup.inode) &&
      Number(cgroup.inode) > 0,
  );
  assert.equal(driver.invocation_id, request.invocation_id);
  assert.equal(driver.stage_request_sha256, prepared.request_sha256);
  assert.equal(driver.status, 0);
  assert.equal(driver.failure, null);
  assert.equal(native.outcome, "passed");
  assert.equal(native.revision, request.expected.producer.source_commit);
  assert.equal(native.platform, "linux");
  assert.equal(native.architecture, "x64");
  assert.equal(object(native.executable).sha256, request.candidate.package.sha256);
  same(object(native.context).selected_scenarios, ["empty-library", "appearance-restart"]);
  assert.ok(Array.isArray(native.checks));
  for (const name of ["empty-library", "appearance-restart"])
    assert.equal(
      native.checks.filter(
        (value) => isRecord(value) && value.scenario === name && value.outcome === "passed",
      ).length,
      1,
    );
  assert.ok(Array.isArray(input.restart) && input.restart.length === 1);
  const restart = object(input.restart[0]);
  assert.equal(restart.preference_preserved, true);
  assert.ok(restart.connected && restart.session_delete_completed);
  assert.equal(runtime.schema_version, 1);
  assert.equal(runtime.authority, "none");
  assert.equal(runtime.binding_sha256, input.binding_sha256);
  const core = object(runtime.core),
    live = object(observed.process),
    browser = object(runtime.browser);
  assert.equal(core.product, "Portcove");
  assert.equal(core.product_version, input.version);
  assert.equal(core.schema_version, source.cli_protocol.min);
  same(compatibility.cli_protocol, source.cli_protocol);
  same(compatibility.catalog_formats, source.catalog_formats);
  same(compatibility.library, source.library);
  assert.ok(
    Array.isArray(compatibility.required_capabilities) &&
      compatibility.required_capabilities.every(
        (value) => typeof value === "string" && source.available_capabilities.includes(value),
      ),
  );
  assert.equal(host.machine_id_sha256, expectedHost.machine_id_sha256);
  assert.equal(host.qualification_uid, binding.account.uid);
  assert.equal(host.qualification_gid, binding.account.gid);
  assert.ok(
    typeof expectedHost.machine_id_sha256 === "string" &&
      typeof compatibility.minimum_os_version === "string",
  );
  inspectNativeWslGuestHost(
    host,
    {
      account: { qualification: String(binding.account.uid) },
      qualification_gid: String(binding.account.gid),
    },
    request.invocation_id,
    {
      machine_id_sha256: expectedHost.machine_id_sha256,
      minimum_os_version: compatibility.minimum_os_version,
    },
  );
  assert.equal(host.architecture, "x86_64");
  assert.equal(observed.architecture, "x86_64");
  assert.equal(host.kernel_release, observed.kernel_release);
  assert.equal(host.os_release, observed.os_release);
  assert.equal(expectedHost.minimum_platform, "ubuntu-24.04-x64");
  assert.ok(atLeast(text(host.kernel_release).split(/[-+]/u)[0], compatibility.minimum_os_version));
  assert.equal(engine.name, "WebKitGTK");
  assert.ok(atLeast(browser.version, engine.minimum_version));
  assert.ok(Array.isArray(live.loaded_libraries) && live.loaded_libraries.length <= 8);
  const webkits = live.loaded_libraries.filter(
    (value) =>
      isRecord(value) &&
      typeof value.path === "string" &&
      /\/libwebkit2gtk-4\.1\.so\./u.test(value.path),
  );
  assert.equal(webkits.length, 1);
  const webkit = object(webkits[0]);
  assert.match(text(webkit.sha256), /^[a-f0-9]{64}$/u);
  const launch = object(live.launch_root),
    creation = inspectNativeLinuxCreation(launch),
    liveCreation = inspectNativeLinuxCreation(live);
  assert.ok(
    Array.isArray(live.launch_ancestry) &&
      live.launch_ancestry.length > 0 &&
      live.launch_ancestry.length <= 64,
  );
  const ancestry = live.launch_ancestry.map(object);
  assert.equal(ancestry[0]!.pid, live.pid);
  assert.equal(ancestry[0]!.creation_ticks, live.creation_ticks);
  assert.equal(ancestry.at(-1)!.pid, launch.pid);
  assert.equal(ancestry.at(-1)!.creation_ticks, launch.creation_ticks);
  assert.ok(Number.isSafeInteger(observed.driver_pid) && Number(observed.driver_pid) > 1);
  assert.equal(launch.parent_pid, observed.driver_pid);
  assert.equal(new Set(ancestry.map((entry) => entry.pid)).size, ancestry.length);
  for (let index = 0; index < ancestry.length - 1; index++)
    assert.equal(ancestry[index]!.parent_pid, ancestry[index + 1]!.pid);
  assert.equal(launch.uid, binding.account.uid);
  assert.ok(Number.isSafeInteger(launch.pid) && Number(launch.pid) > 1);
  assert.match(text(launch.image_sha256), /^[a-f0-9]{64}$/u);
  assert.equal(
    launch.image_sha256,
    request.candidate.package.sha256,
    "actual launch root is not the exact opaque candidate",
  );
  assert.equal(
    launch.image,
    "/native/application.AppImage",
    "actual launch root is not the fixed readonly package",
  );
  assert.ok(creation.started_at <= liveCreation.started_at);
  assert.equal(live.uid, binding.account.uid);
  assert.ok(Number.isSafeInteger(live.pid) && Number(live.pid) > 1);
  assert.match(text(live.image), /\/portcove-desktop$/u);
  assert.match(text(live.image_sha256), /^[a-f0-9]{64}$/u);
  assert.equal(capture.outcome, "completed");
  assert.equal(capture.request_sha256, prepared.request_sha256);
  assert.ok(Array.isArray(capture.roots) && capture.roots.length === 2);
  for (const rawRoot of capture.roots) {
    const root = object(rawRoot),
      image = object(root.image),
      teardown = object(root.teardown);
    assert.equal(root.role, "driver");
    assert.equal(image.pid, 1);
    assert.equal(image.sha256, binding.tools.python!.sha256);
    assert.equal(object(root.creation).kind, "linux-starttime-ticks");
    same(teardown.root_creation, root.creation);
    assert.equal(teardown.root_pid, 1);
    assert.equal(teardown.root_exited, true);
    assert.equal(teardown.job_empty, true);
    assert.equal(teardown.exit_code, 0);
    same(teardown.remaining_pids, []);
  }
  const harness = object(capture.harness);
  assert.equal(harness.path, request.expected.producer.harness.path);
  assert.equal(harness.sha256, request.expected.producer.harness.sha256);
  assert.equal(harness.exit_code, 0);
  const group = object(capture.group);
  assert.equal(group.empty, true);
  assert.equal(group.observed_at, outer.completed_at);
  same(group.remaining_pids, []);
  const start = instant(input.started_at),
    end = instant(group.observed_at);
  assert.ok(
    start <= creation.started_at &&
      creation.started_at <= instant(observed.observed_at) &&
      instant(observed.observed_at) <= end,
  );
  const report = inspectNativeReleaseQualification({
    schema_version: 1,
    stage: request.stage,
    platform_label: request.platform_label,
    candidate: request.candidate,
    producer: {
      ...request.expected.producer,
      invocation_id: request.invocation_id,
      started_at: start,
    },
    host: {
      machine_id_sha256: host.machine_id_sha256,
      architecture: "x86_64",
      qualification_profile: expectedHost.qualification_profile,
      os_version: host.kernel_release,
      minimum_platform: expectedHost.minimum_platform,
      execution_context: "native-ubuntu-24.04-wsl2-account",
      account,
      loaded_engine: { name: "WebKitGTK", version: browser.version, sha256: webkit.sha256 },
    },
    runtime: {
      root_pid: launch.pid,
      root_creation: creation.creation,
      started_at: creation.started_at,
      completed_at: end,
      capture_sha256: digest(capture),
      teardown: {
        root_exited: true,
        tree_empty: true,
        remaining_pids: [],
        completed_at: end,
        capture_sha256: digest(capture),
      },
    },
    compatibility,
    journey: null,
    scenarios: request.required_scenarios.map((name) => ({
      name,
      outcome: "passed",
      // This is the aggregate assertion interval for the actual portable
      // candidate, not a claim that earlier byte materialization began here.
      started_at: creation.started_at,
      completed_at: end,
      capture_sha256: input.evidence_sha256,
    })),
  });
  return {
    report,
    authority: "none" as const,
    scope: "reconstruction only; actual parent capture required" as const,
  };
}

const actualReports = new WeakMap<
  object,
  {
    capture: object;
    files: readonly { name: string; sha256: string; bytes: number }[];
    report_sha256: string;
  }
>();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Only the actual fixed parent/capture map can reach this constructor. The
 * pure reconstruction above and imported receipts cannot enter its map. */
export async function prepareActualLinuxNativeStageReport(captured: object) {
  const actual = await requireActualWslNativeCapture(captured),
    selected = actual.selected,
    prepared = selected.request,
    request = prepared.request,
    summary = object(actual.summary);
  assert.equal(request.stage, "payload-signing");
  assert.equal(actual.resource_status, 0);
  assert.equal(summary.status, 0);
  assert.equal(summary.failure, null);
  assert.ok(actual.retained_capture, "complete original guest capture required");
  const retained = actual.retained_capture,
    directory = actual.capture_directory,
    files: { name: string; sha256: string; bytes: number }[] = [];
  const keep = async (name: string, bytes: Uint8Array) => {
    await writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
    files.push({ name, sha256: sha(bytes), bytes: bytes.byteLength });
  };
  const guestBytes = async (name: string, maximum = 128 * 1024) => {
    const entry = retained.entries.find((value) => value.path === name);
    assert.ok(entry && entry.bytes <= maximum);
    // The actual getter has already verified the complete original inventory.
    // A bounded ordinary read is bracketed by exact retained bytes/hash here.
    const bytes =
      entry.bytes === 0
        ? await readNativeCapturedStream(retained.directory, name)
        : await readBoundedPublicBuildInputFile(retained.directory, name, maximum);
    assert.equal(bytes.byteLength, entry.bytes);
    assert.equal(sha(bytes), entry.sha256);
    return bytes;
  };
  const json = async (name: string) =>
    JSON.parse((await guestBytes(name)).toString("utf8")) as unknown;
  const bindingBytes = await guestBytes("linux-binding.json"),
    binding = inspectIsolatedNativeLinuxBinding(JSON.parse(bindingBytes.toString("utf8"))),
    outer = object(await json("outer-isolation.json"));
  const driver = await json("linux-driver-result.json"),
    native = await json("desktop/evidence.json"),
    runtime = await json("desktop/linux-native-runtime.json"),
    restart = await json("desktop/restart-observations.json");
  const guestHostBytes = await readBoundedPublicBuildInputFile(
      directory,
      "guest-host-before.stdout.bin",
      65536,
    ),
    host: unknown = JSON.parse(guestHostBytes.toString("utf8"));
  const materializationBytes = await readBoundedPublicBuildInputFile(
      directory,
      "stage-application.stdout.bin",
      65536,
    ),
    materialization = object(JSON.parse(materializationBytes.toString("utf8")));
  assert.equal(materialization.invocation_id, request.invocation_id);
  assert.equal(materialization.entry, "application");
  assert.equal(materialization.bytes, request.candidate.package.bytes);
  assert.equal(materialization.sha256, request.candidate.package.sha256);
  assert.equal(materialization.staged, true);
  assert.equal(materialization.authority, "none");
  const joins = [];
  for (const index of [1, 2])
    joins.push(object(await json(`desktop/linux-native-launch-${index}-join.json`)));
  assert.equal(
    retained.entries.filter((value) =>
      /^desktop\/linux-native-launch-[0-9]+-join\.json$/u.test(value.path),
    ).length,
    2,
    "exact native launch inventory required",
  );
  const roots = [];
  for (const join of joins) {
    assert.equal(join.quiesced, true);
    assert.ok(join.protocol_error === undefined || join.protocol_error === null);
    const exit = object(join.exit),
      ready = object(join.ready),
      identity = object(ready.process_identity),
      streams = object(join.streams);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.equal(ready.pid, 1);
    assert.equal(ready.uid, binding.account.uid);
    assert.equal(identity.pid, 1);
    assert.equal(identity.image_sha256, binding.tools.python!.sha256);
    assert.ok(
      typeof join.nonce === "string" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(join.nonce),
    );
    const id = `namespace-${join.nonce.replaceAll("-", "")}`,
      clock = inspectNativeLinuxCreation(identity);
    assert.ok(streams.failed === false, "namespace stream capture failed");
    const copied: Record<string, { path: string; bytes: number; sha256: string }> = {};
    for (const name of ["stdout", "stderr"]) {
      const stream = object(streams[name]),
        filename = `${id}.${name}.bin`;
      assert.equal(stream.path, filename);
      const bytes = await guestBytes(filename, 4 * 1024 * 1024);
      assert.equal(bytes.byteLength, stream.bytes);
      assert.equal(sha(bytes), stream.sha256);
      await keep(filename, bytes);
      copied[name] = { path: filename, bytes: bytes.byteLength, sha256: sha(bytes) };
    }
    roots.push({
      id,
      role: "driver",
      image: { pid: 1, path: identity.image, sha256: identity.image_sha256 },
      creation: clock.creation,
      started_at: clock.started_at,
      stdout: copied.stdout,
      stderr: copied.stderr,
      teardown: {
        root_pid: 1,
        root_creation: clock.creation,
        root_exited: true,
        job_empty: true,
        remaining_pids: [],
        exit_code: exit.code,
        observed_at: exit.observed_at,
      },
    });
  }
  const harness: Record<string, { path: string; bytes: number; sha256: string }> = {};
  for (const name of ["stdout", "stderr"]) {
    const original = `outer-${name}.log`,
      entry = retained.entries.find((value) => value.path === original);
    assert.ok(entry && entry.bytes <= 4 * 1024 * 1024);
    const bytes = await readFile(path.join(retained.directory, original));
    assert.equal(bytes.byteLength, entry.bytes);
    assert.equal(sha(bytes), entry.sha256);
    const filename = `harness.${name}.bin`;
    await keep(filename, bytes);
    harness[name] = { path: filename, bytes: bytes.byteLength, sha256: sha(bytes) };
  }
  const evidence_sha256 = digest({
    request_sha256: prepared.request_sha256,
    capture_wire_sha256: actual.capture_wire_sha256,
    entries: retained.entries,
    materialization_sha256: sha(materializationBytes),
    host_sha256: sha(guestHostBytes),
  });
  const stageCapture = serializeNativeStageCapture(
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
      request_sha256: prepared.request_sha256,
      outcome: "completed",
      started_at: outer.started_at,
      completed_at: outer.completed_at,
      roots,
      group: { empty: outer.cgroup_empty, remaining_pids: [], observed_at: outer.completed_at },
      harness: {
        ...request.expected.producer.harness,
        exit_code: object(driver).status,
        stdout: harness.stdout,
        stderr: harness.stderr,
      },
      scenarios: request.required_scenarios.map((name) => ({
        name,
        outcome: "passed",
        started_at: outer.started_at,
        completed_at: outer.completed_at,
        capture_sha256: evidence_sha256,
      })),
      failure: null,
    },
  );
  const source = await readActualNativeSourceDeclarations(actual.source_selection);
  const input = {
    started_at: outer.started_at,
    version: selected.version,
    binding,
    binding_sha256: sha(bindingBytes),
    outer,
    driver,
    native,
    runtime,
    restart,
    host,
    capture: stageCapture.capture,
    evidence_sha256,
  };
  const result = reconstructNativeLinuxPreSignReport(prepared, input, source.declaration);
  await keep("native-linux-stage-evidence.json", Buffer.from(JSON.stringify(input)));
  await keep("capture.json", Buffer.from(stageCapture.bytes));
  await keep("native-report.json", Buffer.from(JSON.stringify(result.report)));
  await requireActualWslNativeCapture(captured);
  const receipt = Object.freeze({ kind: "actual-direct-linux-native-report", authority: "none" });
  actualReports.set(receipt, {
    capture: captured,
    files: Object.freeze(files),
    report_sha256: digest(result.report),
  });
  return receipt;
}
export function isActualLinuxNativeStageReport(receipt: object) {
  return actualReports.has(receipt);
}
export async function requireActualLinuxNativeStageReport(receipt: object) {
  const retained = actualReports.get(receipt);
  if (!retained) throw new Error("actual direct Linux native capture/report required");
  const actual = await requireActualWslNativeCapture(retained.capture);
  await readActualNativeSourceDeclarations(actual.source_selection);
  for (const file of retained.files) {
    const bytes = /\.(?:stdout|stderr)\.bin$/u.test(file.name)
      ? await readNativeCapturedStream(actual.capture_directory, file.name)
      : await readBoundedPublicBuildInputFile(
          actual.capture_directory,
          file.name,
          Math.max(1, file.bytes),
        );
    assert.equal(bytes.byteLength, file.bytes);
    assert.equal(sha(bytes), file.sha256, "actual Linux report input changed");
  }
  const report = inspectNativeReleaseQualification(
    JSON.parse(
      (
        await readBoundedPublicBuildInputFile(actual.capture_directory, "native-report.json", 65536)
      ).toString("utf8"),
    ),
  );
  assert.equal(digest(report), retained.report_sha256);
  return { ...actual, report, report_sha256: retained.report_sha256, authority: "none" as const };
}
export async function retainActualFailedLinuxNativeStage(captured: object, failure: string) {
  const actual = await requireActualWslNativeCapture(captured);
  const value = {
    schema_version: 1,
    request_sha256: actual.request.request_sha256,
    invocation_id: actual.request.request.invocation_id,
    failure: failure.slice(0, 2048),
    observed_at: new Date().toISOString(),
    capture_wire_sha256: actual.capture_wire_sha256,
    summary: actual.summary,
    authority: "none",
    scope:
      "original failure and retained guest observations only; no native acceptance or automatic retry",
  };
  await writeFile(
    path.join(actual.capture_directory, "stage-refusal.json"),
    JSON.stringify(value),
    { flag: "wx", mode: 0o600 },
  );
  return Object.freeze(value);
}
