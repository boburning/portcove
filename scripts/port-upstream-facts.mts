import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createGitHubClient } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";
import { DiscoveryBudget } from "./discovery-budget.mts";
import { observationHash } from "./upstream-observer.mts";
import { isRecord, errorCode } from "./runtime-values.mts";
import { parseRecompManifest } from "./discovery-ecosystems.mts";
import { parseCatalogSource, type AuthoredListing } from "./catalog-authoring.mts";

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
  expectedRepositoryId?: number | undefined;
  discoveryScope?: boolean;
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

export const discoveryScopePolicy = "github-primary-game-scope/4";

const namesScummVm = (values: readonly unknown[]) =>
  values.some(
    (value) => typeof value === "string" && /(?:^|[^A-Z0-9])scummvm(?:$|[^A-Z0-9])/iu.test(value),
  );

function launcherModPortals(value: unknown): NonNullable<AuthoredListing["mod_portals"]> {
  if (!isRecord(value)) return [];
  const portals: NonNullable<AuthoredListing["mod_portals"]> = [];
  const instructions = "The upstream project lists this community. Follow its setup instructions.";
  if (
    typeof value.thunderstore === "string" &&
    value.thunderstore.length <= 128 &&
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(value.thunderstore)
  )
    portals.push({
      id: "upstream-thunderstore",
      site: "community_site",
      name: "Thunderstore",
      url: `https://thunderstore.io/c/${value.thunderstore}/`,
      instructions,
    });
  if (
    typeof value.gamebanana === "number" &&
    Number.isSafeInteger(value.gamebanana) &&
    value.gamebanana > 0
  )
    portals.push({
      id: "upstream-gamebanana",
      site: "community_site",
      name: "GameBanana",
      url: `https://gamebanana.com/games/${value.gamebanana}`,
      instructions,
    });
  return portals;
}

function launcherScopeEvidence(value: unknown, repository: string) {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    typeof value.repo !== "string" ||
    value.repo.toLowerCase() !== repository.toLowerCase() ||
    value.games !== undefined ||
    !isRecord(value.start) ||
    !Array.isArray(value.start.program) ||
    value.start.program.length === 0 ||
    value.start.program.length > 16 ||
    !Array.isArray(value.inputs) ||
    value.inputs.length !== 1
  )
    throw new Error("Manifest does not identify this repository and one game launch route");
  const input: unknown = value.inputs[0];
  if (
    !isRecord(input) ||
    input.id !== "game" ||
    typeof input.label !== "string" ||
    !input.label.trim() ||
    input.label.length > 256 ||
    (input.role !== undefined && input.role !== "game") ||
    (input.optional !== undefined && input.optional !== false) ||
    input.shared !== undefined ||
    !Array.isArray(input.formats) ||
    input.formats.length === 0 ||
    input.formats.length > 16 ||
    !input.formats.every(
      (format) => isRecord(format) && (format.type === "file" || format.type === "folder"),
    )
  )
    throw new Error("Manifest does not declare one required game input");
  const programs: unknown[] = value.start.program;
  if (
    !programs.every(
      (program) =>
        typeof program === "string" &&
        program.length <= 256 &&
        program
          .split("/")
          .every((part) => part === part.trim() && /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/u.test(part)),
    )
  )
    throw new Error("Manifest does not declare bounded package-relative program candidates");
  const portals = launcherModPortals(value.mods);
  return {
    format: 1,
    repository,
    game_input_declared: true,
    program_count: programs.length,
    names_scummvm: namesScummVm([repository, value.name, ...programs]),
    ...(portals.length ? { mod_portals: portals } : {}),
  };
}

