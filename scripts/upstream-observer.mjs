import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export const observationHash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const apiRoot = "https://api.github.com";

export class ObservationFailure extends Error {
  constructor(rule, details, retryAt = null) {
    super(details);
    this.rule = rule;
    this.retryAt = retryAt;
  }
}

function requireFact(condition, rule, details) {
  if (!condition) throw new ObservationFailure(rule, details);
}

function keys(value, names, label) {
  requireFact(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid-metadata",
    `${label} must be an object`,
  );
  requireFact(
    Object.keys(value).every((key) => names.includes(key)) &&
      names.every((key) => Object.hasOwn(value, key)),
    "invalid-metadata",
    `${label} has unexpected or missing fields`,
  );
}

export function validateObserverConfig(config) {
  keys(
    config,
    [
      "format",
      "port_id",
      "repository",
      "repository_id",
      "cadence_hours",
      "stale_after_hours",
      "budget",
    ],
    "observer configuration",
  );
  requireFact(
    config.format === 1 &&
      typeof config.port_id === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.port_id),
    "invalid-config",
    "unsupported observer format or port identity",
  );
  requireFact(
    typeof config.repository === "string" &&
      config.repository.length <= 200 &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.repository),
    "invalid-config",
    "invalid configured repository",
  );
  requireFact(
    Number.isSafeInteger(config.repository_id) && config.repository_id > 0,
    "invalid-config",
    "repository numeric identity is required",
  );
  requireFact(
    Number.isInteger(config.cadence_hours) &&
      config.cadence_hours >= 1 &&
      config.cadence_hours <= 24 &&
      Number.isInteger(config.stale_after_hours) &&
      config.stale_after_hours >= config.cadence_hours &&
      config.stale_after_hours <= 48,
    "invalid-config",
    "invalid observation cadence",
  );
  const limits = {
    requests: 512,
    pages_per_collection: 20,
    response_bytes: 4 * 1024 * 1024,
    total_bytes: 32 * 1024 * 1024,
    duration_ms: 300_000,
    retries: 2,
  };
  keys(config.budget, Object.keys(limits), "observer budget");
  for (const [name, maximum] of Object.entries(limits))
    requireFact(
      Number.isInteger(config.budget[name]) &&
        config.budget[name] >= (name === "retries" ? 0 : 1) &&
        config.budget[name] <= maximum,
      "invalid-config",
      `invalid ${name} budget`,
    );
  return config;
}

function textFact(value, label, maximum = 1024) {
  const hasControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  requireFact(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= maximum &&
      !hasControlCharacter,
    "invalid-metadata",
    `invalid ${label}`,
  );
  return value;
}

function identity(value, label) {
  requireFact(
    Number.isSafeInteger(value) && value > 0,
    "invalid-metadata",
    `invalid ${label} identity`,
  );
  return value;
}

function timestamp(value, label, nullable = false) {
  if (nullable && value === null) return null;
  requireFact(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "invalid-metadata",
    `invalid ${label} timestamp`,
  );
  return value;
}

