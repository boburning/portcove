import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { inspectMetadataRenewalDescriptor, metadataInstant } from "./release-metadata-contract.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectInitialRootProfile,
  initialRootProfileFields,
  type InitialRootProfile,
  inspectTopLevelTargetsProfile,
  topLevelTargetsProfileFields,
  type TopLevelTargetsProfile,
} from "./release-initial-root-profile.mts";

const run = promisify(execFile);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const shaPattern = /^[a-f0-9]{64}$/u;
type Files = Map<string, Buffer>;
type Identity = { path: string; bytes: number; sha256: string };
type Descriptor = ReturnType<typeof inspectMetadataRenewalDescriptor>;
interface BoundPreparation {
  initial_root_profile: InitialRootProfile;
  top_level_targets_profile: TopLevelTargetsProfile;
  prepared_root: string;
  context: string;
  descriptor: Descriptor;
  descriptor_sha256: string;
  input_manifest_sha256: string;
  files: Identity[];
  verifier: string;
  verifier_sha256: string;
}
export interface PreparedMetadataRenewal {
  readonly kind: "authenticated-metadata-renewal-preparation";
  readonly descriptor_sha256: string;
  readonly input_manifest_sha256: string;
}
const preparations = new WeakMap<PreparedMetadataRenewal, BoundPreparation>();
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("renewal tool public contract differs");
}
async function read(file: string, limit: number, tool = false) {
  const entry = await lstat(file);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    (!tool && entry.nlink !== 1) ||
    entry.size > limit
  )
    throw new Error("renewal input is not a bounded regular single-link file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || (!tool && before.nlink !== 1) || before.size > limit)
      throw new Error("renewal input is not a bounded regular single-link file");
    let count = 0;
    const chunks: Buffer[] = [];
    while (count <= limit) {
      const buffer = Buffer.alloc(Math.min(65536, limit + 1 - count));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
      if (count > limit) throw new Error("renewal input grew beyond byte bound");
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    const bytes = Buffer.concat(chunks),
      after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== bytes.length ||
      after.size !== bytes.length ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("renewal input changed during bounded read");
    return bytes;
  } finally {
    await handle.close();
  }
}
const safePath = (name: string) =>
  name.length <= 512 &&
  name.split("/").length <= 18 &&
  name
    .split("/")
    .every(
      (segment) =>
        /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(segment) && segment !== "." && segment !== "..",
    );
