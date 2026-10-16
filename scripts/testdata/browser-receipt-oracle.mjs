import assert from "node:assert/strict";
// Static transport oracle, captured from real #2006 publications before host reuse.
// Timestamps, absolute Windows paths, durations and random trace names are omitted.
// Original run/source/driver/image and raw receipt hashes stay in provenance.
export function browserReceiptContract(host, result, publication) {
  for (const key of ["run", "image"]) assert.equal(host[key], result[key]);
  for (const key of ["commit", "tree"]) assert.equal(host.source[key], result[key]);
  for (const key of ["run", "commit", "tree", "image"]) assert.equal(publication[key], result[key]);
  const labels = host.container_inspection.Config.Labels;
  assert.equal(labels["io.portcove.tool"], host.tool);
  assert.equal(labels["io.portcove.workspace"], host.workspace);
  assert.equal(labels["io.portcove.run"], host.run);
  const paths = publication.files.map((item) => item.path.replaceAll("\\", "/"));
  for (const item of publication.files) {
    assert(!item.path.includes(".."));
    assert(Number.isSafeInteger(item.bytes) && item.bytes >= 0);
    assert.match(item.sha256, /^[a-f0-9]{64}$/u);
  }
  return {
    formats: [host.format_version, result.format_version, publication.format_version],
    tool: host.tool,
    container_prefix: host.container_name.slice(0, -host.run.length),
    identity_keys: Object.keys(labels)
      .filter((key) => key.startsWith("io.portcove."))
      .sort(),
    driver_keys: Object.keys(host.driver).sort(),
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
    phases: result.phases.map(({ phase, command, code, signal }) => ({
      phase,
      command,
      code,
      signal,
    })),
    resources: {
      user: host.container_inspection.Config.User,
      mounts: host.container_inspection.Mounts,
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
        ].map((key) => [key, host.container_inspection.HostConfig[key]]),
      ),
    },
    publication_keys: Object.keys(publication).sort(),
    root_files: paths.filter((p) => !p.includes("/")).sort(),
    artifact_roots: [
      ...new Set(
        paths
          .filter((p) => p.includes("/"))
          .map((p) =>
            p.startsWith("attachments/desktop/") ? "attachments/desktop" : p.split("/")[0],
          ),
      ),
    ].sort(),
    usable_zip: paths.some((p) => p.endsWith(".zip")),
  };
}
