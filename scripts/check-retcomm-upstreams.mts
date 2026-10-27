import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

if (process.argv.length === 3 && process.argv[2] === "--help") {
  console.log(`Check direct PlayStation game upstream identities against RetComM catalog provenance.

Usage: node scripts/check-retcomm-upstreams.mts [--offline | --port-ids=ID,ID]
       node scripts/check-retcomm-upstreams.mts --help

Options:
  --offline          Check all local mappings without network reads; cannot be scoped.
  --port-ids=ID,ID   Limit live catalog reads to unique existing port IDs.
  --help             Show this help without reading the catalog or contacting upstreams.

Environment:
  RETCOMM_CATALOG_DIR  Read a local RetComM catalog instead of GitHub.
  RETCOMM_CATALOG_REF  Remote catalog revision (default: main).

RetComM-Launcher is not used as a release source. These checks do not establish
gameplay observations or qualify independent pinned artifacts.

Example:
  node scripts/check-retcomm-upstreams.mts --offline
`);
  process.exit(0);
}

const catalogPath = new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url);
const mappingPath = new URL("./retcomm-psx-upstreams.json", import.meta.url);
import type {
  DirectReleaseSpec,
  PortDefinition,
} from "../apps/desktop/src/transport-types.generated.d.ts";

// This checker consumes authoring JSON before Rust applies defaults. It does not admit a catalog.
function authoringPort(value: unknown) {
  if (!isRecord(value) || typeof value.id !== "string")
    throw new Error("Invalid catalog port identity");
  const id: PortDefinition["id"] = value.id;
  return {
    id,
    adapter: value.adapter,
    project_url: value.project_url,
    platforms: value.platforms,
    release: isRecord(value.release) ? value.release : {},
  };
}
const rawCatalog: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
if (!isRecord(rawCatalog) || !Array.isArray(rawCatalog.ports))
  throw new Error("Invalid catalog ports");
const rawPorts: unknown[] = rawCatalog.ports;
const catalog = { ports: rawPorts.map(authoringPort) };
const rawMappings: unknown = JSON.parse(await readFile(mappingPath, "utf8"));
if (!isRecord(rawMappings)) throw new Error("Invalid RetComM mappings");
const mappings = Object.fromEntries(
  Object.entries(rawMappings).map(([id, title]) => {
    if (typeof title !== "string") throw new Error(`Invalid RetComM title mapping: ${id}`);
    return [id, title];
  }),
);
const psxPorts = catalog.ports.filter((port) => port.adapter === "psx-recomp-managed");
const failures: string[] = [];
const offline = process.argv.includes("--offline");
const scopeArguments = process.argv.slice(2).filter((arg: string) => arg.startsWith("--port-ids="));
if (
  scopeArguments.length > 1 ||
  process.argv
    .slice(2)
    .some((arg: string) => arg !== "--offline" && !arg.startsWith("--port-ids=")) ||
  (offline && scopeArguments.length)
)
  throw new Error("Invalid RetComM scope; offline validation always covers the complete catalog");
const scopeValue = scopeArguments[0]?.slice("--port-ids=".length);
const selectedIds =
  scopeValue === undefined ? null : scopeValue === "" ? [] : scopeValue.split(",");
if (
  selectedIds &&
  (new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some(
      (id) =>
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || !catalog.ports.some((port) => port.id === id),
    ))
)
  throw new Error("RetComM scope requires unique existing port IDs");

const mappedPortIds = new Set(Object.keys(mappings));
const outsideRetcomm = [];
const retcommRepositories = new Set([
  "technicallycomputers/retcomm-launcher",
  "technicallycomputers/retcomm-catalog",
  ...psxPorts
    .filter((port) => mappedPortIds.has(port.id))
    .map((port) => port.release?.repository)
    .filter((repository) => typeof repository === "string")
    .map((repository: string) => repository.toLowerCase()),
]);

function githubIdentity(value: unknown, asset = false) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").slice(1);
    if (parts.at(-1) === "") parts.pop();
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !parts.slice(0, 2).every((part) => /^[A-Za-z0-9_.-]+$/u.test(part)) ||
      parts.length < 2 ||
      parts.slice(0, 2).some((part) => part === "." || part === ".." || /\.git$/iu.test(part)) ||
      (asset
        ? parts.length !== 6 ||
          parts[2] !== "releases" ||
          parts[3] !== "download" ||
          !parts[4] ||
          !parts[5]
        : parts.length !== 2)
    )
      return null;
    return parts.slice(0, 2).join("/").toLowerCase();
  } catch {
    return null;
  }
}

