import {
  inspectSiteGeneration,
  isRetainedApplicationRehearsalPath,
} from "./release-site-generation.mts";
import { createHash } from "node:crypto";
import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import { performance } from "node:perf_hooks";
import { readComposedSite, readComposedCatalogSite } from "./release-site-composer.mts";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitHubApiClient, GitHubApiError, createGitHubRunner } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";

const origin = "https://boburning.github.io/portcove/";
const maximumFiles = 6000;
const maximumBytes = 256 * 1024 * 1024;
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
    component: "application" | "catalog";
    directory: string;
    rootPath: string;
    markerSha256: string;
    pins: PublishedPins;
  }
>();

/** Retrieve only bytes acquired in this process from the fixed public origin.
 * This custody does not authenticate TUF, appoint a root or grant deployment.
 * Every use rechecks the complete tree, including the untouched catalog. */
async function requireCompleteSite(receipt: unknown, component: "application" | "catalog") {
  const retained =
    typeof receipt === "object" && receipt !== null ? completeSiteCustody.get(receipt) : undefined;
  if (!retained || retained.component !== component)
    throw new Error("actual complete matching component public site custody required");
  const { files, generation } = await (
    component === "application" ? readComposedSite : readComposedCatalogSite
  )(retained.directory, retained.pins.site_generation_sha256, retained.pins.root_sha256);
  const application = generation.files
    .filter((file) => file.path.startsWith(`${component}/`))
    .map((file) => ({ ...file, path: file.path.slice(component.length + 1) }));
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
    component_directory: path.join(retained.directory, component),
    root_path: retained.rootPath,
    generation,
    pins: structuredClone(retained.pins),
  };
}

export async function requirePublishedCompleteSite(receipt: unknown) {
  const { component_directory, ...observed } = await requireCompleteSite(receipt, "application");
  return { ...observed, application: component_directory };
}
export async function requirePublishedCatalogCompleteSite(receipt: unknown) {
  const { component_directory, ...observed } = await requireCompleteSite(receipt, "catalog");
  return { ...observed, catalog: component_directory };
}

/** Recover the whole journal-pinned site for fresh signing/composition workers.
 * The application still requires the pinned Tough verifier before signing.
 * Catalog bytes are preserved as opaque, independently owned content. */
async function materializeCompleteSite(
  component: "application" | "catalog",
  raw: PublishedPins,
  privateParent: string,
  phaseDeadline?: number,
) {
  const expected = structuredClone(raw);
  if (
    phaseDeadline !== undefined &&
    (!Number.isFinite(phaseDeadline) || phaseDeadline <= performance.now())
  )
    throw new Error("complete site phase deadline exhausted");
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
    const read = publicReader(Math.min(performance.now() + 120_000, phaseDeadline ?? Infinity));
    const first = await read("publication.json", 4 * 1024 * 1024);
    const observed = marker(JSON.parse(first.toString("utf8")), expected.site_generation_sha256);
    if (
      (component === "application"
        ? observed.application_root_sha256
        : observed.schema_version === 2
          ? observed.catalog_root_sha256
          : null) !== expected.root_sha256
    )
      throw new Error("complete site root differs from independently pinned root");
    const application = observed.files
      .filter((file) => file.path.startsWith(`${component}/`))
      .map((file) => ({ ...file, path: file.path.slice(component.length + 1) }));
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
    if (phaseDeadline !== undefined && performance.now() >= phaseDeadline)
      throw new Error("complete site phase deadline exhausted before custody");
    completeSiteCustody.set(receipt, {
      component,
      directory,
      pins: expected,
      rootPath: path.join(directory, component, roots[0]!.path),
      markerSha256: hash(first),
    });
    return { receipt, ...(await requireCompleteSite(receipt, component)) };
  } catch (error) {
    await writeFile(
      path.join(retained, "refusal.json"),
      JSON.stringify({ ...expected, completed: false, authority: "none", automatic_retry: false }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`complete site materialization refused; retain ${retained}`, { cause: error });
  }
}

