import { errorMessage } from "../../../scripts/runtime-values.mts";
export type NamespacePayload =
  | { kind: "namespace-ready"; pid: number; uid: number }
  | { kind: "driver-started"; pid: number }
  | { kind: "driver-error"; message: string }
  | { kind: "driver-exited"; code: number | null; signal: string | null };
export type NamespaceEvent = NamespacePayload & { nonce: string; observed_at: string };
type NamespaceReady = Extract<NamespaceEvent, { kind: "namespace-ready" }>;
interface NamespaceExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  observed_at: string;
}
export interface NamespaceReceipt {
  method: string;
  nonce: string;
  started_at: string;
  unshare_version: string;
  ready: NamespaceReady | undefined;
  events: NamespaceEvent[];
  unshare_sha256?: string;
  init_sha256?: string;
  node_sha256?: string;
  inputs_captured_at?: string;
  protocol_error?: string;
  exit?: NamespaceExit;
  startup_stderr?: string;
  media_log_overflow?: boolean;
  media_log_write_failure?: string;
}
function rethrowFailure(error: unknown): never {
  throw error;
}
export function parseNamespacePacket(value: unknown, nonce: string): NamespaceEvent {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.ok("nonce" in value && value.nonce === nonce);
  assert.ok("kind" in value);
  const observed_at = new Date().toISOString();
  if (value.kind === "namespace-ready") {
    assert.ok("pid" in value && value.pid === 1);
    assert.ok("uid" in value && typeof value.uid === "number");
    return { ...value, kind: value.kind, pid: value.pid, uid: value.uid, nonce, observed_at };
  }
  if (value.kind === "driver-started") {
    assert.ok(
      "pid" in value &&
        typeof value.pid === "number" &&
        Number.isInteger(value.pid) &&
        value.pid > 1,
    );
    return { ...value, kind: value.kind, pid: value.pid, nonce, observed_at };
  }
  if (value.kind === "driver-error") {
    assert.ok("message" in value && typeof value.message === "string");
    return { ...value, kind: value.kind, message: value.message, nonce, observed_at };
  }
  assert.equal(value.kind, "driver-exited", "Known private launch packet required");
  assert.ok(
    "code" in value &&
      (value.code === null || (typeof value.code === "number" && Number.isInteger(value.code))),
  );
  assert.ok("signal" in value && (value.signal === null || typeof value.signal === "string"));
  return {
    ...value,
    kind: "driver-exited",
    code: value.code,
    signal: value.signal,
    nonce,
    observed_at,
  };
}
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const init = fileURLToPath(new URL("./native-linux-init.mts", import.meta.url));
const unshare = "/usr/bin/unshare";
const digest = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const deadline = <Value,>(promise: Promise<Value>, message: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Ephemeral native-harness custody only. Ordinary Core None supervision and
// product launch policy remain unchanged. Numeric host PIDs are never signaled.
export async function launchLinuxNativeSession(
  program: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  { beforeLaunch = () => {} }: { beforeLaunch?: () => void } = {},
) {
  assert.equal(process.platform, "linux");
  assert.ok(process.getuid);
  const uid = process.getuid();
  const nonce = randomUUID();
  const receipt: NamespaceReceipt = {
    method: "private-pid-namespace-init-normal-unshare-join",
    nonce,
    started_at: new Date().toISOString(),
    unshare_version: execFileSync(unshare, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim(),
    ready: undefined,
    events: [],
  };
  const [unshareDigest, initDigest, nodeDigest] = await deadline(
    Promise.all([digest(unshare), digest(init), digest(process.execPath)]),
    "Native namespace input capture timed out before launch",
  );
  Object.assign(receipt, {
    unshare_sha256: unshareDigest,
    init_sha256: initDigest,
    node_sha256: nodeDigest,
    inputs_captured_at: new Date().toISOString(),
  });
  beforeLaunch();
  const child = spawn(
    unshare,
    [
      "--user",
      "--map-current-user",
      "--mount",
      "--pid",
      "--fork",
      "--mount-proc",
      "--kill-child=SIGKILL",
      process.execPath,
      init,
      nonce,
      String(uid),
      program,
      ...args,
    ],
    { env: environment, stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );
  let startupStderr = "";
  child.stderr.on("data", (data: Buffer) => {
    if (!receipt.ready) startupStderr = (startupStderr + data.toString("utf8")).slice(-4096);
  });
  let buffer = "";
  let protocolFailure: { error: unknown; message: string } | undefined;
  const refuseProtocol = (error: unknown) => {
    protocolFailure ??= { error, message: errorMessage(error) };
    receipt.protocol_error = protocolFailure.message;
    buffer = "";
    rejectReady(error);
  };
  let resolveReady!: (receipt: NamespaceReceipt) => void;
  let rejectReady!: (error?: unknown) => void;
  const readiness = new Promise<NamespaceReceipt>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const protocol = child.stdio[3];
  assert.ok(protocol);
  protocol.on("data", (data: Buffer) => {
    if (protocolFailure) return;
    buffer += data.toString();
    if (buffer.length > 8192) {
      refuseProtocol(new Error("Namespace readiness exceeded its boundary"));
      return;
    }
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event = parseNamespacePacket(JSON.parse(line), nonce);
        assert.ok(receipt.events.length < 8, "Bounded private launch protocol");
        if (event.kind === "namespace-ready") {
          assert.equal(event.pid, 1);
          assert.equal(event.uid, uid);
          assert.equal(receipt.ready, undefined);
          receipt.ready = event;
        } else if (event.kind === "driver-started") {
          assert.ok(!receipt.events.some((prior) => prior.kind === "driver-started"));
          assert.ok(Number.isInteger(event.pid) && event.pid > 1);
          assert.ok(receipt.ready);
          resolveReady(receipt);
        } else if (event.kind === "driver-error") rejectReady(new Error(event.message));
        else assert.equal(event.kind, "driver-exited", "Known private launch packet required");
        receipt.events.push(event);
      } catch (error) {
        refuseProtocol(error);
        return;
      }
    }
  });
  child.on("error", rejectReady);
  // Capture actual Child terminal status once; no procfs disappearance inference.
  const joined = new Promise<NamespaceReceipt>((resolve) =>
    child.once("close", (code, signal) => {
      receipt.exit = { code, signal, observed_at: new Date().toISOString() };
      if (!receipt.ready) {
        receipt.startup_stderr = startupStderr;
        rejectReady(
          new Error(
            `Native namespace startup was not acknowledged (exit ${code}, signal ${signal ?? "none"}): ${startupStderr.trim()}`,
          ),
        );
      }
      resolve(receipt);
    }),
  );
  let stopping: ReturnType<typeof custody> | undefined;
  const custody = async () => {
    const result = await joined;
    assert.ok(result.ready, "Launch-bound namespace identity is required");
    const exit = result.exit;
    assert.ok(exit);
    assert.equal(exit.signal, null, "A signaled launcher does not prove init join");
    assert.ok(Number.isInteger(exit.code), "A normal init join is required");
    return {
      ...result,
      ready: result.ready,
      exit,
      quiesced: true as const,
      protocol_error: protocolFailure?.message,
    };
  };
  return {
    child,
    receipt,
    custody,
    ready: () => deadline(readiness, "Native namespace readiness timed out"),
    stop() {
      if (!stopping) {
        child.stdin.end();
        stopping = deadline(
          custody(),
          "Native namespace join unknown; retain this session and fixture",
        ).then((result) => {
          if (protocolFailure) rethrowFailure(protocolFailure.error);
          assert.equal(result.exit.code, 0, "A normal successful init join is required");
          return result;
        });
      }
      return stopping;
    },
  };
}
