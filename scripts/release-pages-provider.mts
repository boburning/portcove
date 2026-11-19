import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { coordinatorCommandTimeout } from "./release-coordinator-deadline.mts";
import { requestAssemblerToken } from "./assembler-job-identity.mts";
import { isRecord } from "./runtime-values.mts";
import { GitHubApiError } from "./github-operation.mts";
import { performance } from "node:perf_hooks";

const endpoint = "repos/boburning/portcove/pages/deployments";
const publicUrl = "https://boburning.github.io/portcove/";
const audience = "https://github.com/boburning";
const deploymentId = /^[A-Za-z0-9_-]{1,128}$/u;
const remoteIdentityPrefix = "github-pages:boburning/portcove:";

/** Interpret an already retained effect locator. The caller still verifies the
 * original operation, provider status and public generation. */
export function retainedPagesDeploymentId(remoteIdentity: string) {
  const id = remoteIdentity.slice(remoteIdentityPrefix.length);
  if (!remoteIdentity.startsWith(remoteIdentityPrefix) || !deploymentId.test(id))
    throw new Error("retained Pages deployment identity differs");
  return id;
}

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
interface PagesReply {
  status: number;
  body: unknown;
  request_id?: string | undefined;
}
interface PagesCreateInput {
  artifact_id: number;
  pages_build_version: string;
  oidc_token: string;
}
export interface PagesProviderOperations {
  create(input: PagesCreateInput): Promise<PagesReply>;
  observe(id: string): Promise<PagesReply>;
  cancel?(id: string): Promise<PagesReply>;
}

/** HTTP only. Pending intent, final controls and byte acceptance belong to the caller. */
export async function createPagesProviderOperations(options: {
  deadline: number;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}): Promise<PagesProviderOperations> {
  const { deadline, fetch: configuredFetch } = options;
  const started = performance.now(),
    left = Math.floor(deadline - started);
  if (!Number.isFinite(deadline) || left < 1)
    throw new Error("Pages phase deadline exhausted; retain pending intent");
  const originalDeadline = Math.min(
    deadline,
    started + coordinatorCommandTimeout(Math.min(left, 2_147_483_647)),
  );
  const credential = (options.environment ?? readOnlyReleaseChildEnvironment() ?? process.env)
    .GH_TOKEN;
  if (!credential) throw new Error("explicit Pages credential required");
  const { createGitHubClient } = await import("./github-client.mts");
  const sdk = await createGitHubClient({
    credential: { kind: "explicit", token: credential },
    deadline: originalDeadline,
    maxBytes: 128 * 1024,
    requestTimeoutMs: 30000,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(configuredFetch ? { fetch: configuredFetch } : {}),
    allowRequest(method, url) {
      return (
        !url.search &&
        ((method === "POST" && url.pathname === `/${endpoint}`) ||
          (method === "POST" &&
            /^\/repos\/boburning\/portcove\/pages\/deployments\/[A-Za-z0-9_-]{1,128}\/cancel$/u.test(
              url.pathname,
            )) ||
          (method === "GET" &&
            /^\/repos\/boburning\/portcove\/pages\/deployments\/[A-Za-z0-9_-]{1,128}$/u.test(
              url.pathname,
            )))
      );
    },
  });
  async function request(method: "POST" | "GET", suffix: string, data?: PagesCreateInput) {
    try {
      const response = await sdk.request({
        method,
        url: `https://api.github.com/${endpoint}${suffix}`,
        ...(data ? { data } : {}),
        request: { portcove: { replay: "once", attempts: 0 } },
      });
      return {
        status: response.status,
        body: response.data as unknown,
        request_id: response.headers["x-github-request-id"],
      };
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status === null) throw error;
      return { status: error.status, body: null, request_id: error.requestId ?? undefined };
    }
  }
  return {
    create: (input) => request("POST", "", input),
    observe(id) {
      if (!deploymentId.test(id)) throw new Error("Pages deployment identity is unavailable");
      return request("GET", `/${id}`);
    },
    cancel(id) {
      if (!deploymentId.test(id)) throw new Error("Pages deployment identity is unavailable");
      return request("POST", `/${id}/cancel`);
    },
  };
}

export interface PagesDeploymentIdentity {
  id: string;
  artifact_id: number;
  controller_revision: string;
  generation: string;
}

export interface PagesRequestEvidence {
  stage: "create" | "acknowledged" | "status" | "cancel";
  id: string;
  status: number | null;
  request_id: string | null;
  native_outcome?: string;
  acknowledgement_refusal?: {
    object: boolean;
    id_type: "string" | "number" | "absent" | "other";
    id_valid: boolean;
    status_url_matches: boolean;
    page_url_matches: boolean;
  };
}

