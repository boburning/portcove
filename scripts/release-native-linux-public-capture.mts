/** Fixed Windows parent -> ordinary shipped Linux public journey. Actual source
 * custody and technical teardown remain distinct from native acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { requireActualPublicJourneyInvocation } from "./release-native-attempt.mts";
import { remainingNativeParentBudget } from "./release-native-parent.mts";
import { inspectNativeWslBoundary } from "./release-native-wsl-boundary.mts";
import {
  observeActualPublicWslRegistration,
  inspectNativeWslGuestHost,
} from "./release-native-wsl-host.mts";
import { readNativeWslControllerSourcePin } from "./release-native-wsl-capture.mts";
import { readNativeSchedulerToolDigest } from "./release-native-scheduler.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  retainNativeCaptureWire,
  hashRetainedNativeCaptureFile,
} from "./release-native-wsl-wire.mts";
import { runResourceCommand } from "./resource-command.mts";
import { runRustTests } from "./run-rust-tests.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectPublicNativeLinuxBinding } from "../apps/desktop/scripts/native-linux-public-plan.mts";
import { isRecord } from "./runtime-values.mts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Claim = Awaited<ReturnType<typeof requireActualPublicJourneyInvocation>>;
type Captured = Awaited<ReturnType<typeof retainNativeCaptureWire>>;
const captures = new WeakMap<
  object,
  {
    claim: object;
    directory: string;
    summary_sha256: string;
    wire: { path: string; bytes: number; sha256: string };
    retained: Captured;
    registration_sha256: string;
    files: readonly { path: string; sha256: string; bytes: number }[];
  }
>();

/** Integrity only. The private capture factory supplies the actual readback. */
export function inspectLinuxPublicTechnicalClosure(
  raw: unknown,
  invocation: string,
  requestSha: string,
) {
  assert.ok(isRecord(raw));
  assert.equal(raw.invocation_id, invocation);
  assert.equal(raw.request_sha256, requestSha);
  assert.equal(raw.authority, "none");
  assert.equal(raw.unit, `portcove-native-${invocation}.service`);
  assert.match(String(raw.unit_invocation_id), /^[a-f0-9]{32}$/u);
  assert.equal(raw.cgroup_empty, true);
  assert.equal(raw.unit_settled, true);
  assert.ok(
    ["observed-unpopulated", "removed-exact-held-cgroup"].includes(String(raw.cgroup_settlement)),
  );
  assert.ok(
    isRecord(raw.cgroup_identity) &&
      Number.isSafeInteger(raw.cgroup_identity.device) &&
      Number.isSafeInteger(raw.cgroup_identity.inode),
  );
  assert.ok(isRecord(raw.root_identity));
  assert.ok(Number.isSafeInteger(raw.root_identity.pid) && Number(raw.root_identity.pid) > 0);
  assert.match(String(raw.root_identity.creation_ticks), /^[1-9][0-9]{0,19}$/u);
  assert.ok(Number.isSafeInteger(raw.exit_code), "actual unit exit status remains unknown");
  assert.ok(typeof raw.completed_at === "string" && Number.isFinite(Date.parse(raw.completed_at)));
  return Object.freeze({
    group: { empty: true as const, observed_at: raw.completed_at, remaining_pids: [] },
    roots: [
      {
        root_pid: Number(raw.root_identity.pid),
        creation: {
          kind: "linux-starttime-ticks" as const,
          value: String(raw.root_identity.creation_ticks),
        },
        root_exited: true as const,
        job_empty: true as const,
        remaining_pids: [],
        exit_code: Number(raw.exit_code),
      },
    ],
    authority: "none" as const,
  });
}

