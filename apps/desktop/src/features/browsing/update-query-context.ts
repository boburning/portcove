import type { PortStatus } from "../../types";

type Install = NonNullable<PortStatus["active"]>;
type Artifact = Install["artifact"];
type Runtime = Install["runtime"];
const digest = /^[a-f0-9]{64}$/iu;
const channels = ["stable", "beta", "rolling"];

function artifactKnown(value: Artifact | null | undefined): value is Artifact {
  return Boolean(
    value &&
    typeof value.asset_name === "string" &&
    value.asset_name.length > 0 &&
    typeof value.sha256 === "string" &&
    digest.test(value.sha256) &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0,
  );
}
function sameArtifact(left: Artifact, right: Artifact): boolean {
  return (
    left.asset_name === right.asset_name &&
    left.size === right.size &&
    left.sha256.toLowerCase() === right.sha256.toLowerCase()
  );
}
function runtimeKnown(value: Runtime | undefined): value is Runtime {
  return (
    value === null ||
    Boolean(
      value &&
      ["verified_download", "adopted_tree"].includes(value.origin) &&
      artifactKnown(value.artifact) &&
      typeof value.archive_root === "string" &&
      typeof value.target_directory === "string" &&
      typeof value.executable === "string",
    )
  );
}
function sameRuntime(left: Runtime, right: Runtime): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.origin === right.origin &&
    left.artifact.asset_name === right.artifact.asset_name &&
    left.artifact.size === right.artifact.size &&
    left.artifact.sha256 === right.artifact.sha256 &&
    left.archive_root === right.archive_root &&
    left.target_directory === right.target_directory &&
    left.executable === right.executable
  );
}

/** Validate a cached Core observation, not update eligibility or execution authority.
 * Undefined means unknown/obsolete, never a negative or an up-to-date assessment.
 * Logical installation identity is version/artifact/runtime in the supplied library.
 */
export function observedUpdateCandidate(
  portId: string,
  status: PortStatus | undefined,
): { availableAtLastCheck: boolean; matchingStaged: boolean } | undefined {
  const active = status?.active;
  const snapshot = status?.last_update_check;
  const check = snapshot?.check;
  if (
    !status ||
    status.port_id !== portId ||
    !active ||
    active.port_id !== portId ||
    !snapshot ||
    !check ||
    check.port_id !== portId ||
    !channels.includes(status.channel) ||
    check.channel !== status.channel ||
    typeof active.version !== "string" ||
    active.version.length === 0 ||
    check.installed_version !== active.version ||
    !artifactKnown(active.artifact) ||
    !artifactKnown(check.installed_artifact) ||
    !sameArtifact(active.artifact, check.installed_artifact) ||
    !runtimeKnown(active.runtime) ||
    !runtimeKnown(check.installed_runtime) ||
    !sameRuntime(active.runtime, check.installed_runtime) ||
    !Number.isSafeInteger(snapshot.checked_at) ||
    snapshot.checked_at < 0 ||
    typeof check.update_available !== "boolean"
  )
    return undefined;
  const release = check.release;
  if (
    !release ||
    release.channel !== check.channel ||
    typeof release.version !== "string" ||
    release.version.length === 0 ||
    !release.asset ||
    typeof release.asset.name !== "string" ||
    release.asset.name.length === 0 ||
    typeof release.asset.sha256 !== "string" ||
    !digest.test(release.asset.sha256) ||
    !Number.isSafeInteger(release.asset.size) ||
    release.asset.size < 0 ||
    !runtimeKnown(check.required_runtime)
  )
    return undefined;
  const staged = status.staged;
  const matchingStaged = Boolean(
    check.update_available &&
    staged?.verified === true &&
    staged.staged === true &&
    staged.port_id === portId &&
    staged.channel === check.channel &&
    staged.version === release.version &&
    artifactKnown(staged.artifact) &&
    staged.artifact.asset_name === release.asset.name &&
    staged.artifact.sha256.toLowerCase() === release.asset.sha256.toLowerCase() &&
    // Core treats a zero release size as unspecified; the digest still binds bytes.
    (release.asset.size === 0 || staged.artifact.size === release.asset.size) &&
    runtimeKnown(staged.runtime) &&
    sameRuntime(staged.runtime, check.required_runtime),
  );
  return { availableAtLastCheck: check.update_available && !matchingStaged, matchingStaged };
}
