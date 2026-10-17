import { errorMessage } from "./runtime-values.mts";
import { resourceEntrypoint } from "./resource-command.mts";
import { frontendOutputResource } from "./resource-capacity.mts";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchLinuxNativeSession } from "../apps/desktop/scripts/desktop-linux-native-session.mts";
import { acquireNativeSessionLock } from "./native-session-lock.mts";
import { fileIdentity } from "./development-evidence.mts";
import {
  retainedEvidenceRoot,
  retainEvidenceInput,
  verifyConsumedInputs,
} from "./retained-evidence.mts";
import {
  parseDesktopHarnessOptions,
  resolveDesktopHarnessSelection,
} from "./desktop-execution-plan.mts";

const source = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const scope =
  "Linux GTK/WebKit on ext4 with private authenticated virtual X11; no WSLg, physical display/controller or universal Linux qualification";
export async function readLinuxX11Configuration(file) {
  const config = JSON.parse(await readFile(file, "utf8"));
  if (
    config.format_version !== 1 ||
    !["gtk", "harness"].includes(config.stage) ||
    !["xvfb", "xkbcomp", "output_root"].every((key) => path.isAbsolute(config[key] ?? "")) ||
    !Array.isArray(config.harness_args) ||
    !config.harness_args.every((value) => typeof value === "string") ||
    Object.keys(config).some(
      (key) =>
        ![
          "format_version",
          "stage",
          "xvfb",
          "xkbcomp",
          "output_root",
          "harness_args",
          "node",
          "tool_cache",
        ].includes(key),
    )
  )
    throw new Error("Unsupported private-X11 prerequisites/configuration; install nothing");
  const identities = await Promise.all(
    [config.xvfb, config.xkbcomp, "/usr/bin/unshare", "/usr/bin/dbus-run-session"].map(
      fileIdentity,
    ),
  );
  assert.equal(
    await realpath(config.output_root),
    path.resolve(config.output_root),
    "Output must use ordinary canonical ext4 storage",
  );
  assert.equal((await lstat(config.output_root)).isDirectory(), true);
  assert.equal(
    (await statfs(config.output_root)).type,
    0xef53,
    "The proven route requires ext4 outputs",
  );
  if (config.stage === "harness")
    resolveDesktopHarnessSelection(parseDesktopHarnessOptions(config.harness_args).values);
  return { config, identities };
}

