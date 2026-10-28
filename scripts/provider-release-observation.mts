import { boundedDiscoveryRequest } from "./discovery-http.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash, ObservationFailure } from "./upstream-observer.mts";
export interface ProviderSource {
  key: string;
  provider: "gitlab" | "direct-manifest";
  repository: string;
  scope_sha256: string;
  ports: { id: string; release: Record<string, unknown> }[];
}
interface Read {
  url: string;
  method: "GET" | "HEAD";
  body: unknown;
  status: number;
  next: string | null;
  page?: string | null;
  per_page?: string | null;
  etag: string | null;
  content_length: number | null;
  observed_at: string;
  sha256: string;
}
export interface ProviderProgress {
  format: 1 | 2;
  binding: string;
  reads: Read[];
  validation_cursor: number;
}
export interface ProviderCapacity {
  remaining: number | null;
  limit: number | null;
  reset_at: string | null;
  retry_at: string | null;
}
const readHash = (read: Omit<Read, "sha256" | "etag" | "observed_at">, legacy = false) =>
  observationHash({
    url: read.url,
    method: read.method,
    body: read.body,
    status: read.status,
    next: read.next,
    ...(legacy ? {} : { page: read.page ?? null, per_page: read.per_page ?? null }),
    content_length: read.content_length,
  });
