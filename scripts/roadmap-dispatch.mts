import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hosted Roadmap commands that a REST-only caller may dispatch. Reads and
 * single-item planning edits are allowed; structural, bulk and file-producing
 * commands stay with a local maintainer session.
 */
export const dispatchableRoadmapCommands = [
  "check",
  "doctor",
  "next",
  "context",
  "history",
  "readiness",
  "candidate-scope",
  "capture-port",
  "capture-feature",
  "normalize-port",
  "promote",
  "set",
  "move",
] as const;

// Options that read or write runner files cannot express a caller's intent safely.
const refusedOptions = new Set(["--spec-file", "--output", "--consumed-file"]);

/** Validate a dispatch into exact `roadmap.mts` arguments without shell parsing. */
export function roadmapDispatchArguments(command: string, encodedArguments: string) {
  if (!(dispatchableRoadmapCommands as readonly string[]).includes(command))
    throw new Error(`Roadmap command ${JSON.stringify(command)} is not dispatchable.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedArguments.trim() || "[]");
  } catch {
    throw new Error("Roadmap arguments must be a JSON array of strings.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 32 ||
    !parsed.every(
      (value): value is string =>
        typeof value === "string" && value.length <= 4096 && !/[\0\r\n]/u.test(value),
    )
  )
    throw new Error("Roadmap arguments must be a JSON array of at most 32 single-line strings.");
  for (const value of parsed) {
    if (value === "--help" || value === "-h")
      throw new Error("Dispatch runs a command; read help locally instead.");
    const option = value.split("=", 1)[0] ?? "";
    if (refusedOptions.has(option))
      throw new Error(`Roadmap option ${option} reads or writes runner files and is refused.`);
  }
  return [command, ...parsed];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = roadmapDispatchArguments(
    process.env.ROADMAP_COMMAND ?? "",
    process.env.ROADMAP_ARGUMENTS ?? "[]",
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./roadmap.mts", import.meta.url)), ...argv],
    { stdio: "inherit", env: process.env },
  );
  const status = result.status ?? 1;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Roadmap \`${argv[0]}\` exited ${status}${result.signal ? ` (${result.signal})` : ""}.\n`,
    );
  if (result.error) throw result.error;
  process.exitCode = status;
}
