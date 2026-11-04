/** Approved non-API CLI operations only. No REST/GraphQL argument protocol. */
import { execFile, spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { GitHubApiError } from "./github-operation.mts";
import { errorCode } from "./runtime-values.mts";
import type { GitHubCredential } from "./github-client.mts";

const execute = promisify(execFile);
export type RetainedGitHubSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => { status: number | null; stdout: string; stderr: string; error?: Error | null };

export function verifyGitHubAttestation(
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxBytes: number;
    environment?: NodeJS.ProcessEnv;
    spawn?: RetainedGitHubSpawn;
  },
) {
  if (args[0] !== "attestation" || args[1] !== "verify")
    throw new GitHubApiError(
      "request_refused",
      "Only retained attestation verification is admitted",
    );
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1
  )
    throw new GitHubApiError("invalid_configuration", "Invalid retained verifier bounds");
  const result = (options.spawn ?? spawnSync)("gh", args, {
    cwd: options.cwd,
    env: options.environment,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxBytes,
    killSignal: "SIGKILL",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw new GitHubApiError("command_failed", "Bounded GitHub attestation verification failed", {
      cause: Object.assign(new Error("Verifier execution failed"), {
        code: errorCode(result.error),
      }),
    });
  return result.stdout.trim();
}

/** Resolve once at the eligible local command boundary. Explicit and anonymous
 * operations pass their own credential kind directly to the SDK factory. */
export function localDeveloperCredential(options: {
  environment?: NodeJS.ProcessEnv;
  command?: string | undefined;
  deadline: number;
  resolve?: (signal: AbortSignal) => Promise<string>;
}): GitHubCredential {
  const environment = options.environment ?? process.env;
  const token = environment.GH_TOKEN || environment.GITHUB_TOKEN;
  if (token) return { kind: "explicit", token };
  if (environment.CI === "true" || environment.GITHUB_ACTIONS === "true")
    throw new GitHubApiError("credential_unavailable", "Workflow GitHub credential is required");
  const resolve =
    options.resolve ??
    (async (signal: AbortSignal) => {
      const remaining = Math.ceil(options.deadline - performance.now());
      if (remaining < 1) throw new Error("Credential deadline exhausted");
      const result = await execute(
        options.command ?? "gh",
        ["auth", "token", "--hostname", "github.com"],
        {
          env: { ...environment, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
          timeout: Math.min(15_000, remaining),
          killSignal: "SIGKILL",
          maxBuffer: 16384,
          encoding: "utf8",
          windowsHide: true,
          signal,
        },
      );
      return result.stdout.trim();
    });
  let pending: Promise<string> | undefined;
  return {
    kind: "local",
    resolve: (signal) => {
      pending ??= Promise.resolve()
        .then(() => resolve(signal))
        .catch(() => {
          throw new GitHubApiError(
            "credential_unavailable",
            "Local GitHub credential is unavailable",
          );
        });
      return pending;
    },
  };
}
