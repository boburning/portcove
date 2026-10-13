import { statSync } from "node:fs";
import path from "node:path";
import { spawnCommand } from "./dev-storage.mjs";
import { frontendEnvironment } from "../apps/desktop/scripts/build-frontend.mjs";

export const frontendProbeTimeoutMs = 10_000;
export const frontendProbeOutputBytes = 16 * 1024;

// File availability is a plan observation, not successful execution or a version proof.
export function frontendCommandPlan({
  cwd,
  environment,
  packageManager,
  platform = process.platform,
}) {
  const env = frontendEnvironment(environment);
  const searchPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const names = platform === "win32" ? ["pnpm.exe", "pnpm.cmd", "pnpm.bat"] : ["pnpm"];
  const directories = [cwd, ...searchPath.split(platform === "win32" ? ";" : ":")];
  const candidates = directories.flatMap((directory) =>
    names.map((name) => path.resolve(directory.replace(/^"|"$/gu, ""), name)),
  );
  const commandFile =
    candidates.find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null;
  return {
    command: "pnpm",
    args: ["--version"],
    cwd,
    expected_version: packageManager.split("@").at(-1),
    command_file: commandFile,
    file_available: Boolean(commandFile),
    observed_version: null,
    execution: "not-run",
    timeout_ms: frontendProbeTimeoutMs,
    output_limit_bytes: frontendProbeOutputBytes,
  };
}

export function probeFrontendCommand({ cwd, environment, packageManager, run = spawnCommand }) {
  const plan = frontendCommandPlan({ cwd, environment, packageManager });
  const started = new Date();
  let result;
  let failure;
  try {
    result = run("pnpm", ["--version"], {
      cwd,
      env: frontendEnvironment(environment),
      encoding: "utf8",
      windowsHide: true,
      timeout: frontendProbeTimeoutMs,
      maxBuffer: frontendProbeOutputBytes,
    });
    if (result.error) throw result.error;
  } catch (error) {
    failure = error;
  }
  const bounded = (value) => {
    let text = String(value ?? "");
    while (Buffer.byteLength(text, "utf8") > frontendProbeOutputBytes)
      text = text.slice(0, Math.floor(text.length / 2));
    return text;
  };
  const stdout = bounded(result?.stdout ?? failure?.stdout);
  const stderr = bounded(result?.stderr ?? failure?.stderr);
  const version = stdout.trim();
  const ready =
    !failure &&
    result?.status === 0 &&
    version === plan.expected_version &&
    Buffer.byteLength(String(result.stdout ?? ""), "utf8") <= frontendProbeOutputBytes &&
    Buffer.byteLength(String(result.stderr ?? ""), "utf8") <= frontendProbeOutputBytes;
  return {
    ...plan,
    execution: "observed",
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    ready,
    observed_version: ready ? version : null,
    exit_status: result?.status ?? null,
    error_code: failure?.code ?? null,
    stdout,
    stderr,
    message: ready
      ? "Pinned frontend command ready"
      : `Frontend pnpm prerequisite failed (${failure?.code ?? result?.status ?? "unknown"}); expected ${plan.expected_version}. Repair the pnpm command in the frontend PATH, then rerun.`,
  };
}
