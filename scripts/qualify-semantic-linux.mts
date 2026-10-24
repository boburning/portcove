import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reenterResourceCommand, runResourceCommand } from "./resource-command.mts";
import { inspectSemanticReaderIndex } from "./release-semantic-reader-core.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  inspectSemanticFixtureEvents,
  requireLinuxSemanticSettlement,
  semanticSupervisorEnvironment,
} from "./release-semantic-runtime.mts";
import { isRecord } from "./runtime-values.mts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const tools = {
  python: "/usr/bin/python3",
  bwrap: "/usr/bin/bwrap",
  systemd_run: "/usr/bin/systemd-run",
  systemctl: "/usr/bin/systemctl",
};

/** Operator-selected inert qualification only; no auth, accepted bundle or runtime brand. */
export function inspectLinuxQualificationConfiguration(raw: unknown) {
  if (
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    !isRecord(raw.tools_sha256) ||
    Object.keys(raw).sort().join(",") !==
      "codex_executable,codex_sha256,node_executable,node_sha256,output_parent,schema_version,supervisor_sha256,tools_sha256" ||
    Object.keys(raw.tools_sha256).sort().join(",") !== Object.keys(tools).sort().join(",")
  )
    throw new Error("fixed credential-free Linux qualification configuration required");
  const string = (value: unknown, digest = false) => {
    if (
      typeof value !== "string" ||
      (digest
        ? !/^[a-f0-9]{64}$/u.test(value)
        : !value.startsWith("/") || value.split("/").includes(".."))
    )
      throw new Error("exact Linux path/tool identity required");
    return value;
  };
  return {
    output_parent: string(raw.output_parent),
    node_executable: string(raw.node_executable),
    codex_executable: string(raw.codex_executable),
    node_sha256: string(raw.node_sha256, true),
    codex_sha256: string(raw.codex_sha256, true),
    supervisor_sha256: string(raw.supervisor_sha256, true),
    tools_sha256: {
      python: string(raw.tools_sha256.python, true),
      bwrap: string(raw.tools_sha256.bwrap, true),
      systemd_run: string(raw.tools_sha256.systemd_run, true),
      systemctl: string(raw.tools_sha256.systemctl, true),
    },
  };
}

/** A separate, explicitly authenticated inert path. The credential-free wire
 * remains closed to auth. Only the supervisor opens this dedicated cache. */
export function inspectAuthenticatedLinuxFixtureConfiguration(raw: unknown) {
  if (!isRecord(raw) || typeof raw.auth_cache !== "string")
    throw new Error("dedicated authenticated fixture configuration required");
  const { auth_cache, ...configuration } = raw;
  if (
    !auth_cache.startsWith("/") ||
    auth_cache.split("/").some((part) => part === ".." || part === ".") ||
    path.posix.basename(auth_cache) !== "auth.json"
  )
    throw new Error("dedicated absolute auth.json path required");
  return { ...inspectLinuxQualificationConfiguration(configuration), auth_cache };
}

/** A successful login/reader fixture cannot mint whole-opportunity acceptance.
 * Auth refresh is a custody effect, even when later reader validation refuses. */
export function inspectAuthenticatedLinuxFixtureResult(
  status: number,
  isolation: unknown,
  events: Buffer,
) {
  if (status !== 0) throw new Error("authenticated fixture supervisor failed");
  requireLinuxSemanticSettlement(isolation);
  const { session } = inspectSemanticFixtureEvents(events);
  return {
    scope: "inert-authenticated-linux-boundary-only" as const,
    authenticated: true as const,
    semantic_acceptance: false as const,
    session,
  };
}

/** Inert settlement decoding only; callers retain and authenticate original bytes. */
export function inspectLinuxQualificationSettlement(
  status: number,
  isolation: unknown,
  mode: string,
) {
  if (mode !== "fixture" && mode !== "codex-fixture")
    throw new Error("fixed qualification mode required");
  if (
    status !== 0 ||
    !isRecord(isolation) ||
    isolation.mode !== mode ||
    isolation.authority !== "none" ||
    isolation.cgroup_verified !== true ||
    isolation.namespaces_verified !== true ||
    isolation.capture_complete !== true ||
    isolation.cgroup_empty !== true ||
    isolation.unit_settled !== true ||
    isolation.network_settled !== true ||
    isolation.network_refused !== false ||
    isolation.forced_termination !== false ||
    isolation.failure !== null ||
    isolation.auth_refreshed !== false ||
    isolation.exit_code !== 0 ||
    !Array.isArray(isolation.cleanup_errors) ||
    isolation.cleanup_errors.length
  )
    throw new Error("inert Linux qualification lacks positive original settlement");
  return { authority: "none" as const, semantic_acceptance: false as const };
}

