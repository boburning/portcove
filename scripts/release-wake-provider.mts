import { semanticReviewCheckName } from "./release-control-phases.mts";
import { downloadGitHubArtifactArchive } from "./github-artifact-download.mts";
import { createGitHubClient } from "./github-client.mts";
import type { GitHubCredential, GitHubRequestPolicy } from "./github-client.mts";

export type WakeResponse = { status: number; body: unknown };
export type RetainWakeResponse = (response: WakeResponse) => Promise<void>;
export interface WakeDispatch {
  ref: string;
  inputs: Record<string, unknown>;
  return_run_details: boolean;
}
export type WakeWorkflow =
  | "application-update-wake.yml"
  | "application-update-production.yml"
  | "job-token-dispatch-fixture.yml"
  | "application-release.yml";
export interface WakeProvider {
  repository(): Promise<unknown>;
  applicationChecks?(sha: string): Promise<unknown>;
  run(id: string, retain?: RetainWakeResponse): Promise<unknown>;
  jobs(id: string, attempt?: number): Promise<unknown>;
  ref(name: string): Promise<unknown>;
  compareAncestry(base: string, head: string): Promise<unknown>;
  file(filename: string, revision: string): Promise<unknown>;
  runs(workflow: WakeWorkflow, filters: Record<string, string>, page: number): Promise<unknown>;
  artifacts(run: string): Promise<unknown>;
  artifact(id: number): Promise<unknown>;
  intentArchive?(id: number, bytes: number, deadline: number): Promise<Buffer>;
  dispatch(
    workflow: WakeWorkflow,
    body: WakeDispatch,
    retain?: RetainWakeResponse,
  ): Promise<WakeResponse>;
}

/** Fixed repository operations. Credentials and the original job deadline are
 * supplied by the owning workflow; this adapter grants no dispatch authority. */
export async function createWakeProvider(options: {
  credential: GitHubCredential;
  deadline: number;
  remainingDeadline: () => number;
  apiVersion: string;
  maxBytes: number;
  maxRequests?: number;
  requestTimeoutMs?: 10000 | 30000;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): Promise<WakeProvider> {
  const credential = { ...options.credential };
  const client = await createGitHubClient({
    credential,
    deadline: options.deadline,
    maxBytes: options.maxBytes,
    requestTimeoutMs: options.requestTimeoutMs ?? 10000,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": options.apiVersion },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let requests = 0;
  const chargeRequest = () => {
    if (++requests > (options.maxRequests ?? Infinity))
      throw new Error("wake provider request budget exhausted");
  };
  const policy = (retain?: RetainWakeResponse): GitHubRequestPolicy => {
    chargeRequest();
    return {
      replay: "once",
      attempts: 0,
      deadline: options.remainingDeadline(),
      ...(retain
        ? { retainResponse: async ({ status, data }) => retain({ status, body: data }) }
        : {}),
    };
  };
  const repository = { owner: "boburning", repo: "portcove" };
  const get = async (
    route: string,
    parameters: Record<string, unknown>,
    retain?: RetainWakeResponse,
  ) => {
    const response = await client.request(`GET ${route}`, {
      ...parameters,
      ...repository,
      request: { portcove: policy(retain) },
    });
    if (response.status !== 200) throw new Error("wake provider readback unavailable");
    return response.data as unknown;
  };
  return {
    repository: () => get("/repos/{owner}/{repo}", {}),
    applicationChecks(sha) {
      if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("wake requires an exact commit");
      return get("/repos/{owner}/{repo}/commits/{ref}/check-runs", {
        ref: sha,
        app_id: 5555053,
        check_name: semanticReviewCheckName,
        filter: "all",
        per_page: 100,
        page: 1,
      });
    },
    run: (id, retain) => get("/repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: id }, retain),
    jobs: (id, attempt = 1) =>
      get("/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs", {
        run_id: id,
        attempt_number: attempt,
        per_page: 100,
      }),
    ref: (name) => get("/repos/{owner}/{repo}/git/ref/{ref}", { ref: name }),
    // Page one can include changed files and patches. Only the comparison
    // status and merge base are needed for this ancestry predicate.
    compareAncestry: (base, head) =>
      get("/repos/{owner}/{repo}/compare/{basehead}", {
        basehead: `${base}...${head}`,
        per_page: 1,
        page: 2,
      }),
    file: (filename, revision) =>
      get("/repos/{owner}/{repo}/contents/{path}", { path: filename, ref: revision }),
    runs: (workflow, filters, page) =>
      get("/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
        ...filters,
        workflow_id: workflow,
        page,
        per_page: 100,
      }),
    artifacts: (id) =>
      get("/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", { run_id: id, per_page: 100 }),
    artifact: (id) =>
      get("/repos/{owner}/{repo}/actions/artifacts/{artifact_id}", { artifact_id: id }),
    async intentArchive(id, bytes, deadline) {
      if (
        !Number.isSafeInteger(id) ||
        id < 1 ||
        !Number.isSafeInteger(bytes) ||
        bytes < 22 ||
        bytes > 1024 ** 2
      )
        throw new Error("wake intent archive lookup requires exact bounded identity");
      chargeRequest();
      return downloadGitHubArtifactArchive(`repos/boburning/portcove/actions/artifacts/${id}/zip`, {
        credential,
        deadline: Math.min(deadline, options.deadline, options.remainingDeadline()),
        maxBytes: bytes,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    },
    async dispatch(workflow, body, retain) {
      const parameters = structuredClone(body);
      const response = await client.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        {
          ...parameters,
          ...repository,
          workflow_id: workflow,
          request: { portcove: policy(retain) },
        },
      );
      return { status: response.status, body: response.data };
    },
  };
}
