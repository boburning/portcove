import { createHash } from "node:crypto";
import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";
import { isSafeSitePath, readComposedSite } from "./release-site-composer.mts";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitHubApiClient, GitHubApiError, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";

const origin = "https://boburning.github.io/portcove/";
const maximumFiles = 6000;
const maximumBytes = 256 * 1024 * 1024;
const maximumFileBytes = 64 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

type PublishedPins = {
  site_generation_sha256: string;
  root_sha256: string;
  repository_sha256: string;
};
const completeSiteCustody = new WeakMap<
  object,
  {
    directory: string;
    rootPath: string;
    markerSha256: string;
    pins: PublishedPins;
  }
>();

/** Retrieve only bytes acquired in this process from the fixed public origin.
 * This custody does not authenticate TUF, appoint a root or grant deployment.
 * Every use rechecks the complete tree, including the untouched catalog. */
export async function requirePublishedCompleteSite(receipt: unknown) {
  const retained =
    typeof receipt === "object" && receipt !== null ? completeSiteCustody.get(receipt) : undefined;
  if (!retained) throw new Error("actual complete public site custody required");
  const { files, generation } = await readComposedSite(
    retained.directory,
    retained.pins.site_generation_sha256,
    retained.pins.root_sha256,
  );
  const application = generation.files
    .filter((file) => file.path.startsWith("application/"))
    .map((file) => ({ ...file, path: file.path.slice(12) }));
  if (
    hash(files.get("publication.json") ?? Buffer.alloc(0)) !== retained.markerSha256 ||
    capacityDigest(application) !== retained.pins.repository_sha256 ||
    hash(
      files.get(path.relative(retained.directory, retained.rootPath).replaceAll("\\", "/")) ??
        Buffer.alloc(0),
    ) !== retained.pins.root_sha256
  )
    throw new Error("retained public application bytes changed");
  return {
    directory: retained.directory,
    application: path.join(retained.directory, "application"),
    root_path: retained.rootPath,
    generation,
    pins: structuredClone(retained.pins),
  };
}

/** Recover the whole journal-pinned site for fresh signing/composition workers.
 * The application still requires the pinned Tough verifier before signing.
 * Catalog bytes are preserved as opaque, independently owned content. */