export async function materializePublishedCompleteSite(
  raw: PublishedPins,
  parent: string,
  deadline?: number,
) {
  const { component_directory, ...observed } = await materializeCompleteSite(
    "application",
    raw,
    parent,
    deadline,
  );
  return { ...observed, application: component_directory };
}
export async function materializePublishedCatalogCompleteSite(
  raw: PublishedPins,
  parent: string,
  deadline?: number,
) {
  const { component_directory, ...observed } = await materializeCompleteSite(
    "catalog",
    raw,
    parent,
    deadline,
  );
  return { ...observed, catalog: component_directory };
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
  try {
    return inspectSiteGeneration(value, expected);
  } catch (cause) {
    throw new Error("public site generation differs", { cause });
  }
}

function publicReader(deadline: number, fetcher: typeof fetch = fetch) {
  let consumed = 0;
  return async (name: string, limit: number) => {
    const timeout = Math.floor(Math.min(30_000, deadline - performance.now()));
    if (timeout <= 0) throw new Error("public site readback deadline exceeded");
    const url = new URL(name, origin).href;
    const response = await fetcher(url, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/octet-stream", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(timeout),
    });
    if (performance.now() >= deadline) {
      await response.body?.cancel();
      throw new Error("public site readback deadline exceeded after response");
    }
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
        if (performance.now() >= deadline)
          throw new Error("public site readback deadline exceeded during stream");
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

/** Retain an independently appointed exact publisher inventory before the first
 * production marker exists. The caller must establish the descriptor from the
 * reviewed publisher artifact; three absent URLs cannot establish an inventory.
 * This GET-only reader grants neither Root trust nor publication authority. */
export async function materializeInitialApplicationRehearsal(
  raw: unknown,
  expectedDescriptorSha256: string,
  privateParent: string,
  options: { api?: GitHubRestReader; fetch?: typeof fetch } = {},
) {
  if (
    !digest(expectedDescriptorSha256) ||
    capacityDigest(raw) !== expectedDescriptorSha256 ||
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !== "files,inventory_sha256,kind,provider,schema_version" ||
    raw.schema_version !== 1 ||
    raw.kind !== "retained-application-rehearsal-preimage" ||
    !digest(raw.inventory_sha256) ||
    !isRecord(raw.provider) ||
    !Array.isArray(raw.files) ||
    raw.files.length < 2 ||
    raw.files.length > 64 ||
    capacityDigest(raw.files) !== raw.inventory_sha256
  )
    throw new Error("independently appointed initial rehearsal descriptor required");
  const identities: { path: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  for (const file of raw.files) {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,path,sha256" ||
      typeof file.path !== "string" ||
      !(file.path === ".nojekyll" || isRetainedApplicationRehearsalPath(file.path)) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < (file.path === ".nojekyll" ? 0 : 1) ||
      file.bytes > 2 * 1024 ** 2 ||
      !digest(file.sha256)
    )
      throw new Error("bounded initial rehearsal file inventory required");
    total += file.bytes;
    identities.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
  }
  const names = identities.map((file) => file.path);
  if (
    total > 4 * 1024 ** 2 ||
    !names.includes(".nojekyll") ||
    new Set(names).size !== names.length ||
    JSON.stringify(names) !== JSON.stringify([...names].sort())
  )
    throw new Error("initial rehearsal inventory count/order/size differs");
  if (!path.isAbsolute(privateParent)) throw new Error("absolute initial site parent required");
  const parent = await lstat(privateParent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(privateParent)) !== privateParent
  )
    throw new Error("initial site parent is linked or unavailable");
  const deadline = performance.now() + 120000;
  const api = options.api ?? new GitHubApiClient(createGitHubRunner({ timeoutMs: 30000 }));
  let requests = 0;
  const get = (suffix: string) => {
    if (++requests > 7 || performance.now() >= deadline)
      throw new Error("initial rehearsal provider observation bound exhausted");
    const response = api.request("GET", `repos/boburning/portcove${suffix}`);
    if (
      response.status !== 200 ||
      performance.now() >= deadline ||
      Buffer.byteLength(JSON.stringify(response.body)) > 65536
    )
      throw new Error("initial rehearsal provider observation unavailable");
    return response.body;
  };
  const repository = get("");
  if (
    !isRecord(repository) ||
    repository.id !== 1354613114 ||
    repository.full_name !== "boburning/portcove"
  )
    throw new Error("initial rehearsal repository differs");
  const provider = () => {
    const pages = get("/pages");
    const deployments = get("/deployments?environment=github-pages&per_page=1");
    if (
      !isRecord(pages) ||
      pages.html_url !== origin ||
      pages.build_type !== "workflow" ||
      pages.cname !== null ||
      pages.https_enforced !== true ||
      !Array.isArray(deployments) ||
      deployments.length !== 1
    )
      throw new Error("initial rehearsal Pages provider unavailable");
    const deployment: unknown = deployments[0];
    if (
      !isRecord(deployment) ||
      typeof deployment.id !== "number" ||
      !Number.isSafeInteger(deployment.id) ||
      deployment.id < 1
    )
      throw new Error("initial rehearsal deployment unavailable");
    const statuses = get(`/deployments/${deployment.id}/statuses?per_page=1`);
    const status: unknown = Array.isArray(statuses) && statuses.length === 1 ? statuses[0] : null;
    if (!isRecord(status) || status.state !== "success")
      throw new Error("initial rehearsal latest deployment has not succeeded");
    const observed = {
      deployment_id: deployment.id,
      source_commit: deployment.sha,
      ref: deployment.ref,
      environment: deployment.environment,
      status_id: status.id,
      log_url: status.log_url,
      pages: {
        html_url: pages.html_url,
        build_type: pages.build_type,
        cname: pages.cname,
        https_enforced: pages.https_enforced,
      },
    };
    if (capacityDigest(observed) !== capacityDigest(raw.provider))
      throw new Error("initial rehearsal Pages preimage changed");
  };
  provider();
  const read = publicReader(deadline, options.fetch);
  const files = new Map<string, Buffer>();
  for (const file of identities) {
    const bytes = await read(file.path, file.bytes);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("initial rehearsal public bytes differ");
    files.set(file.path, bytes);
  }
  for (const name of [
    "publication.json",
    "application/metadata/timestamp.json",
    "catalog/metadata/timestamp.json",
  ]) {
    const url = new URL(name, origin).href;
    const remaining = Math.floor(Math.min(30000, deadline - performance.now()));
    if (remaining <= 0) throw new Error("initial rehearsal readback deadline exhausted");
    const response = await (options.fetch ?? fetch)(url, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(remaining),
    });
    await response.body?.cancel();
    if (response.status !== 404 || response.url !== url || performance.now() >= deadline)
      throw new Error("initial production route is present or unavailable");
  }
  provider();
  const directory = await mkdtemp(path.join(privateParent, "retained-rehearsal-"));
  for (const [name, bytes] of files) {
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  }
  return { directory, inventory_sha256: raw.inventory_sha256, authority: "none" as const };
}

