import { errorMessage } from "./runtime-values.mts";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Serialized watchdog program; EPERM never establishes process-group absence. */
export function unixCleanupProgram({
  readyPath,
  receiptPath,
  group,
}: {
  readyPath: string;
  receiptPath: string;
  group: number;
}) {
  return [
    'const { renameSync, writeFileSync } = require("node:fs")',
    `const ready = ${JSON.stringify(readyPath)}`,
    `const receipt = ${JSON.stringify(receiptPath)}`,
    `const group = ${group}`,
    'writeFileSync(ready, "ready\\n", { flag: "wx" })',
    "let cleaned = false",
    "const waitForQuiescence = () => new Promise((resolve) => {",
    "  const deadline = Date.now() + 5000",
    '  let pending = "timeout"',
    "  const poll = () => {",
    '    try { process.kill(-group, 0); pending = "timeout" } catch (error) {',
    '      if (error.code === "ESRCH") return resolve("quiescent")',
    '      if (error.code !== "EPERM") return resolve(`failed:${error.code ?? error.message}`)',
    '      pending = "EPERM"',
    "    }",
    "    if (Date.now() >= deadline) return resolve(`failed:${pending}`)",
    "    setTimeout(poll, 10)",
    "  }",
    "  poll()",
    "})",
    "const cleanup = async () => {",
    "  if (cleaned) return",
    "  cleaned = true",
    '  let outcome = "quiescent"',
    '  try { process.kill(-group, "SIGKILL"); outcome = await waitForQuiescence() } catch (error) {',
    '    if (error.code === "EPERM") outcome = await waitForQuiescence()',
    '    else if (error.code !== "ESRCH") outcome = `failed:${error.code ?? error.message}`',
    "  }",
    "  const pending = `${receipt}.pending-${group}`",
    '  writeFileSync(pending, `${JSON.stringify({ outcome })}\\n`, { flag: "wx" })',
    "  renameSync(pending, receipt)",
    "}",
    'process.stdin.once("end", () => void cleanup())',
    'process.stdin.once("error", () => void cleanup())',
    "process.stdin.resume()",
  ].join(";");
}

async function main() {
  const linuxManaged = process.argv[2] === "--linux-managed";
  const [gatePath, statusPath, cleanupReceiptPath, command, ...args] = process.argv.slice(
    linuxManaged ? 3 : 2,
  );
  if (!gatePath || !statusPath || !cleanupReceiptPath || !command) {
    console.error(
      "usage: rust-test-tree-supervisor <gate> <status> <cleanup-receipt> <command> [arguments...]",
    );
    process.exit(2);
  }

  if (linuxManaged) {
    const reaperLost = () => {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        process.exit(1);
      }
    };
    process.stdin.once("end", reaperLost);
    process.stdin.once("error", reaperLost);
    process.stdin.resume();
  }

  const gateDeadline = Date.now() + 30_000;
  while (!existsSync(gatePath)) {
    if (Date.now() >= gateDeadline) {
      console.error("Heavy Rust supervisor registration gate timed out before command launch");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  if (linuxManaged) {
    // The Linux parent is already an adopting reaper and owns group closure.
    // This registered Node group admits the exact payload only after the gate.
    const child = spawn(command, args, {
      cwd: process.cwd(),
      detached: false,
      stdio: ["ignore", "inherit", "inherit"],
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
    // Root completion is not descendant closure. Retain the reaper-loss fallback
    // until the adopting parent closes and reaps this anchored group.
    await new Promise(() => {});
  } else
    try {
      const cleanerReadyPath = `${cleanupReceiptPath}.ready`;
      const cleanerScript = unixCleanupProgram({
        readyPath: cleanerReadyPath,
        receiptPath: cleanupReceiptPath,
        group: process.pid,
      });
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
      console.error(`Heavy Rust supervisor failed closed: ${errorMessage(error)}`);
      await new Promise(() => {});
    }
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invoked === fileURLToPath(import.meta.url)) await main();