export async function materializePublishedCompleteSite(raw: PublishedPins, privateParent: string) {
  const expected = structuredClone(raw);
  if (
    !isRecord(expected) ||
    Object.keys(expected).sort().join(",") !==
      "repository_sha256,root_sha256,site_generation_sha256" ||
    !Object.values(expected).every(digest)
  )
    throw new Error("independent complete site identities required");
  if (!path.isAbsolute(privateParent)) throw new Error("private site parent required");
  const parent = await lstat(privateParent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(privateParent)) !== path.resolve(privateParent)
  )
    throw new Error("private site parent is linked or unavailable");
  const retained = await mkdtemp(path.join(privateParent, "published-site-"));
  const directory = path.join(retained, "site");
  await mkdir(directory, { mode: 0o700 });
  try {
    const read = publicReader(performance.now() + 120_000);
    const first = await read("publication.json", 4 * 1024 * 1024);
    const observed = marker(JSON.parse(first.toString("utf8")), expected.site_generation_sha256);
    if (observed.application_root_sha256 !== expected.root_sha256)
      throw new Error("complete site root differs from independently pinned root");
    const application = observed.files
      .filter((file) => file.path.startsWith("application/"))
      .map((file) => ({ ...file, path: file.path.slice(12) }));
    const roots = application.filter(
      (file) =>
        /^metadata\/[1-9][0-9]*\.root\.json$/u.test(file.path) &&
        file.sha256 === expected.root_sha256,
    );
    if (roots.length !== 1 || capacityDigest(application) !== expected.repository_sha256)
      throw new Error("complete site's application inventory differs from journal");
    const directories = new Set<string>();
    for (const file of observed.files) {
      const segments = file.path.split("/");
      for (let count = 1; count < segments.length; count++)
        directories.add(segments.slice(0, count).join("/"));
    }
    // Match the existing composer's entry/byte limits, including its marker.
    if (
      observed.files.length + 1 > maximumFiles ||
      observed.files.length + directories.size + 1 > maximumFiles + 128 ||
      observed.files.some((file) => directories.has(file.path)) ||
      observed.files.reduce((total, file) => total + file.bytes, first.length) > maximumBytes
    )
      throw new Error("complete site exceeds composer bounds or aliases a directory");
    for (const file of observed.files) {
      const bytes = await read(file.path, file.bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error(`complete public site bytes differ: ${file.path}`);
      const filename = path.join(directory, file.path);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
    }
    const last = await read("publication.json", 4 * 1024 * 1024);
    if (!first.equals(last))
      throw new Error("public generation changed during complete acquisition");
    await writeFile(path.join(directory, "publication.json"), first, { flag: "wx", mode: 0o600 });
    const receipt = {
      schema_version: 1,
      ...expected,
      marker_sha256: hash(first),
      authority: "none",
      scope: "complete journal-pinned public bytes; TUF verification still required",
    };
    await writeFile(path.join(retained, "readback.json"), JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
    completeSiteCustody.set(receipt, {
      directory,
      pins: expected,
      rootPath: path.join(directory, "application", roots[0]!.path),
      markerSha256: hash(first),
    });
    return { receipt, ...(await requirePublishedCompleteSite(receipt)) };
  } catch (error) {
    await writeFile(
      path.join(retained, "refusal.json"),
      JSON.stringify({ ...expected, completed: false, authority: "none", automatic_retry: false }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`complete site materialization refused; retain ${retained}`, { cause: error });
  }
}

/** One-time setup preimage, not routine admission or publication authority.
 * A marker 404 alone cannot prove absence: require the actual owner with full
 * repository visibility, no configured project site or user-site repository,
 * and bracket those facts around credential-free probes of the fixed routes.
 * Existing sites require their real preserved inventory, never this path. */
export async function observeInitialApplicationSite(
  privateParent: string,
  options: { api?: GitHubRestReader; fetch?: typeof fetch } = {},
) {
  const apiOverride = options.api,
    fetchOverride = options.fetch;
  const injected = apiOverride !== undefined || fetchOverride !== undefined;
  if (!path.isAbsolute(privateParent)) throw new Error("private setup parent required");
  const parent = await lstat(privateParent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(privateParent)) !== path.resolve(privateParent)
  )
    throw new Error("private setup parent is linked or unavailable");
  const directory = await mkdtemp(path.join(privateParent, "initial-site-readback-"));
  const deadline = performance.now() + 60_000;
  const runner = createGitHubRunner({ cwd: directory, timeoutMs: 5000, maxBuffer: 128 * 1024 });
  const api =
    apiOverride ??
    new GitHubApiClient((args, input) => runner([...args, "--hostname", "github.com"], input));
  const observations: unknown[] = [];
  const withinBudget = () => {
    if (performance.now() >= deadline) throw new Error("initial site observation deadline expired");
  };
  const get = (endpoint: string) => {
    withinBudget();
    try {
      const response = api.request("GET", endpoint);
      withinBudget();
      return response;
    } catch (error) {
      // Collected 404 only; timeout discards even a partly received response.
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      withinBudget();
      return { status: 404, body: null, headers: new Map<string, string>() };
    }
  };
  const provider = () => {
    const viewer = get("user");
    const repo = get("repos/boburning/portcove");
    const scopes = repo.headers
      .get("x-oauth-scopes")
      ?.split(",")
      .map((value) => value.trim());
    if (
      viewer.status !== 200 ||
      !isRecord(viewer.body) ||
      viewer.body.id !== 43177418 ||
      viewer.body.login !== "boburning" ||
      repo.status !== 200 ||
      !isRecord(repo.body) ||
      repo.body.id !== 1354613114 ||
      repo.body.full_name !== "boburning/portcove" ||
      repo.body.private !== false ||
      !isRecord(repo.body.owner) ||
      repo.body.owner.id !== 43177418 ||
      !isRecord(repo.body.permissions) ||
      repo.body.permissions.admin !== true ||
      !scopes?.includes("repo")
    )
      throw new Error("initial absence requires actual owner and full repository visibility");
    const projectSite = get("repos/boburning/portcove/pages");
    const userSite = get("repos/boburning/boburning.github.io");
    if (projectSite.status !== 404 || userSite.status !== 404)
      throw new Error("existing or unavailable Pages origin requires preserved site inventory");
    return {
      owner_id: 43177418,
      repository_id: 1354613114,
      owner_repository_visibility: "repo-scope-with-admin-readback",
      project_site_status: 404,
      user_site_repository_status: 404,
    };
  };
  try {
    const before = provider();
    observations.push({ phase: "provider-before", ...before });
    for (const route of [
      "",
      "publication.json",
      "application/metadata/timestamp.json",
      "catalog/metadata/timestamp.json",
    ]) {
      withinBudget();
      const url = new URL(route, origin).href;
      const response = await (fetchOverride ?? fetch)(url, {
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: { Accept: "application/octet-stream", "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(
          Math.max(1, Math.floor(Math.min(5000, deadline - performance.now()))),
        ),
      });
      await response.body?.cancel();
      observations.push({ phase: "public-route", url, status: response.status });
      if (response.url !== url || response.status !== 404)
        throw new Error("initial fixed public route is present, redirected or unavailable");
    }
    const after = provider();
    observations.push({ phase: "provider-after", ...after });
    if (capacityDigest(before) !== capacityDigest(after))
      throw new Error("initial site provider state changed during observation");
    const receipt = {
      schema_version: 1,
      kind: "unconfigured-application-site-preimage",
      observed_at: new Date().toISOString(),
      origin,
      observations,
      evidence_scope: injected ? "injected-provider" : "github.com",
      authority: "none",
      scope:
        "initial setup preimage only; no unlisted URL, historical absence or publication claim",
    };
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    await writeFile(path.join(directory, "initial-site.json"), bytes, { flag: "wx", mode: 0o600 });
    return { directory, receipt, sha256: hash(bytes) };
  } catch (error) {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ observations, authority: "none", automatic_retry: false }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`initial site observation refused; retain ${directory}`, { cause: error });
  }
}