function desktopEntryScopeEvidence(text: string, repository: string) {
  let group = "";
  let entries = 0;
  const fields = new Map<string, string>();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      group = line;
      if (group === "[Desktop Entry]") entries++;
      continue;
    }
    if (group !== "[Desktop Entry]") continue;
    const separator = line.indexOf("=");
    if (separator < 1) return undefined;
    const key = line.slice(0, separator).trim();
    if (!key || fields.has(key)) return undefined;
    fields.set(key, line.slice(separator + 1).trim());
  }
  const name = fields.get("Name");
  const categories = fields.get("Categories") ?? "";
  const executable = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})(?: +%[fFuU])?$/u.exec(
    fields.get("Exec") ?? "",
  )?.[1];
  if (
    entries !== 1 ||
    fields.get("Type") !== "Application" ||
    !name ||
    name.length > 256 ||
    /\p{Cc}/u.test(name) ||
    !/^[A-Za-z][A-Za-z0-9-]*(?:;[A-Za-z][A-Za-z0-9-]*)*;?$/u.test(categories) ||
    !categories.split(";").includes("Game") ||
    ["Hidden", "NoDisplay", "Terminal", "DBusActivatable"].some(
      (key) => fields.has(key) && fields.get(key) !== "false",
    ) ||
    fields.has("OnlyShowIn") ||
    fields.has("NotShowIn") ||
    !executable ||
    (fields.has("TryExec") && fields.get("TryExec") !== executable) ||
    executable !== repository.split("/")[1]
  )
    return undefined;
  return {
    format: 1,
    category: "Game",
    names_scummvm: namesScummVm([repository, name, executable]),
  };
}

function ordinaryEvidenceBlob(entry: unknown): entry is Record<string, unknown> & { sha: string } {
  return (
    isRecord(entry) &&
    entry.type === "blob" &&
    (entry.mode === "100644" || entry.mode === "100755") &&
    typeof entry.sha === "string" &&
    /^[a-f0-9]{40}$/u.test(entry.sha)
  );
}

function boundedEvidenceBody(body: unknown, path: string, sha: string) {
  if (
    !isRecord(body) ||
    body.type !== "file" ||
    body.path !== path ||
    body.encoding !== "base64" ||
    typeof body.content !== "string" ||
    body.content.length > 90_000 ||
    body.sha !== sha
  )
    return null;
  const encoded = body.content.replace(/[\r\n]/gu, "");
  const bytes = Buffer.from(encoded, "base64");
  if (
    !bytes.length ||
    bytes.length > 64 * 1024 ||
    bytes.length !== body.size ||
    bytes.toString("base64") !== encoded ||
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== sha
  )
    return null;
  return bytes;
}

