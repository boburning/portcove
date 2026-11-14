import { isDeepStrictEqual } from "node:util";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { maximumFundingUrls } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

/**
 * Authoring-time funding links for listings. Reads each GitHub-hosted project's
 * FUNDING.yml in GitHub's lookup order and turns the platforms Portcove knows
 * into reviewed `listing.funding_urls`. Portcove never fetches these at runtime;
 * the result is an ordinary reviewed catalog diff. Dry run unless --write; existing
 * links are only replaced or removed with --replace.
 */

/** GitHub's lookup order: the repository first, then the owner's `.github` repository. */
export const fundingPaths = [".github/FUNDING.yml", "FUNDING.yml", "docs/FUNDING.yml"] as const;
const maximumFundingBytes = 16 * 1024;

const accountPlatforms = [
  ["github", (name: string) => `https://github.com/sponsors/${name}`],
  ["patreon", (name: string) => `https://www.patreon.com/${name}`],
  ["open_collective", (name: string) => `https://opencollective.com/${name}`],
  ["ko_fi", (name: string) => `https://ko-fi.com/${name}`],
  ["liberapay", (name: string) => `https://liberapay.com/${name}`],
  ["buy_me_a_coffee", (name: string) => `https://buymeacoffee.com/${name}`],
] as const;
const supportedKeys = new Set<string>([...accountPlatforms.map(([key]) => key), "custom"]);
const accountName = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_])?$/u;

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

/** A credential-free HTTPS URL with characters safe to place in a JSON line edit. */
export function fundingCustomUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 2048 || /[\s"\\[\]]/u.test(text) || !text.startsWith("https://"))
    return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname)
    return undefined;
  return url.href;
}

/** Why a file's contents leave a listing unchanged. */
export type FundingUnknown = "oversized" | "malformed" | "no-supported-links";
export type FundingFile =
  | { urls: string[]; skipped: string[]; dropped: string[] }
  | { unknown: FundingUnknown; skipped: string[] };

/**
 * Known platforms in a fixed order, then custom HTTPS links in file order. Entries
 * Portcove cannot use are reported in `skipped`. Beyond the Core bound the first
 * links in that order are kept and the rest reported in `dropped`. A file that is
 * too large, malformed (including YAML aliases) or yields no usable link is
 * unknown: it never adds, replaces or removes anything.
 */
export function parseFundingYaml(text: string): FundingFile {
  if (Buffer.byteLength(text) > maximumFundingBytes) return { unknown: "oversized", skipped: [] };
  let document: unknown;
  try {
    document = parse(text, { maxAliasCount: 0 });
  } catch {
    return { unknown: "malformed", skipped: [] };
  }
  if (document === null || document === undefined) document = {};
  if (!isRecord(document)) return { unknown: "malformed", skipped: [] };
  const urls: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(document))
    if (!supportedKeys.has(key) && values(value).some((entry) => entry !== "")) skipped.push(key);
  for (const [key, url] of accountPlatforms)
    for (const name of values(document[key])) {
      if (name === "") continue;
      if (typeof name === "string" && accountName.test(name.trim())) urls.push(url(name.trim()));
      else skipped.push(`${key}: ${JSON.stringify(name)}`);
    }
  for (const custom of values(document.custom)) {
    if (custom === "") continue;
    const url = fundingCustomUrl(custom);
    if (url) urls.push(url);
    else skipped.push(`custom: ${JSON.stringify(custom)}`);
  }
  const unique = [...new Set(urls)];
  if (!unique.length) return { unknown: "no-supported-links", skipped };
  return {
    urls: unique.slice(0, maximumFundingUrls),
    skipped,
    dropped: unique.slice(maximumFundingUrls),
  };
}

