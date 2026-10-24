/** Pure Linux evidence reconstruction. Fixtures/imported JSON never acquire
 * direct-parent, issuer, native acceptance or publication authority here. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectNativeReleaseQualification,
  nativePrepublicationProfile,
  nativePrepublicationPending,
} from "./release-native-qualification-contract.mts";
import type { NativeStageRequest } from "./release-native-stage-capture.mts";
import type { inspectNativeCompatibilitySources } from "./release-native-source-contract.mts";
import { inspectIsolatedNativeLinuxBinding } from "../apps/desktop/scripts/native-linux-isolated-plan.mts";
import {
  inspectNativeWslGuestHost,
  inspectHostedNativeLinuxHost,
} from "./release-native-wsl-host.mts";
import { requireActualWslNativeCapture } from "./release-native-wsl-capture.mts";
import { requireActualHostedNativeLinuxCapture } from "./release-hosted-native-linux-capture.mts";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import {
  requireActualHostedNativeCandidate,
  readActualHostedNativeSourceDeclarations,
  readActualHostedNativePostSignSourceDeclarations,
} from "./release-hosted-native-candidate.mts";
import { requireActualHostedNativePostSignPayload } from "./release-hosted-native-postsign-inputs.mts";
import { serializeHostedNativeStageCapture } from "./release-native-stage-capture.mts";
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

function inspectLinuxLaunch(
  observed: Record<string, unknown>,
  expectedSha256: string,
  uid: number,
) {
  const live = object(observed.process);
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
  assert.equal(launch.uid, uid);
  assert.ok(Number.isSafeInteger(launch.pid) && Number(launch.pid) > 1);
  assert.match(text(launch.image_sha256), /^[a-f0-9]{64}$/u);
  assert.equal(
    launch.image_sha256,
    expectedSha256,
    "actual launch root is not the exact opaque candidate",
  );
  assert.equal(
    launch.image,
    "/native/application.AppImage",
    "actual launch root is not the fixed readonly package",
  );
  assert.ok(creation.started_at <= liveCreation.started_at);
  assert.equal(live.uid, uid);
  assert.ok(Number.isSafeInteger(live.pid) && Number(live.pid) > 1);
  assert.match(text(live.image), /\/portcove-desktop$/u);
  assert.match(text(live.image_sha256), /^[a-f0-9]{64}$/u);
  return { launch, creation };
}

function reconstructNativeLinuxReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
  profile: "wsl" | "hosted" = "wsl",
) {
  const input = object(raw),
    request = prepared.request;
  assert.equal(request.platform_label, "linux-x86_64");
  assert.ok(request.stage === "payload-signing" || request.stage === "release-publication");
  const publication = request.stage === "release-publication";
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
  assert.equal(account.kind, profile === "wsl" ? "windows-wsl-uid" : "linux-uid");
  if (profile === "hosted")
    assert.equal(expectedHost.qualification_profile, "fixed-hosted-native-v1");
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
  (profile === "wsl" ? inspectNativeWslGuestHost : inspectHostedNativeLinuxHost)(
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
  if (profile === "wsl")
    assert.ok(
      atLeast(text(host.kernel_release).split(/[-+]/u)[0], compatibility.minimum_os_version),
    );
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
  const candidateLaunch = inspectLinuxLaunch(
    observed,
    request.candidate.package.sha256,
    binding.account.uid,
  );
  // The stage lifetime begins at the earliest real candidate-package root,
  // including the genuine predecessor when ordinary compatibility is tested.
  const publicationEntries = publication ? object(input.publication).entries : null;
  if (publication) assert.ok(Array.isArray(publicationEntries) && publicationEntries.length > 0);
  const firstEntry = Array.isArray(publicationEntries) ? object(publicationEntries[0]) : null;
  const { launch, creation } = firstEntry
    ? inspectLinuxLaunch(
        object(object(firstEntry.runtime).runtime),
        text(object(firstEntry.package).sha256),
        binding.account.uid,
      )
    : candidateLaunch;
  assert.equal(capture.outcome, "completed");
  assert.equal(capture.request_sha256, prepared.request_sha256);
  const rootCount = publication && request.journey && "predecessor" in request.journey ? 6 : 2;
  assert.ok(Array.isArray(capture.roots) && capture.roots.length === rootCount);
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
    schema_version: publication ? 2 : 1,
    ...(publication
      ? {
          native_prepublication_profile: nativePrepublicationProfile,
          pending_obligations: [...nativePrepublicationPending],
        }
      : {}),
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
      execution_context:
        profile === "wsl"
          ? "native-ubuntu-24.04-wsl2-account"
          : "native-ubuntu-24.04-hosted-isolated-account",
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
    journey: request.journey,
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
export function reconstructNativeLinuxPreSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
) {
  assert.equal(prepared.request.stage, "payload-signing");
  return reconstructNativeLinuxReport(prepared, raw, source);
}

/** Hosted reconstruction is explicitly selected; importing host/capture JSON
 * still cannot create the actual parent's private invocation capability. */
export function reconstructHostedNativeLinuxPreSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
) {
  assert.equal(prepared.request.stage, "payload-signing");
  return reconstructNativeLinuxReport(prepared, raw, source, "hosted");
}
/** Signed-package compatibility only. Ordinary public discovery/apply/recovery
 * remains explicitly pending in report2; no private feed substitutes for it. */
function reconstructNativeLinuxPostSignReportFor(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
  profile: "wsl" | "hosted",
) {
  const request = prepared.request,
    input = object(raw),
    details = object(input.publication);
  assert.equal(request.stage, "release-publication");
  assert.equal(request.native_report_schema_version, 2);
  assert.equal(request.native_prepublication_profile, nativePrepublicationProfile);
  assert.ok(request.journey);
  const journey = request.journey,
    initial = "kind" in journey,
    crypto = object(details.payload_cryptography);
  assert.equal(crypto.signed_context_sha256, journey.signed_context_sha256);
  assert.equal(crypto.signatures_sha256, journey.signatures_sha256);
  assert.equal(crypto.file, "native-payload-result.json");
  assert.match(text(crypto.sha256), /^[a-f0-9]{64}$/u);
  const ids = initial ? ["candidate"] : ["predecessor", "candidate", "rollback"];
  assert.ok(Array.isArray(details.entries) && details.entries.length === ids.length);
  const entries = details.entries.map(object),
    binding = inspectIsolatedNativeLinuxBinding(input.binding);
  const expectedEngine = object(object(request.expected.host).engine);
  let firstPreferences: string | null = null;
  let previousEnd = instant(input.started_at);
  const end = instant(object(input.outer).completed_at);
  for (let index = 0; index < ids.length; index++) {
    const entry = entries[index]!,
      id = ids[index]!,
      packageIdentity =
        id === "candidate"
          ? request.candidate.package
          : !initial
            ? journey.predecessor.package
            : null;
    assert.ok(packageIdentity);
    assert.equal(entry.id, id);
    same(entry.package, { bytes: packageIdentity.bytes, sha256: packageIdentity.sha256 });
    const replacement = object(entry.replacement);
    assert.equal(replacement.step, id);
    assert.equal(replacement.slot, id === "candidate" ? "candidate" : "predecessor");
    assert.equal(replacement.authority, "none");
    assert.equal(replacement.scope, "portable package replacement only");
    same(replacement.installed, entry.package);
    same(replacement.previous, index ? entries[index - 1]!.package : null);
    const active = object(replacement.active_identity);
    assert.match(text(active.device), /^[0-9]+$/u);
    assert.match(text(active.inode), /^[1-9][0-9]*$/u);
    assert.equal(
      entry.before_preferences_sha256,
      index ? entries[index - 1]!.after_preferences_sha256 : null,
    );
    assert.match(text(entry.after_preferences_sha256), /^[a-f0-9]{64}$/u);
    firstPreferences ??= text(entry.after_preferences_sha256);
    assert.equal(entry.after_preferences_sha256, firstPreferences);
    assert.equal(entry.preferences_capture, `package-${id}.preferences.bin`);
    assert.equal(entry.preferences_capture_sha256, entry.after_preferences_sha256);
    const native = object(entry.native),
      runtime = object(entry.runtime),
      observed = object(runtime.runtime),
      core = object(runtime.core);
    assert.equal(native.outcome, "passed");
    assert.equal(native.revision, request.expected.producer.source_commit);
    assert.equal(native.platform, "linux");
    assert.equal(native.architecture, "x64");
    assert.equal(object(native.executable).sha256, packageIdentity.sha256);
    same(object(native.context).selected_scenarios, ["empty-library", "appearance-restart"]);
    assert.ok(Array.isArray(native.checks));
    for (const scenario of ["empty-library", "appearance-restart"])
      assert.equal(
        native.checks.filter(
          (value) => isRecord(value) && value.scenario === scenario && value.outcome === "passed",
        ).length,
        1,
      );
    assert.equal(runtime.schema_version, 1);
    assert.equal(runtime.authority, "none");
    assert.equal(runtime.binding_sha256, entry.binding_sha256);
    assert.match(text(entry.binding_sha256), /^[a-f0-9]{64}$/u);
    assert.equal(core.product, "Portcove");
    assert.equal(core.schema_version, source.cli_protocol.min);
    assert.equal(
      core.product_version,
      id === "candidate" ? input.version : details.predecessor_version,
    );
    const { creation } = inspectLinuxLaunch(observed, packageIdentity.sha256, binding.account.uid);
    assert.equal(observed.kernel_release, object(object(input.runtime).runtime).kernel_release);
    assert.equal(observed.os_release, object(object(input.runtime).runtime).os_release);
    same(
      object(observed.process).loaded_libraries,
      object(object(object(input.runtime).runtime).process).loaded_libraries,
    );
    assert.ok(atLeast(object(runtime.browser).version, expectedEngine.minimum_version));
    assert.ok(Array.isArray(entry.restart) && entry.restart.length === 1);
    const restart = object(entry.restart[0]);
    assert.equal(restart.preference_preserved, true);
    const start = instant(entry.started_at),
      completed = instant(entry.completed_at);
    assert.ok(previousEnd <= start && start <= creation.started_at);
    assert.ok(creation.started_at <= instant(observed.observed_at));
    assert.ok(instant(observed.observed_at) <= instant(restart.session_delete_completed));
    assert.ok(instant(restart.session_delete_completed) <= instant(restart.connected));
    assert.ok(instant(restart.connected) <= completed && completed <= end);
    previousEnd = completed;
  }
  if (initial) assert.equal(details.predecessor_version, null);
  else
    assert.ok(
      typeof details.predecessor_version === "string" && details.predecessor_version.length > 0,
    );
  return reconstructNativeLinuxReport(prepared, input, source, profile);
}

export function reconstructNativeLinuxPostSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
) {
  return reconstructNativeLinuxPostSignReportFor(prepared, raw, source, "wsl");
}

export function reconstructHostedNativeLinuxPostSignReport(
  prepared: NativeStageRequest,
  raw: unknown,
  source: ReturnType<typeof inspectNativeCompatibilitySources>,
) {
  return reconstructNativeLinuxPostSignReportFor(prepared, raw, source, "hosted");
}

const actualReports = new WeakMap<
  object,
  {
    capture: object;
    backend: "wsl" | "hosted";
    stopped: boolean;
    files: readonly { name: string; sha256: string; bytes: number }[];
    report_sha256: string;
  }
>();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Private adapters normalize evidence fields, never provenance. Each uses its
 * own original capture/candidate maps and fixed source reader. */
async function reportBackend(captured: object, kind: "wsl" | "hosted") {
  if (kind === "wsl") {
    const actual = await requireActualWslNativeCapture(captured);
    return {
      selected: actual.selected,
      prepared: actual.selected.request,
      directory: actual.capture_directory,
      summary: actual.summary,
      resource_status: actual.resource_status,
      retained_capture: actual.retained_capture,
      capture_wire_sha256: actual.capture_wire_sha256,
      host_filename: "guest-host-before.stdout.bin",
      serialize: (request: unknown, observation: unknown) =>
        serializeNativeStageCapture(request, actual.parent.authority_configuration, observation),
      readSource: () => readActualNativeSourceDeclarations(actual.source_selection),
      recheck: async () => {
        await requireActualWslNativeCapture(captured);
      },
    };
  }
  const actual = await requireActualHostedNativeLinuxCapture(captured);
  const parent = await requireActualHostedNativeParentSource(actual.actual.parent_source);
  const postSign = actual.prepared.request.stage === "release-publication";
  const candidate = postSign
    ? await requireActualHostedNativePostSignPayload(actual.actual.candidate_receipt)
    : await requireActualHostedNativeCandidate(actual.actual.candidate_receipt);
  return {
    selected: {
      version: candidate.version,
      predecessor: "predecessor" in candidate ? candidate.predecessor : null,
      payload_cryptography: "payload_crypto" in candidate ? candidate.payload_crypto : null,
    },
    prepared: actual.prepared,
    directory: actual.directory,
    summary: actual.summary,
    resource_status: actual.resource_status,
    retained_capture: actual.retained_capture,
    capture_wire_sha256: actual.capture_wire_sha256,
    host_filename: "host-before.stdout.bin",
    serialize: (request: unknown, observation: unknown) =>
      serializeHostedNativeStageCapture(
        request,
        parent.configuration,
        actual.actual.host.projection,
        observation,
      ),
    readSource: () =>
      "package_receipt" in candidate
        ? readActualHostedNativePostSignSourceDeclarations(candidate.package_receipt)
        : readActualHostedNativeSourceDeclarations(actual.actual.candidate_receipt),
    recheck: async () => {
      await requireActualHostedNativeLinuxCapture(captured);
      parent.recheck();
    },
  };
}

