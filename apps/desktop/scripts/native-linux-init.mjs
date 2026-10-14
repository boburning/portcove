// Qualification-only PID1. Closing its private control pipe exits this namespace
// init; the kernel tears down descendants before unshare can normally join it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
const [nonce, expectedUid, program, ...args] = process.argv.slice(2);
assert.equal(process.pid, 1, "The native host must be the private namespace init");
assert.equal(process.getuid(), Number(expectedUid));
assert.match(nonce, /^[0-9a-f-]{36}$/u);
const report = (value) => writeSync(3, JSON.stringify({ nonce, ...value }) + "\n");
report({ kind: "namespace-ready", pid: process.pid, uid: process.getuid() });
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("spawn", () => report({ kind: "driver-started", pid: child.pid }));
child.once("error", (error) => {
  report({ kind: "driver-error", message: error.message });
  process.exit(126);
});
child.once("exit", (code, signal) => report({ kind: "driver-exited", code, signal }));