function marker(value: unknown, expected: string) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "application_root_sha256,files,generation,previous_generation,schema_version" ||
    value.schema_version !== 1 ||
    value.generation !== expected ||
    !digest(value.application_root_sha256) ||
    !(value.previous_generation === null || digest(value.previous_generation)) ||
    !Array.isArray(value.files) ||
    value.files.length > maximumFiles
  )
    throw new Error("public site generation schema differs");
  const seen = new Set<string>();
  let total = 0;
  const files = value.files.map((file: unknown) => {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,path,sha256" ||
      typeof file.path !== "string" ||
      file.path.length > 512 ||
      !/^(?:\.nojekyll|(?:application\/(?:metadata|targets)|catalog)\/)/u.test(file.path) ||
      !isSafeSitePath(file.path) ||
      seen.has(file.path) ||
      !digest(file.sha256) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > maximumFileBytes
    )
      throw new Error("public site inventory differs");
    seen.add(file.path);
    total += file.bytes;
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
  if (
    total > maximumBytes ||
    !seen.has("application/metadata/timestamp.json") ||
    !seen.has(".nojekyll") ||
    JSON.stringify(files.map((file) => file.path)) !== JSON.stringify([...seen].sort())
  )
    throw new Error("public site inventory bound/order differs");
  const unsigned = {
    schema_version: 1,
    previous_generation: value.previous_generation,
    application_root_sha256: value.application_root_sha256,
    files,
  };
  if (capacityDigest(unsigned) !== expected)
    throw new Error("public site inventory digest differs");
  return { ...unsigned, generation: expected };
}