export class PagesCreateAcknowledgementUnavailable extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Pages POST acknowledgement unavailable; preserve pending intent and require readback");
    this.status = status;
  }
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
  injected: {
    operations?: PagesProviderOperations;
    token?: () => Promise<string>;
    evidence?: (entry: PagesRequestEvidence) => void;
  } = {},
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
  const capturedOperations = injected.operations,
    tokenProvider = injected.token;
  const environment = { GH_TOKEN: (readOnlyReleaseChildEnvironment() ?? process.env).GH_TOKEN };
  const originalDeadline = deadline ?? performance.now() + 30000;
  let configured: Promise<PagesProviderOperations> | undefined;
  const operations = () =>
    (configured ??= createPagesProviderOperations({ deadline: originalDeadline, environment }));
  const scope = capturedOperations || tokenProvider ? "injected-provider" : "github.com";
  let attempted = false;
  const cancellationAttempts = new Set<string>();
  const evidence = (
    stage: PagesRequestEvidence["stage"],
    id: string,
    response?: PagesReply,
    nativeOutcome?: string,
    acknowledgementRefusal?: PagesRequestEvidence["acknowledgement_refusal"],
  ) => {
    const requestId = response?.request_id;
    injected.evidence?.({
      stage,
      id,
      status: response?.status ?? null,
      request_id: requestId && /^[0-9A-F:]{1,128}$/iu.test(requestId) ? requestId : null,
      ...(nativeOutcome ? { native_outcome: nativeOutcome } : {}),
      ...(acknowledgementRefusal ? { acknowledgement_refusal: acknowledgementRefusal } : {}),
    });
  };
  return {
    evidence_scope: scope,
    async create(
      raw: Omit<PagesDeploymentIdentity, "id">,
      beforePost?: () => Promise<void> | void,
      buildVersion = raw.generation,
    ) {
      const expected = identity({ ...structuredClone(raw), id: "pending" });
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(buildVersion))
        throw new Error("Invalid Pages build version");
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
      const provider = capturedOperations ?? (await operations());
      remaining();
      // Acquire a distinct Pages-audience token only in the actual fixed job.
      // It is never returned, retained in receipts, or included in diagnostics.
      const token = await (
        tokenProvider ??
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
      let response: PagesReply;
      try {
        response = await provider.create({
          artifact_id: expected.artifact_id,
          pages_build_version: buildVersion,
          oidc_token: token,
        });
      } catch {
        evidence("create", buildVersion);
        // Do not propagate CLI/provider diagnostics that could echo a bearer.
        throw new Error(
          "Pages POST outcome ambiguous; preserve pending intent and require readback",
        );
      }
      const body = response.body;
      const object = isRecord(body);
      const rawId = object ? body.id : undefined;
      const id = typeof rawId === "string" && deploymentId.test(rawId) ? rawId : undefined;
      const statusMatches = !!(
        id &&
        object &&
        typeof body.status_url === "string" &&
        [
          `https://api.github.com/${endpoint}/${id}`,
          `https://api.github.com/${endpoint}/${id}/status`,
        ].includes(body.status_url)
      );
      const pageMatches =
        object &&
        typeof body.page_url === "string" &&
        [publicUrl, publicUrl.slice(0, -1), publicUrl.slice(8), publicUrl.slice(8, -1)].includes(
          body.page_url,
        );
      const acknowledged =
        response.status === 200 && id !== undefined && statusMatches && pageMatches;
      evidence(
        "create",
        buildVersion,
        response,
        undefined,
        acknowledged
          ? undefined
          : {
              object,
              id_type:
                typeof rawId === "string"
                  ? "string"
                  : typeof rawId === "number"
                    ? "number"
                    : rawId === undefined
                      ? "absent"
                      : "other",
              id_valid: id !== undefined,
              status_url_matches: statusMatches,
              page_url_matches: pageMatches,
            },
      );
      remaining();
      if (!acknowledged) throw new PagesCreateAcknowledgementUnavailable(response.status);
      evidence("acknowledged", id, response);
      return {
        ...identity({ ...expected, id }),
        evidence_scope: scope,
        stage: "provider-acknowledged" as const,
        acceptance: "pending-public-readback" as const,
      };
    },
    async status(raw: PagesDeploymentIdentity) {
      remaining();
      const expected = identity(structuredClone(raw));
      let response: PagesReply | undefined;
      try {
        const provider = capturedOperations ?? (await operations());
        remaining();
        response = await provider.observe(expected.id);
      } catch {
        /* No provider disposition was observed. */
      }
      remaining();
      const body = response?.body;
      const status =
        response?.status === 200 && isRecord(body) && typeof body.status === "string"
          ? body.status
          : null;
      const outcome =
        status === "succeed"
          ? "succeeded"
          : status === "cancelled" || status === "deployment_cancelled"
            ? "cancelled"
            : status && isTerminalPagesFailure(status)
              ? "terminal"
              : status &&
                  ["deployment_in_progress", "syncing_files", "updating_pages"].includes(status)
                ? "pending"
                : "unknown";
      const providerOpaque = response?.status === 404 || status === "";
      evidence("status", expected.id, response, providerOpaque ? "provider-opaque" : outcome);
      return {
        ...expected,
        outcome,
        provider_opaque: providerOpaque,
        status: outcome === "unknown" ? null : status,
        evidence_scope: scope,
        stage: "provider-status-only" as const,
        acceptance: "pending-public-readback" as const,
      };
    },
    async observe(raw: PagesDeploymentIdentity) {
      const observation = await this.status(raw);
      if (observation.status === null)
        throw new Error("Pages deployment readback incomplete; retain original pending intent");
      return { ...observation, status: observation.status };
    },
    async cancel(raw: PagesDeploymentIdentity, beforeCancel: () => Promise<void>) {
      const expected = identity(structuredClone(raw));
      if (cancellationAttempts.has(expected.id))
        throw new Error("Pages cancellation already attempted");
      cancellationAttempts.add(expected.id);
      remaining();
      const provider = capturedOperations ?? (await operations());
      if (!provider.cancel) throw new Error("Pages cancellation transport is unavailable");
      await beforeCancel();
      remaining();
      let response: PagesReply | undefined;
      try {
        response = await provider.cancel(expected.id);
      } catch {
        /* Status readback must settle a lost cancellation response. */
      }
      evidence("cancel", expected.id, response);
      remaining();
      return response?.status === 204 ? "acknowledged" : "unknown";
    },
    /** The exact build version is durable before POST. This route can recover
     * a lost acknowledgement, but absent/404 never proves no deployment. The
     * provider's version-to-ID mapping still needs initial setup qualification. */
    observeByGeneration(raw: Omit<PagesDeploymentIdentity, "id">) {
      return this.observe({ ...raw, id: raw.generation });
    },
  };
}
