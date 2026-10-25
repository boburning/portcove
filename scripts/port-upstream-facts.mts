import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { boundedDiscoveryRequest } from "./discovery-http.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { observationHash } from "./upstream-observer.mts";
import { isRecord, errorCode } from "./runtime-values.mts";

const limits = { requests: 12, bytes: 8 * 1024 * 1024, milliseconds: 120000 };
interface CachedFact {
  format_version: 1;
  endpoint: string;
  observed_at: string;
  fresh_until: string;
  body: unknown;
  body_sha256: string;
  next_page: boolean;
}
interface FactResult {
  endpoint: string;
  status: "observed" | "reused" | "unavailable";
  observed_at?: string;
  body?: unknown;
  next_page?: boolean;
  reason?: string;
  retry_after?: string;
  previous_observation?: CachedFact;
}
export interface PortFactsOptions {
  projectUrl?: string | undefined;
  issue?: string | undefined;
  route?: "listing" | "download";
  releaseTag?: string | undefined;
  releaseUrl?: string | undefined;
  resolveReleaseUrl?: (identity: {
    projectUrl: string;
    issuePortId?: string;
  }) => string | null | undefined;
  cacheDirectory: string;
  token?: string | undefined;
  now?: () => number;
  fetcher?: typeof fetch;
}

function checkedPublicUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || value.length > 2048)
    throw new Error("An official project requires a bounded credential-free HTTPS URL.");
  return url;
}
function hasControl(value: string) {
  for (const character of value) if (character.charCodeAt(0) < 32) return true;
  return false;
}
function observedAsset(value: unknown) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) < 1 ||
    typeof value.name !== "string" ||
    !value.name ||
    value.name.length > 1024 ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0 ||
    typeof value.browser_download_url !== "string"
  )
    return false;
  try {
    return checkedPublicUrl(value.browser_download_url).hostname === "github.com";
  } catch {
    return false;
  }
}
export function githubRepository(projectUrl: string) {
  const url = checkedPublicUrl(projectUrl);
  if (url.hostname !== "github.com") return undefined;
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(url.pathname);
  if (!match || url.search || url.hash)
    throw new Error("Use the GitHub repository root as the official project URL.");
  return `${match[1]}/${match[2]}`;
}

/** Match Core's repository locator without treating a release URL's tag as a pin. */
export function githubReleaseRepository(value: string) {
  const url = checkedPublicUrl(value);
  const parts = url.pathname.slice(1).split("/");
  const owner = parts[0];
  const repository = parts[1];
  if (
    url.hostname !== "github.com" ||
    url.port ||
    !owner ||
    !repository ||
    [owner, repository].some(
      (part) =>
        part.length > 100 || part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/u.test(part),
    )
  )
    throw new Error("Release provider requires a bounded public GitHub repository URL.");
  return `${owner}/${repository.replace(/\.git$/u, "")}`;
}

function readCache(file: string, endpoint: string): CachedFact | undefined {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 3 * 1024 * 1024)
    throw new Error("Preparation cache must contain bounded regular files.");
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    value.endpoint !== endpoint ||
    typeof value.observed_at !== "string" ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    typeof value.fresh_until !== "string" ||
    !Number.isFinite(Date.parse(value.fresh_until)) ||
    Date.parse(value.fresh_until) < Date.parse(value.observed_at) ||
    Date.parse(value.fresh_until) - Date.parse(value.observed_at) > 86400000 ||
    typeof value.next_page !== "boolean" ||
    value.body_sha256 !== observationHash(value.body)
  )
    throw new Error("Malformed preparation cache retained; reconcile it before retrying.");
  return value as unknown as CachedFact;
}

