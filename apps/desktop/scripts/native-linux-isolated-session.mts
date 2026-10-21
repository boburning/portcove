/** Owned namespace lifecycle and private WebDriver FDs. This is a native harness
 * adapter, never a scheduler grant, issuer or installed-platform acceptance. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { open, lstat, realpath, writeFile, readFile, statfs } from "node:fs/promises";
import path from "node:path";
import { constants, openSync, writeSync, closeSync, fstatSync } from "node:fs";
import { Duplex, Writable, type Readable } from "node:stream";
import { get } from "node:http";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import {
  inspectIsolatedNativeLinuxBinding,
  inspectNativeLinuxHomeMount,
  planIsolatedNativeLinuxCommand,
} from "./native-linux-isolated-plan.mts";
import {
  inspectPublicNativeLinuxBinding,
  planPublicNativeLinuxCommand,
} from "./native-linux-public-plan.mts";
import {
  privateNativeDriverAgent,
  inspectPrivateNativeDriverResponse,
  type PrivateNativeDriverResponse,
} from "./native-linux-driver-http.mts";
import { parseNamespacePacket, type NamespaceEvent } from "./desktop-linux-native-session.mts";
import { isRecord, errorMessage } from "../../../scripts/runtime-values.mts";
const fixedInit = fileURLToPath(new URL("./native-linux-isolated-init.py", import.meta.url));

/** Raw group streams, not per-descendant output attribution or acceptance. */
export function createNativeNamespaceStreamCapture(directory: string, id: string) {
  assert.match(id, /^namespace-[a-f0-9]{32}$/u);
  const captures: {
    name: "stdout" | "stderr";
    path: string;
    fd: number;
    bytes: number;
    hash: ReturnType<typeof createHash>;
  }[] = [];
  try {
    for (const name of ["stdout", "stderr"] as const)
      captures.push({
        name,
        path: `${id}.${name}.bin`,
        fd: openSync(path.join(directory, `${id}.${name}.bin`), "wx", 0o600),
        bytes: 0,
        hash: createHash("sha256"),
      });
  } catch (error) {
    for (const item of captures) closeSync(item.fd);
    throw error;
  }
  let attached = false,
    finished = false,
    failed = false;
  return {
    attach(streams: { stdout: Readable; stderr: Readable }, refuse: (error: unknown) => void) {
      assert.ok(!attached && !finished);
      attached = true;
      for (const capture of captures)
        streams[capture.name].on("data", (chunk: Buffer) => {
          if (failed) return;
          try {
            assert.ok(
              !finished && capture.bytes + chunk.length <= 4 * 1024 * 1024,
              "native namespace stream exceeds bound or closed capture",
            );
            let written = 0;
            while (written < chunk.length) {
              const count = writeSync(capture.fd, chunk, written, chunk.length - written);
              assert.ok(count > 0);
              capture.hash.update(chunk.subarray(written, written + count));
              capture.bytes += count;
              written += count;
            }
          } catch (error) {
            failed = true;
            refuse(error);
          }
        });
    },
    finish() {
      assert.ok(!finished);
      finished = true;
      const files = captures.map((capture) => {
        closeSync(capture.fd);
        return { path: capture.path, bytes: capture.bytes, sha256: capture.hash.digest("hex") };
      });
      return { stdout: files[0]!, stderr: files[1]!, failed };
    },
  };
}

