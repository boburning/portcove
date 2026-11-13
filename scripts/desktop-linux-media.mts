// Fixed, disposable hosted media prerequisites for the existing ordinary-DEB
// scenario. This never changes WebKit permission policy or the shipped package.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ExecFileSyncOptions } from "node:child_process";
import type { Stats } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { appendFileSync, constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  lstat,
  readdir,
  realpath,
  copyFile,
  cp,
  readlink,
  link,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileIdentity } from "./development-evidence.mts";
import type { FileIdentity } from "./development-evidence.mts";
import { errorCode, errorMessage, isRecord } from "./runtime-values.mts";
import type { executionAdmission } from "./retained-evidence.mts";
import { acquireNativeSessionLock } from "./native-session-lock.mts";
import { toolCachePaths } from "./tool-cache.mts";
import { launchLinuxNativeSession } from "../apps/desktop/scripts/desktop-linux-native-session.mts";

const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "work/linux-packaged-security");
const device = "/dev/video42";
const sourceName = "portcove_qualification";
type NativeLaunch = Awaited<ReturnType<typeof launchLinuxNativeSession>>;
type WrapperEvent = { kind: string; code?: number | null; signal?: string | null };
type ReadinessLaunch = {
  receipt: { events: readonly WrapperEvent[] };
  child: { exitCode: number | null };
};
interface MediaConfiguration {
  cookie: string;
  socket: string;
  source: string;
  source_head: string;
  video: string;
}
interface PreparationReceipt {
  source: string;
  uid: number;
  gid: number;
  kernel: string;
  os_release: string;
  image_os: string | null;
  image_version: string | null;
  module_created: boolean;
  phase: string;
  packages?: string;
  module?: FileIdentity;
  module_package_owner?: string;
  module_version?: string;
  module_signer?: string;
  module_vermagic?: string;
  device?: ReturnType<typeof nodeIdentity>;
  tools?: FileIdentity[];
  failure?: { name: string; message: string };
}
interface ApplicationReport {
  phase: string;
  configuration: FileIdentity;
  source: FileIdentity;
  executable?: FileIdentity;
  wrapper?: Awaited<ReturnType<typeof mediaNamespace>>;
  probe?: Awaited<ReturnType<typeof probe>>;
  positive_reads_completed_at?: string;
  application?: Awaited<ReturnType<typeof mediaNamespace>>;
  application_observed_at?: string;
}
function uid() {
  assert.ok(process.getuid, "Linux UID support required");
  return process.getuid();
}
function gid() {
  assert.ok(process.getgid, "Linux GID support required");
  return process.getgid();
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Media evidence must be an object");
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string", "Media evidence text required");
  return value;
}
function identity(value: unknown): FileIdentity {
  const record = object(value);
  assert.ok(
    typeof record.bytes === "number" && Number.isSafeInteger(record.bytes) && record.bytes >= 0,
  );
  const sha256 = text(record.sha256);
  assert.match(sha256, /^[a-f0-9]{64}$/u);
  return { ...record, path: text(record.path), bytes: record.bytes, sha256 };
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const command = (
  program: string,
  args: readonly string[],
  options: Omit<ExecFileSyncOptions, "encoding"> = {},
) =>
  execFileSync(program, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 128 * 1024,
    ...options,
  });
const revision = () => command("git", ["rev-parse", "HEAD"]).trim();
const nodeIdentity = (node: Stats) => ({
  ino: node.ino,
  rdev: node.rdev,
  ctime_ms: node.ctimeMs,
  uid: node.uid,
  gid: node.gid,
  mode: node.mode,
});
const save = (file: string, value: unknown, exclusive = true) =>
  writeFile(file, JSON.stringify(value, null, 2) + "\n", {
    flag: exclusive ? "wx" : "w",
    mode: 0o600,
  });

export function assertMediaWrapperOutcome(events: readonly WrapperEvent[]) {
  for (const event of events) {
    assert.notEqual(event.kind, "driver-error", "Application media wrapper launch failed");
    if (event.kind === "driver-exited")
      assert.deepEqual(
        { code: event.code, signal: event.signal },
        { code: 0, signal: null },
        "Application media wrapper exited unsuccessfully before namespace cleanup",
      );
  }
}

