import { isRecord } from "./runtime-values.mts";

export const retcommRepositoryId = 1316230812;
const repositoryName = /^[\w.-]+\/[\w.-]+$/u;
const pathComponent = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;

export function retcommTitlePaths(index: unknown) {
  if (!isRecord(index) || !isRecord(index.platforms)) throw new Error("Invalid RetComM index");
  const paths = new Map<string, { platform: string; title: string; path: string }>();
  for (const [platform, entry] of Object.entries(index.platforms)) {
    if (
      !pathComponent.test(platform) ||
      !isRecord(entry) ||
      typeof entry.dir !== "string" ||
      !entry.dir.split("/").every((part) => pathComponent.test(part)) ||
      !Array.isArray(entry.titles)
    )
      throw new Error("Malformed RetComM platform index");
    for (const title of entry.titles as unknown[]) {
      if (typeof title !== "string" || !pathComponent.test(title))
        throw new Error("Malformed RetComM title ID");
      const key = `${platform}:${title}`;
      if (paths.has(key)) throw new Error("Repeated RetComM title ID");
      paths.set(key, { platform, title, path: `${entry.dir}/${title}.json` });
    }
  }
  return paths;
}

export async function resolveRetcommRevision(
  readMetadata: (endpoint: string) => Promise<unknown>,
  override?: string,
) {
  const meta = await readMetadata(`repositories/${retcommRepositoryId}`);
  if (
    !isRecord(meta) ||
    meta.id !== retcommRepositoryId ||
    typeof meta.full_name !== "string" ||
    !repositoryName.test(meta.full_name) ||
    meta.full_name.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("RetComM repository identity did not match");
  const repository = meta.full_name;
  const requested = override ?? meta.default_branch;
  if (typeof requested !== "string" || !requested)
    throw new Error("RetComM default branch is unavailable");
  const commit = await readMetadata(`repos/${repository}/commits/${encodeURIComponent(requested)}`);
  if (!isRecord(commit) || typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/u.test(commit.sha))
    throw new Error("RetComM did not return an immutable commit");
  return { repository, revision: commit.sha, repository_id: retcommRepositoryId };
}