/** `owner/name` for a github.com project URL, or undefined for other hosts. */
export function githubRepository(projectUrl: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(
    projectUrl,
  );
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

/**
 * Replaces, inserts or removes the listing's `funding_urls` line. The result is
 * checked to differ from the input only in that field.
 */
export function withFundingUrls(text: string, urls: readonly string[]) {
  const current = (JSON.parse(text) as { listing: { funding_urls?: unknown } }).listing
    .funding_urls;
  // Formatting may wrap the array; an equal value is left exactly as written.
  if (isDeepStrictEqual(current ?? [], urls)) return text;
  const existing = /^ {4}"funding_urls": \[[^\]]*\],?\n/mu;
  let next = text.replace(existing, "");
  if (urls.length) {
    const line = `    "funding_urls": [${urls.map((url) => JSON.stringify(url)).join(", ")}],`;
    let inserted = false;
    for (const key of ["listed_at", "issue_number", "project_url"]) {
      const pattern = new RegExp(`^( {4}"${key}": [^\\n]*,)$`, "mu");
      if (!pattern.test(next)) continue;
      next = next.replace(pattern, `$1\n${line}`);
      inserted = true;
      break;
    }
    if (!inserted) throw new Error("Listing has no line to anchor funding_urls.");
  }
  const before = JSON.parse(text) as { listing: Record<string, unknown> };
  const after = JSON.parse(next) as { listing: Record<string, unknown> };
  const { funding_urls: _old, ...beforeRest } = before.listing;
  const { funding_urls: written, ...afterRest } = after.listing;
  if (
    !isDeepStrictEqual({ ...before, listing: beforeRest }, { ...after, listing: afterRest }) ||
    !isDeepStrictEqual(written ?? [], urls)
  )
    throw new Error("funding_urls edit changed more than the field.");
  return next;
}

type Blobs = (string | null | undefined)[];
/** Per repository: the FUNDING.yml texts in lookup order, "missing", or null when unreadable. */
export type FundingReader = (
  repositories: readonly { owner: string; name: string }[],
) => Promise<Map<string, Blobs | "missing" | null>>;

/** What the lookup established for one listing. */
export type FundingResolution =
  | { kind: "links"; urls: string[]; source: string; skipped: string[]; dropped: string[] }
  /** The project is readable and no lookup location holds a FUNDING.yml. */
  | { kind: "none" }
  | {
      kind: "unknown";
      reason: FundingUnknown | "project-missing" | "unreadable";
      source?: string;
      skipped?: string[];
    };

/** First file found decides, as on GitHub. Only a definite absence everywhere is "none". */
export function firstFunding(
  repository: { owner: string; name: string },
  own: Blobs | "missing" | null,
  owner: Blobs | "missing" | null,
): FundingResolution {
  // The project itself must be readable before its absence of a file means anything.
  if (own === null) return { kind: "unknown", reason: "unreadable" };
  if (own === "missing") return { kind: "unknown", reason: "project-missing" };
  const places = [
    [`${repository.owner}/${repository.name}`, own],
    [`${repository.owner}/.github`, owner],
  ] as const;
  for (const [name, candidate] of places) {
    if (candidate === null) return { kind: "unknown", reason: "unreadable" };
    if (candidate === "missing") return { kind: "none" };
    for (const [index, blob] of candidate.entries()) {
      if (blob === undefined) return { kind: "unknown", reason: "unreadable" };
      if (blob === null) continue;
      const source = `${name}:${fundingPaths[index]}`;
      const file = parseFundingYaml(blob);
      if ("unknown" in file)
        return { kind: "unknown", reason: file.unknown, source, skipped: file.skipped };
      return { kind: "links", source, ...file };
    }
  }
  return { kind: "none" };
}

const key = (repository: { owner: string; name: string }) =>
  `${repository.owner}/${repository.name}`.toLowerCase();

/**
 * One GraphQL query per batch. `resource(url:)` answers null, without an error,
 * for a repository that does not exist publicly (including a renamed one); any
 * GraphQL error fails the run.
 */