export async function verifyApplicationMediaInputs(
  inputs: readonly unknown[],
  admission: ReturnType<typeof executionAdmission>,
) {
  admission.assertReady();
  for (const input of inputs) {
    const record = object(input);
    const captured = identity(record);
    // Retained custody and package/configuration identities have distinct
    // formats. A malformed retained record must never fall back to a live read.
    if (Object.hasOwn(record, "retained")) {
      const binding = record.binding;
      assert.ok(
        binding === "retained-artifact" ||
          binding === "retained-metadata-read" ||
          binding === "live-path-checked-cooperative",
      );
      await admission.verify([{ ...captured, retained: identity(record.retained), binding }]);
    } else {
      const observed = await fileIdentity(captured.path, {
        maxBytes: captured.bytes,
        signal: admission.signal,
      });
      assert.equal(observed.bytes, captured.bytes, "Application media input size changed");
      assert.equal(observed.sha256, captured.sha256, "Application media input bytes changed");
    }
  }
  admission.assertReady();
}

/** Bind both readiness inputs to the originally captured bytes. */
export function assertCapturedApplicationMediaBindings(
  readiness: unknown,
  inputs: readonly unknown[],
) {
  const media = object(readiness);
  for (const value of [media.configuration, media.source]) {
    const binding = object(value);
    const captured = inputs.find((input) => object(input).path === binding.path);
    assert.ok(captured, "Application media readiness requires captured configuration/source");
    const capturedIdentity = object(captured);
    assert.equal(binding.sha256, capturedIdentity.sha256);
    assert.equal(binding.bytes, capturedIdentity.bytes);
  }
}

/** The connected inspector must enter caller custody before any post-connect
 * media check can fail. The harness still owns connection and final teardown. */
export async function verifyConnectedApplicationMedia<
  Inspector extends { ownedProcessIdentity?: unknown },
>({
  inspector,
  retain,
  inputs,
  admission,
  readiness,
}: {
  inspector: Inspector;
  retain: (inspector: Inspector) => void;
  inputs: readonly unknown[];
  admission: ReturnType<typeof executionAdmission>;
  readiness: unknown;
}): Promise<void> {
  retain(inspector);
  await verifyApplicationMediaInputs(inputs, admission);
  assertCapturedApplicationMediaBindings(readiness, inputs);
  assertApplicationMediaReadiness(readiness, inspector.ownedProcessIdentity);
}

export async function publishApplicationMediaReadiness(file: string, value: unknown) {
  const pending = `${file}.pending`;
  await save(pending, value);
  // A hard link publishes complete bytes atomically and refuses replacement.
  await link(pending, file);
  await unlink(pending);
}

export async function awaitApplicationMediaReadiness(
  file: string,
  launch: ReadinessLaunch,
  deadline: number,
): Promise<unknown> {
  for (;;) {
    assert.ok(Date.now() < deadline, "Application media readiness deadline");
    assertMediaWrapperOutcome(launch.receipt.events);
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    assert.equal(launch.child.exitCode, null, "Namespace exited before media readiness");
    await pause(Math.max(1, Math.min(20, deadline - Date.now())));
  }
}

export async function failApplicationMediaWrapper(
  evidence: string,
  report: object,
  error: unknown,
): Promise<never> {
  try {
    await save(`${evidence}.failure.json`, {
      ...report,
      phase: "failed",
      failure: {
        name: error instanceof Error ? error.name : "Error",
        message: errorMessage(error),
      },
    });
  } catch (secondary) {
    console.error(`Application media failure persistence (secondary): ${errorMessage(secondary)}`);
  }
  console.error(error);
  // A live app child must not keep a failed wrapper alive. The existing PID1
  // retains descendant custody and reports this nonzero driver exit separately.
  process.exit(1);
}

export function assertHostedMediaEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: string,
  uid: number | undefined,
) {
  assert.equal(platform, "linux");
  assert.ok(
    typeof uid === "number" && Number.isSafeInteger(uid) && uid > 0,
    "Use an ordinary runner user",
  );
  assert.equal(environment.GITHUB_ACTIONS, "true");
  assert.equal(environment.GITHUB_REPOSITORY, "boburning/portcove");
  assert.equal(environment.RUNNER_OS, "Linux");
  assert.equal(environment.RUNNER_ARCH, "X64");
  assert.equal(
    environment.RUNNER_ENVIRONMENT,
    "github-hosted",
    "Never provision a user or self-hosted kernel",
  );
}

