import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { requestAssemblerToken } from "./assembler-job-identity.mts";
import { isRecord } from "./runtime-values.mts";

const endpoint = "repos/boburning/portcove/pages/deployments";
const publicUrl = "https://boburning.github.io/portcove/";
const audience = "https://github.com/boburning";
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
) {
  const runner = createGitHubRunner({ cwd: directory, timeoutMs: 30_000, maxBuffer: 128 * 1024 });
  const api =
    injected.api ??
    new GitHubApiClient((args, input) => runner([...args, "--hostname", "github.com"], input));
  const scope = injected.api || injected.token ? "injected-provider" : "github.com";
  let attempted = false;
  return {
    evidence_scope: scope,
    async create(raw: Omit<PagesDeploymentIdentity, "id">) {
      const expected = identity({ ...structuredClone(raw), id: "pending" });
      if (attempted)
        throw new Error(
          "Pages POST already attempted; reconcile original evidence before any later action",
        );
      // Acquire a distinct Pages-audience token only in the actual fixed job.
      // It is never returned, retained in receipts, or included in diagnostics.
      const token = await (injected.token ?? (() => requestAssemblerToken(audience)))();
      if (typeof token !== "string" || token.length < 1 || token.length > 16384)
        throw new Error("Pages OIDC credential is unavailable");
      attempted = true;
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
      const body = response.body;
      if (
        response.status !== 200 ||
        !isRecord(body) ||
        typeof body.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(body.id) ||
        body.status_url !== `https://api.github.com/${endpoint}/${body.id}` ||
        body.page_url !== publicUrl
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
      const expected = identity(structuredClone(raw));
      let response: ReturnType<Api["request"]>;
      try {
        response = api.request("GET", `${endpoint}/${expected.id}`);
      } catch {
        throw new Error("Pages deployment readback unavailable; retain original pending intent");
      }
      const body = response.body;
      if (
        response.status !== 200 ||
        !isRecord(body) ||
        typeof body.status !== "string" ||
        ![
          "deployment_in_progress",
          "syncing_files",
          "updating_pages",
          "succeed",
          "cancelled",
          "failed",
          "deployment_failed",
        ].includes(body.status)
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