async function observeDiscoveryScope(
  project: unknown,
  repositoryId: number,
  read: (endpoint: string, hours?: number, reuseCached?: boolean) => Promise<FactResult>,
) {
  const outcome = (
    state: "held" | "unavailable" | "restricted",
    reason: string,
    retryAfter?: string,
  ) => ({
    policy: discoveryScopePolicy,
    state,
    reason,
    reconsider_on:
      state === "unavailable" ? "provider-retry" : "upstream-evidence-or-scope-policy-change",
    ...(retryAfter ? { retry_after: retryAfter } : {}),
  });
  if (
    !isRecord(project) ||
    project.fork !== false ||
    project.mirror_url !== null ||
    project.parent != null ||
    project.source != null ||
    typeof project.full_name !== "string"
  )
    return outcome("held", "independent-upstream-scope-unresolved");
  const location = `repositories/${repositoryId}`;
  // GitHub uses the current default branch when the sha parameter is absent.
  const head = await read(`${location}/commits?per_page=1`, 1, false);
  if (head.status === "unavailable")
    return outcome("unavailable", head.reason ?? "default-commit-unobserved", head.retry_after);
  const branchCommit: unknown =
    Array.isArray(head.body) && head.body.length === 1 ? head.body[0] : undefined;
  const commit = isRecord(branchCommit) ? branchCommit.sha : undefined;
  const commitDetails = isRecord(branchCommit) ? branchCommit.commit : undefined;
  const treeRef = isRecord(commitDetails) ? commitDetails.tree : undefined;
  const treeId = isRecord(treeRef) ? treeRef.sha : undefined;
  if (
    typeof commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(commit) ||
    typeof treeId !== "string" ||
    !/^[a-f0-9]{40}$/u.test(treeId)
  )
    return outcome("held", "default-commit-unresolved");
  const tree = await read(`${location}/git/trees/${treeId}`, 24);
  if (tree.status === "unavailable")
    return outcome("unavailable", tree.reason ?? "default-tree-unobserved", tree.retry_after);
  if (
    !isRecord(tree.body) ||
    tree.body.sha !== treeId ||
    tree.body.truncated !== false ||
    !Array.isArray(tree.body.tree)
  )
    return outcome("held", "default-tree-incomplete");
  const rootEntries = (tree.body.tree as unknown[]).filter(
    (entry): entry is Record<string, unknown> & { path: string } =>
      isRecord(entry) && typeof entry.path === "string" && entry.path.length > 0,
  );
  if (
    rootEntries.length !== tree.body.tree.length ||
    new Set(rootEntries.map(({ path }) => path)).size !== rootEntries.length
  )
    return outcome("held", "default-tree-incomplete");
  if (
    rootEntries.some(({ path }) => typeof path === "string" && /^\.recomp-[2-9]\.json$/u.test(path))
  )
    return outcome("held", "multiple-manifest-subjects");
  const manifestPath = [".recomp.json", ".recomp-board.json", "recomplauncher.json"].find((name) =>
    rootEntries.some(({ path }) => path === name),
  );
  let evidencePath: string;
  let entry: unknown;
  if (manifestPath === undefined) {
    const topics: unknown[] = Array.isArray(project.topics) ? project.topics : [];
    if (!topics.includes("source-port"))
      return outcome("held", "project-scope-evidence-unavailable");
    if (namesScummVm([project.full_name, ...topics]))
      return outcome("restricted", "scummvm-out-of-scope");
    const complete = await read(`${location}/git/trees/${treeId}?recursive=1`, 24);
    if (complete.status === "unavailable")
      return outcome(
        "unavailable",
        complete.reason ?? "desktop-entry-tree-unobserved",
        complete.retry_after,
      );
    if (
      !isRecord(complete.body) ||
      complete.body.sha !== treeId ||
      complete.body.truncated !== false ||
      !Array.isArray(complete.body.tree)
    )
      return outcome("held", "desktop-entry-tree-incomplete");
    const files = (complete.body.tree as unknown[]).filter(
      (value): value is Record<string, unknown> & { path: string } =>
        isRecord(value) && typeof value.path === "string",
    );
    if (
      files.length !== complete.body.tree.length ||
      new Set(files.map(({ path }) => path)).size !== files.length
    )
      return outcome("held", "desktop-entry-tree-incomplete");
    const desktops = files.filter(({ path }) => path.endsWith(".desktop"));
    if (desktops.length !== 1) return outcome("held", "single-desktop-entry-unresolved");
    entry = desktops[0];
    evidencePath = desktops[0]!.path;
    if (
      evidencePath.length > 240 ||
      !evidencePath
        .split("/")
        .every((part) => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== "..") ||
      evidencePath
        .split("/")
        .slice(0, -1)
        .some((part) =>
          /^(?:tests?|fixtures?|examples?|samples?|docs?|vendor|third[-_]party|external|\.github)$/iu.test(
            part,
          ),
        )
    )
      return outcome("held", "unsupported-project-desktop-entry");
  } else {
    evidencePath = manifestPath;
    entry = rootEntries.find(({ path }) => path === manifestPath);
  }
  if (!ordinaryEvidenceBlob(entry))
    return outcome(
      "held",
      manifestPath ? "unsupported-project-manifest-entry" : "unsupported-project-desktop-entry",
    );
  const fact = await read(`${location}/contents/${evidencePath}?ref=${commit}`, 24);
  if (fact.status === "unavailable")
    return outcome(
      "unavailable",
      fact.reason ?? "project-scope-evidence-unobserved",
      fact.retry_after,
    );
  const bytes = boundedEvidenceBody(fact.body, evidencePath, entry.sha);
  if (!bytes) return outcome("held", "project-scope-evidence-bytes-unverified");
  const binding = {
    policy: discoveryScopePolicy,
    state: "eligible" as const,
    repository_id: repositoryId,
    commit,
    tree: treeId,
    evidence_path: evidencePath,
  };
  if (manifestPath === undefined) {
    let desktop;
    try {
      desktop = desktopEntryScopeEvidence(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        project.full_name,
      );
    } catch {
      return outcome("held", "unsupported-project-desktop-entry");
    }
    if (!desktop) return outcome("held", "unsupported-project-desktop-entry");
    if (desktop.names_scummvm) return outcome("restricted", "scummvm-out-of-scope");
    return {
      ...binding,
      desktop_entry_blob: entry.sha,
      desktop_entry_sha256: createHash("sha256").update(bytes).digest("hex"),
      desktop_entry: desktop,
    };
  }

  let manifest: ReturnType<typeof parseRecompManifest> | ReturnType<typeof launcherScopeEvidence>;
  try {
    const value = parseCatalogSource(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    manifest =
      manifestPath === "recomplauncher.json"
        ? launcherScopeEvidence(value, project.full_name)
        : parseRecompManifest(value);
  } catch {
    return outcome("held", "unsupported-project-manifest");
  }
  if (
    "names_scummvm" in manifest
      ? manifest.names_scummvm
      : namesScummVm([manifest.game, ...manifest.systems, ...manifest.toolchains])
  )
    return outcome("restricted", "scummvm-out-of-scope");
  return {
    ...binding,
    manifest_path: manifestPath,
    manifest_blob: entry.sha,
    manifest_sha256: createHash("sha256").update(bytes).digest("hex"),
    manifest,
  };
}

export class BoundRepositoryUnavailable extends Error {
  readonly reason: string;
  readonly retryAfter: string | undefined;
  constructor(reason: string, retryAfter?: string) {
    super(`Public repository metadata unavailable: ${reason}.`);
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
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
  const expectedId = options.expectedRepositoryId;
  if (expectedId !== undefined && (!Number.isSafeInteger(expectedId) || expectedId <= 0))
    throw new Error("Expected repository ID must be a positive GitHub repository ID.");
  if (options.discoveryScope && expectedId === undefined)
    throw new Error("Discovery scope needs an immutable GitHub repository identity.");
  if (options.releaseUrl !== undefined && options.resolveReleaseUrl)
    throw new Error(
      "Select either an explicit release provider or its canonical identity resolver.",
    );
  const now = options.now ?? Date.now;
  const started = now();
  const budget = new DiscoveryBudget("ordinary", undefined, now);
  const observations: FactResult[] = [];
  const deadline = performance.now() + limits.milliseconds;
  const deferral = { primary: new Map<string, number>(), secondary: 0 };
  let received = 0;
  const sdk = await createGitHubClient({
    credential:
      options.token === undefined
        ? { kind: "anonymous" }
        : { kind: "explicit", token: options.token },
    deadline,
    wallNow: now,
    deferral,
    maxBytes: 2 * 1024 * 1024,
    requestTimeoutMs: 20000,
    ...(options.fetcher ? { fetch: options.fetcher } : {}),
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) => method === "GET" && url.origin === "https://api.github.com",
    reserve: async ({ url }) => {
      if (
        budget.usage.requests >= limits.requests ||
        received >= limits.bytes ||
        performance.now() >= deadline
      )
        throw new GitHubApiError(
          "budget_exhausted",
          "Ordinary facts collection allowance exhausted",
        );
      await budget.admit(1, 1);
      return {
        consumeBytes(bytes) {
          received += bytes;
          if (received > limits.bytes)
            throw new GitHubApiError("budget_exhausted", "Ordinary facts byte allowance exhausted");
        },
        settle(observation) {
          if (observation.dispatched)
            budget.charge("GET", url.href, 1, observation.bytes, String(observation.status ?? 0));
        },
      };
    },
  });
  mkdirSync(options.cacheDirectory, { recursive: true });
  if (
    !lstatSync(options.cacheDirectory).isDirectory() ||
    lstatSync(options.cacheDirectory).isSymbolicLink()
  )
    throw new Error("Preparation cache must be a real directory.");
  const read = async (endpoint: string, hours = 1, reuseCached = true): Promise<FactResult> => {
    const url = new URL(endpoint, "https://api.github.com/");
    if (url.origin !== "https://api.github.com") throw new Error("Unexpected facts provider.");
    const pathHash = observationHash(url.href);
    const cacheHash = expectedId === undefined ? pathHash : observationHash([expectedId, url.href]);
    const file = join(options.cacheDirectory, `${cacheHash}.json`);
    const cached = readCache(file, url.href);
    const retryFile = join(options.cacheDirectory, `${pathHash}.json.retry`);
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
      reuseCached &&
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
        let response: {
          status: number;
          headers: Readonly<Record<string, string | number | undefined>>;
          data?: unknown;
          error?: true;
          backoff_until?: string;
        };
        try {
          const result = await sdk.request({
            method: "GET",
            url: url.href,
            // These bounded, cached observations have always been one-shot.
            request: { portcove: { replay: "once", attempts: 0 } },
          });
          response = {
            status: result.status,
            headers: result.headers,
            data: result.data as unknown,
          };
        } catch (error) {
          const deferred = Math.max(deferral.secondary, ...deferral.primary.values());
          const status = error instanceof GitHubApiError ? (error.status ?? 0) : 0;
          response = {
            status,
            headers: {},
            ...(status >= 400 ? {} : { error: true as const }),
            ...(deferred > now() && Number.isFinite(new Date(deferred).getTime())
              ? { backoff_until: new Date(deferred).toISOString() }
              : {}),
          };
        }
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
          const body: unknown = response.data;
          if (body === undefined || typeof body === "string")
            result = unavailable("invalid-provider-json");
          else {
            const observed = now();
            const entry: CachedFact = {
              format_version: 1,
              endpoint: url.href,
              observed_at: new Date(observed).toISOString(),
              fresh_until: new Date(observed + hours * 3600000).toISOString(),
              body,
              body_sha256: observationHash(body),
              next_page: /rel="next"/u.test(String(response.headers.link ?? "")),
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
  if (expectedId !== undefined && !repository)
    throw new Error("A bound repository ID requires a GitHub repository URL.");
  // A path cache cannot prove who owns a mutable repository name now.
  const project = repository
    ? await read(`repos/${repository}`, 24, expectedId === undefined)
    : undefined;
  if (isRecord(project?.body) && project.body.private === true)
    throw new Error("Private repository metadata cannot establish a public catalog origin.");
  if (expectedId !== undefined && project?.status === "unavailable")
    throw new BoundRepositoryUnavailable(project.reason ?? "unobserved", project.retry_after);
  if (
    expectedId !== undefined &&
    (!isRecord(project?.body) ||
      project.body.private !== false ||
      project.body.id !== expectedId ||
      typeof project.body.full_name !== "string" ||
      project.body.full_name.toLowerCase() !== repository?.toLowerCase())
  )
    throw new Error(
      "Public repository metadata does not match the observed repository ID and location.",
    );
  const discoveryScope =
    options.discoveryScope && expectedId !== undefined
      ? await observeDiscoveryScope(project?.body, expectedId, read)
      : undefined;
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
      ? await read(`repos/${releaseRepository}`, 24, expectedId === undefined)
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
    const releaseLocation =
      expectedId === undefined
        ? `repos/${releaseRepository}`
        : `repositories/${relatedProvider && isRecord(releaseProject?.body) ? Number(releaseProject.body.id) : expectedId}`;
    if (options.releaseTag) {
      if (options.releaseTag.length > 255 || hasControl(options.releaseTag))
        throw new Error("Release tag is not bounded text.");
      release = await read(
        `${releaseLocation}/releases/tags/${encodeURIComponent(options.releaseTag)}`,
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
            `${releaseLocation}/releases/${Number(value.id)}/assets?per_page=100&page=${page}`,
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
    } else candidates = await read(`${releaseLocation}/releases?per_page=20&page=1`);
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
    ...(discoveryScope ? { discovery_scope: discoveryScope } : {}),
    usage: { ...budget.usage, limits },
    scope:
      "Bounded upstream metadata only. Release candidates are one current window; incomplete assets are Unknown. No package acquisition, qualification, execution, issue mutation or catalog admission.",
  };
}