async function prepare() {
  assertHostedMediaEnvironment(process.env, process.platform, process.getuid?.());
  assert.equal(revision(), process.env.GITHUB_SHA);
  assert.equal(command("git", ["status", "--porcelain"]).trim(), "");
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const receipt: PreparationReceipt = {
    source: revision(),
    uid: uid(),
    gid: gid(),
    kernel: command("uname", ["-r"]).trim(),
    os_release: await readFile("/etc/os-release", "utf8"),
    image_os: process.env.ImageOS ?? null,
    image_version: process.env.ImageVersion ?? null,
    module_created: false,
    phase: "preflight",
  };
  const record = () => save(path.join(output, "media-preparation.json"), receipt, false);
  await record();
  try {
    assert.match(receipt.kernel, /^[A-Za-z0-9._+-]+$/u);
    assert.equal(
      (await readdir("/dev")).some((name) => /^video\d+$/u.test(name)),
      false,
      "Refuse existing camera devices",
    );
    assert.equal(
      (await readdir("/sys/module")).includes("vivid"),
      false,
      "Refuse a pre-existing module",
    );
    command("sudo", ["-n", "true"]);
    receipt.phase = "distribution-prerequisites";
    await record();
    command("sudo", ["-n", "apt-get", "update"], { timeout: 14 * 60_000, stdio: "inherit" });
    command(
      "sudo",
      [
        "-n",
        "apt-get",
        "install",
        "--yes",
        "--no-install-recommends",
        `linux-modules-extra-${receipt.kernel}`,
        "v4l-utils",
        "pulseaudio",
        "pulseaudio-utils",
        "gstreamer1.0-tools",
        "gstreamer1.0-plugins-base",
        "gstreamer1.0-plugins-good",
      ],
      { timeout: 14 * 60_000, stdio: "inherit" },
    );
    receipt.packages = command("dpkg-query", [
      "-W",
      "-f=${Package}=${Version}\n",
      `linux-modules-extra-${receipt.kernel}`,
      "v4l-utils",
      "pulseaudio",
      "pulseaudio-utils",
      "gstreamer1.0-tools",
      "gstreamer1.0-plugins-base",
      "gstreamer1.0-plugins-good",
    ]);
    receipt.module = await fileIdentity(command("modinfo", ["-n", "vivid"]).trim());
    receipt.module_package_owner = command("dpkg-query", ["-S", receipt.module.path]).trim();
    assert.ok(receipt.module_package_owner.startsWith(`linux-modules-extra-${receipt.kernel}: `));
    receipt.module_version = command("modinfo", ["-F", "version", "vivid"]).trim();
    receipt.module_signer = command("modinfo", ["-F", "signer", "vivid"]).trim();
    receipt.module_vermagic = command("modinfo", ["-F", "vermagic", "vivid"]).trim();
    assert.equal(receipt.module_vermagic.split(" ")[0], receipt.kernel);
    receipt.phase = "normal-module-load";
    await record();
    assert.equal((await readdir("/sys/module")).includes("vivid"), false);
    assert.equal(
      (await readdir("/dev")).some((name) => /^video\d+$/u.test(name)),
      false,
    );
    // A signature/Secure Boot/module refusal is a failure. No key enrollment,
    // alternate kernel, reboot, custom module or security-policy override.
    command(
      "sudo",
      [
        "-n",
        "modprobe",
        "vivid",
        "n_devs=1",
        "node_types=0x1",
        "num_inputs=1",
        "input_types=0",
        "vid_cap_nr=42",
        "no_error_inj=1",
      ],
      { stdio: "inherit" },
    );
    receipt.module_created = true;
    await record();
    command("sudo", ["-n", "udevadm", "settle", "--timeout=5"], {
      timeout: 6000,
      stdio: "inherit",
    });

    assert.equal((await lstat(device)).isCharacterDevice(), true);
    assert.match(
      await readFile("/sys/class/video4linux/video42/name", "utf8"),
      /^vivid-000-vid-cap\s*$/u,
    );
    command("sudo", ["-n", "chown", `${receipt.uid}:${receipt.gid}`, device]);
    command("sudo", ["-n", "chmod", "600", device]);
    assert.deepEqual(
      (await readdir("/dev")).filter((name) => /^video\d+$/u.test(name)),
      ["video42"],
    );
    command("/usr/bin/v4l2-ctl", [
      "--device",
      device,
      "--set-fmt-video=width=640,height=360,pixelformat=YUYV",
      "--set-parm=30",
    ]);
    receipt.device = nodeIdentity(await lstat(device));
    receipt.tools = await Promise.all(
      ["/usr/bin/pulseaudio", "/usr/bin/pactl", "/usr/bin/v4l2-ctl", "/usr/bin/gst-launch-1.0"].map(
        (file) => fileIdentity(file),
      ),
    );
    receipt.phase = "prepared";
  } catch (error) {
    receipt.failure = {
      name: error instanceof Error ? error.name : "Error",
      message: errorMessage(error),
    };
    throw error;
  } finally {
    await record();
  }
}

