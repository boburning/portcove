import assert from "node:assert/strict";
import { isRecord } from "../runtime-values.mts";
function object(value: unknown) {
  assert(isRecord(value));
  return value;
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}
function string(value: unknown) {
  assert.equal(typeof value, "string");
  assert(typeof value === "string");
  return value;
}
// Static transport oracle, captured from real #2006 publications before host reuse.
// Timestamps, absolute Windows paths, durations and random trace names are omitted.
// Original run/source/driver/image and raw receipt hashes stay in provenance.
export function browserReceiptContract(
  hostValue: unknown,
  resultValue: unknown,
  publicationValue: unknown,
) {
  const host = object(hostValue),
    result = object(resultValue),
    publication = object(publicationValue);
  const source = object(host.source),
    inspection = object(host.container_inspection);
  const config = object(inspection.Config),
    hostConfig = object(inspection.HostConfig);
  for (const key of ["run", "image"]) assert.equal(host[key], result[key]);
  for (const key of ["commit", "tree"]) assert.equal(source[key], result[key]);
  for (const key of ["run", "commit", "tree", "image"]) assert.equal(publication[key], result[key]);
  const labels = object(config.Labels);
  assert.equal(labels["io.portcove.tool"], host.tool);
  assert.equal(labels["io.portcove.workspace"], host.workspace);
  assert.equal(labels["io.portcove.run"], host.run);
  const files = array(publication.files).map(object);
  const paths = files.map((item) => string(item.path).replaceAll("\\", "/"));
  for (const item of files) {
    assert(!string(item.path).includes(".."));
    assert(typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0);
    assert.match(string(item.sha256), /^[a-f0-9]{64}$/u);
  }
  return {
    formats: [host.format_version, result.format_version, publication.format_version],
    tool: host.tool,
    container_prefix: string(host.container_name).slice(0, -string(host.run).length),
    identity_keys: Object.keys(labels)
      .filter((key: string) => key.startsWith("io.portcove."))
      .sort(),
    driver_keys: Object.keys(object(host.driver)).sort(),
    prepublication: {
      export_complete: host.export_complete,
      result_embedded: Object.hasOwn(host, "result"),
    },
    host_status: host.status,
    execution_status: host.execution_status ?? null,
    causal_exit: host.causal_exit,
    container_exit: host.container_exit,
    result_status: result.status,
    command_exit: result.command_exit,
    interruption: result.interruption,
    fresh_execution: result.fresh_execution,
    platform: result.platform,
    architecture: result.architecture,
    uid: result.uid,
    mode: result.mode,
    files: result.files,
    command: result.command,
    phases: array(result.phases)
      .map(object)
      .map(({ phase, command, code, signal }) => ({
        phase,
        command,
        code,
        signal,
      })),
    resources: {
      user: config.User,
      mounts: inspection.Mounts,
      ...Object.fromEntries(
        [
          "Privileged",
          "CapAdd",
          "CapDrop",
          "NetworkMode",
          "PidMode",
          "IpcMode",
          "Devices",
          "Memory",
          "MemorySwap",
          "NanoCpus",
          "ShmSize",
          "PidsLimit",
          "SecurityOpt",
        ].map((key) => [key, hostConfig[key]]),
      ),
    },
    publication_keys: Object.keys(publication).sort(),
    root_files: paths.filter((p) => !p.includes("/")).sort(),
    artifact_roots: [
      ...new Set(
        paths
          .filter((p) => p.includes("/"))
          .map((p: string) =>
            p.startsWith("attachments/desktop/")
              ? "attachments/desktop"
              : p.slice(0, p.indexOf("/")),
          ),
      ),
    ].sort(),
    usable_zip: paths.some((p: string) => p.endsWith(".zip")),
  };
}