async function hash(filename: string, maximum: number) {
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    assert.ok(before.isFile() && before.size > 0 && before.size <= BigInt(maximum));
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      assert.ok(total <= maximum);
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat({ bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const)
      assert.equal(after[key], before[key], "native launch input changed");
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}
async function ownedDirectory(filename: string, uid: number) {
  for (let current = filename; current !== "/"; current = path.posix.dirname(current)) {
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.ok(info.uid === uid || info.uid === 0);
    assert.equal(info.mode & 0o022, 0, "native launch ancestry writable by another identity");
  }
}

export async function launchIsolatedLinuxNativeSession(
  raw: unknown,
  program: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  beforeLaunch: () => void = () => {},
) {
  return launchFixedLinuxNativeSession(raw, program, args, environment, beforeLaunch);
}

/** Ordinary shipped public updater harness only; this returns process/capture
 * custody and never a native Check, scheduler grant or public acceptance. */
export async function launchPublicLinuxNativeSession(
  raw: unknown,
  program: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  beforeLaunch: () => void = () => {},
) {
  const publicBinding = inspectPublicNativeLinuxBinding(raw);
  return launchFixedLinuxNativeSession(
    publicBinding.session,
    program,
    args,
    environment,
    beforeLaunch,
    publicBinding,
  );
}

async function launchFixedLinuxNativeSession(
  raw: unknown,
  program: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  beforeLaunch: () => void,
  publicBinding?: ReturnType<typeof inspectPublicNativeLinuxBinding>,
) {
  assert.equal(process.platform, "linux");
  const binding = inspectIsolatedNativeLinuxBinding(raw);
  const home = publicBinding?.state ?? binding.home;
  assert.equal(process.getuid?.(), binding.account.uid);
  assert.equal(process.getgid?.(), binding.account.gid);
  assert.equal(program, binding.tools.driver?.path);
  assert.equal(args.length, 6);
  assert.equal(args[0], "--port");
  assert.equal(args[2], "--native-port");
  assert.equal(args[4], "--native-driver");
  assert.equal(args[5], binding.tools.webkit_driver?.path);
  const port = Number(args[1]);
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65533);
  assert.equal(Number(args[3]), port + 1);
  const expires = Date.parse(binding.deadline_utc),
    remaining = () => {
      const value = expires - Date.now();
      assert.ok(value > 0, "original native lifetime expired");
      return value;
    };
  const bounded = <T,>(promise: Promise<T>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), Math.min(remaining(), 10000));
      }),
    ]).finally(() => clearTimeout(timer));
  };
  await ownedDirectory(binding.capture_root, binding.account.uid);
  await ownedDirectory(binding.home, binding.account.uid);
  if (publicBinding) {
    await ownedDirectory(publicBinding.state, binding.account.uid);
    await ownedDirectory(publicBinding.installation, binding.account.uid);
  }
  const recheck = async () => {
    remaining();
    beforeLaunch();
    const git = binding.tools.git!;
    assert.equal(await hash(await realpath(git.path), 64 * 1024 * 1024), git.sha256);
    const env = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: binding.home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
    };
    const call = (argv: string[]) =>
      execFileSync(
        git.path,
        ["-c", "core.hooksPath=/dev/null", "-C", binding.controller.root, ...argv],
        { env, encoding: "utf8", timeout: Math.min(remaining(), 5000), maxBuffer: 65536 },
      ).trim();
    assert.equal(call(["rev-parse", "HEAD"]), binding.controller.source_commit);
    assert.equal(call(["rev-parse", "HEAD^{tree}"]), binding.controller.source_tree);
    assert.equal(call(["status", "--porcelain", "--untracked-files=no"]), "");
    assert.equal(
      (await readFile("/proc/self/cgroup", "utf8")).trim(),
      `0::${binding.unit.control_group}`,
    );
    for (const [name, value] of Object.entries(binding.tools))
      assert.equal(
        await hash(
          await realpath(value.path),
          name === "node" ? 128 * 1024 * 1024 : 64 * 1024 * 1024,
        ),
        value.sha256,
      );
    assert.equal(
      await hash(binding.application.path, 512 * 1024 * 1024),
      binding.application.sha256,
    );
    assert.equal((await lstat(binding.application.path)).size, binding.application.bytes);
    assert.equal(
      fixedInit,
      `${binding.controller.root}/apps/desktop/scripts/native-linux-isolated-init.py`,
    );
    assert.equal(await hash(fixedInit, 1024 * 1024), binding.controller.init_sha256);
    if (publicBinding) {
      inspectNativeLinuxHomeMount(
        await readFile("/proc/self/mountinfo", "utf8"),
        binding.home,
        await statfs(binding.home),
      );
      for (const [filename, expected] of [
        ["native-linux-public-fuse.py", publicBinding.source.fuse_sha256],
        ["native-linux-public-network.py", publicBinding.source.network_sha256],
        ["native-linux-public-services.py", publicBinding.source.services_sha256],
      ])
        assert.equal(
          await hash(`${binding.controller.root}/apps/desktop/scripts/${filename}`, 1024 * 1024),
          expected,
        );
      assert.equal(
        await hash(publicBinding.candidate.path, 512 * 1024 * 1024),
        publicBinding.candidate.sha256,
      );
      assert.equal((await lstat(publicBinding.candidate.path)).size, publicBinding.candidate.bytes);
    }
    remaining();
  };
  await recheck();
  const nonce = randomUUID(),
    configurationPath = `${binding.capture_root}/namespace-${nonce}.json`;
  const allowed = [
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "PORTCOVE_LIBRARY",
    "PORTCOVE_PREFERENCES",
    "PORTCOVE_APPLICATION_UPDATE_PREFERENCES",
    "PORTCOVE_APPLICATION_UPDATE_SCHEDULE",
    "PORTCOVE_APPLICATION_UPDATE_STAGING",
  ];
  const selected = Object.fromEntries(
    allowed
      .filter((key) => environment[key] !== undefined)
      .map((key) => {
        const value = environment[key]!;
        assert.ok(value.startsWith(home + "/") && path.posix.normalize(value) === value);
        return [key, value];
      }),
  );
  let publicConfiguration: Record<string, unknown> | undefined;
  let networkPolicyPath: string | undefined, networkPolicySha: string | undefined;
  if (publicBinding) {
    const policies = {
      fuse: {
        schema_version: 1,
        nonce: binding.invocation_id,
        uid: binding.account.uid,
        gid: binding.account.gid,
        packages: [binding.application, publicBinding.candidate].map(({ bytes, sha256 }) => ({
          bytes,
          sha256,
        })),
        deadline_utc: binding.deadline_utc,
        python_sha256: binding.tools.python!.sha256,
      },
      network: { schema_version: 1, nonce, ...publicBinding.network },
    };
    const policyPins: Record<string, string> = {};
    for (const [name, value] of Object.entries(policies)) {
      const bytes = Buffer.from(JSON.stringify(value));
      const filename = `${binding.capture_root}/public-${name}.json`;
      await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
      policyPins[`${name}_policy_sha256`] = createHash("sha256").update(bytes).digest("hex");
      if (name === "network") {
        networkPolicyPath = filename;
        networkPolicySha = policyPins[`${name}_policy_sha256`];
      }
    }
    const hosts =
      [
        "127.0.0.1 localhost",
        "::1 localhost",
        ...Object.entries(publicBinding.network.addresses)
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([host, addresses]) => addresses.map((address) => `${address} ${host}`)),
      ].join("\n") + "\n";
    await writeFile(`${binding.capture_root}/public-hosts`, hosts, { flag: "wx", mode: 0o600 });
    await writeFile(`${binding.capture_root}/public-nsswitch`, "hosts: files\n", {
      flag: "wx",
      mode: 0o600,
    });
    publicConfiguration = {
      invocation_id: binding.invocation_id,
      deadline_utc: binding.deadline_utc,
      ...publicBinding.source,
      ...policyPins,
    };
  }
  await writeFile(
    configurationPath,
    JSON.stringify({
      schema_version: publicBinding ? 2 : 1,
      nonce,
      qualification_uid: binding.account.uid,
      qualification_gid: binding.account.gid,
      port,
      application_original: publicBinding?.active_application ?? binding.application.path,
      application_sha256: binding.application.sha256,
      home,
      environment: selected,
      tools: Object.fromEntries(
        ["python", "driver", "webkit_driver", "xvfb"].map((name) => [
          name,
          {
            ...binding.tools[name],
            path: name === "driver" ? "/native/runtime/tauri-driver" : binding.tools[name]!.path,
          },
        ]),
      ),
      timeout_seconds: Math.min(1750, Math.floor(remaining() / 1000)),
      ...(publicConfiguration ? { public: publicConfiguration } : {}),
    }),
    { flag: "wx", mode: 0o600 },
  );
  const plan = publicBinding
    ? planPublicNativeLinuxCommand(
        {
          schema_version: 1,
          session: publicBinding.session,
          candidate: publicBinding.candidate,
          source: publicBinding.source,
          network: publicBinding.network,
          retained_state_bytes: publicBinding.retained_state_bytes,
        },
        configurationPath,
      )
    : planIsolatedNativeLinuxCommand(raw, configurationPath);
  await recheck();
  const streamId = `namespace-${nonce.replaceAll("-", "")}`;
  const streams = createNativeNamespaceStreamCapture(binding.capture_root, streamId);
  const devices: number[] = [];
  const child = (() => {
    try {
      if (publicBinding)
        for (let index = 0; index < 8; index++) {
          const descriptor = openSync("/dev/fuse", constants.O_RDWR | constants.O_NOFOLLOW);
          devices.push(descriptor);
          const info = fstatSync(descriptor);
          assert.ok(
            info.isCharacterDevice() && info.rdev === 10 * 256 + 229,
            "fixed FUSE device identity differs",
          );
        }
      return spawn(plan.executable, plan.arguments, {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: publicBinding
          ? ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", ...devices]
          : ["pipe", "pipe", "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      // Device admission can refuse before a child exists. Close the already
      // created capture handles, retaining their actual empty/partial files.
      streams.finish();
      throw error;
    } finally {
      for (const descriptor of devices) closeSync(descriptor);
    }
  })();
  assert.ok(child.stdin && child.stdout && child.stderr);
  const stdin = child.stdin;
  const childPipes: readonly (Readable | Writable | null | undefined)[] = child.stdio;
  const events: NamespaceEvent[] = [],
    receipt = {
      method: "private-bubblewrap-pid1-owned-unit",
      nonce,
      started_at: new Date().toISOString(),
      unshare_version: "not-used",
      ready: undefined as Extract<NamespaceEvent, { kind: "namespace-ready" }> | undefined,
      events,
      public_events: [] as Record<string, unknown>[],
      public_relay: undefined as
        | {
            process_id: number | undefined;
            exit: {
              code: number | null;
              signal: NodeJS.Signals | null;
              observed_at: string;
            } | null;
          }
        | undefined,
      exit: undefined as
        | { code: number | null; signal: NodeJS.Signals | null; observed_at: string }
        | undefined,
      protocol_error: undefined as string | undefined,
      streams: undefined as
        | {
            stdout: { path: string; bytes: number; sha256: string };
            stderr: { path: string; bytes: number; sha256: string };
          }
        | undefined,
    };
  let resolveReady!: () => void, rejectReady!: (reason: unknown) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  readiness.catch(() => {});
  let sequence = 0,
    pending:
      | {
          sequence: number;
          resolve: (value: PrivateNativeDriverResponse) => void;
          reject: (reason: unknown) => void;
        }
      | undefined,
    buffer = Buffer.alloc(0),
    total = 0,
    failed = false;
  let stopPublicRelay = () => {};
  const refuse = (error: unknown) => {
    if (failed) return;
    failed = true;
    receipt.protocol_error = errorMessage(error);
    rejectReady(error);
    pending?.reject(error);
    pending = undefined;
    stdin.end();
    stopPublicRelay();
  };
  streams.attach({ stdout: child.stdout, stderr: child.stderr }, refuse);
  const protocol = child.stdio[3],
    requests = child.stdio[4];
  assert.ok(protocol && requests instanceof Writable);
  protocol.on("data", (chunk: Buffer) => {
    if (failed) return;
    try {
      total += chunk.length;
      assert.ok(total <= 128 * 1024 * 1024);
      buffer = Buffer.concat([buffer, chunk]);
      assert.ok(buffer.length <= 24 * 1024 * 1024);
      for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
        const packet: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)),
        );
        buffer = buffer.subarray(newline + 1);
        assert.ok(isRecord(packet) && packet.nonce === nonce);
        if (packet.kind === "driver-response") {
          assert.ok(pending && packet.sequence === pending.sequence);
          const selectedPending = pending;
          pending = undefined;
          selectedPending.resolve(inspectPrivateNativeDriverResponse(packet.response));
          continue;
        }
        if (
          publicBinding &&
          ["native-private-fuse", "public-setup-ready", "public-services-stopped"].includes(
            String(packet.kind),
          )
        ) {
          assert.ok(
            receipt.public_events.length < 64 && Buffer.byteLength(JSON.stringify(packet)) <= 8192,
          );
          receipt.public_events.push(structuredClone(packet));
          if (packet.kind === "public-services-stopped") stopPublicRelay();
          continue;
        }
        const event = parseNamespacePacket(packet, nonce);
        assert.ok(events.length < 8);
        if (event.kind === "namespace-ready") {
          assert.equal(receipt.ready, undefined);
          assert.equal(event.uid, binding.account.uid);
          receipt.ready = event;
        } else if (event.kind === "driver-started") {
          assert.ok(receipt.ready && !events.some((value) => value.kind === "driver-started"));
          resolveReady();
        } else if (event.kind === "driver-error") throw new Error(event.message);
        events.push(event);
      }
    } catch (error) {
      refuse(error);
    }
  });
  child.on("error", refuse);
  let publicStopping = false;
  let relayJoined: Promise<void> = Promise.resolve();
  if (publicBinding) {
    assert.ok(networkPolicyPath && networkPolicySha);
    const input = childPipes[5],
      output = childPipes[6];
    assert.ok(input instanceof Duplex && output instanceof Duplex);
    // Constructor ABI is (reader,writer): FD5 receives outer responses and FD6
    // emits guest requests. Keep the TLS bytes opaque and preserve backpressure.
    const relay = spawn(
      binding.tools.python!.path,
      [
        "-I",
        "-S",
        "-B",
        `${binding.controller.root}/apps/desktop/scripts/native-linux-public-network.py`,
        "--outer-controlled",
        networkPolicyPath,
        networkPolicySha,
        String(Math.min(1750000, Math.floor(remaining()))),
      ],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["pipe", "pipe", "inherit", "pipe"],
      },
    );
    receipt.public_relay = { process_id: relay.pid, exit: null };
    assert.ok(relay.stdin && relay.stdout);
    const control = relay.stdio[3];
    assert.ok(control instanceof Writable);
    let stopRequested = false;
    stopPublicRelay = () => {
      if (stopRequested) return;
      stopRequested = true;
      control.end(Buffer.from([0]));
    };
    control.on("error", refuse);
    output.pipe(relay.stdin);
    relay.stdout.pipe(input);
    for (const stream of [output, input, relay.stdin, relay.stdout]) stream.on("error", refuse);
    relay.on("error", refuse);
    relayJoined = new Promise<void>((resolve) =>
      relay.once("close", (code, signal) => {
        receipt.public_relay!.exit = { code, signal, observed_at: new Date().toISOString() };
        if (!publicStopping || code !== 0 || signal !== null)
          refuse(new Error("public relay ended before complete owned settlement"));
        resolve();
      }),
    );
  }
  const joined = new Promise<typeof receipt>((resolve) =>
    child.once("close", (code, signal) => {
      receipt.streams = streams.finish();
      receipt.exit = { code, signal, observed_at: new Date().toISOString() };
      if (!receipt.ready || pending || buffer.length)
        refuse(new Error("native namespace ended before complete capture"));
      resolve(receipt);
    }),
  );
  const agent = privateNativeDriverAgent(async (request) => {
    assert.ok(!failed && !pending);
    await bounded(readiness, "native namespace startup deadline");
    const current = ++sequence;
    return bounded(
      new Promise<PrivateNativeDriverResponse>((resolve, reject) => {
        pending = { sequence: current, resolve, reject };
        requests.write(
          JSON.stringify({ kind: "driver-request", nonce, sequence: current, request }) + "\n",
          (error) => {
            if (error) refuse(error);
          },
        );
      }),
      "native private driver response deadline",
    ).catch((error) => {
      refuse(error);
      throw error;
    });
  }, performance.now() + remaining());
  const custody = async () => {
    await bounded(joined, "native namespace settlement remains unknown");
    await bounded(relayJoined, "public relay settlement remains unknown");
    assert.ok(
      receipt.ready &&
        receipt.exit &&
        receipt.exit.signal === null &&
        Number.isInteger(receipt.exit.code),
    );
    await recheck();
    return { ...receipt, ready: receipt.ready, exit: receipt.exit, quiesced: true as const };
  };
  let stopping: ReturnType<typeof custody> | undefined;
  return {
    child,
    receipt,
    privateAgent: agent,
    observeRuntime: () =>
      bounded(
        new Promise<unknown>((resolve, reject) => {
          const request = get(
            `http://127.0.0.1:${port}/${publicBinding ? "native-public-runtime" : "native-runtime"}`,
            { agent },
            (response) => {
              const parts: Buffer[] = [];
              let bytes = 0;
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 1024 * 1024) {
                  request.destroy(new Error("native runtime observation exceeds bound"));
                  return;
                }
                parts.push(chunk);
              });
              response.on("error", reject);
              response.on("end", () => {
                try {
                  if (publicBinding && response.statusCode === 503) {
                    const body: unknown = JSON.parse(
                      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
                    );
                    assert.ok(
                      isRecord(body) &&
                        Object.keys(body).sort().join(",") === "authority,state" &&
                        body.state === "runtime-not-ready" &&
                        body.authority === "none",
                    );
                    throw Object.assign(new Error("ordinary public runtime is not yet stable"), {
                      code: "ERR_NATIVE_PUBLIC_RUNTIME_NOT_READY",
                    });
                  }
                  assert.equal(response.statusCode, 200);
                  const raw: unknown = JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
                  );
                  assert.ok(isRecord(raw) && raw.schema_version === 1 && raw.authority === "none");
                  resolve(raw);
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          request.on("error", reject);
        }),
        "native runtime observation exhausted original deadline",
      ),
    custody,
    ready: () => bounded(readiness, "native namespace startup deadline"),
    stop() {
      stopping ??= (async () => {
        publicStopping = true;
        stdin.end();
        const result = await custody();
        agent.destroy();
        assert.ok(!failed && result.exit.code === 0, "native namespace failed; preserve capture");
        return result;
      })();
      return stopping;
    },
  };
}