export function graphqlFundingReader(
  request: (query: string) => Promise<{ data?: unknown }>,
): FundingReader {
  return async (repositories) => {
    const result = new Map<string, Blobs | "missing" | null>();
    for (let start = 0; start < repositories.length; start += 40) {
      const batch = repositories.slice(start, start + 40);
      const files = fundingPaths
        .map(
          (path, index) =>
            `f${index}: object(expression: ${JSON.stringify(`HEAD:${path}`)}) { ... on Blob { text isBinary byteSize } }`,
        )
        .join(" ");
      const query = `{ ${batch
        .map(
          (repository, index) =>
            `r${index}: resource(url: ${JSON.stringify(`https://github.com/${repository.owner}/${repository.name}`)}) { ... on Repository { ${files} } }`,
        )
        .join(" ")} }`;
      const response = await request(query);
      const data = isRecord(response.data) ? response.data : undefined;
      batch.forEach((repository, index) => {
        const node = data?.[`r${index}`];
        if (node === null) {
          result.set(key(repository), "missing");
          return;
        }
        if (!isRecord(node)) {
          result.set(key(repository), null);
          return;
        }
        result.set(
          key(repository),
          fundingPaths.map((_, file) => {
            const blob = node[`f${file}`];
            if (blob === null) return null;
            if (
              !isRecord(blob) ||
              blob.isBinary !== false ||
              typeof blob.text !== "string" ||
              blob.byteSize !== Buffer.byteLength(blob.text)
            )
              return undefined;
            return blob.text;
          }),
        );
      });
    }
    return result;
  };
}

/** The lookup result per GitHub-hosted listing id. */
export async function resolveFunding(
  listings: readonly { id: string; project_url: string }[],
  read: FundingReader,
) {
  const projects = new Map<string, { owner: string; name: string }>();
  for (const listing of listings) {
    const repository = githubRepository(listing.project_url);
    if (repository) projects.set(listing.id, repository);
  }
  const own = await read([...new Map([...projects.values()].map((r) => [key(r), r])).values()]);
  const owners = new Map<string, { owner: string; name: string }>();
  for (const repository of projects.values()) {
    const found = own.get(key(repository));
    if (Array.isArray(found) && found.every((blob) => blob === null))
      owners.set(repository.owner.toLowerCase(), { owner: repository.owner, name: ".github" });
  }
  const shared = await read([...owners.values()]);
  const resolved = new Map<string, FundingResolution>();
  for (const [id, repository] of projects) {
    const owner = shared.get(key({ owner: repository.owner, name: ".github" })) ?? "missing";
    resolved.set(id, firstFunding(repository, own.get(key(repository)) ?? null, owner));
  }
  return resolved;
}

/**
 * What a run does to one authored file. Unknown answers change nothing; adding
 * links to a listing without any is always allowed; replacing or removing
 * existing (possibly hand-authored) links needs --replace.
 */
export function plannedFunding(
  current: readonly string[] | undefined,
  resolution: FundingResolution,
  replace: boolean,
): { urls?: string[]; held?: "replace" | "remove" } {
  if (resolution.kind === "unknown") return {};
  const next = resolution.kind === "links" ? resolution.urls : [];
  if (isDeepStrictEqual(current ?? [], next)) return {};
  if (!current?.length || replace) return { urls: next };
  return { held: next.length ? "replace" : "remove" };
}