async function build() {
  assertHostedMediaEnvironment(process.env, process.platform, process.getuid?.());
  assert.equal(revision(), process.env.GITHUB_SHA);
  assert.equal(command("git", ["status", "--porcelain"]).trim(), "");
  const environment = { ...process.env };
  for (const name of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ])
    assert.equal(environment[name], undefined, "Signing authority must be absent");
  for (const name of Object.keys(environment))
    if (
      /^(PORTCOVE_|VITE_PORTCOVE_|TAURI_|CARGO_FEATURE_|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$)/iu.test(
        name,
      ) &&
      !/^PORTCOVE_HEAVY_RUST/iu.test(name)
    )
      delete environment[name];
  const start = {
    revision: revision(),
    build_command: ["pnpm", "--dir", "apps/desktop", "desktop:build", "--bundles", "deb"] as const,
    qualification_features: [],
    started_at: new Date().toISOString(),
  };
  await save(path.join(output, "build-start.json"), start);
  command(start.build_command[0], start.build_command.slice(1), {
    env: environment,
    timeout: 25 * 60_000,
    stdio: "inherit",
  });
  const packageRoot = path.join(root, "target/release/bundle/deb");
  const packages = (await readdir(packageRoot)).filter((file) => file.endsWith(".deb"));
  assert.equal(packages.length, 1);
  const packageName = packages[0];
  assert.ok(packageName);
  const retainedPackage = path.join(output, packageName);
  await copyFile(path.join(packageRoot, packageName), retainedPackage, constants.COPYFILE_EXCL);
  const packageIdentity = await fileIdentity(retainedPackage);
  const payload = path.join(output, "payload");
  await mkdir(payload, { mode: 0o700 });
  const extractionCommand = ["dpkg-deb", "--extract", retainedPackage, payload] as const;
  command(extractionCommand[0], extractionCommand.slice(1));
  const executable = await fileIdentity(path.join(payload, "usr/bin/portcove-desktop"));
  const extraction = path.join(output, "extraction-evidence.json");
  await save(extraction, {
    command: extractionCommand,
    exit_code: 0,
    payload_root: payload,
    package_sha256: packageIdentity.sha256,
    executable_sha256: executable.sha256,
  });
  const manifest = path.join(output, "package-evidence.json");
  await save(manifest, {
    revision: start.revision,
    build_command: start.build_command,
    qualification_features: [],
    execution_context: "extracted-deb-payload",
    package: packageIdentity,
    extraction_evidence: await fileIdentity(extraction),
    executable,
    configuration: await Promise.all(
      ["tauri.conf.json", "Cargo.toml"].map((file) =>
        fileIdentity(path.join(root, "apps/desktop/src-tauri", file)),
      ),
    ),
  });
  await cp(path.join(root, "apps/desktop/dist"), path.join(output, "frontend"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const metadata = path.join(output, "run-metadata.json");
  await save(metadata, {
    source_head: start.revision,
    execution_condition:
      "Ordinary default DEB under existing private X11 with disposable synthetic audio/video. Native media preflight is separate from unchanged strict permission refusals; no physical/minimum/installed-GUI claim.",
  });
  await save(path.join(output, "private-x11.json"), {
    format_version: 1,
    stage: "harness",
    xvfb: "/usr/bin/Xvfb",
    xkbcomp: "/usr/bin/xkbcomp",
    output_root: output,
    harness_args: [
      "--app",
      executable.path,
      "--output",
      path.join(output, "native"),
      "--driver",
      command("which", ["tauri-driver"]).trim(),
      "--native-driver",
      command("which", ["WebKitWebDriver"]).trim(),
      "--scenario",
      "native-linux-packaged-webview-boundary",
      "--package-evidence",
      manifest,
      "--run-metadata",
      metadata,
    ],
  });
  await save(path.join(output, "build-result.json"), {
    ...start,
    finished_at: new Date().toISOString(),
    exit_code: 0,
  });
}

export async function readMediaConfiguration(file: string): Promise<MediaConfiguration> {
  assert.ok(path.isAbsolute(file));
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  const value = object(raw);
  const config: MediaConfiguration = {
    cookie: text(value.cookie),
    socket: text(value.socket),
    source: text(value.source),
    source_head: text(value.source_head),
    video: text(value.video),
  };
  assert.deepEqual(
    Object.keys(value).sort(),
    ["cookie", "socket", "source", "source_head", "video"].sort(),
  );
  assert.equal(config.video, device);
  assert.equal(config.source, sourceName);
  assert.match(config.source_head, /^[a-f0-9]{40}$/u);
  for (const key of ["socket", "cookie"] as const) assert.ok(path.isAbsolute(config[key]));
  assert.equal(path.dirname(config.socket), path.dirname(config.cookie));
  assert.ok(Buffer.byteLength(config.socket) <= 107, "Private audio socket must fit AF_UNIX");
  const directory = await lstat(path.dirname(config.socket));
  assert.equal(directory.isDirectory(), true);
  assert.equal(directory.mode & 0o077, 0);
  assert.equal(directory.uid, uid());
  assert.equal(await realpath(path.dirname(config.socket)), path.dirname(config.socket));
  const cookie = await lstat(config.cookie);
  assert.equal(cookie.isFile(), true);
  assert.equal(cookie.mode & 0o077, 0);
  assert.equal(cookie.uid, uid());
  assert.equal(cookie.size, 256);
  return config;
}

export async function retainMediaVideoObservations(
  directory: string,
  video: string,
  after: string,
) {
  // Keep the existing per-command bound. Verbose driver controls belong in
  // retained files, not twice inside the 16 KiB namespace control message.
  for (const value of [video, after]) assert.ok(Buffer.byteLength(value) <= 128 * 1024);
  const retained = await mkdtemp(path.join(directory, "media-probe-"));
  const beforeFile = path.join(retained, "video-before.log");
  const afterFile = path.join(retained, "video-after.log");
  await writeFile(beforeFile, video, { flag: "wx", mode: 0o600 });
  await writeFile(afterFile, after, { flag: "wx", mode: 0o600 });
  return { video: await fileIdentity(beforeFile), video_after_read: await fileIdentity(afterFile) };
}

async function probe(file: string) {
  const config = await readMediaConfiguration(file);
  assert.equal(config.source_head, revision());
  assert.equal(process.env.PULSE_SERVER, `unix:${config.socket}`);
  assert.equal(process.env.PULSE_COOKIE, config.cookie);
  assert.equal(process.env.PULSE_SOURCE, sourceName);
  const node = await lstat(device);
  assert.equal(node.isCharacterDevice(), true);
  assert.equal(node.uid, uid(), "Device access must match the app's mapped user");
  // Reserve two seconds for serialization/join inside the existing ten-second
  // namespace probe boundary; individual commands cannot accumulate past it.
  const deadline = Date.now() + 8000;
  const observe = (program: string, args: readonly string[]) => {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "Mapped media readiness deadline expired");
    return command(program, args, { timeout: Math.min(5000, remaining) });
  };
  const sources = observe("/usr/bin/pactl", ["list", "short", "sources"]).trim().split("\n");
  assert.equal(sources.length, 1, "Only the private synthetic source may be exposed");
  const source = sources[0];
  assert.ok(source);
  assert.equal(source.split(/\s+/u)[1], sourceName);
  const video = observe("/usr/bin/v4l2-ctl", ["--device", device, "--all"]);
  assert.match(video, /Video Capture/u, "Kernel fixture must expose capture capability");
  assert.match(video, /640\/360/u);
  // Positive readiness reads synthetic media only. The unchanged app test must
  // still refuse capture, rather than succeeding because no device exists.
  observe("/usr/bin/gst-launch-1.0", [
    "-q",
    "v4l2src",
    `device=${device}`,
    "num-buffers=1",
    "!",
    // Keep the first readiness read from renegotiating the shared Vivid device
    // before the identical probe runs in the final application namespace.
    "video/x-raw,format=YUY2,width=640,height=360,framerate=30/1",
    "!",
    "fakesink",
  ]);
  const videoAfterRead = observe("/usr/bin/v4l2-ctl", ["--device", device, "--all"]);
  assert.match(videoAfterRead, /640\/360/u, "Positive read changed the prepared video mode");
  assert.match(videoAfterRead, /Pixel Format\s*:\s*'YUYV'/u);
  assert.match(videoAfterRead, /Frames per second:\s*30\.000 \(30\/1\)/u);
  observe("/usr/bin/gst-launch-1.0", [
    "-q",
    "pulsesrc",
    `device=${sourceName}`,
    "num-buffers=1",
    "!",
    "fakesink",
  ]);
  return {
    outcome: "ready",
    uid: uid(),
    uid_map: (await readFile("/proc/self/uid_map", "utf8")).trim(),
    ...(await retainMediaVideoObservations(output, video, videoAfterRead)),
    sources,
    positive_reads: { video_buffers: 1, audio_buffers: 1 },
    scope:
      "Synthetic devices readable by mapped app user; not physical capture or permission acceptance",
  };
}