/** Small route-specific reads. No release history, tag resolution, README or package execution. */
export async function collectPortFacts(options: PortFactsOptions) {
  if (options.releaseUrl !== undefined && options.resolveReleaseUrl)
    throw new Error(
      "Select either an explicit release provider or its canonical identity resolver.",
    );
  const now = options.now ?? Date.now;
  const started = now();
  const budget = new DiscoveryBudget("ordinary", undefined, now);
  const observations: FactResult[] = [];
  mkdirSync(options.cacheDirectory, { recursive: true });
  if (
    !lstatSync(options.cacheDirectory).isDirectory() ||
    lstatSync(options.cacheDirectory).isSymbolicLink()
  )
    throw new Error("Preparation cache must be a real directory.");
  const read = async (endpoint: string, hours = 1): Promise<FactResult> => {
    const url = new URL(endpoint, "https://api.github.com/");
    if (url.origin !== "https://api.github.com") throw new Error("Unexpected facts provider.");
    const file = join(options.cacheDirectory, `${observationHash(url.href)}.json`);
    const cached = readCache(file, url.href);
    const retryFile = `${file}.retry`;
    let retainedRetry: string | undefined;
    try {
      const info = lstatSync(retryFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
        throw new Error("Preparation backoff must be a bounded regular receipt.");
      const retry: unknown = JSON.parse(readFileSync(retryFile, "utf8"));
      if (
        !isRecord(retry) ||
        retry.endpoint !== url.href ||
        typeof retry.retry_after !== "string" ||
        !Number.isFinite(Date.parse(retry.retry_after))
      )
        throw new Error("Malformed preparation backoff retained for reconciliation.");
      retainedRetry = retry.retry_after;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    let result: FactResult;
    if (
      cached &&
      Date.parse(cached.observed_at) <= now() &&
      Date.parse(cached.fresh_until) > now()
    ) {
      result = {
        endpoint: url.href,
        status: "reused",
        observed_at: cached.observed_at,
        body: cached.body,
        next_page: cached.next_page,
      };
    } else {
      const remaining = {
        requests: limits.requests - budget.usage.requests,
        bytes: limits.bytes - budget.usage.bytes,
        milliseconds: limits.milliseconds - (now() - started),
      };
      const unavailable = (reason: string, retry_after?: string): FactResult => ({
        endpoint: url.href,
        status: "unavailable",
        reason,
        ...(retry_after ? { retry_after } : {}),
        ...(cached ? { previous_observation: cached } : {}),
      });
      if (remaining.requests <= 0 || remaining.bytes <= 0 || remaining.milliseconds <= 0)
        result = unavailable("ordinary-collection-budget-exhausted");
      else if (retainedRetry && Date.parse(retainedRetry) > now())
        result = unavailable("provider-backoff", retainedRetry);
      else if (budget.usage.backoff_until && Date.parse(budget.usage.backoff_until) > now())
        result = unavailable("provider-backoff", budget.usage.backoff_until);
      else {
        budget.admit(1, 1);
        const response = await boundedDiscoveryRequest(
          {
            url: url.href,
            method: "GET",
            token: options.token,
            cap: Math.min(2 * 1024 * 1024, remaining.bytes),
            timeout: Math.min(20000, remaining.milliseconds),
            maxRequests: Math.min(5, remaining.requests),
          },
          options.fetcher,
        );
        budget.charge("GET", url.href, response.requests, response.bytes, String(response.status));
        if (response.backoff_until) {
          budget.retainBackoff(response.backoff_until);
          const temporary = `${retryFile}.${randomUUID()}.tmp`;
          writeFileSync(
            temporary,
            JSON.stringify({ endpoint: url.href, retry_after: response.backoff_until }),
            { flag: "wx", mode: 0o600 },
          );
          renameSync(temporary, retryFile);
        }
        if ("error" in response || response.status !== 200)
          result = unavailable(
            "error" in response ? "bounded-request-failed" : `http-${response.status}`,
            response.backoff_until,
          );
        else {
          let body: unknown;
          try {
            body = JSON.parse(response.text);
          } catch {
            /* Invalid JSON stays unknown. */
          }
          if (body === undefined) result = unavailable("invalid-provider-json");
          else {
            const observed = now();
            const entry: CachedFact = {
              format_version: 1,
              endpoint: url.href,
              observed_at: new Date(observed).toISOString(),
              fresh_until: new Date(observed + hours * 3600000).toISOString(),
              body,
              body_sha256: observationHash(body),
              next_page: /rel="next"/u.test(response.headers.link ?? ""),
            };
            const temporary = `${file}.${randomUUID()}.tmp`;
            writeFileSync(temporary, `${JSON.stringify(entry)}\n`, { flag: "wx", mode: 0o600 });
            renameSync(temporary, file);
            result = {
              endpoint: url.href,
              status: "observed",
              observed_at: entry.observed_at,
              body,
              next_page: entry.next_page,
            };
          }
        }
      }
    }
    observations.push(result);
    return result;
  };

  let projectUrl = options.projectUrl;
  let issue: { number: number; url: string; id?: string; name?: string } | undefined;
  if (options.issue) {
    const match = /^(?:https:\/\/github\.com\/boburning\/portcove\/issues\/)?([1-9][0-9]*)$/u.exec(
      options.issue,
    );
    if (!match || !Number.isSafeInteger(Number(match[1])))
      throw new Error("Use a canonical Portcove issue number or URL.");
    const number = Number(match[1]);
    const fact = await read(`repos/boburning/portcove/issues/${number}`, 1);
    const body = fact.body;
    if (
      !isRecord(body) ||
      typeof body.body !== "string" ||
      typeof body.title !== "string" ||
      body.pull_request
    )
      throw new Error(
        "Canonical issue unavailable; resume from the same checkpoint or supply reviewed project facts.",
      );
    const issueBody = body.body;
    const marker = (name: string) =>
      [
        ...issueBody.matchAll(new RegExp(`<!--\\s*portcove-${name}:\\s*([^\\s>]+)\\s*-->`, "giu")),
      ].map((m) => m[1]!);
    const upstreams = [...new Set(marker("upstream"))];
    const ids = [...new Set([...marker("catalog-id"), ...marker("port-key")])];
    if (upstreams.length !== 1 || ids.length !== 1 || !/^\[Port\]\s/u.test(body.title))
      throw new Error(
        "Canonical issue identity is ambiguous; resolve its single upstream and stable ID first.",
      );
    if (projectUrl && projectUrl !== upstreams[0])
      throw new Error("Project URL conflicts with canonical issue origin.");
    projectUrl = upstreams[0];
    issue = {
      number,
      url: `https://github.com/boburning/portcove/issues/${number}`,
      id: ids[0]!,
      name: body.title.replace(/^\[Port\]\s*/u, ""),
    };
  }
  if (!projectUrl) throw new Error("A project URL or canonical issue is required.");
  const repository = githubRepository(projectUrl);
  const project = repository ? await read(`repos/${repository}`, 24) : undefined;
  if (isRecord(project?.body) && project.body.private === true)
    throw new Error("Private repository metadata cannot establish a public catalog origin.");
  const releaseUrl =
    options.route === "download"
      ? options.resolveReleaseUrl
        ? options.resolveReleaseUrl({
            projectUrl,
            ...(issue?.id ? { issuePortId: issue.id } : {}),
          })
        : options.releaseUrl
      : undefined;
  const releaseRepository =
    releaseUrl === undefined
      ? repository
      : releaseUrl === null
        ? undefined
        : githubReleaseRepository(releaseUrl);
  const relatedProvider = Boolean(
    releaseRepository && releaseRepository.toLowerCase() !== repository?.toLowerCase(),
  );
  const releaseProject = !releaseRepository
    ? undefined
    : relatedProvider
      ? await read(`repos/${releaseRepository}`, 24)
      : project;
  if (
    relatedProvider &&
    (!isRecord(releaseProject?.body) ||
      releaseProject.body.private !== false ||
      !Number.isSafeInteger(releaseProject.body.id) ||
      Number(releaseProject.body.id) < 1 ||
      typeof releaseProject.body.full_name !== "string" ||
      releaseProject.body.full_name.toLowerCase() !== releaseRepository?.toLowerCase())
  )
    throw new Error(
      "Related release provider must have matching observed public repository metadata.",
    );
  let release: FactResult | undefined;
  let candidates: FactResult | undefined;
  const assets: unknown[] = [];
  let assetsComplete = false;
  if (options.route === "download" && releaseRepository) {
    if (options.releaseTag) {
      if (options.releaseTag.length > 255 || hasControl(options.releaseTag))
        throw new Error("Release tag is not bounded text.");
      release = await read(
        `repos/${releaseRepository}/releases/tags/${encodeURIComponent(options.releaseTag)}`,
      );
      const value = release.body;
      if (isRecord(value) && (relatedProvider || typeof value.html_url === "string")) {
        if (
          typeof value.html_url !== "string" ||
          githubReleaseRepository(value.html_url).toLowerCase() !== releaseRepository.toLowerCase()
        )
          throw new Error("Selected release provenance conflicts with its reviewed provider.");
      }
      if (
        isRecord(value) &&
        Number.isSafeInteger(value.id) &&
        Number(value.id) > 0 &&
        value.draft === false &&
        value.tag_name === options.releaseTag
      ) {
        for (let page = 1; page <= 2; page++) {
          const fact = await read(
            `repos/${releaseRepository}/releases/${Number(value.id)}/assets?per_page=100&page=${page}`,
          );
          if (!Array.isArray(fact.body)) break;
          const pageAssets: unknown[] = fact.body;
          assets.push(...pageAssets);
          if (
            !assets.every(observedAsset) ||
            new Set(assets.map((asset) => (isRecord(asset) ? asset.id : null))).size !==
              assets.length
          )
            break;
          if (
            relatedProvider &&
            assets.some(
              (asset) =>
                isRecord(asset) &&
                typeof asset.browser_download_url === "string" &&
                githubReleaseRepository(asset.browser_download_url).toLowerCase() !==
                  releaseRepository.toLowerCase(),
            )
          )
            throw new Error("Selected asset provenance conflicts with its reviewed provider.");
          if (!fact.next_page) {
            assetsComplete = true;
            break;
          }
        }
      }
    } else candidates = await read(`repos/${releaseRepository}/releases?per_page=20&page=1`);
  }
  return {
    format_version: 1,
    project_url: projectUrl,
    repository: repository ?? null,
    issue,
    project,
    release_repository: releaseRepository ?? null,
    release_project: releaseProject,
    release_provider_scope:
      releaseUrl === null
        ? "The retained operational release provider is outside this bounded GitHub metadata collector. No listing helper or canonical repository substitutes for it."
        : "Bounded GitHub release metadata; canonical project identity remains separate.",
    release,
    release_candidates: candidates,
    assets,
    assets_complete: assetsComplete,
    observations,
    usage: { ...budget.usage, limits },
    scope:
      "Bounded upstream metadata only. Release candidates are one current window; incomplete assets are Unknown. No package acquisition, qualification, execution, issue mutation or catalog admission.",
  };
}
