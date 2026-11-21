import { createHash } from "node:crypto";
import reviewedGuidance from "../crates/portcove-core/catalog/v64recomp-source-guidance.json" with { type: "json" };
import { createGitHubClient } from "./github-client.mts";
import { isRecord } from "./runtime-values.mts";

export const v64recompRepository = "polaco1782/v64recomp";
export const v64recompRepositoryId = 1420121199;
export const v64recompProfileId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const v64recompGitId = /^[a-f0-9]{40}$/u;
const repository = `/repos/${v64recompRepository}`;
const branch = "master";
const profileSource = (profile: string) => `games/${profile}/profile.toml`;
const maximumFileBytes = 256 * 1024;
const maximumProfiles = 24;
export const v64recompCurrentLayout = "rt64-release-msvc-deck";
export const v64recompLegacyLayout = "cmake-release-msvc-deck";
export type V64recompLayout = typeof v64recompCurrentLayout | typeof v64recompLegacyLayout;
const presetSource = "CMakePresets.json";
const reviewedTools: Record<
  V64recompLayout,
  { revision: string; tree: string; files: Record<string, string>; preset_sha256: string }
> = reviewedGuidance.tool_layouts;
const toolPaths = new Set(Object.values(reviewedTools).flatMap(({ files }) => Object.keys(files)));

export function requireV64recompTools(tree: ReadonlyMap<string, { sha: string }>) {
  const blob = tree.get(presetSource)?.sha;
  const matches = ([v64recompLegacyLayout, v64recompCurrentLayout] as const).filter(
    (layout) => reviewedTools[layout].files[presetSource] === blob,
  );
  if (!blob || matches.length !== 1)
    throw new Error("v64recomp CMake presets changed outside the reviewed build contract");
  const layout = matches[0]!;
  const { revision, files, preset_sha256 } = reviewedTools[layout];
  for (const file of toolPaths) {
    if (tree.get(file)?.sha !== files[file])
      throw new Error(`v64recomp executable helper changed outside the reviewed contract: ${file}`);
  }
  return { layout, tool_revision: revision, presets: { blob, sha256: preset_sha256 } };
}

export function readV64recompProfile(text: string) {
  if (Buffer.byteLength(text) > maximumFileBytes) throw new Error("Oversized v64recomp profile");
  // Read only the leading, scalar portion of the project's exact [game] table.
  // Other TOML tables describe the build and are neither needed nor interpreted.
  const tables = text.split(/^\[game\][ \t]*$/mu);
  if (tables.length !== 2) throw new Error("Expected exactly one v64recomp game table");
  const table = tables[1]!.split(/^\[/mu)[0]!;
  const field = (name: string, form: RegExp) => {
    const assignment = new RegExp(`^\\s*${name}\\s*=`);
    const lines = table.split(/\r?\n/u).filter((line) => assignment.test(line));
    const value = lines.length === 1 ? form.exec(lines[0]!)?.[1] : undefined;
    if (!value) throw new Error(`Unsupported v64recomp game field ${name}`);
    return value;
  };
  const rom = field(
    "rom",
    /^rom\s*=\s*"\.\.\/\.\.\/(local\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.z64)"\s*$/u,
  );
  const sha1 = field("rom_sha1", /^rom_sha1\s*=\s*"([a-f0-9]{40})"\s*$/u);
  const size = Number(field("rom_size", /^rom_size\s*=\s*(0x[a-fA-F0-9]{1,8}|[0-9]{1,9})\s*$/u));
  const name = field("name", /^name\s*=\s*"([^"\\<>\p{Cc}]{1,128})"\s*$/u);
  if (size < 1 || size > 64 * 1024 * 1024) throw new Error("Invalid v64recomp ROM size");
  return { name, rom, sha1, size };
}

interface BlobProof {
  blob: string;
  sha256: string;
}
interface ProfileProof extends BlobProof, ReturnType<typeof readV64recompProfile> {
  target_blob: string;
}
export interface V64recompObservation {
  format_version: number;
  repository: string;
  repository_id: number;
  revision: string;
  tree: string;
  layout: V64recompLayout;
  tool_revision?: string;
  reads?: number;
  common: Record<string, BlobProof>;
  profiles: Record<string, ProfileProof>;
}