async function mediaNamespace(pid: string | number, config: MediaConfiguration) {
  const prefix = `/proc/${pid}`;
  const stat = await readFile(`${prefix}/stat`, "utf8");
  const status = await readFile(`${prefix}/status`, "utf8");
  const start_ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  assert.ok(start_ticks && /^\d+$/u.test(start_ticks), "Process generation required");
  function credentials(name: "Uid" | "Gid" | "Groups") {
    const match = status.match(new RegExp(`^${name}:([^\\n]+)$`, "mu"));
    assert.ok(match?.[1], `Missing process ${name}`);
    return match[1].trim().split(/\s+/u);
  }
  return {
    pid: Number(stat.slice(0, stat.indexOf(" "))),
    start_ticks,
    namespaces: {
      user: await readlink(`${prefix}/ns/user`),
      mnt: await readlink(`${prefix}/ns/mnt`),
      pid: await readlink(`${prefix}/ns/pid`),
    },
    uid_map: (await readFile(`${prefix}/uid_map`, "utf8")).trim(),
    gid_map: (await readFile(`${prefix}/gid_map`, "utf8")).trim(),
    credentials: {
      Uid: credentials("Uid"),
      Gid: credentials("Gid"),
      Groups: credentials("Groups"),
    },
    device: nodeIdentity(await lstat(config.video)),
    socket: nodeIdentity(await lstat(config.socket)),
  };
}