function independentDirectIdentity(port: ReturnType<typeof authoringPort>) {
  const project = githubIdentity(port.project_url);
  const direct = port.release.direct;
  if (
    !project ||
    typeof port.project_url !== "string" ||
    retcommRepositories.has(project) ||
    port.release.repository !== undefined ||
    !Array.isArray(port.platforms) ||
    port.platforms.length === 0 ||
    new Set(port.platforms).size !== port.platforms.length ||
    !direct ||
    typeof direct !== "object" ||
    Array.isArray(direct) ||
    Object.keys(direct).length !== port.platforms.length
  )
    return null;
  const artifacts = [];
  const platforms: unknown[] = port.platforms;
  const artifactsByPlatform = isRecord(direct) ? direct : {};
  for (const platform of platforms) {
    if (typeof platform !== "string") return null;
    const artifact = artifactsByPlatform[platform];
    if (!isRecord(artifact)) return null;
    const repository = githubIdentity(artifact?.url, true);
    if (
      !repository ||
      typeof artifact.url !== "string" ||
      retcommRepositories.has(repository) ||
      typeof artifact.version !== "string" ||
      !artifact.version.trim() ||
      typeof artifact.size !== "number" ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    )
      return null;
    const checked: Pick<DirectReleaseSpec, "url" | "version" | "size" | "sha256"> = {
      url: artifact.url,
      version: artifact.version,
      size: artifact.size,
      sha256: artifact.sha256,
    };
    artifacts.push({ platform, ...artifact, ...checked });
  }
  return { port_id: port.id, project_url: port.project_url, artifacts };
}

function independentGithubIdentity(port: ReturnType<typeof authoringPort>) {
  const project = githubIdentity(port.project_url);
  const repository = port.release.repository;
  const release =
    typeof repository === "string" ? githubIdentity(`https://github.com/${repository}`) : null;
  if (
    !project ||
    retcommRepositories.has(project) ||
    (port.release.provider ?? "github") !== "github" ||
    typeof repository !== "string" ||
    !release ||
    release !== repository.toLowerCase() ||
    retcommRepositories.has(release) ||
    !Array.isArray(port.platforms) ||
    port.platforms.length === 0 ||
    new Set(port.platforms).size !== port.platforms.length ||
    port.platforms.some((platform: unknown) => typeof platform !== "string") ||
    ["direct", "managed_build", "user_prepared"].some((key) => {
      const value = port.release[key];
      return value !== undefined && (!isRecord(value) || Object.keys(value).length !== 0);
    })
  )
    return null;
  return { port_id: port.id, project_url: port.project_url, repository, provider: "github" };
}
for (const port of psxPorts) {
  if (!mappedPortIds.has(port.id)) {
    if (port.release?.provider === "direct-manifest") {
      const identity = independentDirectIdentity(port);
      if (identity) outsideRetcomm.push(identity);
      else failures.push(`${port.id}: ambiguous independent direct-manifest identity`);
      continue;
    }
    const independent = independentGithubIdentity(port);
    if (independent) {
      outsideRetcomm.push(independent);
      continue;
    }
    failures.push(`${port.id}: missing RetComM title mapping`);
  }
  if ((port.release.provider ?? "github") !== "github") {
    failures.push(`${port.id}: RetComM game upstream must resolve directly through GitHub`);
  }
  if (typeof port.release.repository !== "string" || !port.release.repository.trim()) {
    failures.push(`${port.id}: missing GitHub game repository identity`);
  } else if (port.release.repository.toLowerCase() === "technicallycomputers/retcomm-launcher") {
    failures.push(`${port.id}: points at RetComM-Launcher instead of the game upstream`);
  }
}

for (const portId of mappedPortIds) {
  if (!psxPorts.some((port) => port.id === portId)) {
    failures.push(`${portId}: stale mapping has no psx-recomp-managed catalog entry`);
  }
}