async function waitExit(launch, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const event = launch.receipt.events.find((item) =>
      ["driver-exited", "driver-error"].includes(item.kind),
    );
    if (event) return event;
    if (Date.now() >= end) throw new Error("Private X11 operation deadline expired");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function virtualDisplay(config, runtime: string) {
  assert.equal(process.pid, 1);
  assert.equal(process.getuid(), 1000);
  assert.equal(
    (await readFile("/proc/self/uid_map", "utf8")).trim().replace(/\s+/gu, " "),
    "1000 0 1",
  );
  const auth = path.join(runtime, "private-authority");
  const cookie = randomBytes(16);
  function authority(number) {
    const chunks = [Buffer.from([255, 255])];
    for (const value of [
      Buffer.alloc(0),
      Buffer.from(number),
      Buffer.from("MIT-MAGIC-COOKIE-1"),
      cookie,
    ]) {
      const size = Buffer.alloc(2);
      size.writeUInt16BE(value.length);
      chunks.push(size, value);
    }
    return Buffer.concat(chunks);
  }
  await writeFile(auth, authority("0"), { flag: "wx", mode: 0o600 });
  const environment = { ...process.env, GDK_BACKEND: "x11", XAUTHORITY: auth };
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
    environment[name] = path.join(runtime, name.toLowerCase());
    await mkdir(environment[name], { mode: 0o700 });
  }
  const receipt = {
    format_version: 1,
    scope,
    stage: config.stage,
    authorization: "private cookie excluded from capture and receipts",
    prerequisites: await Promise.all([config.xvfb, config.xkbcomp].map(fileIdentity)),
    events: [],
  };
  const record = () =>
    writeFile(path.join(runtime, "runtime-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  let server, probe, program;
  async function close(launch, name) {
    if (!launch) return;
    try {
      receipt[name] = await launch.stop();
      await record();
    } catch (error) {
      receipt[name] = { outcome: "unknown", message: errorMessage(error) };
      await record();
      console.error(`Unknown namespace closure; retain guards and runtime ${runtime}`);
      setInterval(() => {}, 60_000);
      await new Promise(() => {});
    }
  }
  try {
    server = await launchLinuxNativeSession(
      config.xvfb,
      [
        "-displayfd",
        "1",
        "-screen",
        "0",
        "1280x800x24",
        "-nolisten",
        "tcp",
        "-noreset",
        "-auth",
        auth,
      ],
      environment,
    );
    let display = "";
    server.child.stdout.on("data", (chunk) => {
      display += chunk;
      if (display.length > 8192) receipt.server_output_exceeded = true;
    });
    server.child.stderr.pipe(process.stderr);
    await server.ready();
    const until = Date.now() + 10_000;
    while (!/^\d+\n/u.test(display)) {
      if (Date.now() >= until || receipt.server_output_exceeded)
        throw new Error("X11 display readiness unavailable");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const number = display.split("\n")[0];
    assert.match(number, /^\d{1,5}$/u);
    environment.DISPLAY = `:${number}`;
    await writeFile(auth, authority(number), { mode: 0o600 });
    receipt.display = environment.DISPLAY;
    probe = await launchLinuxNativeSession(
      "/usr/bin/timeout",
      [
        "--signal=TERM",
        "5s",
        "/usr/bin/python3",
        "-c",
        'import ctypes,json; gtk=ctypes.CDLL("libgtk-3.so.0"); print(json.dumps({"gtk_init":bool(gtk.gtk_init_check(None,None))}));',
      ],
      environment,
    );
    let result = "";
    probe.child.stdout.on("data", (chunk) => {
      if (result.length < 8192) result += chunk;
    });
    probe.child.stderr.pipe(process.stderr);
    await probe.ready();
    const exited = await waitExit(probe, 10_000);
    await close(probe, "gtk_join");
    probe = undefined;
    assert.equal(exited.code, 0);
    assert.equal(JSON.parse(result).gtk_init, true);
    receipt.gtk_readiness = { outcome: "ready", exit: exited };
    await record();
    if (config.stage === "harness") {
      environment.PORTCOVE_QUALIFICATION_DISPLAY_RECEIPT = path.join(
        runtime,
        "runtime-receipt.json",
      );
      program = await launchLinuxNativeSession(
        "/usr/bin/dbus-run-session",
        [
          "--",
          process.execPath,
          path.join(root, "scripts/desktop-test-cli.mts"),
          ...config.harness_args,
        ],
        environment,
      );
      program.child.stdout.pipe(process.stdout);
      program.child.stderr.pipe(process.stderr);
      await program.ready();
      receipt.harness_exit = await waitExit(program, 240_000);
      await close(program, "harness_join");
      program = undefined;
      assert.equal(receipt.harness_exit.code, 0);
    }
    receipt.outcome = "passed";
  } catch (error) {
    receipt.outcome = "failed";
    receipt.failure = errorMessage(error);
    process.exitCode = 1;
  } finally {
    await close(probe, "gtk_join");
    await close(program, "harness_join");
    await close(server, "xserver_join");
    await record();
  }
  console.log(
    JSON.stringify({
      runtime_receipt: path.join(runtime, "runtime-receipt.json"),
      outcome: receipt.outcome,
      scope,
    }),
  );
}

async function bootstrap(config, runtime) {
  assert.equal(process.pid, 1);
  assert.equal(process.getuid(), 0);
  assert.equal(
    (await readFile("/proc/self/uid_map", "utf8")).trim().replace(/\s+/gu, " "),
    "0 1000 1",
  );
  execFileSync("/usr/bin/mount", ["-t", "tmpfs", "-o", "mode=1777,nosuid,nodev", "tmpfs", "/tmp"]);
  await mkdir("/tmp/.X11-unix", { mode: 0o1777 });
  await chmod("/tmp/.X11-unix", 0o1777);
  await mkdir("/tmp/x11-bin-upper");
  await mkdir("/tmp/x11-bin-work");
  await copyFile(config.xkbcomp, "/tmp/x11-bin-upper/xkbcomp");
  await chmod("/tmp/x11-bin-upper/xkbcomp", 0o755);
  execFileSync("/usr/bin/mount", [
    "-t",
    "overlay",
    "overlay",
    "-o",
    "lowerdir=/usr/bin,upperdir=/tmp/x11-bin-upper,workdir=/tmp/x11-bin-work,userxattr",
    "/usr/bin",
  ]);
  const child = spawn(
    "/usr/bin/unshare",
    [
      "--user",
      "--map-user=1000",
      "--map-group=1000",
      "--mount",
      "--pid",
      "--fork",
      "--mount-proc",
      "--kill-child=SIGKILL",
      process.execPath,
      source,
      "--internal-display",
      JSON.stringify(config),
      runtime,
    ],
    { stdio: "inherit" },
  );
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(status.signal, null);
  process.exitCode = status.code ?? 1;
}

export async function runLinuxX11(file) {
  assert.equal(process.platform, "linux", "Private X11 route supports Linux only");
  assert.equal(process.getuid(), 1000, "Proven private namespace route requires ordinary uid 1000");
  const { config, identities } = await readLinuxX11Configuration(file);
  const runtime = await mkdtemp(path.join(config.output_root, "private-x11-"));
  await chmod(runtime, 0o700);
  const lease = await acquireNativeSessionLock({
    workspace: root,
    scenarios: [`private-x11-${config.stage}`],
    namespaceDelegation: true,
  });
  let launch;
  try {
    const retainedRoot = retainedEvidenceRoot(config.output_root);
    const inputs = [];
    const signal = AbortSignal.timeout(60_000);
    for (const input of [
      config.xvfb,
      config.xkbcomp,
      "/usr/bin/unshare",
      "/usr/bin/dbus-run-session",
      process.execPath,
      source,
      path.join(root, "apps/desktop/scripts/desktop-linux-native-session.mts"),
      path.join(root, "apps/desktop/scripts/native-linux-init.mts"),
    ])
      inputs.push({
        ...(await retainEvidenceInput({ root: retainedRoot, file: input, signal })),
        consumption_phase:
          input === source ? "trusted-verifier-observation" : "cooperative-live-path",
      });
    await writeFile(
      path.join(runtime, "preflight.json"),
      JSON.stringify(
        {
          format_version: 1,
          scope,
          stage: config.stage,
          identities,
          inputs,
          limitations: [
            "Runtime and verifier use original paths with cooperative prelaunch/postjoin content checks; retained bytes do not prove immutable loading",
            "Authentication cookie and environment values are excluded",
          ],
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    await verifyConsumedInputs(inputs, { signal });
    launch = await launchLinuxNativeSession(
      "/usr/bin/unshare",
      [
        "--user",
        "--map-root-user",
        "--mount",
        "--pid",
        "--fork",
        "--mount-proc",
        "--kill-child=SIGKILL",
        process.execPath,
        source,
        "--internal-bootstrap",
        JSON.stringify(config),
        runtime,
      ],
      {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              ![
                "PORTCOVE_RESOURCE_RESERVATION",
                "PORTCOVE_HEAVY_RUST_LOCK_TOKEN",
                "PORTCOVE_HEAVY_RUST_PROCESS_TOKEN",
              ].includes(key),
          ),
        ),
        PORTCOVE_CONTAINER_GUEST: "1",
        PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: lease.owner.token,
      },
    );
    launch.child.stdout.pipe(process.stdout);
    launch.child.stderr.pipe(process.stderr);
    await launch.ready();
    const exit = await waitExit(launch, 270_000);
    const join = await launch.stop();
    launch = undefined;
    await writeFile(
      path.join(runtime, "outer-join.json"),
      JSON.stringify({ exit, join }, null, 2) + "\n",
      { flag: "wx" },
    );
    await verifyConsumedInputs(inputs, { signal: AbortSignal.timeout(60_000) });
    process.exitCode = exit.code ?? 1;
  } finally {
    if (launch) {
      try {
        const join = await launch.stop();
        await writeFile(
          path.join(runtime, "failed-outer-join.json"),
          JSON.stringify(join, null, 2) + "\n",
          { flag: "wx" },
        );
      } catch {
        console.error(`Unknown outer custody ${runtime}; retain native slot`);
        setInterval(() => {}, 60_000);
        await new Promise(() => {});
      }
    }
    await lease.release();
  }
}

export async function runWindowsLinuxX11(file) {
  const config = JSON.parse(await readFile(file, "utf8"));
  if (!path.posix.isAbsolute(config.node ?? "") || !path.posix.isAbsolute(config.tool_cache ?? ""))
    throw new Error("WSL route requires already provisioned absolute Linux node/tool_cache paths");
  const mapped = (value: string) => {
    const absolute = path.resolve(value);
    if (!/^[a-z]:\\/iu.test(absolute))
      throw new Error("Proven WSL route requires a drive-mounted ordinary checkout");
    return `/mnt/${absolute[0].toLowerCase()}/${absolute.slice(3).replaceAll("\\", "/")}`;
  };
  const lease = await acquireNativeSessionLock({
    workspace: root,
    scenarios: ["private-X11 cross-host resource"],
  });
  try {
    const gitDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    const child = spawn(
      process.execPath,
      [
        path.join(root, "scripts/run-rust-tests.mts"),
        "--guard-command",
        "wsl.exe",
        "-d",
        "Ubuntu",
        "--cd",
        mapped(root),
        "--exec",
        "/usr/bin/env",
        "-u",
        "PORTCOVE_NATIVE_SESSION_LOCK_TOKEN",
        "-u",
        "PORTCOVE_RESOURCE_RESERVATION",
        "-u",
        "PORTCOVE_HEAVY_RUST_LOCK_TOKEN",
        "-u",
        "PORTCOVE_HEAVY_RUST_PROCESS_TOKEN",
        "PORTCOVE_CONTAINER_GUEST=1",
        `GIT_DIR=${mapped(gitDirectory)}`,
        `GIT_WORK_TREE=${mapped(root)}`,
        `PORTCOVE_SHARED_TOOL_CACHE=${config.tool_cache}`,
        `PATH=${path.posix.dirname(config.node)}:/home/boburning/.cargo/bin:/usr/bin:/bin`,
        config.node,
        mapped(source),
        "--config",
        mapped(file),
      ],
      { cwd: root, stdio: "inherit", windowsHide: true },
    );
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(status.signal, null, "Guarded cross-host runner must end normally");
    process.exitCode = status.code ?? 1;
  } finally {
    await lease.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === source) {
  const [mode, value, runtime] = process.argv.slice(2);
  try {
    if (mode === "--internal-bootstrap") await bootstrap(JSON.parse(value), runtime);
    else if (mode === "--internal-display") await virtualDisplay(JSON.parse(value), runtime);
    else if (mode === "--config" && value && !runtime) {
      process.exitCode = await resourceEntrypoint(
        process.platform === "win32" ? "rust" : "browser",
        async () => {
          if (process.platform === "win32") await runWindowsLinuxX11(value);
          else await runLinuxX11(value);
          return process.exitCode ?? 0;
        },
        { exclusive: [frontendOutputResource(root)] },
      );
    } else
      throw new Error(
        "usage: desktop-linux-x11.mts --config ABSOLUTE_JSON; stages gtk|harness; prerequisites must already exist",
      );
  } catch (error) {
    console.error(
      `Private-X11 prerequisite/execution unsupported or failed: ${errorMessage(error)}`,
    );
    process.exitCode = 1;
  }
}