export async function captureActualLinuxPublicJourney(claim: object) {
  const selected = await requireActualPublicJourneyInvocation(claim),
    parent = selected.parent;
  assert.equal(process.platform, "win32");
  assert.equal(parent.descriptor.platform_label, "linux-x86_64");
  assert.ok(selected.phase === "initial-v0-v1" || selected.phase === "park-v0-with-v1");
  assert.equal(
    fileURLToPath(import.meta.url),
    path.join(parent.controller_root, "scripts/release-native-linux-public-capture.mts"),
  );
  const configured = parent.authority_configuration.native["linux-x86_64"],
    account = configured.host.account;
  const boundary = inspectNativeWslBoundary(
    parent.boundary_configuration,
    account,
    parent.controller_root,
    parent.descriptor.capture_root,
  );
  const directory = selected.capture_directory,
    invocation = selected.invocation_id,
    guest = `${boundary.linux_root}/invocations/${invocation}`;
  const before = await observeActualPublicWslRegistration(selected.pair_receipt);
  const pin = (name: string) => readNativeWslControllerSourcePin(parent.controller_root, name);
  const [supervisor, support, driver, init, transfer, fuse, network, services] = await Promise.all(
    [
      "scripts/native-qualification-linux-supervisor.py",
      "scripts/semantic-review-linux-supervisor.py",
      "scripts/release-native-linux-driver.mts",
      "apps/desktop/scripts/native-linux-isolated-init.py",
      "scripts/native-qualification-linux-transfer.py",
      "apps/desktop/scripts/native-linux-public-fuse.py",
      "apps/desktop/scripts/native-linux-public-network.py",
      "apps/desktop/scripts/native-linux-public-services.py",
    ].map(pin),
  );
  assert.equal(supervisor, boundary.supervisor_sha256);
  const remaining = () =>
    Math.floor(
      Math.min(selected.original_deadline - performance.now(), remainingNativeParentBudget()),
    );
  const available = remaining() - 60000;
  assert.ok(available > 0);
  const deadline_utc = new Date(Date.now() + Math.min(1800000, available)).toISOString();
  const tools: Record<string, { path: string; sha256: string }> = {};
  for (const name of ["bwrap", "git", "node", "python", "webkit_driver", "xvfb", "driver"]) {
    const value = boundary.tools[name === "driver" ? "tauri_driver" : name];
    assert.ok(value);
    tools[name] = { ...value };
  }
  const binding = {
    schema_version: 1,
    invocation_id: invocation,
    linux_root: boundary.linux_root,
    account: {
      uid: Number(boundary.account.qualification),
      gid: Number(boundary.qualification_gid),
    },
    application: {
      path: `${guest}/install/Portcove.AppImage`,
      bytes: selected.prior_package.identity.package.bytes,
      sha256: selected.prior_package.identity.package.sha256,
    },
    controller: {
      root: `${boundary.linux_root}/controller`,
      source_commit: parent.descriptor.controller_revision,
      source_tree: parent.controller_tree,
      init_sha256: init,
    },
    tools,
    capture_root: `${guest}/capture`,
    home: `${guest}/work/home`,
    deadline_utc,
  };
  const resolver = new Resolver({ timeout: Math.max(1, Math.min(5000, remaining())), tries: 1 });
  const dnsTimer = setTimeout(() => resolver.cancel(), Math.max(1, Math.min(5000, remaining())));
  let addresses: Record<string, string[]>;
  try {
    addresses = Object.fromEntries(
      await Promise.all(
        ["boburning.github.io", "github.com", "release-assets.githubusercontent.com"].map(
          async (host) => {
            assert.ok(remaining() > 0);
            const values = [...new Set(await resolver.resolve4(host))].sort();
            assert.ok(remaining() > 0 && values.length > 0 && values.length <= 8);
            return [host, values] as const;
          },
        ),
      ),
    );
  } finally {
    clearTimeout(dnsTimer);
    resolver.cancel();
  }
  await requireActualPublicJourneyInvocation(claim);
  const journey = {
    candidate: {
      path: `${guest}/packages/Candidate.AppImage`,
      bytes: selected.candidate_package.identity.package.bytes,
      sha256: selected.candidate_package.identity.package.sha256,
    },
    network: {
      metadata_base_url: "https://boburning.github.io/portcove/application/metadata/",
      targets_base_url: "https://boburning.github.io/portcove/application/targets/",
      addresses,
    },
    phase: selected.phase,
    profile_id: selected.client,
    retained_state_bytes: 64 * 1024 * 1024,
    source: { fuse_sha256: fuse, network_sha256: network, services_sha256: services },
    versions: {
      prior: selected.prior_package.identity.version,
      candidate: selected.candidate_package.identity.version,
    },
  };
  inspectPublicNativeLinuxBinding({
    schema_version: 1,
    session: binding,
    ...Object.fromEntries(Object.entries(journey).filter(([key]) => key !== "versions")),
  });
  const planBytes = Buffer.from(
    JSON.stringify({
      schema_version: 3,
      invocation_id: invocation,
      stage: "ordinary-public-update",
      stage_request_sha256: selected.request_sha256,
      binding,
      public_journey: journey,
    }),
  );
  const requestBytes = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      invocation_id: invocation,
      stage_request_sha256: selected.request_sha256,
      qualification_uid: binding.account.uid,
      qualification_gid: binding.account.gid,
      controller: {
        source_commit: parent.descriptor.controller_revision,
        source_tree: parent.controller_tree,
      },
      plan_sha256: sha(planBytes),
      supervisor_sha256: supervisor,
      support_sha256: support,
      driver_sha256: driver,
      tools_sha256: Object.fromEntries(
        ["python", "bwrap", "systemd_run", "systemctl", "node", "git"].map((name) => [
          name,
          boundary.tools[name]!.sha256,
        ]),
      ),
      timeout_seconds: Math.max(1, Math.floor(Math.min(1800000, available) / 1000)),
      deadline_utc,
    }),
  );
  for (const [name, bytes] of [
    ["wsl-plan.json", planBytes],
    ["wsl-request.json", requestBytes],
    ["wsl-registration-before.json", Buffer.from(JSON.stringify(before))],
  ] as const)
    await writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
  const driverPlan = {
    schema_version: 3,
    invocation_id: invocation,
    request_sha256: sha(requestBytes),
    plan_sha256: sha(planBytes),
    stage_request_sha256: selected.request_sha256,
    controller_root: parent.controller_root,
    capture_root: parent.descriptor.capture_root,
    capture_directory: directory,
    boundary_configuration: parent.boundary_configuration,
    account,
    package: {
      path: selected.prior_package.path,
      bytes: binding.application.bytes,
      sha256: binding.application.sha256,
    },
    candidate: {
      path: selected.candidate_package.path,
      bytes: journey.candidate.bytes,
      sha256: journey.candidate.sha256,
    },
    node: {
      path: process.execPath,
      sha256: await readNativeSchedulerToolDigest(process.execPath, 128 * 1024 * 1024),
    },
    parent_deadline_utc: new Date(Date.now() + remaining()).toISOString(),
    entry_pins: {
      supervisor_sha256: supervisor,
      transfer_sha256: transfer,
      controller_revision: parent.descriptor.controller_revision,
      controller_tree: parent.controller_tree,
    },
    host_expected: {
      machine_id_sha256: configured.host.machine_id_sha256,
      minimum_os_version: configured.compatibility.minimum_os_version,
    },
  };
  const driverBytes = Buffer.from(JSON.stringify(driverPlan)),
    driverPath = path.join(directory, "wsl-driver-plan.json");
  await writeFile(driverPath, driverBytes, { flag: "wx", mode: 0o600 });
  const signal = new EventEmitter();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await runResourceCommand(
      "analysis",
      process.execPath,
      [
        path.join(parent.controller_root, "scripts/release-native-wsl-capture.mts"),
        "--driver",
        driverPath,
        sha(driverBytes),
      ],
      {
        cwd: parent.controller_root,
        environment: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.SystemRoot,
          USERPROFILE: process.env.USERPROFILE,
          PATH: path.join(String(process.env.SystemRoot), "System32"),
          TEMP: directory,
          TMP: directory,
        },
        exclusive: [`native-wsl:${boundary.account.qualification}`],
        supervise: (args, options) =>
          runRustTests(args, {
            ...options,
            tempRoot: directory,
            signalTarget: signal,
            acquireLock: async (metadata, admission) => {
              assert.ok(options.acquireLock);
              const lease = await options.acquireLock(metadata, admission);
              try {
                await requireActualPublicJourneyInvocation(claim);
                const left = remaining();
                assert.ok(left > 0);
                timer = setTimeout(() => signal.emit("SIGTERM"), left);
                return lease;
              } catch (error) {
                await lease.release();
                throw error;
              }
            },
          }),
      },
    );
  } finally {
    clearTimeout(timer);
  }
  await requireActualPublicJourneyInvocation(claim);
  const summaryBytes = await readBoundedPublicBuildInputFile(
      directory,
      "wsl-capture-summary.json",
      128 * 1024,
    ),
    summary: unknown = JSON.parse(summaryBytes.toString("utf8"));
  assert.ok(isRecord(summary));
  assert.equal(summary.invocation_id, invocation);
  assert.equal(summary.request_sha256, sha(requestBytes));
  assert.equal(summary.stage_request_sha256, selected.request_sha256);
  const after = await observeActualPublicWslRegistration(selected.pair_receipt);
  assert.equal(digest(after.observed.registration), digest(before.observed.registration));
  await writeFile(
    path.join(directory, "wsl-registration-after.json"),
    Buffer.from(JSON.stringify(after)),
    { flag: "wx", mode: 0o600 },
  );
  const wirePath = path.join(directory, "public-capture.stdout.bin");
  assert.equal(summary.capture_wire, wirePath);
  const wireSha = await hashRetainedNativeCaptureFile(
      directory,
      "public-capture.stdout.bin",
      272 * 1024 * 1024,
    ),
    retained = await retainNativeCaptureWire(
      wirePath,
      path.join(directory, "guest-capture"),
      invocation,
      wireSha,
      selected.original_deadline,
    );
  const files = [];
  assert.ok(typeof driverPlan.host_expected.machine_id_sha256 === "string");
  assert.ok(typeof driverPlan.host_expected.minimum_os_version === "string");
  for (const name of [
    "wsl-registration-before.json",
    "wsl-registration-after.json",
    "guest-host-before.stdout.bin",
    "guest-host-after.stdout.bin",
  ]) {
    const bytes = await readBoundedPublicBuildInputFile(directory, name, 65536);
    files.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
    if (name.startsWith("guest-host")) {
      assert.equal(
        sha(bytes),
        summary[name.includes("before") ? "host_before_sha256" : "host_after_sha256"],
      );
      inspectNativeWslGuestHost(JSON.parse(bytes.toString("utf8")), boundary, invocation, {
        machine_id_sha256: driverPlan.host_expected.machine_id_sha256,
        minimum_os_version: driverPlan.host_expected.minimum_os_version,
      });
    }
  }
  const receipt = Object.freeze({
    kind: "actual-linux-public-capture",
    authority: "none",
    native_acceptance: "not-established",
  });
  captures.set(receipt, {
    claim,
    directory,
    summary_sha256: sha(summaryBytes),
    wire: {
      path: "public-capture.stdout.bin",
      bytes: (await lstat(wirePath)).size,
      sha256: wireSha,
    },
    retained,
    registration_sha256: digest(after.observed.registration),
    files,
  });
  return receipt;
}

