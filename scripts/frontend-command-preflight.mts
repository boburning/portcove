import { spawnCommand } from "./dev-storage.mts";
import { vitePlusCommand } from "./viteplus-cli.mts";
import { frontendEnvironment } from "../apps/desktop/scripts/build-frontend.mts";

export const frontendProbeTimeoutMs = 10_000;
export const frontendProbeOutputBytes = 16 * 1024;

// File availability is a plan observation, never successful execution/version proof.
export function frontendCommandPlan({ cwd }) {
  let cli;
  let error;
  try {
    cli = vitePlusCommand(cwd);
  } catch (failure) {
    error = failure;
  }
  return {
    command: cli?.command ?? null,
    args: cli ? [...cli.args, "--version"] : [],
    cwd,
    expected_version: cli?.version ?? null,
    command_file: cli?.executable ?? null,
    file_available: Boolean(cli),
    observed_version: null,
    execution: "not-run",
    timeout_ms: frontendProbeTimeoutMs,
    output_limit_bytes: frontendProbeOutputBytes,
    ...(error ? { resolution_error: error.message } : {}),
  };
}

export function probeFrontendCommand({ cwd, environment, run = spawnCommand }) {
  const plan = frontendCommandPlan({ cwd });
  const started = new Date();
  let result;
  let failure;
  if (plan.file_available) {
    try {
      result = run(plan.command, plan.args, {
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
  }
  const bounded = (value) => {
    let text = String(value ?? "");
    while (Buffer.byteLength(text, "utf8") > frontendProbeOutputBytes)
      text = text.slice(0, Math.floor(text.length / 2));
    return text;
  };
  const stdout = bounded(result?.stdout ?? failure?.stdout);
  const stderr = bounded(result?.stderr ?? failure?.stderr);
  const version = /^vp v(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/u.exec(
    stdout.split(/\r?\n/u)[0]?.trim() ?? "",
  )?.[1];
  const ready =
    plan.file_available &&
    !failure &&
    result?.status === 0 &&
    version === plan.expected_version &&
    Buffer.byteLength(String(result.stdout ?? ""), "utf8") <= frontendProbeOutputBytes &&
    Buffer.byteLength(String(result.stderr ?? ""), "utf8") <= frontendProbeOutputBytes;
  return {
    ...plan,
    execution: plan.file_available ? "observed" : "not-run",
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    ready,
    observed_version: ready ? version : null,
    exit_status: result?.status ?? null,
    error_code: failure?.code ?? null,
    stdout,
    stderr,
    message: ready
      ? "Installed frontend Vite+ command ready"
      : `Frontend Vite+ prerequisite failed (${failure?.code ?? result?.status ?? plan.resolution_error ?? "unknown"}); run pnpm install --frozen-lockfile, then rerun.`,
  };
}
