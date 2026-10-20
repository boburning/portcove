import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import path from "node:path";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";

/** Credential transport only. The existing remote verifier owns repository,
 * namespace, object and CAS checks; this API grants no caller/job authority.
 * Journal credentials are never borrowed from the provider GH_TOKEN/config. */
export function createCoordinatorJournalApi(directory: string): CoordinatorRemoteApi {
  const token = process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 16384 ||
    Array.from(token).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("dedicated coordinator journal credential unavailable");
  if (
    !path.isAbsolute(directory) ||
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink() ||
    realpathSync(directory) !== path.resolve(directory)
  )
    throw new Error("journal transport requires a private owned directory");
  const home = mkdtempSync(path.join(directory, "journal-api-"));
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "windir",
    "COMSPEC",
    "PATHEXT",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  Object.assign(environment, {
    GH_TOKEN: token,
    GH_HOST: "github.com",
    GH_CONFIG_DIR: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  });
  const redact = (value: string) => value.replaceAll(token, "[redacted]");
  const runner = createGitHubRunner({
    cwd: directory,
    timeoutMs: 15000,
    maxBuffer: 2 * 1024 * 1024,
    spawn(command, args, options) {
      const result = spawnSync(command, args, { ...options, env: environment });
      const error = result.error
        ? Object.assign(new Error("journal subprocess failed"), {
            code:
              "code" in result.error && result.error.code === "ETIMEDOUT"
                ? "ETIMEDOUT"
                : "JOURNAL_PROCESS_FAILED",
          })
        : null;
      return {
        status: result.status,
        stdout: redact(String(result.stdout ?? "")),
        stderr: redact(String(result.stderr ?? "")),
        error,
      };
    },
  });
  const api = new GitHubApiClient((args, body) =>
    runner([...args, "--hostname", "github.com"], body),
  );
  return {
    request(method, endpoint, body) {
      if (
        !/^repos\/boburning\/portcove(?:\/git\/(?:blobs|trees|commits)(?:\/[a-f0-9]{40})?)?$/u.test(
          endpoint,
        ) ||
        !["GET", "POST"].includes(method) ||
        (method === "POST" &&
          !/^repos\/boburning\/portcove\/git\/(?:blobs|trees|commits)$/u.test(endpoint))
      )
        throw new Error("journal transport route is outside the fixed repository/object endpoints");
      return api.request(method, endpoint, body);
    },
    graphql(query, variables) {
      return api.graphql(query, variables);
    },
  };
}