export async function observeV64recompProfiles(
  profiles: readonly string[],
  token = process.env.GH_TOKEN,
  fetchImplementation?: typeof fetch,
  known?: V64recompObservation,
): Promise<V64recompObservation> {
  if (
    !profiles.length ||
    profiles.length > maximumProfiles ||
    new Set(profiles).size !== profiles.length ||
    profiles.some((profile) => profile.length > 48 || !v64recompProfileId.test(profile))
  )
    throw new Error("Invalid v64recomp profile scope");
  const files = profiles.map(profileSource);
  const branchRoute = `${repository}/git/ref/heads/${branch}`;
  const contents = files.map((file) => `${repository}/contents/${file}`);
  const allowed = new Set([repository, branchRoute, ...contents]);
  let reads = 0;
  const sdk = await createGitHubClient({
    credential: token ? { kind: "explicit", token } : { kind: "anonymous" },
    deadline: performance.now() + 35_000,
    requestTimeoutMs: 5_000,
    maxBytes: 384 * 1024,
    observe: (attempt) => {
      if (attempt.dispatched) reads += 1;
    },
    allowRequest: (method, url) => method === "GET" && allowed.has(url.pathname),
    ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
  });
  const identity = async () => {
    const data: unknown = (await sdk.request("GET " + repository)).data;
    if (
      !isRecord(data) ||
      data.id !== v64recompRepositoryId ||
      data.full_name !== v64recompRepository ||
      data.default_branch !== branch ||
      data.archived !== false
    )
      throw new Error("v64recomp repository authority changed");
  };
  const revision = async () => {
    const data: unknown = (await sdk.request("GET " + branchRoute)).data;
    if (
      !isRecord(data) ||
      data.ref !== `refs/heads/${branch}` ||
      !isRecord(data.object) ||
      data.object.type !== "commit" ||
      typeof data.object.sha !== "string" ||
      !v64recompGitId.test(data.object.sha)
    )
      throw new Error("v64recomp source revision is unavailable");
    return data.object.sha;
  };
  await identity();
  const pinned = await revision();
  const commitRoute = `${repository}/git/commits/${pinned}`;
  allowed.add(commitRoute);
  const commit: unknown = (await sdk.request("GET " + commitRoute)).data;
  if (
    !isRecord(commit) ||
    commit.sha !== pinned ||
    !isRecord(commit.tree) ||
    typeof commit.tree.sha !== "string" ||
    !v64recompGitId.test(commit.tree.sha)
  )
    throw new Error("v64recomp commit does not bind an exact source tree");
  const treeSha = commit.tree.sha;
  const treeRoute = `${repository}/git/trees/${treeSha}`;
  allowed.add(treeRoute);
  const tree: unknown = (await sdk.request("GET " + treeRoute, { recursive: "1" })).data;
  if (
    !isRecord(tree) ||
    tree.sha !== treeSha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree) ||
    tree.tree.length > 1500
  )
    throw new Error("v64recomp source tree inventory is incomplete");
  const targetSource = (profile: string) => `games/${profile}/CMakeLists.txt`;
  const verified = new Map<string, { sha: string; size: number }>();
  const required = [...files, ...profiles.map(targetSource)];
  const expected = new Set([...required, ...toolPaths]);
  for (const row of tree.tree) {
    if (!isRecord(row) || typeof row.path !== "string" || !expected.has(row.path)) continue;
    if (
      verified.has(row.path) ||
      row.type !== "blob" ||
      !["100644", "100755"].includes(String(row.mode)) ||
      typeof row.sha !== "string" ||
      !v64recompGitId.test(row.sha) ||
      typeof row.size !== "number" ||
      !Number.isSafeInteger(row.size) ||
      row.size < 1 ||
      row.size > maximumFileBytes
    )
      throw new Error(`Invalid v64recomp tree member: ${row.path}`);
    verified.set(row.path, { sha: row.sha, size: row.size });
  }
  if (required.some((file) => !verified.has(file)))
    throw new Error("v64recomp source tree lacks a selected profile or target");
  const read = async (file: string) => {
    const data: unknown = (
      await sdk.request("GET " + `${repository}/contents/${file}`, { ref: pinned })
    ).data;
    if (
      !isRecord(data) ||
      data.type !== "file" ||
      data.path !== file ||
      data.encoding !== "base64" ||
      typeof data.content !== "string" ||
      typeof data.sha !== "string" ||
      !v64recompGitId.test(data.sha) ||
      typeof data.size !== "number" ||
      !Number.isSafeInteger(data.size) ||
      data.size < 1 ||
      data.size > maximumFileBytes
    )
      throw new Error(`v64recomp source file is unavailable: ${file}`);
    const bytes = Buffer.from(data.content, "base64");
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const prior = verified.get(file)!;
    if (
      bytes.length !== prior.size ||
      bytes.length !== data.size ||
      blob !== prior.sha ||
      blob !== data.sha
    )
      throw new Error(`v64recomp source does not match its Git blob: ${file}`);
    return {
      blob,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  };
  const reviewed =
    known?.repository === v64recompRepository &&
    known.repository_id === v64recompRepositoryId &&
    known.format_version === 1
      ? known
      : undefined;
  const { layout, tool_revision, presets } = requireV64recompTools(verified);
  const profileBodies = profiles.filter(
    (profile) => reviewed?.profiles[profile]?.blob !== verified.get(profileSource(profile))?.sha,
  );
  const needed = profileBodies.map(profileSource);
  const sources = new Map<string, Awaited<ReturnType<typeof read>>>();
  for (let index = 0; index < needed.length; index += 4) {
    const selected = needed.slice(index, index + 4);
    for (const [file, source] of await Promise.all(
      selected.map(async (file) => [file, await read(file)] as const),
    ))
      sources.set(file, source);
  }
  if ((await revision()) !== pinned) throw new Error("v64recomp source changed during observation");
  await identity();

  const text = (path: string) => sources.get(path)!.text;
  const proof = (file: string) => {
    const { blob, sha256 } = sources.get(file)!;
    return { blob, sha256 };
  };
  return {
    format_version: 1,
    repository: v64recompRepository,
    repository_id: v64recompRepositoryId,
    revision: pinned,
    tree: treeSha,
    layout,
    tool_revision,
    reads,
    common: { [presetSource]: presets },
    profiles: Object.fromEntries(
      [...profiles].sort().map((profile) => {
        const file = profileSource(profile);
        const facts = sources.has(file)
          ? { ...proof(file), ...readV64recompProfile(text(file)) }
          : reviewed!.profiles[profile]!;
        return [profile, { ...facts, target_blob: verified.get(targetSource(profile))!.sha }];
      }),
    ),
  };
}

if (import.meta.main) {
  const facts = await observeV64recompProfiles(process.argv.slice(2));
  console.log(JSON.stringify(facts, null, 2));
}