/** Only the actual fixed parent/capture map can reach this constructor. The
 * pure reconstruction above and imported receipts cannot enter its map. */
export async function prepareActualLinuxNativeStageReport(captured: object) {
  return prepareLinuxReport(captured, "wsl");
}
export async function prepareActualHostedLinuxNativeStageReport(captured: object) {
  return prepareLinuxReport(captured, "hosted");
}
async function prepareLinuxReport(captured: object, backend: "wsl" | "hosted") {
  const actual = await reportBackend(captured, backend),
    selected = actual.selected,
    prepared = actual.prepared,
    request = prepared.request,
    summary = object(actual.summary);
  const publication = request.stage === "release-publication";
  assert.equal(actual.resource_status, 0);
  assert.equal(summary.status, 0);
  assert.equal(summary.failure, null);
  assert.ok(actual.retained_capture, "complete original guest capture required");
  const retained = actual.retained_capture,
    directory = actual.directory,
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
  const driver = object(await json("linux-driver-result.json"));
  const outputs = publication
    ? request.journey && "predecessor" in request.journey
      ? ["predecessor", "candidate", "rollback"]
      : ["candidate"]
    : ["desktop"];
  const candidateOutput = publication ? "candidate" : "desktop";
  const native = await json(`${candidateOutput}/evidence.json`),
    runtime = await json(`${candidateOutput}/linux-native-runtime.json`),
    restart = await json(`${candidateOutput}/restart-observations.json`);
  let publicationDetails: Record<string, unknown> | undefined;
  if (publication) {
    assert.ok(selected.payload_cryptography && request.journey);
    assert.ok(
      Array.isArray(driver.package_lifecycle) && driver.package_lifecycle.length === outputs.length,
    );
    const entries = [];
    for (const [index, id] of outputs.entries()) {
      const item = object(driver.package_lifecycle[index]);
      assert.equal(item.id, id);
      const stepBindingBytes = await guestBytes(`linux-binding-${id}.json`);
      const stepBinding = inspectIsolatedNativeLinuxBinding(
        JSON.parse(stepBindingBytes.toString("utf8")),
      );
      assert.equal(sha(stepBindingBytes), item.binding_sha256);
      same(stepBinding.home, binding.home);
      same(stepBinding.unit, binding.unit);
      same(stepBinding.controller, binding.controller);
      same(stepBinding.tools, binding.tools);
      same(stepBinding.account, binding.account);
      assert.equal(stepBinding.application.path, binding.application.path);
      same(
        { bytes: stepBinding.application.bytes, sha256: stepBinding.application.sha256 },
        item.package,
      );
      same(await json(`package-${id}-replacement.json`), item.replacement);
      const preference = await guestBytes(`package-${id}.preferences.bin`, 65536);
      entries.push({
        ...item,
        preferences_capture_sha256: sha(preference),
        native: await json(`${id}/evidence.json`),
        runtime: await json(`${id}/linux-native-runtime.json`),
        restart: await json(`${id}/restart-observations.json`),
      });
    }
    publicationDetails = {
      payload_cryptography: selected.payload_cryptography,
      predecessor_version: selected.predecessor?.version ?? null,
      entries,
    };
  }
  const guestHostBytes = await readBoundedPublicBuildInputFile(
      directory,
      actual.host_filename,
      65536,
    ),
    host: unknown = JSON.parse(guestHostBytes.toString("utf8"));
  const materializationBytes = await readBoundedPublicBuildInputFile(
      directory,
      publication ? "stage-candidate.stdout.bin" : "stage-application.stdout.bin",
      65536,
    ),
    materialization = object(JSON.parse(materializationBytes.toString("utf8")));
  assert.equal(materialization.invocation_id, request.invocation_id);
  assert.equal(materialization.entry, publication ? "candidate" : "application");
  assert.equal(materialization.bytes, request.candidate.package.bytes);
  assert.equal(materialization.sha256, request.candidate.package.sha256);
  assert.equal(materialization.staged, true);
  assert.equal(materialization.authority, "none");
  if (publication && selected.predecessor) {
    const previous = object(
      JSON.parse(
        (
          await readBoundedPublicBuildInputFile(directory, "stage-predecessor.stdout.bin", 65536)
        ).toString("utf8"),
      ),
    );
    assert.equal(previous.invocation_id, request.invocation_id);
    assert.equal(previous.entry, "predecessor");
    assert.equal(previous.bytes, selected.predecessor.bytes);
    assert.equal(previous.sha256, selected.predecessor.sha256);
    assert.equal(previous.staged, true);
    assert.equal(previous.authority, "none");
  }
  const joins = [];
  for (const output of outputs)
    for (const index of [1, 2])
      joins.push(object(await json(`${output}/linux-native-launch-${index}-join.json`)));
  assert.equal(
    retained.entries.filter((value) =>
      /^(?:desktop|candidate|predecessor|rollback)\/linux-native-launch-[0-9]+-join\.json$/u.test(
        value.path,
      ),
    ).length,
    outputs.length * 2,
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
    const bytes = await readNativeCapturedStream(retained.directory, original);
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
  const stageCapture = actual.serialize(
    {
      schema_version: 1,
      stage: request.stage,
      platform_label: request.platform_label,
      candidate: request.candidate,
      journey: request.journey,
      invocation_id: request.invocation_id,
      setup_descriptor_sha256: request.setup_descriptor_sha256,
    },
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
  const source = await actual.readSource();
  await actual.recheck();
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
    ...(publicationDetails ? { publication: publicationDetails } : {}),
  };
  const result =
    backend === "hosted"
      ? publication
        ? reconstructHostedNativeLinuxPostSignReport(prepared, input, source.declaration)
        : reconstructHostedNativeLinuxPreSignReport(prepared, input, source.declaration)
      : publication
        ? reconstructNativeLinuxPostSignReport(prepared, input, source.declaration)
        : reconstructNativeLinuxPreSignReport(prepared, input, source.declaration);
  await keep("native-linux-stage-evidence.json", Buffer.from(JSON.stringify(input)));
  await keep("capture.json", Buffer.from(stageCapture.bytes));
  await keep("native-report.json", Buffer.from(JSON.stringify(result.report)));
  if (backend === "hosted") await actual.readSource();
  await actual.recheck();
  const receipt = Object.freeze({
    kind:
      backend === "wsl" ? "actual-direct-linux-native-report" : "actual-hosted-linux-native-report",
    authority: "none",
  });
  actualReports.set(receipt, {
    capture: captured,
    backend,
    stopped: false,
    files: Object.freeze(files),
    report_sha256: digest(result.report),
  });
  return receipt;
}
export function isActualLinuxNativeStageReport(receipt: object) {
  return actualReports.get(receipt)?.backend === "wsl";
}
export function isActualHostedLinuxNativeStageReport(receipt: object) {
  const retained = actualReports.get(receipt);
  return retained?.backend === "hosted" && !retained.stopped;
}
async function readReport(receipt: object, backend: "wsl" | "hosted") {
  const retained = actualReports.get(receipt);
  if (!retained || retained.backend !== backend || retained.stopped)
    throw new Error("original matching Linux native capture/report required");
  try {
    const actual = await reportBackend(retained.capture, backend);
    await actual.readSource();
    await actual.recheck();
    for (const file of retained.files) {
      const bytes = /\.(?:stdout|stderr)\.bin$/u.test(file.name)
        ? await readNativeCapturedStream(actual.directory, file.name)
        : await readBoundedPublicBuildInputFile(
            actual.directory,
            file.name,
            Math.max(1, file.bytes),
          );
      assert.equal(bytes.byteLength, file.bytes);
      assert.equal(sha(bytes), file.sha256, "actual Linux report input changed");
    }
    const report = inspectNativeReleaseQualification(
      JSON.parse(
        (
          await readBoundedPublicBuildInputFile(actual.directory, "native-report.json", 65536)
        ).toString("utf8"),
      ),
    );
    assert.equal(digest(report), retained.report_sha256);
    if (backend === "hosted") await actual.readSource();
    await actual.recheck();
    return { retained, report };
  } catch (error) {
    if (backend === "hosted") retained.stopped = true;
    throw error;
  }
}
export async function requireActualLinuxNativeStageReport(receipt: object) {
  const { retained, report } = await readReport(receipt, "wsl");
  const actual = await requireActualWslNativeCapture(retained.capture);
  return { ...actual, report, report_sha256: retained.report_sha256, authority: "none" as const };
}
export async function requireActualHostedLinuxNativeStageReport(receipt: object) {
  const { retained, report } = await readReport(receipt, "hosted");
  const actual = await requireActualHostedNativeLinuxCapture(retained.capture);
  return {
    ...actual,
    report,
    report_sha256: retained.report_sha256,
    original_file_identities: Object.freeze(
      retained.files.map((file) => Object.freeze({ ...file })),
    ),
    authority: "none" as const,
  };
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