async function tree(root: string, prepared = false): Promise<Files> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("renewal tree root is linked or not a directory");
  const files: Files = new Map();
  let entries = 0,
    total = 0;
  const walk = async (prefix: string, depth: number) => {
    if (depth > 18) throw new Error("renewal tree depth exceeded");
    for await (const entry of await opendir(path.join(root, prefix))) {
      if (++entries > (prepared ? 8192 : 4096)) throw new Error("renewal tree entries exceeded");
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        !safePath(name) ||
        (!prepared &&
          !name.startsWith("metadata/") &&
          !name.startsWith("targets/") &&
          name !== "metadata" &&
          name !== "targets")
      )
        throw new Error("renewal tree contains non-public paths");
      const child = await assertOwnedUnlinkedPath(
        root,
        path.join(root, name),
        "public renewal file",
      );
      if (entry.isDirectory()) await walk(name, depth + 1);
      else {
        if (!entry.isFile() || files.size >= (prepared ? 2208 : 1100))
          throw new Error("renewal tree type/count exceeded");
        const bytes = await read(child, 1024 * 1024);
        total += bytes.length;
        if (total > (prepared ? 128 : 64) * 1024 * 1024)
          throw new Error("renewal tree total byte bound exceeded");
        files.set(name, bytes);
      }
    }
  };
  await walk("", 0);
  return files;
}
function identities(files: Files): Identity[] {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) }));
}
async function copy(root: string, files: Files) {
  await mkdir(root, { mode: 0o700 });
  for (const [name, bytes] of files) {
    const output = path.join(root, name);
    await mkdir(path.dirname(output), { mode: 0o700, recursive: true });
    await writeFile(output, bytes, { mode: 0o600, flag: "wx" });
  }
}
// Preserve exact JSON u64 token text when inspecting the Rust public context.
// Ordinary JSON.parse numeric conversion must not round a version above2^53.
function publicContext(bytes: Buffer): unknown {
  return JSON.parse(
    bytes.toString("utf8"),
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== "number") return value;
      if (!context?.source || !/^[1-9][0-9]*$/u.test(context.source))
        throw new Error("public context number representation differs");
      return context.source;
    },
  ) as unknown;
}
function validateOutput(
  files: Files,
  expected: {
    generated_at: string;
    root_sha256: string;
    prior_sha256: string;
    initial_root_profile: InitialRootProfile;
    top_level_targets_profile: TopLevelTargetsProfile;
  },
) {
  const required = (name: string) => {
    const bytes = files.get(name);
    if (!bytes) throw new Error("prepared renewal output incomplete");
    return bytes;
  };
  const descriptor = inspectMetadataRenewalDescriptor(
    JSON.parse(required("renewal.json").toString("utf8")) as unknown,
  );
  if (
    (descriptor.schema_version === 2) !==
    (expected.top_level_targets_profile === "online-unchanged-authority-v1")
  )
    throw new Error("prepared Targets renewal mode differs from appointed configuration");
  if (
    descriptor.generated_at !== expected.generated_at ||
    descriptor.root_sha256 !== expected.root_sha256 ||
    descriptor.prior_repository_sha256 !== expected.prior_sha256 ||
    sha(required("trusted-root.json")) !== expected.root_sha256 ||
    sha(required("offline-targets.json")) !== descriptor.offline_targets_sha256
  )
    throw new Error("prepared renewal descriptor differs from fixed public input");
  const context = publicContext(required("context.json"));
  exact(
    context,
    [
      "expires",
      "generated_at",
      "offline_targets",
      "payload_key_registry",
      "previous_repository",
      "reconstructed_records",
      "schema_version",
      "trusted_root",
      "versions",
      ...Object.keys(initialRootProfileFields(expected.initial_root_profile)),
      ...Object.keys(topLevelTargetsProfileFields(expected.top_level_targets_profile)),
    ]
      .sort()
      .join(","),
  );
  if (
    context.schema_version !== "1" ||
    (expected.initial_root_profile === "single-owner-one-of-one-v1" &&
      context.initial_root_profile !== expected.initial_root_profile) ||
    (expected.top_level_targets_profile === "online-unchanged-authority-v1" &&
      context.top_level_targets_profile !== expected.top_level_targets_profile) ||
    context.generated_at !== descriptor.generated_at ||
    context.trusted_root !== "trusted-root.json" ||
    context.offline_targets !== "offline-targets.json" ||
    context.payload_key_registry !== "payload.json" ||
    context.previous_repository !== "prior" ||
    context.reconstructed_records !== "records" ||
    digest(context.versions) !== digest(descriptor.next_versions) ||
    digest(context.expires) !== digest(descriptor.next_expires)
  )
    throw new Error("prepared public context differs from verified renewal descriptor");
  const prior: Files = new Map(
    [...files]
      .filter(([name]) => name.startsWith("prior/") && name !== "prior/repository-manifest.json")
      .map(([name, bytes]) => [name.slice(6), bytes]),
  );
  if (digest(identities(prior)) !== expected.prior_sha256)
    throw new Error("prepared prior repository changed");
  const records: Files = new Map(
    [...files]
      .filter(
        ([name]) => name.startsWith("records/") && name !== "records/reconstruction-manifest.json",
      )
      .map(([name, bytes]) => [name.slice(8), bytes]),
  );
  if (digest(identities(records)) !== descriptor.unchanged_records_sha256)
    throw new Error("prepared unchanged records differ");
  return descriptor;
}