export function assertApplicationMediaReadiness(value: unknown, listenerValue: unknown) {
  const receipt = object(value);
  const listener = object(listenerValue);
  assert.equal(receipt.phase, "app-launched");
  const probe = object(receipt.probe);
  assert.equal(probe.outcome, "ready");
  assert.deepEqual(probe.positive_reads, { video_buffers: 1, audio_buffers: 1 });
  assert.ok(typeof probe.uid === "number" && Number.isSafeInteger(probe.uid) && probe.uid > 0);
  const application = object(receipt.application);
  const wrapper = object(receipt.wrapper);
  const executable = object(receipt.executable);
  assert.ok(
    typeof application.pid === "number" &&
      Number.isSafeInteger(application.pid) &&
      application.pid > 0,
  );
  assert.match(text(application.start_ticks), /^\d+$/u);
  assert.match(text(executable.sha256), /^[a-f0-9]{64}$/u);
  assert.ok(path.isAbsolute(text(executable.path)));
  for (const field of ["namespaces", "uid_map", "gid_map", "credentials", "device", "socket"]) {
    assert.ok(wrapper[field], `Missing wrapper ${field}`);
    assert.deepEqual(
      application[field],
      wrapper[field],
      `Application changed ${field} after positive media reads`,
    );
  }
  const namespaces = object(wrapper.namespaces);
  for (const name of ["user", "mnt", "pid"])
    assert.match(text(namespaces[name]), new RegExp(`^${name}:\\[\\d+\\]$`, "u"));
  for (const name of ["device", "socket"]) {
    const node = object(wrapper[name]);
    for (const field of ["ino", "rdev", "uid", "gid", "mode"])
      assert.ok(
        typeof node[field] === "number" && Number.isSafeInteger(node[field]) && node[field] >= 0,
        `Invalid ${name} ${field}`,
      );
    assert.ok(
      typeof node.ino === "number" &&
        node.ino > 0 &&
        typeof node.ctime_ms === "number" &&
        Number.isFinite(node.ctime_ms) &&
        node.ctime_ms > 0,
    );
    assert.ok(typeof node.mode === "number");
    // Receipts describe Linux stat modes, including when reviewed on Windows.
    assert.equal(node.mode & 0o170000, name === "device" ? 0o020000 : 0o140000);
  }
  const credentials = object(wrapper.credentials);
  const uids: unknown = credentials.Uid;
  const gids: unknown = credentials.Gid;
  assert.ok(Array.isArray(uids) && uids.length === 4);
  assert.ok(Array.isArray(gids) && gids.length === 4);
  assert.equal(Number(uids[1]), probe.uid);
  assert.equal(application.start_ticks, listener.start_ticks);
  assert.equal(application.pid, listener.namespace_pid);
  assert.deepEqual(application.namespaces, listener.namespaces);
  assert.equal(executable.sha256, listener.sha256);
  assert.equal(executable.path, listener.executable);
}

