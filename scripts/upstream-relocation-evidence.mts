/**
 * Read-only provider evidence for a reviewed upstream relocation (#4784).
 *
 * For each named repository at its current name this makes a fixed set of
 * bounded GitHub metadata reads: the repository, the first page of releases
 * and, when a tag is named, that release and its complete asset collection.
 * Release and asset facts use the observer's own fact functions and hashes, so
 * a reviewer can compare a reviewed pin's numeric identities, size and digest
 * at the new name and see the exact facts a rebinding would record.
 *
 * Output is inert evidence. It grants no lineage, relocation, selector,
 * acquisition or accounting authority, follows no redirect, downloads no
 * artifact and writes nothing except the requested report and summary files.
 */
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubClient, type GitHubRequestPolicy } from "./github-client.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { assetFact, observationHash, releaseFact } from "./upstream-observer.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";

export interface EvidenceRequest {
  repository: string;
  tag: string | null;
}

export interface MetadataRead {
  (endpoint: string): Promise<unknown>;
}

const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,99}$/u;
export const maxRequests = 8;
const releasePage = 30;

/** Parse whitespace-separated `OWNER/NAME` or `OWNER/NAME@TAG` requests. */
export function parseEvidenceRequests(text: string): EvidenceRequest[] {
  const items = text.split(/\s+/u).filter(Boolean);
  if (items.length === 0 || items.length > maxRequests)
    throw new Error(`Name between 1 and ${maxRequests} repositories`);
  const requests = items.map((item) => {
    const at = item.indexOf("@");
    const repository = at === -1 ? item : item.slice(0, at);
    const tag = at === -1 ? null : item.slice(at + 1);
    if (
      !repositoryPattern.test(repository) ||
      repository.split("/").some((part) => /^\.+$/u.test(part))
    )
      throw new Error(`Invalid repository name: ${repository}`);
    if (tag !== null && !tagPattern.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
    return { repository, tag };
  });
  const keys = requests.map(
    (request) => `${request.repository.toLowerCase()}@${request.tag ?? ""}`,
  );
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate evidence request");
  return requests;
}

function repositoryIdentity(data: unknown) {
  if (
    !isRecord(data) ||
    !Number.isSafeInteger(data.id) ||
    Number(data.id) <= 0 ||
    typeof data.full_name !== "string" ||
    !repositoryPattern.test(data.full_name) ||
    typeof data.archived !== "boolean"
  )
    throw new Error("invalid repository metadata");
  return { id: Number(data.id), full_name: data.full_name, archived: data.archived };
}

function assetNames(release: Record<string, unknown>) {
  if (!Array.isArray(release.assets)) return null;
  return release.assets
    .map((asset: unknown) =>
      isRecord(asset) && typeof asset.name === "string" ? asset.name : null,
    )
    .filter((name): name is string => name !== null);
}

/**
 * Pin evidence applies the observer's declared-pin collection checks, so the
 * report never shows facts the pin validator would reject.
 */
async function pinEvidence(
  request: EvidenceRequest & { tag: string },
  repository: string,
  read: MetadataRead,
) {
  const release = await read(
    `/repos/${request.repository}/releases/tags/${encodeURIComponent(request.tag)}`,
  );
  const fact = releaseFact(release);
  if (fact.tag_name !== request.tag || fact.draft)
    throw new Error("release tag differs from the request or is a draft");
  const assets = await read(`/repos/${request.repository}/releases/${fact.id}/assets?per_page=100`);
  if (
    !Array.isArray(assets) ||
    assets.length === 0 ||
    assets.length >= 100 ||
    !isRecord(release) ||
    !Array.isArray(release.assets) ||
    release.assets.length !== assets.length
  )
    throw new Error("asset collection is empty, capped or incomplete");
  const config = { repository };
  const facts = assets.map((asset: unknown) => assetFact(asset, config, request.tag));
  const embedded = release.assets.map((asset: unknown) => assetFact(asset, config, request.tag));
  const byId = (left: { id: number }, right: { id: number }) => left.id - right.id;
  if (
    new Set(facts.map((asset) => asset.id)).size !== facts.length ||
    observationHash(facts.toSorted(byId)) !== observationHash(embedded.toSorted(byId))
  )
    throw new Error("asset collections differ or repeat an identity");
  return {
    release: fact,
    release_facts_sha256: observationHash(fact),
    assets: facts
      .map((asset) => ({ ...asset, asset_facts_sha256: observationHash(asset) }))
      .toSorted(byId),
  };
}

/** Collect evidence for one request. Every read is a fixed metadata endpoint. */
export async function relocationEvidence(request: EvidenceRequest, read: MetadataRead) {
  const repository = repositoryIdentity(await read(`/repos/${request.repository}`));
  // The pin is read before the bounded sample, so a large sample cannot hide it.
  const pin =
    request.tag === null
      ? null
      : await pinEvidence({ ...request, tag: request.tag }, repository.full_name, read);
  let sample;
  try {
    const listed = await read(`/repos/${request.repository}/releases?per_page=${releasePage}`);
    if (!Array.isArray(listed)) throw new Error("invalid release collection");
    const releases = listed.map((value: unknown) => ({
      ...releaseFact(value),
      asset_names: isRecord(value) ? assetNames(value) : null,
    }));
    // The first release page is a bounded sample, never a complete history.
    sample = {
      releases_sampled: releases.length,
      releases_may_be_partial: releases.length === releasePage,
      releases,
      releases_error: null,
    };
  } catch (error) {
    sample = {
      releases_sampled: 0,
      releases_may_be_partial: true,
      releases: [],
      releases_error: errorMessage(error).slice(0, 300),
    };
  }
  return {
    request: `${request.repository}${request.tag === null ? "" : `@${request.tag}`}`,
    repository,
    ...sample,
    pin,
  };
}

export async function relocationEvidenceReport(
  requests: readonly EvidenceRequest[],
  read: MetadataRead,
) {
  const results = [];
  for (const request of requests) {
    try {
      results.push({ ok: true as const, ...(await relocationEvidence(request, read)) });
    } catch (error) {
      results.push({
        ok: false as const,
        request: `${request.repository}${request.tag === null ? "" : `@${request.tag}`}`,
        error: errorMessage(error).slice(0, 300),
      });
    }
  }
  return {
    format: 1,
    authority: "evidence-only",
    redirects_followed: false,
    artifacts_downloaded: false,
    results,
  };
}

export function renderEvidenceSummary(
  report: Awaited<ReturnType<typeof relocationEvidenceReport>>,
) {
  const lines = [
    "### Upstream relocation evidence (read-only)",
    "",
    "No redirect was followed, no artifact was downloaded and nothing was changed. The JSON report holds the complete facts.",
    "",
    "| Request | Repository | Releases sampled | Pin assets |",
    "| --- | --- | --- | --- |",
  ];
  for (const result of report.results) {
    if (!result.ok) {
      lines.push(
        `| \`${result.request}\` | failed: ${result.error.replaceAll(/[|\r\n]/gu, " ")} | | |`,
      );
      continue;
    }
    const pin = result.pin
      ? result.pin.assets
          .map((asset) => `\`${asset.name}\` (${asset.id}, ${asset.size} B)`)
          .join("<br>")
      : "";
    lines.push(
      `| \`${result.request}\` | \`${result.repository.full_name}\` (${result.repository.id}${result.repository.archived ? ", archived" : ""}) | ${result.releases_sampled}${result.releases_may_be_partial ? "+" : ""} | ${pin} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(args: string[]) {
  let requestText: string | null = null;
  let outputPath: string | null = null;
  let summaryPath: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (value === undefined) throw new Error(`Missing value for ${String(flag)}`);
    if (flag === "--requests") requestText = value;
    else if (flag === "--output") outputPath = value;
    else if (flag === "--summary") summaryPath = value;
    else
      throw new Error(
        "usage: upstream-relocation-evidence.mts --requests 'OWNER/NAME[@TAG] ...' [--output PATH] [--summary PATH]",
      );
  }
  if (requestText === null) throw new Error("--requests is required");
  const requests = parseEvidenceRequests(requestText);
  const deadline = performance.now() + 90_000;
  const sdk = await createGitHubClient({
    credential: localDeveloperCredential({ deadline }),
    deadline,
    maxBytes: 4 * 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) =>
      method === "GET" &&
      (/^\/repos\/[^/]+\/[^/]+$/u.test(url.pathname) ||
        /^\/repos\/[^/]+\/[^/]+\/releases$/u.test(url.pathname) ||
        /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/[^/]+$/u.test(url.pathname) ||
        /^\/repos\/[^/]+\/[^/]+\/releases\/[1-9]\d*\/assets$/u.test(url.pathname)),
  });
  const read: MetadataRead = async (endpoint) => {
    const policy: GitHubRequestPolicy = { replay: "safe-read", attempts: 0 };
    const response = await sdk.request({
      method: "GET",
      url: endpoint,
      request: { portcove: policy },
    });
    return response.data as unknown;
  };
  const report = await relocationEvidenceReport(requests, read);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, json);
  else process.stdout.write(json);
  if (summaryPath) await appendFile(summaryPath, renderEvidenceSummary(report));
  if (report.results.some((result) => !result.ok)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main(process.argv.slice(2));
