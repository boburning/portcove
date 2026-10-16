import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const init = fileURLToPath(new URL("./native-linux-init.mts", import.meta.url));
const unshare = "/usr/bin/unshare";
const digest = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const deadline = (promise, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Ephemeral native-harness custody only. Ordinary Core None supervision and
// product launch policy remain unchanged. Numeric host PIDs are never signaled.
export async function launchLinuxNativeSession(
  program,
  args,
  environment,
  { beforeLaunch = () => {} } = {},
) {
  assert.equal(process.platform, "linux");
  const nonce = randomUUID();
  const receipt = {
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
      String(process.getuid()),
      program,
      ...args,
    ],
    { env: environment, stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );
  let startupStderr = "";
  child.stderr.on("data", (data) => {
    if (!receipt.ready) startupStderr = (startupStderr + data.toString("utf8")).slice(-4096);
  });
  let buffer = "";
  let protocolError;
  const refuseProtocol = (error) => {
    protocolError ??= error;
    receipt.protocol_error = protocolError.message;
    buffer = "";
    rejectReady(error);
  };
  let resolveReady, rejectReady;
  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdio[3].on("data", (data) => {
    if (protocolError) return;
    buffer += data;
    if (buffer.length > 8192) {
      refuseProtocol(new Error("Namespace readiness exceeded its boundary"));
      return;
    }
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        assert.equal(event.nonce, nonce);
        event.observed_at = new Date().toISOString();
        assert.ok(receipt.events.length < 8, "Bounded private launch protocol");
        if (event.kind === "namespace-ready") {
          assert.equal(event.pid, 1);
          assert.equal(event.uid, process.getuid());
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
  const joined = new Promise((resolve) =>
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
  let stopping;
  const custody = async () => {
    const result = await joined;
    assert.ok(result.ready, "Launch-bound namespace identity is required");
    assert.equal(result.exit.signal, null, "A signaled launcher does not prove init join");
    assert.ok(Number.isInteger(result.exit.code), "A normal init join is required");
    return { ...result, quiesced: true, protocol_error: protocolError?.message };
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
          if (protocolError) throw protocolError;
          assert.equal(result.exit.code, 0, "A normal successful init join is required");
          return result;
        });
      }
      return stopping;
    },
  };
}