const localCatalogDir = process.env.RETCOMM_CATALOG_DIR;
const ref = process.env.RETCOMM_CATALOG_REF ?? "main";
const rawHeaders = { "User-Agent": "Portcove-RetComM-upstream-audit" };

async function loadRetcommTitle(titleId: string): Promise<unknown> {
  const relativeCandidates = [
    join("titles", "psx", `${titleId}.json`),
    join("titles", `${titleId}.json`),
  ];
  if (localCatalogDir) {
    for (const relative of relativeCandidates) {
      try {
        return JSON.parse(await readFile(join(localCatalogDir, relative), "utf8"));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    throw new Error(`RetComM catalog has no PSX title manifest for ${titleId}`);
  }

  for (const relative of relativeCandidates) {
    const url = `https://raw.githubusercontent.com/TechnicallyComputers/retcomm-catalog/${encodeURIComponent(ref)}/${relative.replaceAll("\\", "/")}`;
    const response = await fetch(url, { headers: rawHeaders, signal: AbortSignal.timeout(15_000) });
    if (response.ok) return response.json();
    if (response.status !== 404) {
      throw new Error(`RetComM catalog returned ${response.status} for ${titleId}`);
    }
  }
  throw new Error(`RetComM catalog returned 404 for ${titleId}`);
}

if (!offline) {
  await Promise.all(
    Object.entries(mappings).map(async ([portId, titleId]) => {
      if (selectedIds !== null && !selectedIds.includes(portId)) return;
      const port = psxPorts.find((candidate) => candidate.id === portId);
      if (!port) return;

      try {
        const title = await loadRetcommTitle(titleId);
        if (!isRecord(title)) throw new Error("Invalid RetComM title manifest");
        const releaseRepository = isRecord(title.release) ? title.release.github : undefined;
        const source = isRecord(title.build) ? title.build.source : undefined;
        const buildRepository = isRecord(source) ? source.github : undefined;
        if (!releaseRepository) {
          failures.push(`${titleId}: RetComM entry has no GitHub game release repository`);
          return;
        }
        if (
          typeof releaseRepository !== "string" ||
          (buildRepository && typeof buildRepository !== "string")
        )
          throw new Error("Invalid RetComM GitHub repository identity");
        if (
          typeof buildRepository === "string" &&
          buildRepository &&
          buildRepository !== releaseRepository
        ) {
          failures.push(
            `${titleId}: RetComM release (${releaseRepository}) and build (${buildRepository}) repositories differ`,
          );
        }
        if (port.release.repository !== releaseRepository) {
          failures.push(
            `${portId}: Portcove uses ${String(port.release.repository)}, RetComM uses ${releaseRepository}`,
          );
        }
      } catch (error) {
        failures.push(`${portId}: ${errorMessage(error)}`);
      }
    }),
  );
}

for (const identity of outsideRetcomm) {
  if (selectedIds !== null && !selectedIds.includes(identity.port_id)) continue;
  console.log(
    `RetComM audit NOT_APPLICABLE: ${JSON.stringify(identity)}; independent release rules or pinned artifacts, upstream health NOT_CHECKED. Catalog identity and exact-artifact acceptance own this route; this audit performs neither.`,
  );
}

if (failures.length) {
  console.error(failures.sort().join("\n"));
  process.exit(1);
}

if (offline) {
  const count = psxPorts.length - outsideRetcomm.length;
  console.log(
    `Checked ${count} local PlayStation upstream mapping${count === 1 ? "" : "s"}. Live upstream checks were not run. RetComM-Launcher is not used as a release source.`,
  );
} else {
  const source = localCatalogDir ? localCatalogDir : `TechnicallyComputers/retcomm-catalog@${ref}`;
  const checkedPorts = psxPorts.filter(
    (port) => mappedPortIds.has(port.id) && (selectedIds === null || selectedIds.includes(port.id)),
  );
  const repositories = new Set(checkedPorts.map((port) => port.release.repository)).size;
  console.log(
    `Checked ${repositories} direct PlayStation upstream repositor${repositories === 1 ? "y" : "ies"} for ${checkedPorts.length} mapped port${checkedPorts.length === 1 ? "" : "s"} against ${source}. RetComM-Launcher is not used as a release source.${selectedIds === null ? "" : " Unselected live identities remain unassessed."}`,
  );
}
