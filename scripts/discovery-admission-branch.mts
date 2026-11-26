import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runCheckedGit } from "./checked-git.mts";
import { isRecord } from "./runtime-values.mts";

export const generatedAdmissionDirectory = "crates/portcove-core/catalog/listings.json";
export const generatedAdmissionRegistration =
  "crates/portcove-core/catalog/generated-registration.generated.json";
const authoredListing = /^crates\/portcove-core\/catalog\/ports\/github-[1-9]\d*\.json$/u;

/** The dedicated App may propose new listings and their generated directory. */
export function checkDiscoveryAdmissionPaths(status: string, generated: boolean) {
  const tokens = status.split("\0");
  if (tokens.pop() !== "" || tokens.length % 2 !== 0)
    throw new Error("Malformed staged admission inventory.");
  const added = new Set<string>();
  const derived = new Set<string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const [kind, path] = tokens.slice(index, index + 2);
    if (kind === "A" && path && authoredListing.test(path) && !added.has(path)) {
      added.add(path);
    } else if (
      generated &&
      kind === "M" &&
      (path === generatedAdmissionDirectory || path === generatedAdmissionRegistration) &&
      !derived.has(path)
    ) {
      derived.add(path);
    } else {
      throw new Error("Catalog admission changed a path outside its append-only scope.");
    }
  }
  if (added.size === 0 || (generated && derived.size !== 2))
    throw new Error(
      "Catalog admission needs authored additions and its exact generated directory.",
    );
  return [...added].sort();
}

export function checkDiscoveryRegistrationDelta(
  before: unknown,
  after: unknown,
  additions: number,
) {
  if (
    !isRecord(before) ||
    !isRecord(after) ||
    !isRecord(before.blocked) ||
    !isRecord(after.blocked)
  )
    throw new Error("Missing generated registration counts.");
  const expected = structuredClone(before) as typeof before & { blocked: Record<string, unknown> };
  let added = 0;
  for (const reason of ["no-observation", "upstream-unavailable"]) {
    const oldCount = before.blocked[reason];
    const newCount = after.blocked[reason];
    if (
      typeof oldCount !== "number" ||
      !Number.isSafeInteger(oldCount) ||
      oldCount < 0 ||
      typeof newCount !== "number" ||
      !Number.isSafeInteger(newCount) ||
      newCount < oldCount
    )
      throw new Error("Invalid generated registration count for catalog admission.");
    expected.blocked[reason] = newCount;
    added += newCount - oldCount;
  }
  if (added !== additions || !isDeepStrictEqual(expected, after))
    throw new Error(
      "Catalog admission may only increase the registration counts for its new listings.",
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== "authored" && mode !== "generated"))
    throw new Error("Expected authored or generated catalog admission scope.");
  const staged = runCheckedGit(["diff", "--cached", "--name-status", "--no-renames", "-z"]);
  const additions = checkDiscoveryAdmissionPaths(staged, mode === "generated");
  if (mode === "generated") {
    const baseline: unknown = JSON.parse(
      runCheckedGit(["show", `HEAD:${generatedAdmissionRegistration}`]),
    );
    const proposed: unknown = JSON.parse(
      runCheckedGit(["show", `:${generatedAdmissionRegistration}`]),
    );
    checkDiscoveryRegistrationDelta(baseline, proposed, additions.length);
  }
}