function publicReader(deadline: number) {
  let consumed = 0;
  return async (name: string, limit: number) => {
    const timeout = Math.floor(Math.min(30_000, deadline - performance.now()));
    if (timeout <= 0) throw new Error("public site readback deadline exceeded");
    const url = new URL(name, origin).href;
    const response = await fetch(url, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/octet-stream", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status !== 200 || response.url !== url || !response.body) {
      await response.body?.cancel();
      throw new Error(`public site response unavailable: ${name}`);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
      await response.body.cancel();
      throw new Error(`public site declared length exceeds bound: ${name}`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const bytes: unknown = item.value;
        if (!(bytes instanceof Uint8Array)) throw new Error("public site stream is not bytes");
        size += bytes.length;
        consumed += bytes.length;
        if (size > limit || consumed > maximumBytes + 8 * 1024 * 1024)
          throw new Error(`public site streamed bytes exceed bound: ${name}`);
        chunks.push(bytes);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  };
}

/** Independent credential-free HTTP readback of the exact already-authenticated
 * complete site. The expected marker must come from actual trusted composition,
 * never from the server being checked. This does not enumerate unlisted URLs,
 * authenticate a deployment actor or grant publication/settlement authority. */
export async function readPublicApplicationSite(expectedMarker: unknown) {
  if (!isRecord(expectedMarker) || !digest(expectedMarker.generation))
    throw new Error("independently expected site generation unavailable");
  const expected = marker(expectedMarker, expectedMarker.generation);
  const deadline = performance.now() + 120_000;
  const observations: { path: string; bytes: number; sha256: string }[] = [];
  const read = publicReader(deadline);
  const first = await read("publication.json", 4 * 1024 * 1024);
  const observed: unknown = JSON.parse(first.toString("utf8"));
  if (JSON.stringify(marker(observed, expected.generation)) !== JSON.stringify(expected))
    throw new Error("public marker differs from trusted expected site");
  for (const file of expected.files) {
    const bytes = await read(file.path, file.bytes);
    const actual = { path: file.path, bytes: bytes.length, sha256: hash(bytes) };
    observations.push(actual);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error(`public site bytes differ: ${file.path}`);
  }
  const last = await read("publication.json", 4 * 1024 * 1024);
  if (!first.equals(last)) throw new Error("public generation changed during readback");
  return {
    authority: "none",
    origin,
    generation: expected.generation,
    application_root_sha256: expected.application_root_sha256,
    marker_sha256: hash(first),
    files: observations,
    evidence_sha256: capacityDigest({ generation: expected.generation, files: observations }),
    scope: "exact expected public bytes; no unlisted-path or deployment-actor claim",
  };
}

/** Lightweight late bracket over a previously independently verified complete
 * generation. Marker equality is not a substitute for that prior byte readback. */
export async function readPublicApplicationSiteMarker(expectedMarker: unknown) {
  if (!isRecord(expectedMarker) || !digest(expectedMarker.generation))
    throw new Error("independently expected site generation unavailable");
  const expected = marker(expectedMarker, expectedMarker.generation);
  const bytes = await publicReader(performance.now() + 30_000)("publication.json", 4 * 1024 * 1024);
  const observed: unknown = JSON.parse(bytes.toString("utf8"));
  if (JSON.stringify(marker(observed, expected.generation)) !== JSON.stringify(expected))
    throw new Error("public marker differs from trusted expected site");
  return {
    generation: expected.generation,
    marker_sha256: hash(bytes),
    authority: "none",
    scope: "expected generation marker only",
  };
}

/** Reconstruct only the journal-pinned public application component for a fresh
 * renewal worker. Downloaded bytes confer no root, signer or execution authority;
 * the existing renewal adapter must still run its independently pinned verifier. */
export async function materializePublishedApplicationComponent(
  raw: {
    site_generation_sha256: string;
    root_sha256: string;
    repository_sha256: string;
  },
  privateParent: string,
) {
  const expected = structuredClone(raw);
  if (
    !isRecord(expected) ||
    Object.keys(expected).sort().join(",") !==
      "repository_sha256,root_sha256,site_generation_sha256" ||
    !digest(expected.site_generation_sha256) ||
    !digest(expected.root_sha256) ||
    !digest(expected.repository_sha256)
  )
    throw new Error("independent published component identities required");
  if (!path.isAbsolute(privateParent)) throw new Error("private component parent required");
  const parent = await lstat(privateParent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(privateParent)) !== path.resolve(privateParent)
  )
    throw new Error("private component parent is linked or unavailable");
  const retained = await mkdtemp(path.join(privateParent, "published-component-"));
  const directory = path.join(retained, "repository");
  await mkdir(directory, { mode: 0o700 });
  try {
    const read = publicReader(performance.now() + 120_000);
    const first = await read("publication.json", 4 * 1024 * 1024);
    const observed = marker(JSON.parse(first.toString("utf8")), expected.site_generation_sha256);
    if (observed.application_root_sha256 !== expected.root_sha256)
      throw new Error("public component root differs from ratified root");
    const files = observed.files
      .filter((file) => file.path.startsWith("application/"))
      .map((file) => ({ ...file, path: file.path.slice("application/".length) }));
    const directories = new Set<string>();
    for (const file of files) {
      const segments = file.path.split("/");
      for (let count = 1; count < segments.length; count++)
        directories.add(segments.slice(0, count).join("/"));
    }
    if (
      files.length > 1100 ||
      files.length + directories.size > 4096 ||
      files.some((file) => directories.has(file.path)) ||
      files.some((file) => file.bytes > 1024 * 1024) ||
      files.reduce((total, file) => total + file.bytes, 0) > 64 * 1024 * 1024 ||
      capacityDigest(files) !== expected.repository_sha256
    )
      throw new Error("public component inventory differs or exceeds renewal bounds");
    const roots = files.filter(
      (file) =>
        /^metadata\/[1-9][0-9]*\.root\.json$/u.test(file.path) &&
        file.sha256 === expected.root_sha256,
    );
    if (roots.length !== 1) throw new Error("exact independently pinned public root unavailable");
    for (const file of files) {
      const bytes = await read(`application/${file.path}`, file.bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error(`public component bytes differ: ${file.path}`);
      const filename = path.join(directory, file.path);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
    }
    const last = await read("publication.json", 4 * 1024 * 1024);
    if (!first.equals(last)) throw new Error("public generation changed during materialization");
    const receipt = {
      schema_version: 1,
      ...expected,
      marker_sha256: hash(first),
      files,
      authority: "none",
      scope: "journal-pinned public application bytes only; verifier still required",
    };
    await writeFile(path.join(retained, "readback.json"), JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
    return { directory, root_path: path.join(directory, roots[0]!.path), receipt };
  } catch (error) {
    await writeFile(
      path.join(retained, "refusal.json"),
      JSON.stringify({
        schema_version: 1,
        ...expected,
        authority: "none",
        completed: false,
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`public component materialization refused; retain ${retained}`, {
      cause: error,
    });
  }
}