export function validateProviderProgress(value: unknown): asserts value is ProviderProgress {
  if (
    !isRecord(value) ||
    ![1, 2].includes(Number(value.format)) ||
    typeof value.binding !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.binding) ||
    !Array.isArray(value.reads) ||
    !Number.isSafeInteger(value.validation_cursor) ||
    Number(value.validation_cursor) < 0 ||
    Number(value.validation_cursor) > value.reads.length ||
    Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024
  )
    throw new Error("Invalid provider continuation");
  for (const read of value.reads) {
    if (
      !isRecord(read) ||
      typeof read.url !== "string" ||
      !["GET", "HEAD"].includes(String(read.method)) ||
      !Number.isInteger(read.status) ||
      !((read.next === null && value.format === 2) || typeof read.next === "string") ||
      (value.format === 2 &&
        [read.page, read.per_page].some(
          (field) => !(field === null || (typeof field === "string" && /^\d+$/u.test(field))),
        )) ||
      !(
        read.etag === null ||
        (typeof read.etag === "string" && read.etag.length <= 512 && !/[\r\n]/u.test(read.etag))
      ) ||
      typeof read.observed_at !== "string" ||
      !Number.isFinite(Date.parse(read.observed_at)) ||
      read.sha256 !== readHash(read as unknown as Read, value.format === 1)
    )
      throw new Error("Corrupt provider read evidence");
  }
}
/** Exact GET/HEAD prefixes under the existing catalog checkpoint, without mutation or artifact trust. */
export async function observeProviderSource(
  source: ProviderSource,
  prior: unknown,
  options: {
    now?: () => number;
    deadline: number;
    maximumRequests: number;
    maximumBytes: number;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    capacities: Record<string, ProviderCapacity>;
    commit: (progress: ProviderProgress) => Promise<void>;
    charge: (bytes: number) => void;
    admit: () => void;
    reuseComplete?: boolean;
    bindIdentity?: (identity: number) => Promise<void>;
    project: (portId: string, observation: Record<string, unknown>) => Promise<unknown>;
  },
) {
  const now = options.now ?? Date.now;
  const state: ProviderProgress =
    prior === undefined
      ? { format: 2, binding: source.scope_sha256, reads: [], validation_cursor: 0 }
      : (structuredClone(prior) as ProviderProgress);
  validateProviderProgress(state);
  if (state.format !== 2)
    throw new ObservationFailure(
      "provider-proof-upgrade",
      "Legacy provider reads need a fresh pagination proof; historical evidence must remain retained",
    );
  if (state.binding !== source.scope_sha256)
    throw new ObservationFailure(
      "provider-scope-changed",
      "Reviewed provider scope changed; retain previous evidence for explicit reconciliation",
    );
  let cursor = 0,
    requests = 0,
    bytes = 0;
  const resumed = state.reads.length > 0;
  const persist = () => options.commit(structuredClone(state));
  const request = async (url: string, method: "GET" | "HEAD", etag?: string): Promise<Read> => {
    let admissionFailure: ObservationFailure | undefined;
    const response = await boundedDiscoveryRequest(
      {
        url,
        method,
        cap: 2 * 1024 * 1024,
        timeout: Math.max(1, Math.min(20000, options.deadline - now())),
        maxRequests: method === "HEAD" ? 5 : 1,
      },
      async (input, init) => {
        const inputUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const target = new URL(inputUrl);
        const origin = target.origin;
        const quota = (options.capacities[origin] ??= {
          remaining: null,
          limit: null,
          reset_at: null,
          retry_at: null,
        });
        try {
          if (quota.reset_at && Date.parse(quota.reset_at) <= now()) {
            quota.remaining = null;
            quota.limit = null;
            quota.reset_at = null;
          }
          if (quota.retry_at && Date.parse(quota.retry_at) <= now()) quota.retry_at = null;
          if (options.signal?.aborted)
            throw new ObservationFailure(
              "cancelled",
              "Provider observation cancelled before request",
            );
          if (
            (quota.retry_at && Date.parse(quota.retry_at) > now()) ||
            (quota.remaining !== null &&
              quota.remaining <= Math.max(1, Math.ceil((quota.limit ?? quota.remaining) * 0.05)))
          )
            throw new ObservationFailure(
              "provider-quota",
              "Provider reserve unavailable",
              quota.retry_at ?? quota.reset_at,
            );
          if (
            requests >= options.maximumRequests ||
            now() >= options.deadline ||
            bytes + 2 * 1024 * 1024 > options.maximumBytes
          )
            throw new ObservationFailure(
              "budget",
              "Provider quantum exhausted; exact prefix retained",
            );
          options.admit();
          requests++;
          if (quota.remaining !== null) quota.remaining--;
        } catch (error) {
          if (error instanceof ObservationFailure) admissionFailure = error;
          throw error;
        }
        const result = await (options.fetch ?? fetch)(input, {
          ...init,
          signal: options.signal
            ? AbortSignal.any([options.signal, init?.signal ?? AbortSignal.timeout(20000)])
            : (init?.signal ?? AbortSignal.timeout(20000)),
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            ...(etag && inputUrl === url ? { "If-None-Match": etag } : {}),
          },
        });
        const integer = (name: string) => {
          const raw = result.headers.get(name);
          return raw && /^\d+$/u.test(raw) && Number.isSafeInteger(Number(raw))
            ? Number(raw)
            : null;
        };
        const remaining = integer("ratelimit-remaining") ?? integer("x-ratelimit-remaining");
        const limit = integer("ratelimit-limit") ?? integer("x-ratelimit-limit");
        const reset = integer("ratelimit-reset") ?? integer("x-ratelimit-reset");
        if (remaining !== null && limit !== null && remaining <= limit) {
          quota.remaining = remaining;
          quota.limit = limit;
          quota.reset_at =
            reset !== null && reset * 1000 <= 8.64e15 ? new Date(reset * 1000).toISOString() : null;
        }
        const retry = result.headers.get("retry-after");
        if (retry !== null) {
          const at = /^\d+$/u.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry);
          if (Number.isFinite(at) && at > now() && at <= 8.64e15)
            quota.retry_at = new Date(at).toISOString();
        }
        return result;
      },
    );
    bytes += response.bytes;
    options.charge(response.bytes);
    if ("error" in response) {
      if (admissionFailure) throw admissionFailure;
      // bounded transport retains failures; only a positive admission failure is continuation.
      const quota = options.capacities[new URL(url).origin];
      if (
        quota?.retry_at ||
        (quota?.remaining !== null &&
          quota?.remaining !== undefined &&
          quota.remaining <= Math.max(1, Math.ceil((quota.limit ?? quota.remaining) * 0.05)))
      )
        throw new ObservationFailure(
          "provider-quota",
          response.error,
          quota?.retry_at ?? quota?.reset_at,
        );
      throw new ObservationFailure("provider-transport", response.error);
    }
    if (response.status === 304 && (method !== "GET" || !etag))
      throw new ObservationFailure(
        "provider-http",
        "Unexpected not-modified response without a conditional GET",
      );
    if (![200, 204, 304].includes(response.status) && method === "GET")
      throw new ObservationFailure(
        "provider-http",
        `Primary provider returned HTTP ${response.status}`,
      );
    const body: unknown =
      method === "GET" && response.status !== 304 ? JSON.parse(response.text) : null;
    const rawLength = response.headers["content-length"];
    const contentLength =
      method === "HEAD" &&
      rawLength &&
      /^\d+$/u.test(rawLength) &&
      Number.isSafeInteger(Number(rawLength))
        ? Number(rawLength)
        : null;
    const value = {
      url,
      method,
      body,
      status: response.status,
      next: response.headers["x-next-page"] ?? null,
      page: response.headers["x-page"] ?? null,
      per_page: response.headers["x-per-page"] ?? null,
      content_length: contentLength,
    };
    return {
      ...value,
      etag: (response.headers.etag?.length ?? 0) <= 512 ? (response.headers.etag ?? null) : null,
      observed_at: new Date(now()).toISOString(),
      sha256: readHash(value),
    };
  };
  const read = async (
    url: string,
    method: "GET" | "HEAD" = "GET",
    validate: (read: Read) => void | Promise<void> = () => {},
  ) => {
    let saved = state.reads[cursor++];
    if (saved && (saved.url !== url || saved.method !== method))
      throw new ObservationFailure(
        "provider-scope-changed",
        "Provider continuation query order changed; preserve evidence",
      );
    if (!saved) {
      saved = await request(url, method);
      await validate(saved);
      state.reads.push(saved);
      await persist();
    } else await validate(saved);
    return saved;
  };
  const list = async (base: string, kind: "release" | "package" | "file") => {
    const rows: unknown[] = [];
    for (let page = 1; ; page++) {
      const url = new URL(base);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const result = await read(url.href, "GET", (result) => {
        if (
          !Array.isArray(result.body) ||
          result.body.length > 100 ||
          result.page !== String(page) ||
          result.per_page !== "100" ||
          result.next === null ||
          (result.next && (result.next !== String(page + 1) || result.body.length !== 100))
        )
          throw new ObservationFailure(
            "provider-pagination",
            "GitLab page coverage or cursor is invalid",
          );
        const identities = new Set(
          rows.map((row) =>
            isRecord(row) ? String(kind === "release" ? row.tag_name : row.id) : "",
          ),
        );
        for (const raw of result.body as unknown[]) {
          if (!isRecord(raw))
            throw new ObservationFailure("provider-metadata", "GitLab row is not an object");
          const identity = kind === "release" ? raw.tag_name : raw.id;
          if (
            kind === "release"
              ? typeof identity !== "string" ||
                !identity.length ||
                identity.length > 255 ||
                Array.from(identity).some(
                  (character) =>
                    character.charCodeAt(0) < 32 ||
                    (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
                ) ||
                typeof raw.upcoming_release !== "boolean" ||
                typeof raw.released_at !== "string" ||
                !Number.isFinite(Date.parse(raw.released_at)) ||
                !isRecord(raw.assets) ||
                !Array.isArray(raw.assets.links)
              : !Number.isSafeInteger(identity) || Number(identity) < 1
          )
            throw new ObservationFailure(
              "provider-metadata",
              "GitLab row identity or required metadata is invalid",
            );
          const key = typeof identity === "string" ? identity : String(Number(identity));
          if (identities.has(key))
            throw new ObservationFailure("provider-identity", "GitLab pages repeat an identity");
          identities.add(key);
          if (
            kind === "package" &&
            (typeof raw.version !== "string" || typeof raw.name !== "string")
          )
            throw new ObservationFailure("provider-metadata", "GitLab package metadata is invalid");
          if (
            kind === "file" &&
            (typeof raw.file_name !== "string" ||
              !raw.file_name.length ||
              !Number.isSafeInteger(raw.size) ||
              Number(raw.size) < 1 ||
              typeof raw.file_sha256 !== "string" ||
              !/^[a-f0-9]{64}$/iu.test(raw.file_sha256))
          )
            throw new ObservationFailure(
              "provider-metadata",
              "GitLab registry file integrity metadata is invalid",
            );
        }
      });
      rows.push(...(result.body as unknown[]));
      if (!result.next) return rows;
    }
  };
  let facts: Record<string, unknown>;
  if (source.provider === "gitlab") {
    const base = `https://gitlab.com/api/v4/projects/${encodeURIComponent(source.repository)}`;
    const projectRead = await read(base, "GET", async (result) => {
      const project = result.body;
      if (
        !isRecord(project) ||
        project.path_with_namespace !== source.repository ||
        !Number.isSafeInteger(project.id) ||
        Number(project.id) < 1
      )
        throw new ObservationFailure(
          "repository-identity",
          "GitLab project identity differs from the reviewed source",
        );
      if (
        project.archived !== undefined &&
        project.archived !== null &&
        typeof project.archived !== "boolean"
      )
        throw new ObservationFailure(
          "provider-metadata",
          "GitLab archive state is malformed; no active-state assumption is permitted",
        );
      await options.bindIdentity?.(Number(project.id));
    });
    const project = projectRead.body as Record<string, unknown>;
    const releases = await list(`${base}/releases?order_by=released_at&sort=desc`, "release");
    const packages = await list(
      `${base}/packages?package_type=generic&order_by=created_at&sort=desc`,
      "package",
    );
    const tags = new Set(
      releases.flatMap((release) =>
        isRecord(release) && typeof release.tag_name === "string"
          ? [release.tag_name, release.tag_name.replace(/^v/u, "")]
          : [],
      ),
    );
    const files: Record<string, unknown> = {};
    for (const item of packages) {
      if (
        !isRecord(item) ||
        !Number.isSafeInteger(item.id) ||
        Number(item.id) < 1 ||
        typeof item.version !== "string"
      )
        throw new ObservationFailure("provider-identity", "Invalid GitLab package identity");
      if (tags.has(item.version))
        files[String(item.id)] = await list(
          `https://gitlab.com/api/v4/projects/${Number(project.id)}/packages/${Number(item.id)}/package_files`,
          "file",
        );
    }
    facts = {
      project: { ...project, archived: project.archived ?? null },
      releases,
      packages,
      package_files: files,
      coverage: { releases: true, packages: true },
    };
  } else {
    const endpoints: Record<string, unknown> = {};
    for (const port of source.ports) {
      if (!isRecord(port.release.direct))
        throw new ObservationFailure("provider-definition", "Reviewed direct manifest is missing");
      for (const pin of Object.values(port.release.direct)) {
        if (!isRecord(pin) || typeof pin.url !== "string")
          throw new ObservationFailure(
            "provider-definition",
            "Reviewed direct endpoint is missing",
          );
        if (!endpoints[pin.url]) {
          const result = await read(pin.url, "HEAD");
          endpoints[pin.url] = {
            url: pin.url,
            status: result.status,
            content_length: result.content_length,
          };
        }
      }
    }
    facts = { endpoints };
  }
  if (cursor !== state.reads.length)
    throw new ObservationFailure(
      "provider-scope-changed",
      "Provider continuation has an unmatched read tail",
    );
  if (resumed && !options.reuseComplete) {
    while (state.validation_cursor < state.reads.length) {
      const saved = state.reads[state.validation_cursor]!;
      let current = await request(
        saved.url,
        saved.method,
        saved.method === "GET" ? (saved.etag ?? undefined) : undefined,
      );
      if (
        current.status === 304 &&
        saved.page !== null &&
        saved.page !== undefined &&
        (current.page !== saved.page ||
          current.per_page !== saved.per_page ||
          current.next !== saved.next)
      ) {
        // A body ETag alone cannot prove the terminal pagination boundary.
        current = await request(saved.url, saved.method);
      }
      if (current.status !== 304 && current.sha256 !== saved.sha256) {
        state.reads = [];
        state.validation_cursor = 0;
        await persist();
        throw new ObservationFailure(
          "provider-changed",
          "Provider facts changed during continuation; restart exact source without publishing partial data",
        );
      }
      saved.observed_at = current.observed_at;
      state.validation_cursor++;
      await persist();
    }
  }
  const oldest =
    state.reads.map((r) => r.observed_at).toSorted()[0] ?? new Date(now()).toISOString();
  if (
    state.reads.some((r) => Date.parse(r.observed_at) > now()) ||
    now() - Date.parse(oldest) >= 12 * 3600000
  ) {
    state.validation_cursor = 0;
    await persist();
    throw new ObservationFailure(
      "provider-stale",
      "Provider fact interval requires fresh validation",
    );
  }
  const observations = source.ports.map((port) => ({
    format: 3,
    authority: "provider-observation-only",
    provider: source.provider,
    port_id: port.id,
    started_at: oldest,
    completed_at: new Date(now()).toISOString(),
    facts,
    facts_sha256: observationHash(facts),
  }));
  const policies: unknown[] = [];
  for (const observation of observations) {
    if (options.signal?.aborted)
      throw new ObservationFailure("cancelled", "Provider projection cancelled");
    if (now() >= options.deadline)
      throw new ObservationFailure("budget", "Provider Core projection deferred");
    policies.push(await options.project(observation.port_id, observation));
  }
  return { state, observations, policies, requests, bytes, observed_at: oldest };
}
