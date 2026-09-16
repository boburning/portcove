import { existsSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const [, , gatePath, statusPath, command, ...args] = process.argv;
if (!gatePath || !statusPath || !command) {
  console.error("usage: rust-test-tree-supervisor <gate> <status> <command> [arguments...]");
  process.exit(2);
}

const gateDeadline = Date.now() + 30_000;
while (!existsSync(gatePath)) {
  if (Date.now() >= gateDeadline) {
    console.error("Heavy Rust supervisor registration gate timed out before command launch");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

try {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: false,
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  const exitCode = await new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });

  const pendingStatus = `${statusPath}.pending-${process.pid}`;
  writeFileSync(pendingStatus, `${JSON.stringify({ exit_code: exitCode })}\n`, { flag: "wx" });
  renameSync(pendingStatus, statusPath);

  const cleanerScript = [
    'const { existsSync, writeFileSync } = require("node:fs")',
    `const ready = ${JSON.stringify(`${statusPath}.cleaner-ready`)}`,
    `const go = ${JSON.stringify(`${statusPath}.cleaner-go`)}`,
    `const group = ${process.pid}`,
    'writeFileSync(ready, "ready\\n", { flag: "wx" })',
    "const deadline = Date.now() + 30000",
    "while (!existsSync(go) && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25) }",
    "if (!existsSync(go)) process.exit(1)",
    'try { process.kill(-group, "SIGKILL") } catch (error) { console.error(error.message); process.exit(1) }',
  ].join(";");
  const cleaner = spawn(process.execPath, ["-e", cleanerScript], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  cleaner.unref();
  const readyPath = `${statusPath}.cleaner-ready`;
  const readyDeadline = Date.now() + 5_000;
  while (!existsSync(readyPath)) {
    if (Date.now() >= readyDeadline) {
      throw new Error("Heavy Rust supervisor cleanup helper did not become ready");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  writeFileSync(`${statusPath}.cleaner-go`, "go\n", { flag: "wx" });
  await new Promise(() => {});
} catch (error) {
  console.error(`Heavy Rust supervisor failed closed: ${error.message}`);
  await new Promise(() => {});
}