async function qualify(mode: string, configurationPath: string) {
  const authenticatedFixture = mode === "authenticated-fixture";
  if (
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    !["fixture", "codex-fixture", "authenticated-fixture"].includes(mode)
  )
    throw new Error("fixed ordinary Linux fixture required");
  const raw: unknown = JSON.parse(await readFile(configurationPath, "utf8"));
  const configuration = authenticatedFixture
    ? inspectAuthenticatedLinuxFixtureConfiguration(raw)
    : { ...inspectLinuxQualificationConfiguration(raw), auth_cache: null };
  await reenterResourceCommand("analysis", import.meta.url);
  const supervisor = fileURLToPath(
    new URL("./semantic-review-linux-supervisor.py", import.meta.url),
  );
  const identities = new Map([
    [supervisor, configuration.supervisor_sha256],
    [configuration.node_executable, configuration.node_sha256],
    [configuration.codex_executable, configuration.codex_sha256],
    ...Object.entries(tools).map(
      ([key, file]) =>
        [file, configuration.tools_sha256[key as keyof typeof tools]] as [string, string],
    ),
  ]);
  const verify = async () => {
    for (const [file, digest] of identities)
      if (sha(await readFile(file)) !== digest)
        throw new Error("qualification tool/source hash differs");
  };
  await verify();
  const root = await mkdtemp(path.join(configuration.output_parent, "q-"));
  await chmod(root, 0o700);
  console.error(`inert Linux qualification evidence: ${root}`);
  for (const directory of ["runtime", "inputs", "inputs/objects", "capture"])
    await mkdir(path.join(root, directory), { mode: 0o700 });
  const hashes = new Map<string, string>();
  const put = async (name: string, bytes: Buffer | string) => {
    await writeFile(path.join(root, name), bytes, { mode: 0o600, flag: "wx" });
    hashes.set(name, sha(bytes));
  };
  await put(".portcove-semantic-review-owned", "inert Linux fixture only\n");
  const data = Buffer.from("inert fixture\n");
  const oid = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  const entry = { path: "fixture.txt", oid, mode: "100644" };
  const manifest = {
    qualification: "inert; no release opportunity or acceptance",
    snapshots: { source: [entry], baseline: [entry] },
  };
  const payload = Buffer.from(
    JSON.stringify({
      manifest,
      bundle_sha256: "0".repeat(64),
      files: [{ name: `objects/${oid}.data`, sha256: sha(data), data: data.toString("base64") }],
    }),
  );
  inspectSemanticReaderIndex(payload, sha(payload));
  await put("inputs/manifest.json", JSON.stringify(manifest));
  await put(
    "inputs/instructions.txt",
    authenticatedFixture
      ? 'This is an inert authenticated reader fixture, never a release or semantic review. Use only the portcove_frozen_bundle read tool with snapshot="source", path="fixture.txt", offset=0. Verify it returns the exact text "inert fixture\\n". Do not use shell, other files, web or other tools. After the successful reader call, reply exactly with {"fixture":"inert"}.\n'
      : "Inert credential-free startup fixture; never a semantic review.\n",
  );
  await put(
    "inputs/result-schema.json",
    JSON.stringify({
      type: "object",
      properties: { fixture: { const: "inert" } },
      required: ["fixture"],
      additionalProperties: false,
    }),
  );
  await put("inputs/reader-index.json", payload);
  await put(
    "inputs/reader-launch.json",
    JSON.stringify({ schema_version: 1, index_sha256: sha(payload) }),
  );
  await put(`inputs/objects/${oid}.data`, data);
  for (const name of [
    "release-semantic-reader-server.mts",
    "release-semantic-reader-core.mts",
    "runtime-values.mts",
    "semantic-review-model-catalog.json",
  ])
    await put(`runtime/${name}`, await readFile(new URL(name, import.meta.url)));
  for (const [name, file] of [
    ["node", configuration.node_executable],
    ["codex", configuration.codex_executable],
  ]) {
    const destination = path.join(root, "runtime", name!);
    await copyFile(file!, destination);
    await chmod(destination, 0o700);
    hashes.set(`runtime/${name}`, sha(await readFile(destination)));
  }
  if (
    hashes.get("runtime/node") !== configuration.node_sha256 ||
    hashes.get("runtime/codex") !== configuration.codex_sha256
  )
    throw new Error(`materialized qualification runtime changed; retain ${root}`);
  const subset = (prefix: string) =>
    Object.fromEntries(
      [...hashes]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, digest]) => [name.slice(prefix.length), digest]),
    );
  const request = path.join(root, "capture/linux-request.json");
  await put(
    "capture/linux-request.json",
    JSON.stringify({
      schema_version: 1,
      mode: authenticatedFixture ? "codex" : mode,
      run_root: root,
      runtime_sha256: subset("runtime/"),
      inputs_sha256: subset("inputs/"),
      tools_sha256: configuration.tools_sha256,
      timeout_seconds: mode === "fixture" ? 60 : authenticatedFixture ? 300 : 120,
      auth_cache: configuration.auth_cache,
    }),
  );
  const status = await runResourceCommand(
    "analysis",
    tools.python,
    ["-I", "-S", "-B", supervisor, "--request", request],
    { environment: semanticSupervisorEnvironment() },
  );
  await verify();
  for (const [name, digest] of hashes)
    if (sha(await readFile(path.join(root, name))) !== digest)
      throw new Error(`frozen inert qualification bytes changed; retain ${root}`);
  const isolation: unknown = JSON.parse(
    await readFile(path.join(root, "capture/isolation.json"), "utf8"),
  );
  if (authenticatedFixture) {
    const events = await readBoundedPublicBuildInputFile(
      root,
      "capture/stdout.jsonl",
      16 * 1024 * 1024,
    );
    return { ...inspectAuthenticatedLinuxFixtureResult(status, isolation, events), mode, root };
  }
  inspectLinuxQualificationSettlement(status, isolation, mode);
  return {
    scope: "inert-linux-boundary-only",
    mode,
    root,
    authenticated: false,
    semantic_acceptance: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || !process.argv[3] || !path.isAbsolute(process.argv[3]))
    throw new Error(
      "usage: qualify-semantic-linux.mts fixture|codex-fixture|authenticated-fixture ABSOLUTE_CONFIG.json",
    );
  console.log(JSON.stringify(await qualify(process.argv[2]!, process.argv[3])));
}