/** Where a repository that GraphQL could not resolve went, from REST's own answer. */
export async function missingRepositoryReason(
  repository: { owner: string; name: string },
  get: (path: string) => Promise<{ status: number | null; data: unknown }>,
) {
  const found = await get(`/repos/${repository.owner}/${repository.name}`);
  if (found.status === 404) return "not found";
  if (found.status === 301) {
    const location = isRecord(found.data) ? found.data.url : undefined;
    const id =
      typeof location === "string" ? /\/repositories\/([0-9]+)$/u.exec(location)?.[1] : undefined;
    const target = id ? await get(`/repositories/${id}`) : undefined;
    return target?.status === 200 &&
      isRecord(target.data) &&
      typeof target.data.full_name === "string"
      ? `moved to ${target.data.full_name}; update project_url`
      : "moved; update project_url";
  }
  if (found.status === 200) return "readable over REST but not GraphQL";
  return "not resolvable";
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const portsDirectory = join(root, "crates", "portcove-core", "catalog", "ports");
  const write = process.argv.includes("--write");
  const replace = process.argv.includes("--replace");
  const only = new Set<string>();
  process.argv.forEach((argument, index) => {
    if (argument === "--only") only.add(process.argv[index + 1] ?? "");
  });
  const files = readdirSync(portsDirectory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = join(portsDirectory, name);
      const text = readFileSync(file, "utf8");
      const { listing } = JSON.parse(text) as {
        listing: { id: string; project_url: string; funding_urls?: string[] };
      };
      return { file, name, text, listing };
    })
    .filter(({ listing }) => !only.size || only.has(listing.id));
  const { createGitHubClient } = await import("./github-client.mts");
  const { localDeveloperCredential } = await import("./github-cli.mts");
  const deadline = performance.now() + 15 * 60_000;
  const sdk = await createGitHubClient({
    credential: localDeveloperCredential({ deadline }),
    deadline,
    environmentProxy: true,
    observeRedirects: true,
    allowRequest: (method, url) =>
      (method === "POST" && url.pathname === "/graphql") ||
      (method === "GET" && /^\/(?:repos\/[^/]+\/[^/]+|repositories\/[0-9]+)$/u.test(url.pathname)),
  });
  const read = graphqlFundingReader(async (query) => {
    const response = await sdk.request({
      method: "POST",
      url: "https://api.github.com/graphql",
      data: { query },
      request: { portcove: { replay: "pure-query", attempts: 0 } },
    });
    const envelope: unknown = response.data;
    return isRecord(envelope) ? envelope : {};
  });
  const get = async (path: string) => {
    try {
      const response = await sdk.request({
        method: "GET",
        url: `https://api.github.com${path}`,
        request: { portcove: { replay: "safe-read", attempts: 0, readRedirectBodyFor: [301] } },
      });
      const data: unknown = response.data;
      return { status: response.status, data };
    } catch (error) {
      const status = isRecord(error) && typeof error.status === "number" ? error.status : null;
      return { status, data: undefined };
    }
  };
  const resolved = await resolveFunding(
    files.map(({ listing }) => listing),
    read,
  );
  const counts = { changed: 0, held: 0, unknown: 0 };
  for (const { file, name, text, listing } of files) {
    const resolution = resolved.get(listing.id);
    if (!resolution) continue;
    if (resolution.kind === "unknown") {
      counts.unknown++;
      const reason =
        resolution.reason === "project-missing"
          ? await missingRepositoryReason(githubRepository(listing.project_url)!, get)
          : resolution.reason;
      const detail = [
        resolution.source,
        resolution.skipped?.length ? `skipped ${resolution.skipped.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      console.log(`${name}: unchanged, ${reason}${detail ? ` (${detail})` : ""}`);
      continue;
    }
    if (resolution.kind === "links" && resolution.skipped.length)
      console.log(`${name}: ${resolution.source} skipped ${resolution.skipped.join(", ")}`);
    if (resolution.kind === "links" && resolution.dropped.length)
      console.log(
        `${name}: over the limit of ${maximumFundingUrls}, kept the first and dropped ${resolution.dropped.join(" ")}`,
      );
    const plan = plannedFunding(listing.funding_urls, resolution, replace);
    if (plan.held) {
      counts.held++;
      console.log(`${name}: kept existing links; --replace would ${plan.held} them`);
      continue;
    }
    if (!plan.urls) continue;
    counts.changed++;
    console.log(`${name}: ${plan.urls.length ? plan.urls.join(" ") : "(no links)"}`);
    if (write) writeFileSync(file, withFundingUrls(text, plan.urls));
  }
  console.log(
    `${write ? "Updated" : "Would update"} ${counts.changed} port files; ${counts.held} kept existing links; ${counts.unknown} GitHub projects had no definite answer and were left unchanged.`,
  );
  if (write && counts.changed)
    console.log("Format the changed files and regenerate the catalog before review.");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