// Fixed qualification-only wrapper: positive reads and the ordinary app share
// the final user/mount/PID namespaces. No credential or namespace transition
// occurs between this existing probe and spawn; the existing PID1 owns cleanup.
async function launchProbedApplication(
  file: string,
  app: string,
  expectedSha256: string,
  evidence: string,
) {
  assertHostedMediaEnvironment(process.env, process.platform, process.getuid?.());
  assert.ok(path.isAbsolute(app) && path.isAbsolute(evidence));
  assert.match(expectedSha256, /^[a-f0-9]{64}$/u);
  const config = await readMediaConfiguration(file);
  const report: ApplicationReport = {
    phase: "preflight",
    configuration: await fileIdentity(file),
    source: await fileIdentity(script),
  };
  try {
    report.executable = await fileIdentity(await realpath(app));
    assert.equal(report.executable.sha256, expectedSha256);
    report.wrapper = await mediaNamespace("self", config);
    report.probe = await probe(file);
    report.positive_reads_completed_at = new Date().toISOString();
    const child = spawn(app, [], { env: process.env, stdio: "inherit", shell: false });
    // Register exit/error custody before metadata reads or persistence awaits.
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    // The owned namespace init remains responsible if readback/persistence fails.
    // Attach immediately so a failed preflight cannot cause an unhandled rejection.
    exited.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    assert.ok(child.pid, "Spawned application PID required");
    report.application = await mediaNamespace(child.pid, config);
    assert.equal(await realpath(`/proc/${child.pid}/exe`), report.executable.path);
    assert.equal(
      createHash("sha256")
        .update(await readFile(`/proc/${child.pid}/exe`))
        .digest("hex"),
      expectedSha256,
    );
    report.phase = "app-launched";
    assertApplicationMediaReadiness(report, {
      ...report.application,
      namespace_pid: child.pid,
      sha256: expectedSha256,
      executable: report.executable.path,
    });
    report.application_observed_at = new Date().toISOString();
    await publishApplicationMediaReadiness(evidence, report);
    const status = await exited;
    await save(`${evidence}.exit.json`, { ...status, observed_at: new Date().toISOString() });
    assert.equal(status.signal, null, "Ordinary app exited by signal before namespace cleanup");
    process.exitCode = status.code ?? 1;
  } catch (error) {
    await failApplicationMediaWrapper(evidence, report, error);
  }
}

async function waitReady(launch: NativeLaunch, check: () => Promise<boolean>) {
  const until = Date.now() + 10_000;
  for (;;) {
    const exit = launch.receipt.events.find((event) =>
      ["driver-exited", "driver-error"].includes(event.kind),
    );
    assert.equal(exit, undefined, "Synthetic producer exited before readiness");
    assert.equal(launch.receipt.media_log_overflow, undefined, "Bounded producer log exceeded");
    assert.equal(
      launch.receipt.media_log_write_failure,
      undefined,
      "Producer log persistence failed",
    );
    if (await check()) return;
    assert.ok(Date.now() < until, "Synthetic media readiness unavailable");
    await pause(20);
  }
}

async function run() {
  assertHostedMediaEnvironment(process.env, process.platform, process.getuid?.());
  const raw: unknown = JSON.parse(
    await readFile(path.join(output, "media-preparation.json"), "utf8"),
  );
  const preparation = object(raw);
  assert.equal(preparation.source, revision());
  assert.equal(preparation.source, process.env.GITHUB_SHA);
  assert.equal(preparation.phase, "prepared");
  assert.equal(preparation.uid, uid());
  assert.equal(preparation.module_created, true);
  assert.deepEqual(nodeIdentity(await lstat(device)), preparation.device);
  assert.equal(
    (await fileIdentity(command("modinfo", ["-n", "vivid"]).trim())).sha256,
    object(preparation.module).sha256,
  );
  const lock = await acquireNativeSessionLock({
    workspace: root,
    scenarios: ["native-linux-packaged-webview-boundary"],
    namespaceDelegation: true,
  });
  const launches: { name: string; owned: NativeLaunch }[] = [];
  const joins: (
    | { name: string; receipt: Awaited<ReturnType<NativeLaunch["stop"]>> }
    | { name: string; outcome: "unknown"; message: string }
  )[] = [];
  let quiesced = false;
  try {
    await save(path.join(output, "media-runtime-started.json"), {
      source: revision(),
      pid: process.pid,
    });
    const runtime = await mkdtemp(
      path.join(await realpath(text(process.env.RUNNER_TEMP)), "pcv-media-"),
    );
    assert.match(
      runtime,
      /^\/[A-Za-z0-9_./-]+$/u,
      "Private Pulse paths cannot contain parser metacharacters",
    );
    const config = {
      socket: path.join(runtime, "native"),
      cookie: path.join(runtime, "auth.cookie"),
      source: sourceName,
      video: device,
      source_head: revision(),
    };
    await writeFile(config.cookie, randomBytes(256), { flag: "wx", mode: 0o600 });
    const configFile = path.join(output, "media-config.json");
    await save(configFile, config);
    const environment = {
      ...process.env,
      PULSE_SERVER: `unix:${config.socket}`,
      PULSE_COOKIE: config.cookie,
      PULSE_SOURCE: sourceName,
      PORTCOVE_QUALIFICATION_MEDIA_CONFIG: configFile,
      PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: lock.owner.token,
      PORTCOVE_SHARED_TOOL_CACHE: toolCachePaths().sharedRoot,
    };
    const launch = async (name: string, program: string, args: readonly string[]) => {
      const owned = await launchLinuxNativeSession(program, args, environment);
      launches.push({ name, owned });
      for (const [stream, label] of [
        [owned.child.stdout, "stdout"],
        [owned.child.stderr, "stderr"],
      ] as const) {
        let bytes = 0;
        stream.on("data", (chunk: Buffer) => {
          const remaining = Math.max(0, 128 * 1024 - bytes);
          bytes += chunk.length;
          if (bytes > 128 * 1024) owned.receipt.media_log_overflow = true;
          if (remaining) {
            try {
              appendFileSync(
                path.join(output, `${name}-${label}.log`),
                chunk.subarray(0, remaining),
              );
            } catch (error) {
              owned.receipt.media_log_write_failure = errorCode(error) ?? "unknown";
            }
          }
        });
      }
      await owned.ready();
      return owned;
    };
    const pulse = await launch("pulse", "/usr/bin/pulseaudio", [
      "-n",
      "--daemonize=no",
      "--exit-idle-time=-1",
      "--log-target=stderr",
      `--load=module-native-protocol-unix socket=${config.socket} auth-cookie=${config.cookie} auth-anonymous=false`,
      `--load=module-null-source source_name=${sourceName} rate=48000 channels=1`,
    ]);
    await waitReady(
      pulse,
      async () => (await lstat(config.socket).catch(() => null))?.isSocket() === true,
    );
    Object.assign(process.env, environment);
    const { runLinuxX11 } = await import("./desktop-linux-x11.mts");
    await runLinuxX11(path.join(output, "private-x11.json"));
    for (const { owned } of launches) {
      assert.equal(
        owned.receipt.events.some((event) => event.kind === "driver-exited"),
        false,
        "Synthetic producers must remain alive throughout the application case",
      );
      assert.equal(owned.receipt.media_log_overflow, undefined);
      assert.equal(owned.receipt.media_log_write_failure, undefined);
    }
  } finally {
    for (const { name, owned } of launches.reverse()) {
      try {
        joins.push({ name, receipt: await owned.stop() });
      } catch (error) {
        joins.push({ name, outcome: "unknown", message: errorMessage(error) });
      }
    }
    quiesced =
      joins.length === launches.length &&
      joins.every((join) => "receipt" in join && join.receipt.quiesced === true);
    try {
      await save(path.join(output, "media-runtime-joins.json"), { quiesced, joins });
    } catch (error) {
      quiesced = false;
      console.error(errorMessage(error));
    }
    if (quiesced) await lock.release();
    else {
      console.error("Media namespace custody unknown; retaining native lease and fixture");
      setInterval(() => {}, 30_000);
      await new Promise(() => {});
    }
  }
}

