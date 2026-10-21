/** Public binding shape only. This parser authenticates neither the prior feed
 * nor a coordinator, and it never grants a metadata signing capability. */
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectMetadataRenewalDescriptor } from "./release-metadata-contract.mts";
import { inspectCoordinatorRemoteNamespace } from "./release-coordinator-remote.mts";
import { isRecord } from "./runtime-values.mts";
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("metadata signing binding schema differs");
}
function sha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error("metadata signing digest differs");
}
export function inspectMetadataSigningBinding(
  rawFacts: unknown,
  rawBinding: unknown,
  rawPins: unknown,
) {
  const facts: unknown = structuredClone(rawFacts),
    binding: unknown = structuredClone(rawBinding),
    pins: unknown = structuredClone(rawPins);
  exact(
    facts,
    "checkpoint,descriptor,mode,namespace,previous_site_pins,public_source_commit,setup_plan_sha256",
  );
  exact(binding, "descriptor_sha256,kind,records_sha256");
  exact(pins, "repository_sha256,root_sha256,site_generation_sha256");
  const descriptor = inspectMetadataRenewalDescriptor(facts.descriptor);
  for (const value of Object.values(pins)) sha(value);
  for (const value of [facts.setup_plan_sha256, binding.descriptor_sha256, binding.records_sha256])
    sha(value);
  const namespace = inspectCoordinatorRemoteNamespace({
    schema_version: 1,
    namespace: facts.namespace,
  });
  if (
    facts.mode !== "renewal" ||
    binding.kind !== "metadata-renewal" ||
    typeof facts.checkpoint !== "string" ||
    !/^[a-f0-9]{40}$/u.test(facts.checkpoint) ||
    typeof facts.public_source_commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(facts.public_source_commit) ||
    digest(facts.previous_site_pins) !== digest(pins) ||
    descriptor.root_sha256 !== pins.root_sha256 ||
    descriptor.prior_repository_sha256 !== pins.repository_sha256 ||
    binding.descriptor_sha256 !== digest(descriptor) ||
    binding.records_sha256 !== descriptor.unchanged_records_sha256
  )
    throw new Error("metadata renewal context differs from its exact prior/descriptor binding");
  return {
    facts: { ...facts, namespace, descriptor },
    binding,
    previous_site_pins: pins,
    authority: "none" as const,
  };
}
