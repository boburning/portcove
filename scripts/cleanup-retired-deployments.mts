import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createGitHubClient, retainedGitHubHeaders } from "./github-client.mts";
import { GitHubApiError, sanitizeOperationError } from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";

export const repository = "boburning/portcove";
const root = `https://api.github.com/repos/${repository}/deployments`;
const terminal = new Set(["SUCCESS", "FAILURE", "ERROR", "INACTIVE"]);
export type Candidate = {
  id: number;
  node_id: string;
  environment: string;
  sha: string;
  created_at: string;
};
type Status = { id: string; state: string; description: string | null };
export type Deployment = {
  id: string;
  commitOid: string;
  environment: string;
  createdAt: string;
  repository: { nameWithOwner: string };
  latestStatus: Status | null;
  statuses: {
    totalCount: number;
    nodes: Status[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};
export interface Operations {
  inventory(): Promise<Record<string, unknown>[]>;
  read(candidates: Candidate[]): Promise<(Deployment | null)[]>;
  inactivate(id: number, description: string): Promise<void>;
  remove(id: number): Promise<void>;
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const statusFields =
  "id state description environment environmentUrl logUrl createdAt updatedAt creator { login }";
const query = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Deployment {
    id commitOid environment originalEnvironment createdAt updatedAt description task payload
    repository { nameWithOwner }
    creator { login }
    latestStatus { ${statusFields} }
    statuses(first: 100) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { ${statusFields} }
    }
  } }
  rateLimit { cost remaining resetAt }
}`;

/** This dated operation cannot select newer deployments or another repository. */
export function validateManifest(value: unknown): Candidate[] {
  if (!Array.isArray(value) || value.length !== 382) throw new Error("Expected 382 audited IDs");
  const ids = new Set<number>(),
    nodes = new Set<string>();
  for (const c of value) {
    if (
      !isRecord(c) ||
      typeof c.id !== "number" ||
      !Number.isSafeInteger(c.id) ||
      c.id < 1 ||
      typeof c.node_id !== "string" ||
      !c.node_id ||
      typeof c.environment !== "string" ||
      !/^(?:release|portcove-controller-canary|production-(?:catalog-(?:definitions|policy|snapshot|timestamp)|release-(?:admission|classification|coordinator|protection-observer|publication)|tuf-(?:preview|releases|snapshot|stable|timestamp)))$/u.test(
        c.environment,
      ) ||
      typeof c.sha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(c.sha) ||
      typeof c.created_at !== "string" ||
      !Number.isFinite(Date.parse(c.created_at)) ||
      c.created_at > "2026-11-16T14:00:51Z" ||
      ids.has(c.id) ||
      nodes.has(c.node_id)
    )
      throw new Error("Invalid or duplicate historical deployment identity");
    ids.add(c.id);
    nodes.add(c.node_id);
  }
  return value as Candidate[];
}

export function validateDeployment(value: unknown, candidate: Candidate): Deployment {
  if (
    !isRecord(value) ||
    value.id !== candidate.node_id ||
    value.commitOid !== candidate.sha ||
    value.environment !== candidate.environment ||
    value.createdAt !== candidate.created_at ||
    !isRecord(value.repository) ||
    value.repository.nameWithOwner !== repository ||
    !isRecord(value.statuses) ||
    !Array.isArray(value.statuses.nodes) ||
    !isRecord(value.statuses.pageInfo) ||
    value.statuses.pageInfo.hasNextPage !== false ||
    value.statuses.totalCount !== value.statuses.nodes.length
  )
    throw new Error(`Incomplete history or changed identity for deployment ${candidate.id}`);
  const ids = new Set<string>();
  for (const s of value.statuses.nodes) {
    if (
      !isRecord(s) ||
      typeof s.id !== "string" ||
      !s.id ||
      ids.has(s.id) ||
      typeof s.state !== "string" ||
      !(s.description === null || typeof s.description === "string")
    )
      throw new Error(`Invalid status history for deployment ${candidate.id}`);
    ids.add(s.id);
  }
  if (
    value.latestStatus !== null &&
    (!isRecord(value.latestStatus) ||
      !value.statuses.nodes.some(
        (s) => isRecord(s) && JSON.stringify(s) === JSON.stringify(value.latestStatus),
      ))
  )
    throw new Error(`Latest status is absent from complete history for deployment ${candidate.id}`);
  return value as Deployment;
}

function historyEqual(a: Status[], b: Status[]) {
  const stable = (items: Status[]) =>
    JSON.stringify([...items].sort((x, y) => x.id.localeCompare(y.id)));
  return stable(a) === stable(b);
}

export function deletionDecision(
  candidate: Candidate,
  archived: unknown,
  current: unknown,
  marker: string,
) {
  const before = validateDeployment(archived, candidate);
  if (current === null) return "already-absent" as const;
  const now = validateDeployment(current, candidate);
  if (!before.latestStatus || !terminal.has(before.latestStatus.state))
    return "skip-unfinished" as const;
  if (!now.latestStatus || !terminal.has(now.latestStatus.state)) return "skip-changed" as const;
  const unchanged = historyEqual(before.statuses.nodes, now.statuses.nodes);
  const resumed =
    now.latestStatus.state === "INACTIVE" &&
    now.latestStatus.description === marker &&
    now.statuses.nodes.length === before.statuses.nodes.length + 1 &&
    historyEqual(
      before.statuses.nodes,
      now.statuses.nodes.filter((s) => s.id !== now.latestStatus?.id),
    );
  if (!unchanged && !resumed) return "skip-changed" as const;
  return now.latestStatus.state === "INACTIVE"
    ? ("delete" as const)
    : ("inactivate-then-delete" as const);
}

export async function createOperations(
  token: string,
  record: (value: unknown) => Promise<void>,
): Promise<Operations> {
  let requests = 0,
    bytes = 0;
  const remaining = new Map<string, number>();
  const sdk = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline: performance.now() + 12 * 60_000,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    allowRequest: (method, url) =>
      url.origin === "https://api.github.com" &&
      ((method === "POST" && url.pathname === "/graphql") ||
        (method === "GET" && url.pathname === `/repos/${repository}/deployments`) ||
        (method === "POST" &&
          /^\/repos\/boburning\/portcove\/deployments\/[1-9][0-9]*\/statuses$/u.test(
            url.pathname,
          )) ||
        (method === "DELETE" &&
          /^\/repos\/boburning\/portcove\/deployments\/[1-9][0-9]*$/u.test(url.pathname))),
    reserve: ({ url }) => {
      const resource = url.pathname === "/graphql" ? "graphql" : "core";
      if (++requests > 160 || (remaining.get(resource) ?? 1000) < 60)
        throw new GitHubApiError(
          "budget_exhausted",
          "Cleanup stopped with quota headroom; resume after reset",
        );
      return {
        consumeBytes(count) {
          bytes += count;
          if (bytes > 64 * 1024 * 1024)
            throw new GitHubApiError("budget_exhausted", "Cleanup byte budget exhausted");
        },
        settle(observation) {
          if (typeof observation.rate?.remaining === "number" && observation.rate.resource)
            remaining.set(observation.rate.resource, observation.rate.remaining);
        },
      };
    },
  });
  const request = async (method: "GET" | "POST" | "DELETE", url: string, data?: unknown) => {
    const mutation = method !== "GET" && url !== "https://api.github.com/graphql";
    if (mutation) await delay(1100);
    const response = await sdk.request({
      method,
      url,
      ...(data === undefined ? {} : { data }),
      request: {
        portcove: {
          replay: mutation ? "once" : method === "GET" ? "safe-read" : "pure-query",
          attempts: 0,
        },
      },
    });
    const responseData: unknown = response.data;
    const responseHeaders = Object.fromEntries(
      Object.entries(response.headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    await record({
      method,
      url,
      observed_at: new Date().toISOString(),
      status: response.status,
      headers: retainedGitHubHeaders(responseHeaders),
      data: responseData,
    });
    return response;
  };
  return {
    async inventory() {
      const values: Record<string, unknown>[] = [],
        ids = new Set<number>();
      for (let page = 1; page <= 20; page++) {
        const response = await request("GET", `${root}?per_page=100&page=${page}`);
        if (!Array.isArray(response.data)) throw new Error("Malformed deployment inventory");
        for (const item of response.data) {
          if (
            !isRecord(item) ||
            typeof item.id !== "number" ||
            !Number.isSafeInteger(item.id) ||
            ids.has(item.id)
          )
            throw new Error("Invalid or changing deployment inventory");
          ids.add(item.id);
          values.push(item);
        }
        const link = response.headers.link ?? "";
        if (!/rel="next"/u.test(link)) return values;
        const next = /<([^>]+)>; rel="next"/u.exec(link)?.[1];
        const url = next ? new URL(next) : null;
        if (
          !url ||
          url.origin !== "https://api.github.com" ||
          ![`/repos/${repository}/deployments`, "/repositories/1354613114/deployments"].includes(
            url.pathname,
          ) ||
          url.searchParams.get("per_page") !== "100" ||
          url.searchParams.get("page") !== String(page + 1) ||
          [...url.searchParams.keys()].some((key) => key !== "page" && key !== "per_page")
        )
          throw new Error("Unexpected deployment pagination link");
      }
      throw new Error("Deployment inventory page budget exhausted");
    },
    async read(candidates) {
      if (candidates.length > 20) throw new Error("Deployment query batch exceeds 20");
      const response = await request("POST", "https://api.github.com/graphql", {
        query,
        variables: { ids: candidates.map((c) => c.node_id) },
      });
      const body: unknown = response.data;
      if (
        !isRecord(body) ||
        (Array.isArray(body.errors) && body.errors.length) ||
        !isRecord(body.data) ||
        !Array.isArray(body.data.nodes) ||
        body.data.nodes.length !== candidates.length
      )
        throw new Error("Incomplete deployment query");
      return body.data.nodes.map((node, index) =>
        node === null ? null : validateDeployment(node, candidates[index]!),
      );
    },
    async inactivate(id, description) {
      const response = await request("POST", `${root}/${id}/statuses`, {
        state: "inactive",
        auto_inactive: false,
        description,
      });
      const body: unknown = response.data;
      if (
        response.status !== 201 ||
        !isRecord(body) ||
        body.state !== "inactive" ||
        body.deployment_url !== `${root}/${id}`
      )
        throw new Error(`Inactivation outcome needs reconciliation for ${id}`);
    },
    async remove(id) {
      const response = await request("DELETE", `${root}/${id}`);
      if (response.status !== 204)
        throw new Error(`Deletion outcome needs reconciliation for ${id}`);
    },
  };
}

export async function applyBatch(
  api: Operations,
  candidates: Candidate[],
  archived: Deployment[],
  batch: number,
  archiveDigest: string,
  receipt: (value: unknown) => Promise<void>,
) {
  if (
    !Number.isSafeInteger(batch) ||
    batch < 1 ||
    batch > 8 ||
    !/^[0-9a-f]{64}$/u.test(archiveDigest) ||
    archived.length !== candidates.length
  )
    throw new Error("Invalid archived batch");
  const marker = `Portcove cleanup 2026-11-16 archive ${archiveDigest}`;
  const start = (batch - 1) * 50,
    end = Math.min(start + 50, candidates.length);
  const deleted: number[] = [];
  for (let offset = start; offset < end; offset += 10) {
    const chunk = candidates.slice(offset, Math.min(offset + 10, end));
    const current = await api.read(chunk),
      observedAt = Date.now();
    if (current.length !== chunk.length) throw new Error("Incomplete current deployment batch");
    for (let index = 0; index < chunk.length; index++) {
      const candidate = chunk[index]!;
      const decision = deletionDecision(
        candidate,
        archived[offset + index],
        current[index],
        marker,
      );
      await receipt({
        id: candidate.id,
        decision,
        observed_at: new Date(observedAt).toISOString(),
      });
      if (decision !== "delete" && decision !== "inactivate-then-delete") continue;
      if (Date.now() - observedAt > 60_000)
        throw new Error("Current deployment observation expired");
      if (decision === "inactivate-then-delete") {
        await api.inactivate(candidate.id, marker);
        await receipt({ id: candidate.id, result: "inactive" });
      }
      await api.remove(candidate.id);
      deleted.push(candidate.id);
      await receipt({ id: candidate.id, result: "deleted" });
    }
  }
  const after = await api.inventory();
  if (after.some((item) => deleted.includes(Number(item.id))))
    throw new Error("Deleted deployment remains in readback");
  await receipt({ result: "verified", deleted, remaining_inventory: after });
  return deleted;
}

async function main() {
  await mkdir("cleanup-evidence", { recursive: true });
  const record = (value: unknown) =>
    appendFile("cleanup-evidence/receipts.jsonl", `${JSON.stringify(value)}\n`);
  try {
    if (
      process.env.GITHUB_REPOSITORY !== repository ||
      process.env.GITHUB_REF !== "refs/heads/main"
    )
      throw new Error("Cleanup requires the reviewed default branch of boburning/portcove");
    const mode = process.env.PORTCOVE_CLEANUP_MODE;
    if (mode !== "archive" && mode !== "apply") throw new Error("Choose archive or apply");
    const manifestBytes = await readFile(
      new URL("./maintenance/retired-deployments-2026-11-16.json", import.meta.url),
    );
    const candidates = validateManifest(JSON.parse(manifestBytes.toString())),
      manifestDigest = digest(manifestBytes);
    const token = process.env.GH_TOKEN;
    if (!token) throw new Error("A scoped workflow token is required");
    const api = await createOperations(token, record);
    if (mode === "archive") {
      const inventory = await api.inventory();
      for (const c of candidates) {
        const item = inventory.find((value) => value.id === c.id);
        if (!item || Object.entries(c).some(([key, value]) => item[key] !== value))
          throw new Error(`Audited deployment changed or disappeared: ${c.id}`);
      }
      const deployments: Deployment[] = [];
      for (let offset = 0; offset < candidates.length; offset += 20) {
        const chunk = candidates.slice(offset, offset + 20),
          values = await api.read(chunk);
        deployments.push(...values.map((value, index) => validateDeployment(value, chunk[index]!)));
      }
      const archive = {
        format_version: 1,
        repository,
        manifest_sha256: manifestDigest,
        created_at: new Date().toISOString(),
        source_sha: process.env.GITHUB_SHA,
        run_id: process.env.GITHUB_RUN_ID,
        run_attempt: process.env.GITHUB_RUN_ATTEMPT,
        inventory,
        deployments,
      };
      const contents = `${JSON.stringify(archive, null, 2)}\n`,
        sha256 = digest(contents);
      await writeFile("cleanup-evidence/archive.json", contents);
      await writeFile("cleanup-evidence/SHA256SUMS", `${sha256}  archive.json\n`);
      console.log(
        `Archived ${deployments.length} complete histories. archive.json SHA-256: ${sha256}`,
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `Archived ${deployments.length} complete histories. Download and durably save the artifact before apply.\n\nSHA-256 of archive.json: \`${sha256}\`\n`,
        );
    } else {
      const bytes = await readFile("cleanup-archive/archive.json");
      const expected = process.env.PORTCOVE_CLEANUP_ARCHIVE_SHA256 ?? "";
      if (!/^[0-9a-f]{64}$/u.test(expected) || digest(bytes) !== expected)
        throw new Error("Saved archive digest mismatch");
      const archive: unknown = JSON.parse(bytes.toString());
      if (
        !isRecord(archive) ||
        archive.format_version !== 1 ||
        archive.repository !== repository ||
        archive.manifest_sha256 !== manifestDigest ||
        archive.run_id !== process.env.PORTCOVE_CLEANUP_ARCHIVE_RUN ||
        archive.run_attempt !== process.env.PORTCOVE_CLEANUP_ARCHIVE_ATTEMPT ||
        !Array.isArray(archive.deployments) ||
        archive.deployments.length !== candidates.length ||
        !Array.isArray(archive.inventory)
      )
        throw new Error("Archive does not match the fixed manifest and selected run");
      const archived = archive.deployments.map((value, index) =>
        validateDeployment(value, candidates[index]!),
      );
      const deleted = await applyBatch(
        api,
        candidates,
        archived,
        Number(process.env.PORTCOVE_CLEANUP_BATCH),
        expected,
        record,
      );
      const remaining = await api.inventory(),
        remainingIds = new Set(remaining.map((item) => item.id));
      const candidateIds = new Set(candidates.map((c) => c.id));
      for (const item of archive.inventory) {
        if (!isRecord(item) || typeof item.id !== "number")
          throw new Error("Malformed preserved inventory");
        if (!candidateIds.has(item.id) && !remainingIds.has(item.id))
          throw new Error(`Preserved deployment missing: ${item.id}`);
      }
      await record({ result: "preserved-inventory-verified", deleted });
      console.log(
        `Verified ${deleted.length} deletions in this batch; all archived non-candidates remain.`,
      );
    }
  } catch (error) {
    const safe = sanitizeOperationError(error);
    await record({ result: "stopped", error: safe.message, code: safe.code });
    throw new Error(safe.message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