function downloadUrl(value, config, tag, name) {
  const url = new URL(textFact(value, "asset URL", 4096));
  const expected = `/${config.repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  requireFact(
    url.origin === "https://github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === expected,
    "asset-scope",
    "asset URL does not match the configured repository, tag and filename",
  );
  return value;
}

function assetFact(asset, config, tag) {
  requireFact(asset && typeof asset === "object", "invalid-metadata", "invalid asset object");
  const name = textFact(asset.name, "asset filename", 255);
  requireFact(
    !/[\\/]/.test(name) && name !== "." && name !== "..",
    "invalid-metadata",
    "asset filename is not a single component",
  );
  requireFact(
    Number.isSafeInteger(asset.size) && asset.size >= 0 && asset.state === "uploaded",
    "invalid-metadata",
    "asset size or upload state is invalid",
  );
  requireFact(
    asset.digest === null ||
      asset.digest === undefined ||
      /^sha256:[a-fA-F0-9]{64}$/.test(asset.digest),
    "invalid-metadata",
    "unsupported asset digest",
  );
  return {
    id: identity(asset.id, "asset"),
    name,
    size: asset.size,
    state: asset.state,
    digest: asset.digest ?? null,
    browser_download_url: downloadUrl(asset.browser_download_url, config, tag, name),
    created_at: timestamp(asset.created_at, "asset creation"),
    updated_at: timestamp(asset.updated_at, "asset update"),
  };
}

function releaseFact(release) {
  requireFact(
    release &&
      typeof release === "object" &&
      typeof release.draft === "boolean" &&
      typeof release.prerelease === "boolean",
    "invalid-metadata",
    "release flags must be explicit booleans",
  );
  const published = timestamp(release.published_at, "release publication", true);
  requireFact(
    release.draft || published !== null,
    "invalid-metadata",
    "published release has no publication clock",
  );
  return {
    id: identity(release.id, "release"),
    tag_name: textFact(release.tag_name, "release tag", 255),
    draft: release.draft,
    prerelease: release.prerelease,
    created_at: timestamp(release.created_at, "release creation"),
    published_at: published,
  };
}

function repositoryFact(repository, config) {
  requireFact(
    repository?.id === config.repository_id &&
      repository.full_name === config.repository &&
      typeof repository.archived === "boolean",
    "repository-identity",
    "configured repository identity changed",
  );
  return {
    id: repository.id,
    full_name: repository.full_name,
    archived: repository.archived,
  };
}

function nextPage(link, pathname, page, config) {
  if (!link) return false;
  const paths = [
    pathname,
    pathname.replace(`/repos/${config.repository}`, `/repositories/${config.repository_id}`),
  ];
  const relations = new Set();
  for (const part of link.split(",")) {
    const match = part.trim().match(/^<([^>]+)>; rel="(next|prev|first|last)"$/);
    requireFact(match, "pagination", "malformed pagination link");
    const url = new URL(match[1]);
    const number = Number(url.searchParams.get("page"));
    requireFact(
      url.origin === apiRoot &&
        !url.username &&
        !url.password &&
        !url.hash &&
        paths.includes(url.pathname) &&
        url.searchParams.get("per_page") === "100" &&
        [...url.searchParams.keys()].length === 2 &&
        Number.isInteger(number) &&
        number > 0,
      "pagination",
      "pagination link escaped its configured collection",
    );
    requireFact(!relations.has(match[2]), "pagination", "duplicate pagination relation");
    relations.add(match[2]);
    if (match[2] === "next")
      requireFact(number === page + 1, "pagination", "pagination did not advance exactly one page");
  }
  return relations.has("next");
}

function validatedCache(cache, configHash) {
  if (!cache) return {};
  keys(cache, ["format", "config_sha256", "pages"], "observation cache");
  requireFact(
    cache.format === 1 &&
      cache.config_sha256 === configHash &&
      cache.pages &&
      typeof cache.pages === "object" &&
      !Array.isArray(cache.pages),
    "invalid-cache",
    "cache configuration identity differs",
  );
  return cache.pages;
}

/** Read-only provider observations. No candidate data is executed or admitted. */
export async function observeUpstream(config, options = {}) {
  validateObserverConfig(config);
  const configHash = observationHash(config);
  const prior = validatedCache(options.cache, configHash);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const pages = {};
  const consumed = { requests: 0, response_bytes: 0, conditional_hits: 0 };
  const requestOrder = [];

  async function request(pathname, page = null, cached = null) {
    const url = `${apiRoot}${pathname}${page === null ? "" : `?per_page=100&page=${page}`}`;
    const previous = cached ?? prior[url];
    if (previous) {
      keys(previous, ["etag", "link", "body", "sha256"], "cached response");
      requireFact(
        typeof previous.etag === "string" &&
          previous.etag.length <= 512 &&
          !/[\r\n]/.test(previous.etag) &&
          typeof previous.link === "string" &&
          previous.link.length <= 8192 &&
          previous.sha256 === observationHash(previous.body),
        "invalid-cache",
        "cached response identity is invalid",
      );
      requireFact(
        Buffer.byteLength(JSON.stringify(previous.body)) <= config.budget.response_bytes,
        "invalid-cache",
        "cached response exceeds the byte budget",
      );
    }
    for (let attempt = 0; ; attempt++) {
      const remaining = config.budget.duration_ms - (now() - started);
      requireFact(
        remaining > 0 && consumed.requests < config.budget.requests,
        "budget",
        "observation request or time budget exhausted",
      );
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Portcove-upstream-observer",
      };
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      if (previous?.etag) headers["If-None-Match"] = previous.etag;
      consumed.requests++;
      let response;
      try {
        response = await fetcher(url, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(15_000, remaining)),
        });
      } catch {
        if (attempt >= config.budget.retries)
          throw new ObservationFailure(
            "transport",
            "provider transport failed within its retry budget",
          );
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has("retry-after") ||
            response.headers.get("x-ratelimit-remaining") === "0"))
      ) {
        const retry = response.headers.get("retry-after");
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
        const retryTime =
          retry && /^\d+$/.test(retry) ? now() + Number(retry) * 1000 : Date.parse(retry ?? "");
        const resume = Math.max(
          now() + 60_000,
          Number.isFinite(retryTime) ? retryTime : 0,
          Number.isFinite(reset) ? reset : 0,
        );
        await response.body?.cancel();
        requireFact(
          Number.isFinite(resume) && resume <= 8.64e15,
          "invalid-metadata",
          "provider retry clock is invalid",
        );
        throw new ObservationFailure(
          "rate-limit",
          "provider rate limit defers observation without advancing the last complete snapshot",
          new Date(resume).toISOString(),
        );
      }
      if (response.status >= 500 && attempt < config.budget.retries) {
        await response.body?.cancel();
        await sleep(250 * 2 ** attempt);
        continue;
      }
      if (response.status === 304) {
        requireFact(
          previous?.etag,
          "invalid-cache",
          "provider returned 304 without a validated conditional response",
        );
        consumed.conditional_hits++;
        return { url, value: previous };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new ObservationFailure(
          "provider-status",
          `provider returned HTTP ${response.status}`,
        );
      }
      if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
        await response.body?.cancel();
        throw new ObservationFailure("invalid-metadata", "provider response is not JSON");
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        consumed.response_bytes += chunk.length;
        requireFact(
          bytes <= config.budget.response_bytes &&
            consumed.response_bytes <= config.budget.total_bytes,
          "budget",
          "provider response byte budget exhausted",
        );
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        throw new ObservationFailure("invalid-metadata", "provider returned malformed UTF-8 JSON");
      }
      return {
        url,
        value: {
          etag: response.headers.get("etag") ?? "",
          link: response.headers.get("link") ?? "",
          body,
          sha256: observationHash(body),
        },
      };
    }
  }

  async function read(pathname, page, normalize) {
    const result = await request(pathname, page);
    pages[result.url] = result.value;
    requestOrder.push({ pathname, page, normalize, ...result });
    return result.value;
  }

  async function collection(pathname, normalizeItem) {
    const all = [];
    const ids = new Set();
    for (let page = 1; ; page++) {
      requireFact(
        page <= config.budget.pages_per_collection,
        "budget",
        "collection exceeded the complete-pagination budget",
      );
      const response = await read(pathname, page, (body) => {
        requireFact(
          Array.isArray(body) && body.length <= 100,
          "invalid-metadata",
          "collection page must contain at most 100 objects",
        );
        return body.map(normalizeItem);
      });
      requireFact(
        Array.isArray(response.body) && response.body.length <= 100,
        "invalid-metadata",
        "collection page must contain at most 100 objects",
      );
      for (const item of response.body) {
        const id = identity(item?.id, "collection item");
        requireFact(!ids.has(id), "pagination", "collection repeated an identity across pages");
        ids.add(id);
        all.push(item);
      }
      if (!nextPage(response.link, pathname, page, config)) return all;
      requireFact(response.body.length === 100, "pagination", "nonterminal page is incomplete");
    }
  }

  const repositoryPath = `/repos/${config.repository}`;
  const repository = repositoryFact(
    (await read(repositoryPath, null, (value) => repositoryFact(value, config))).body,
    config,
  );
  const releases = [];
  const assetIds = new Set();
  for (const raw of await collection(`${repositoryPath}/releases`, releaseFact)) {
    const release = releaseFact(raw);
    const normalizeAsset = (asset) => assetFact(asset, config, release.tag_name);
    release.assets = (
      await collection(`${repositoryPath}/releases/${release.id}/assets`, normalizeAsset)
    ).map(normalizeAsset);
    for (const asset of release.assets) {
      requireFact(
        !assetIds.has(asset.id),
        "invalid-metadata",
        "asset identity appears in multiple releases",
      );
      assetIds.add(asset.id);
    }
    releases.push(release);
  }
  // GitHub provides no atomic repository snapshot. Revalidate every consumed
  // page and preserve the observation interval; any detected change aborts.
  for (const entry of requestOrder) {
    const current = await request(entry.pathname, entry.page, entry.value);
    requireFact(
      observationHash(entry.normalize(current.value.body)) ===
        observationHash(entry.normalize(entry.value.body)) &&
        current.value.link === entry.value.link,
      "concurrent-change",
      `provider collection changed during observation: ${entry.pathname}`,
    );
    pages[entry.url] = current.value;
  }
  const completed = now();
  requireFact(
    completed >= started && completed - started <= config.budget.duration_ms,
    "clock-or-budget",
    "observation clock moved backwards or exceeded its deadline",
  );
  const facts = { repository, releases };
  return {
    observation: {
      format: 1,
      config_sha256: configHash,
      port_id: config.port_id,
      started_at: new Date(started).toISOString(),
      completed_at: new Date(completed).toISOString(),
      facts_sha256: observationHash(facts),
      facts,
      consumed,
      authority: "provider-observation-only",
    },
    cache: { format: 1, config_sha256: configHash, pages },
  };
}