/** Independent credential-free HTTP readback of the exact already-authenticated
 * complete site. The expected marker must come from actual trusted composition,
 * never from the server being checked. This does not enumerate unlisted URLs,
 * authenticate a deployment actor or grant publication/settlement authority. */
export async function readPublicApplicationSite(expectedMarker: unknown, phaseDeadline?: number) {
  if (
    phaseDeadline !== undefined &&
    (!Number.isFinite(phaseDeadline) || phaseDeadline <= performance.now())
  )
    throw new Error("public site phase deadline exhausted");
  if (!isRecord(expectedMarker) || !digest(expectedMarker.generation))
    throw new Error("independently expected site generation unavailable");
  const expected = marker(expectedMarker, expectedMarker.generation);
  const deadline = Math.min(performance.now() + 120_000, phaseDeadline ?? Infinity);
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
export async function readPublicApplicationSiteMarker(
  expectedMarker: unknown,
  phaseDeadline?: number,
) {
  if (
    phaseDeadline !== undefined &&
    (!Number.isFinite(phaseDeadline) || phaseDeadline <= performance.now())
  )
    throw new Error("public marker phase deadline exhausted");
  if (!isRecord(expectedMarker) || !digest(expectedMarker.generation))
    throw new Error("independently expected site generation unavailable");
  const expected = marker(expectedMarker, expectedMarker.generation);
  const bytes = await publicReader(Math.min(performance.now() + 30_000, phaseDeadline ?? Infinity))(
    "publication.json",
    4 * 1024 * 1024,
  );
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
  phaseDeadline?: number,
) {
  if (
    phaseDeadline !== undefined &&
    (!Number.isFinite(phaseDeadline) || phaseDeadline <= performance.now())
  )
    throw new Error("public component phase deadline exhausted");
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
    const read = publicReader(Math.min(performance.now() + 120_000, phaseDeadline ?? Infinity));
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
    if (phaseDeadline !== undefined && performance.now() >= phaseDeadline)
      throw new Error("public component phase deadline exhausted after materialization");
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
