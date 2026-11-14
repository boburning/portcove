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
 * the result is an ordinary reviewed catalog diff. Dry run unless --write.
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

/**
 * Known platforms in a fixed order, then custom HTTPS links in file order. Unknown
 * platforms, malformed names and non-HTTPS custom links are skipped.
 */
export function fundingUrlsFromYaml(text: string): string[] {
  if (Buffer.byteLength(text) > maximumFundingBytes) return [];
  let document: unknown;
  try {
    document = parse(text, { maxAliasCount: 0 });
  } catch {
    return [];
  }
  if (!isRecord(document)) return [];
  const urls: string[] = [];
  for (const [key, url] of accountPlatforms)
    for (const name of values(document[key]))
      if (typeof name === "string" && accountName.test(name.trim())) urls.push(url(name.trim()));
  for (const custom of values(document.custom)) {
    const url = fundingCustomUrl(custom);
    if (url) urls.push(url);
  }
  return [...new Set(urls)].slice(0, maximumFundingUrls);
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
/** Per repository: the FUNDING.yml texts in lookup order, or null when unreadable. */
export type FundingReader = (
  repositories: readonly { owner: string; name: string }[],
) => Promise<Map<string, Blobs | "missing" | null>>;

/** First file found decides, as on GitHub; undefined means the answer is unknown. */
export function firstFunding(own: Blobs | "missing" | null, owner: Blobs | "missing" | null) {
  // The project itself must be readable before its absence of a file means anything.
  if (own === null || own === "missing") return undefined;
  for (const candidate of [own, owner]) {
    if (candidate === null) return undefined;
    if (candidate === "missing") return [];
    for (const blob of candidate) {
      if (blob === undefined) return undefined;
      if (blob !== null) return fundingUrlsFromYaml(blob);
    }
  }
  return [];
}

const key = (repository: { owner: string; name: string }) =>
  `${repository.owner}/${repository.name}`.toLowerCase();

/**
 * One GraphQL query per batch. `resource(url:)` answers null, without an error,
 * for a repository that does not exist publicly; any GraphQL error fails the run.
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

/** Funding links per listing id; listings whose answer is unknown are absent. */
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
  const resolved = new Map<string, string[]>();
  for (const [id, repository] of projects) {
    const owner = shared.get(key({ owner: repository.owner, name: ".github" })) ?? "missing";
    const urls = firstFunding(own.get(key(repository)) ?? null, owner);
    if (urls) resolved.set(id, urls);
  }
  return resolved;
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const portsDirectory = join(root, "crates", "portcove-core", "catalog", "ports");
  const write = process.argv.includes("--write");
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
      const listing = (JSON.parse(text) as { listing: { id: string; project_url: string } })
        .listing;
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
    allowRequest: (method, url) => method === "POST" && url.pathname === "/graphql",
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
  const resolved = await resolveFunding(
    files.map(({ listing }) => listing),
    read,
  );
  let changed = 0;
  let unknown = 0;
  for (const { file, name, text, listing } of files) {
    const urls = resolved.get(listing.id);
    if (!urls) {
      if (githubRepository(listing.project_url)) unknown++;
      continue;
    }
    const next = withFundingUrls(text, urls);
    if (next === text) continue;
    changed++;
    console.log(`${name}: ${urls.length ? urls.join(" ") : "(no links)"}`);
    if (write) writeFileSync(file, next);
  }
  console.log(
    `${write ? "Updated" : "Would update"} ${changed} port files; ${unknown} GitHub projects could not be read and were left unchanged.`,
  );
  if (write && changed)
    console.log("Format the changed files and regenerate the catalog before review.");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