async function cleanup() {
  assertHostedMediaEnvironment(process.env, process.platform, process.getuid?.());
  const raw: unknown = JSON.parse(
    await readFile(path.join(output, "media-preparation.json"), "utf8"),
  );
  const preparation = object(raw);
  assert.equal(preparation.source, revision());
  assert.equal(preparation.uid, uid());
  assert.equal(preparation.gid, gid());
  if (!preparation.module_created) return;
  const started = await lstat(path.join(output, "media-runtime-started.json")).catch(() => null);
  if (started) {
    const raw: unknown = JSON.parse(
      await readFile(path.join(output, "media-runtime-joins.json"), "utf8"),
    );
    const joins = object(raw);
    assert.equal(joins.quiesced, true, "Unknown consumers prohibit fixture removal");
  }
  const module = await fileIdentity(command("modinfo", ["-n", "vivid"]).trim());
  assert.equal(module.sha256, object(preparation.module).sha256);
  assert.deepEqual(nodeIdentity(await lstat(device)), preparation.device);
  assert.match(
    await readFile("/sys/class/video4linux/video42/name", "utf8"),
    /^vivid-000-vid-cap\s*$/u,
  );
  command("sudo", ["-n", "modprobe", "--remove", "vivid"], { stdio: "inherit" });
  assert.equal((await readdir("/dev")).includes("video42"), false);
  await save(path.join(output, "media-module-cleanup.json"), {
    source: revision(),
    module_removed: true,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const [mode, file, ...rest] = process.argv.slice(2);
    if (mode === "--launch-probed-app") {
      assert.equal(rest.length, 3);
      const [app, sha256, evidence] = rest;
      assert.ok(file && app && sha256 && evidence);
      await launchProbedApplication(file, app, sha256, evidence);
    } else {
      const [extra] = rest;
      assert.equal(extra, undefined);
      if (mode === "--probe" && file) console.log(JSON.stringify(await probe(file)));
      else if (mode === "--prepare" && !file) await prepare();
      else if (mode === "--build" && !file) await build();
      else if (mode === "--run" && !file) await run();
      else if (mode === "--cleanup" && !file) await cleanup();
      else
        throw new Error(
          "Fixed hosted media operation required: --prepare|--build|--run|--cleanup or internal --probe FILE",
        );
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
