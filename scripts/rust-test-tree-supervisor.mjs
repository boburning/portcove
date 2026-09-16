import { existsSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [, , gatePath, statusPath, cleanupReceiptPath, command, ...args] = process.argv;
if (!gatePath || !statusPath || !cleanupReceiptPath || !command) {
  console.error(
    "usage: rust-test-tree-supervisor <gate> <status> <cleanup-receipt> <command> [arguments...]",
  );
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
  const cleanerReadyPath = `${cleanupReceiptPath}.ready`;
  const cleanerScript = [
    'const { renameSync, writeFileSync } = require("node:fs")',
    `const ready = ${JSON.stringify(cleanerReadyPath)}`,
    `const receipt = ${JSON.stringify(cleanupReceiptPath)}`,
    `const group = ${process.pid}`,
    'writeFileSync(ready, "ready\\n", { flag: "wx" })',
    "let cleaned = false",
    "const waitForQuiescence = () => new Promise((resolve) => {",
    "  const deadline = Date.now() + 5000",
    "  const poll = () => {",
    '    try { process.kill(-group, 0) } catch (error) { return resolve(error.code === "ESRCH" ? "quiescent" : `failed:${error.code ?? error.message}`) }',
    '    if (Date.now() >= deadline) return resolve("failed:timeout")',
    "    setTimeout(poll, 10)",
    "  }",
    "  poll()",
    "})",
    "const cleanup = async () => {",
    "  if (cleaned) return",
    "  cleaned = true",
    '  let outcome = "quiescent"',
    '  try { process.kill(-group, "SIGKILL"); outcome = await waitForQuiescence() } catch (error) { if (error.code !== "ESRCH") outcome = `failed:${error.code ?? error.message}` }',
    "  const pending = `${receipt}.pending-${process.pid}`",
    '  writeFileSync(pending, `${JSON.stringify({ outcome })}\\n`, { flag: "wx" })',
    "  renameSync(pending, receipt)",
    "}",
    'process.stdin.once("end", () => void cleanup())',
    'process.stdin.once("error", () => void cleanup())',
    "process.stdin.resume()",
  ].join(";");
  const cleaner = spawn(process.execPath, ["-e", cleanerScript], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  let cleanerFailed = false;
  const killAnchoredGroup = () => {
    if (cleanerFailed) return;
    cleanerFailed = true;
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {}
  };
  cleaner.once("error", killAnchoredGroup);
  cleaner.once("exit", killAnchoredGroup);
  const readyDeadline = Date.now() + 5_000;
  while (!existsSync(cleanerReadyPath)) {
    if (cleanerFailed || Date.now() >= readyDeadline)
      throw new Error("Heavy Rust supervisor cleanup watchdog did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

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
  cleanerFailed = true;
  cleaner.stdin.end();
  await new Promise(() => {});
} catch (error) {
  console.error(`Heavy Rust supervisor failed closed: ${error.message}`);
  await new Promise(() => {});
}