/** Uses only independently ratified fixed tool/root pins and public inputs.
 * Actual safe-expiry Tough authentication happens in that qualified executable;
 * JSON reports and hash equality alone grant no publisher or execution authority.
 */
export async function prepareAuthenticatedMetadataRenewal(request: {
  initial_root_profile?: InitialRootProfile;
  top_level_targets_profile?: TopLevelTargetsProfile;
  verifier: string;
  verifier_sha256: string;
  trusted_root: string;
  trusted_root_sha256: string;
  previous_repository: string;
  prior_repository_sha256: string;
  generated_at: string;
  output_parent: string;
  deadline?: number;
}): Promise<PreparedMetadataRenewal> {
  const selected = {
    ...structuredClone(request),
    initial_root_profile: inspectInitialRootProfile(
      request.initial_root_profile ?? "legacy-two-of-three-v1",
    ),
    top_level_targets_profile: inspectTopLevelTargetsProfile(
      request.top_level_targets_profile ?? "offline-pinned-v1",
    ),
  };
  if (
    selected.top_level_targets_profile === "online-unchanged-authority-v1" &&
    selected.initial_root_profile !== "single-owner-one-of-one-v1"
  )
    throw new Error("online Targets requires explicit single-owner profile");
  const remaining = () => {
    const timeout =
      selected.deadline === undefined
        ? 120000
        : Math.floor(Math.min(120000, selected.deadline - performance.now()));
    if (!Number.isFinite(timeout) || timeout < 1)
      throw new Error("metadata preparation phase deadline exhausted");
    return timeout;
  };
  remaining();
  for (const value of [
    selected.verifier_sha256,
    selected.trusted_root_sha256,
    selected.prior_repository_sha256,
  ])
    if (!shaPattern.test(value)) throw new Error("independent renewal identities unavailable");
  for (const name of [
    selected.verifier,
    selected.trusted_root,
    selected.previous_repository,
    selected.output_parent,
  ])
    if (!path.isAbsolute(name)) throw new Error("renewal paths must be absolute");
  metadataInstant(selected.generated_at);
  if (
    releasePathContains(selected.previous_repository, selected.output_parent) ||
    releasePathContains(selected.output_parent, selected.previous_repository)
  )
    throw new Error("renewal work overlaps public source");
  const prior = await tree(selected.previous_repository),
    priorIdentity = identities(prior);
  if (digest(priorIdentity) !== selected.prior_repository_sha256)
    throw new Error("independently observed public component differs");
  const root = await read(selected.trusted_root, 1024 * 1024);
  if (sha(root) !== selected.trusted_root_sha256)
    throw new Error("independently ratified root differs");
  const tool = await read(selected.verifier, 128 * 1024 * 1024, true);
  if (sha(tool) !== selected.verifier_sha256) throw new Error("qualified renewal verifier changed");
  const work = await mkdtemp(path.join(selected.output_parent, "renewal-"));
  await chmod(work, 0o700);
  const verifier = path.join(work, process.platform === "win32" ? "renewal.exe" : "renewal");
  const prepared = path.join(work, "prepared");
  try {
    await writeFile(verifier, tool, { mode: 0o700, flag: "wx" });
    await writeFile(path.join(work, "trusted-root.json"), root, { mode: 0o600, flag: "wx" });
    await copy(path.join(work, "prior"), prior);
    const config = path.join(work, "request.json");
    await writeFile(
      config,
      JSON.stringify({
        schema_version: 1,
        ...initialRootProfileFields(selected.initial_root_profile),
        ...topLevelTargetsProfileFields(selected.top_level_targets_profile),
        generated_at: selected.generated_at,
        trusted_root: "trusted-root.json",
        previous_repository: "prior",
        output: "prepared",
      }),
      { mode: 0o600, flag: "wx" },
    );
    const result = await run(verifier, ["prepare-tuf-renewal", config], {
      cwd: work,
      timeout: remaining(),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        PATH: process.platform === "win32" ? `${process.env.SystemRoot}/System32` : "/usr/bin:/bin",
        SystemRoot: process.env.SystemRoot,
        HOME: work,
        TMP: work,
        TEMP: work,
        TMPDIR: work,
      },
    });
    remaining();
    await writeFile(path.join(work, "verifier.stdout.json"), result.stdout, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(path.join(work, "verifier.stderr.log"), result.stderr, {
      mode: 0o600,
      flag: "wx",
    });
    const files = await tree(prepared, true),
      fileIdentities = identities(files);
    const descriptor = validateOutput(files, {
      initial_root_profile: selected.initial_root_profile,
      top_level_targets_profile: selected.top_level_targets_profile,
      generated_at: selected.generated_at,
      root_sha256: selected.trusted_root_sha256,
      prior_sha256: selected.prior_repository_sha256,
    });
    const report: unknown = JSON.parse(result.stdout);
    exact(report, "authority,changed,context_sha256,descriptor_sha256,files,output,schema_version");
    if (
      report.schema_version !== 1 ||
      typeof report.changed !== "boolean" ||
      report.authority !== "none" ||
      path.resolve(String(report.output)) !== prepared ||
      report.context_sha256 !== sha(files.get("context.json")!) ||
      report.descriptor_sha256 !== digest(descriptor) ||
      digest(report.files) !== digest(fileIdentities)
    )
      throw new Error("actual renewal tool report/output differs");
    if (
      digest(identities(await tree(selected.previous_repository))) !== digest(priorIdentity) ||
      sha(await read(selected.trusted_root, 1024 * 1024)) !== selected.trusted_root_sha256 ||
      sha(await read(verifier, 128 * 1024 * 1024)) !== selected.verifier_sha256
    )
      throw new Error("renewal inputs changed during actual verification");
    const inputManifest = digest({
      ...initialRootProfileFields(selected.initial_root_profile),
      ...topLevelTargetsProfileFields(selected.top_level_targets_profile),
      generated_at: selected.generated_at,
      tool_sha256: selected.verifier_sha256,
      root_sha256: selected.trusted_root_sha256,
      prior_repository_sha256: selected.prior_repository_sha256,
    });
    const session = Object.freeze({
      kind: "authenticated-metadata-renewal-preparation" as const,
      descriptor_sha256: digest(descriptor),
      input_manifest_sha256: inputManifest,
    });
    remaining();
    preparations.set(session, {
      initial_root_profile: selected.initial_root_profile,
      top_level_targets_profile: selected.top_level_targets_profile,
      prepared_root: prepared,
      context: path.join(prepared, "context.json"),
      descriptor,
      descriptor_sha256: session.descriptor_sha256,
      input_manifest_sha256: inputManifest,
      files: fileIdentities,
      verifier,
      verifier_sha256: selected.verifier_sha256,
    });
    return session;
  } catch (error) {
    for (const name of ["stdout", "stderr"] as const)
      if (isRecord(error) && typeof error[name] === "string")
        await writeFile(path.join(work, `failed.${name}`), error[name].slice(0, 1024 * 1024), {
          mode: 0o600,
          flag: "wx",
        });
    throw new Error(`actual renewal preparation refused; retain ${work}`, { cause: error });
  }
}
/** Rechecks exact private output custody before role jobs or journal admission. */
export async function inspectPreparedMetadataRenewal(session: PreparedMetadataRenewal) {
  const bound = preparations.get(session);
  if (!bound) throw new Error("metadata renewal session was not prepared by this admitted process");
  if (
    digest(identities(await tree(bound.prepared_root, true))) !== digest(bound.files) ||
    sha(await read(bound.verifier, 128 * 1024 * 1024)) !== bound.verifier_sha256
  )
    throw new Error("prepared metadata renewal custody changed");
  return structuredClone(bound);
}