export async function requireActualLinuxPublicCapture(receipt: object) {
  const retained = captures.get(receipt);
  if (!retained) throw new Error("actual installed Linux public capture required");
  const selected: Claim = await requireActualPublicJourneyInvocation(retained.claim);
  const registration = await observeActualPublicWslRegistration(selected.pair_receipt);
  assert.equal(digest(registration.observed.registration), retained.registration_sha256);
  const summaryBytes = await readBoundedPublicBuildInputFile(
    retained.directory,
    "wsl-capture-summary.json",
    128 * 1024,
  );
  assert.equal(sha(summaryBytes), retained.summary_sha256);
  const summary: unknown = JSON.parse(summaryBytes.toString("utf8"));
  assert.ok(isRecord(summary));
  const closure = inspectLinuxPublicTechnicalClosure(
    summary.readback,
    selected.invocation_id,
    String(summary.request_sha256),
  );
  assert.equal(
    await hashRetainedNativeCaptureFile(
      retained.directory,
      retained.wire.path,
      272 * 1024 * 1024,
      retained.wire.bytes,
    ),
    retained.wire.sha256,
  );
  for (const file of retained.files)
    assert.equal(
      await hashRetainedNativeCaptureFile(retained.directory, file.path, 65536, file.bytes),
      file.sha256,
    );
  for (const file of retained.retained.entries)
    assert.equal(
      await hashRetainedNativeCaptureFile(
        retained.retained.directory,
        file.path,
        32 * 1024 * 1024,
        file.bytes,
      ),
      file.sha256,
    );
  const reportEntry = retained.retained.entries.find(
    (file) => file.path === "public-journey/public-update-journey.json",
  );
  assert.ok(reportEntry && reportEntry.bytes > 0 && reportEntry.bytes <= 4 * 1024 * 1024);
  const reportBytes = await readBoundedPublicBuildInputFile(
    retained.retained.directory,
    reportEntry.path,
    4 * 1024 * 1024,
  );
  assert.equal(sha(reportBytes), reportEntry.sha256);
  const report: unknown = JSON.parse(reportBytes.toString("utf8"));
  assert.ok(isRecord(report) && report.authority === "none" && report.phase === selected.phase);
  return {
    claim: retained.claim,
    selected,
    directory: retained.directory,
    wire: { ...retained.wire },
    retained: retained.retained,
    files: retained.retained.entries,
    driver_status: summary.status,
    driver_failure: summary.failure,
    report,
    report_identity: { ...reportEntry },
    ...closure,
    authority: "none" as const,
    scope:
      "actual parent capture custody and technical closure; public acceptance remains separate",
  };
}
