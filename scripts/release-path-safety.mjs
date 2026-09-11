import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function assertOwnedUnlinkedPath(projectRoot, candidatePath, label) {
  const project = path.resolve(projectRoot);
  const candidate = path.resolve(candidatePath);
  if (candidate === project || !contains(project, candidate)) {
    throw new Error(`${label} must be a child path inside the project`);
  }

  const canonicalProject = await realpath(project);
  const parts = path.relative(project, candidate).split(path.sep);
  let current = project;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic-link or reparse-point component: ${current}`);
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new Error(`${label} contains a non-directory ancestor: ${current}`);
    }
    const canonicalCurrent = await realpath(current);
    if (!contains(canonicalProject, canonicalCurrent)) {
      throw new Error(`${label} resolves outside the project: ${current}`);
    }
  }
  return candidate;
}
