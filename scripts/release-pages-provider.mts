import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { requestAssemblerToken } from "./assembler-job-identity.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";

const endpoint = "repos/boburning/portcove/pages/deployments";
const publicUrl = "https://boburning.github.io/portcove/";
const audience = "https://github.com/boburning";
const terminalFailures = new Set([
  "cancelled",
  "failed",
  "deployment_failed",
  "deployment_perms_error",
  "deployment_content_failed",
  "deployment_cancelled",
  "deployment_lost",
]);
export function isTerminalPagesFailure(status: string) {
  return terminalFailures.has(status);
}
interface Api {
  request(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Pick<ReturnType<GitHubApiClient["request"]>, "status" | "headers" | "body">;
}

export interface PagesDeploymentIdentity {
  id: string;
  artifact_id: number;
  controller_revision: string;
  generation: string;
}

function identity(value: unknown): PagesDeploymentIdentity {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "artifact_id,controller_revision,generation,id" ||
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.id) ||
    typeof value.artifact_id !== "number" ||
    !Number.isSafeInteger(value.artifact_id) ||
    value.artifact_id < 1 ||
    typeof value.controller_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.controller_revision) ||
    typeof value.generation !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.generation)
  )
    throw new Error("Pages deployment identity is unavailable");
  return {
    id: value.id,
    artifact_id: value.artifact_id,
    controller_revision: value.controller_revision,
    generation: value.generation,
  };
}

/** Narrow provider transport, not admission or executor authority. The caller
 * must first durably publish the existing coordinator pending intent. A Pages
 * deployment ID/build version is NOT a CAS token or proof of the deployed bytes.
 * This instance allows exactly one POST, including when its response is lost.
 * Recovery uses readback; creating a new instance is not retry authorization. */
export function createPagesProviderTransport(
  directory: string,
  injected: { api?: Api; token?: () => Promise<string> } = {},
  deadline?: number,
) {
  const remaining = () => {
    if (deadline !== undefined && !Number.isFinite(deadline))
      throw new Error("Pages phase deadline exhausted; retain pending intent");
    const timeoutMs =
      deadline === undefined ? 30000 : Math.floor(Math.min(30000, deadline - performance.now()));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
      throw new Error("Pages phase deadline exhausted; retain pending intent");
    return timeoutMs;
  };
  remaining();
  const api =
    injected.api ??
    new GitHubApiClient((args, input) =>
      createGitHubRunner({ cwd: directory, timeoutMs: remaining(), maxBuffer: 128 * 1024 })(
        [...args, "--hostname", "github.com"],
        input,
      ),
    );
  const scope = injected.api || injected.token ? "injected-provider" : "github.com";
  let attempted = false;
  return {
    evidence_scope: scope,
    async create(
      raw: Omit<PagesDeploymentIdentity, "id">,
      beforePost?: () => Promise<void> | void,
    ) {
      const expected = identity({ ...structuredClone(raw), id: "pending" });
      if (scope === "github.com" && typeof beforePost !== "function")
        throw new Error("actual Pages transport requires the fixed final pre-POST guard");
      if (attempted)
        throw new Error(
          "Pages POST already attempted; reconcile original evidence before any later action",
        );
      // Claim the one-shot boundary before the first await. Two callers must
      // not both acquire a credential and enter the same pending effect.
      attempted = true;
      remaining();
      // Acquire a distinct Pages-audience token only in the actual fixed job.
      // It is never returned, retained in receipts, or included in diagnostics.
      const token = await (
        injected.token ??
        (() =>
          requestAssemblerToken(audience, process.env, (input, init) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([
                ...(init?.signal ? [init.signal] : []),
                AbortSignal.timeout(remaining()),
              ]),
            }),
          ))
      )();
      if (typeof token !== "string" || token.length < 1 || token.length > 16384)
        throw new Error("Pages OIDC credential is unavailable");
      // Credential acquisition can outlast the caller's fresh controls. Its
      // fixed guard runs after that await, immediately before the sole POST.
      await beforePost?.();
      remaining();
      let response: ReturnType<Api["request"]>;
      try {
        response = api.request("POST", endpoint, {
          artifact_id: expected.artifact_id,
          pages_build_version: expected.controller_revision,
          oidc_token: token,
        });
      } catch {
        // Do not propagate CLI/provider diagnostics that could echo a bearer.
        throw new Error(
          "Pages POST outcome ambiguous; preserve pending intent and require readback",
        );
      }
      remaining();
      const body = response.body;
      if (
        response.status !== 200 ||
        !isRecord(body) ||
        typeof body.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(body.id) ||
        ![
          `https://api.github.com/${endpoint}/${body.id}`,
          `https://api.github.com/${endpoint}/${body.id}/status`,
        ].includes(String(body.status_url)) ||
        ![publicUrl, publicUrl.slice(0, -1), publicUrl.slice(8), publicUrl.slice(8, -1)].includes(
          String(body.page_url),
        )
      )
        throw new Error(
          "Pages POST acknowledgement unavailable; preserve pending intent and require readback",
        );
      return {
        ...identity({ ...expected, id: body.id }),
        evidence_scope: scope,
        stage: "provider-acknowledged" as const,
        acceptance: "pending-public-readback" as const,
      };
    },
    /** One observation, no cancellation, re-POST or unbounded polling. Even
     * succeed must be followed by independent complete expected-byte readback. */
    observe(raw: PagesDeploymentIdentity) {
      remaining();
      const expected = identity(structuredClone(raw));
      let response: ReturnType<Api["request"]>;
      try {
        response = api.request("GET", `${endpoint}/${expected.id}`);
      } catch {
        throw new Error("Pages deployment readback unavailable; retain original pending intent");
      }
      remaining();
      const body = response.body;
      if (
        response.status !== 200 ||
        !isRecord(body) ||
        typeof body.status !== "string" ||
        (![
          "deployment_in_progress",
          "syncing_files",
          "updating_pages",
          "succeed",
          "cancelled",
          "failed",
          "deployment_failed",
        ].includes(body.status) &&
          !isTerminalPagesFailure(body.status))
      )
        throw new Error("Pages deployment readback incomplete; retain original pending intent");
      return {
        ...expected,
        status: body.status,
        evidence_scope: scope,
        stage: "provider-status-only" as const,
        acceptance: "pending-public-readback" as const,
      };
    },
  };
}
