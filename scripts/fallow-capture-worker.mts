import { spawn } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHeavyRustTestLock } from "./heavy-rust-test-lock.mts";
import { acquireSourceBoundCapacity, frontendOutputResource } from "./resource-capacity.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

async function main() {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3)
    throw new Error("Capture worker requires one owned invocation file");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw new Error("Invalid capture invocation file");
  const config: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !isRecord(config) ||
    typeof config.command !== "string" ||
    !Array.isArray(config.args) ||
    !config.args.every((arg: unknown) => typeof arg === "string") ||
    typeof config.maxBytes !== "number" ||
    !Number.isSafeInteger(config.maxBytes) ||
    config.maxBytes < 1 ||
    config.maxBytes > 32 * 1024 * 1024
  )
    throw new Error("Invalid capture invocation");
  const args: unknown[] = config.args;
  const command = config.command;
  const maxBytes = config.maxBytes;
  if (!process.env.PORTCOVE_HEAVY_RUST_LOCK_TOKEN && !process.env.PORTCOVE_RESOURCE_RESERVATION)
    throw new Error("Capture worker requires verified inherited custody");
  if (
    (process.env.GITHUB_ACTIONS === "true" || process.env.PORTCOVE_CONTAINER_GUEST === "1") &&
    !process.env.PORTCOVE_HEAVY_RUST_LOCK_TOKEN
  )
    throw new Error("Hosted capture worker requires a verified inherited Heavy Rust owner");
  const lease = process.env.PORTCOVE_HEAVY_RUST_LOCK_TOKEN
    ? await acquireHeavyRustTestLock({ workspace: root })
    : await acquireSourceBoundCapacity(
        "analysis",
        { workspace: root },
        { exclusive: [frontendOutputResource(root)] },
      );
  if (!lease.inherited) {
    await lease.release();
    throw new Error("Capture worker cannot establish its own unsupervised reservation");
  }
  try {
    const code = await new Promise<number>((resolve) => {
      const child = spawn(command, args as string[], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let spawnError: Error | undefined;
      const counts = [0, 0];
      const resultFile = path.join(path.dirname(file), "native-exit.json");
      const retain = (value: unknown) =>
        writeFileSync(resultFile, JSON.stringify(value), { flag: "wx" });
      for (const [index, stream] of [child.stdout, child.stderr].entries())
        stream.on("data", (chunk: Buffer) => {
          const remaining = maxBytes - (counts[index] ?? 0);
          if (remaining > 0) writeSync(index + 1, chunk.subarray(0, remaining));
          counts[index] = (counts[index] ?? 0) + chunk.length;
          if ((counts[index] ?? 0) > maxBytes) {
            retain({
              status: null,
              signal: null,
              error: "Analyzer output exceeded its retained byte limit",
              code: "ENOBUFS",
            });
            // The registered ancestor owns termination and exit proof for this
            // child and descendants after the bounded capture worker exits.
            process.exit(1);
          }
        });
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (status, signal) => {
        retain({
          status,
          signal,
          error: spawnError ? errorMessage(spawnError).slice(0, 2048) : null,
        });
        resolve(spawnError || signal ? 1 : (status ?? 1));
      });
    });
    process.exitCode = code;
  } finally {
    await lease.release();
  }
}

try {
  await main();
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
