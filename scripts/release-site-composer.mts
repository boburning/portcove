import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { capacityDigest } from "./release-capacity.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectTufPublicationFacts } from "./release-metadata-contract.mts";
import { inspectSiteGeneration, isSafeSitePath } from "./release-site-generation.mts";
import type { SiteGeneration } from "./release-site-generation.mts";
export { isSafeSitePath } from "./release-site-generation.mts";

const run = promisify(execFile);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const maximumFiles = 6000,
  maximumBytes = 256 * 1024 * 1024;
const maximumFileBytes = 64 * 1024 * 1024;
type Files = Map<string, Buffer>;
interface SiteFile {
  path: string;
  bytes: number;
  sha256: string;
}
type Generation = SiteGeneration;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

function remaining(deadline: number | undefined, maximum = 300000) {
  if (deadline !== undefined && !Number.isFinite(deadline))
    throw new Error("site composition phase deadline exhausted");
  const value =
    deadline === undefined ? maximum : Math.floor(Math.min(maximum, deadline - performance.now()));
  if (!Number.isFinite(value) || value < 1)
    throw new Error("site composition phase deadline exhausted");
  return value;
}

async function boundedFile(file: string, maximum: number, qualifiedTool = false) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || (!qualifiedTool && before.nlink !== 1) || before.size > maximum)
      throw new Error("site input is not a bounded single-link file");
    const chunks: Buffer[] = [];
    let count = 0;
    while (count <= maximum) {
      const chunk = Buffer.alloc(Math.min(65536, maximum + 1 - count));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
      if (count > maximum) throw new Error("site input exceeded read bound");
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    const after = await handle.stat();
    if (
      bytes.length > maximum ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== bytes.length ||
      after.size !== bytes.length ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("site input changed during read");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function tree(root: string, deadline?: number): Promise<Files> {
  remaining(deadline);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("site input root is linked or not a directory");
  const files: Files = new Map();
  let total = 0,
    entries = 0;
  const walk = async (relative: string, depth: number) => {
    if (depth > 16) throw new Error("site input depth exceeded");
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      remaining(deadline);
      if (++entries > maximumFiles + 128) throw new Error("site input entry bound exceeded");
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSafeSitePath(name))
        throw new Error("site input path differs from fixed publication layout");
      await assertOwnedUnlinkedPath(root, path.join(root, name), "site input");
      if (entry.isDirectory()) await walk(name, depth + 1);
      else {
        if (!entry.isFile() || files.size >= maximumFiles)
          throw new Error("site input type/count refused");
        const bytes = await boundedFile(path.join(root, name), maximumFileBytes);
        remaining(deadline);
        total += bytes.length;
        if (total > maximumBytes) throw new Error("site input aggregate byte bound exceeded");
        files.set(name, bytes);
      }
    }
  };
  await walk("", 0);
  remaining(deadline);
  return files;
}
function identities(files: Files): SiteFile[] {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) }));
}
function inspectPrior(files: Files, expected: string) {
  const marker = files.get("publication.json");
  if (!marker || marker.length > 4 * 1024 * 1024)
    throw new Error("prior site generation marker unavailable");
  if (!Buffer.from(marker.toString("utf8"), "utf8").equals(marker))
    throw new Error("prior site marker is not UTF-8");
  const value = inspectSiteGeneration(JSON.parse(marker.toString("utf8")), expected);
  const original = new Map(files);
  original.delete("publication.json");
  if (JSON.stringify(value.files) !== JSON.stringify(identities(original)))
    throw new Error("prior site bytes differ from independently expected generation");
  return value;
}

/** Bounded filesystem readback only. A matching marker is not authentication;
 * expected identities must come from the protected caller's real composition. */
export async function readComposedSite(
  directory: string,
  expected: string,
  rootHash: string,
  deadline?: number,
) {
  const files = await tree(directory, deadline);
  const generation = inspectPrior(files, expected);
  if (generation.application_root_sha256 !== rootHash)
    throw new Error("prior application root differs");
  return { files, generation };
}

/** Catalog custody uses its own expected root, never the application's root. */
export async function readComposedCatalogSite(
  directory: string,
  expected: string,
  rootHash: string,
  deadline?: number,
) {
  const files = await tree(directory, deadline);
  const generation = inspectPrior(files, expected);
  if (generation.schema_version !== 2 || generation.catalog_root_sha256 !== rootHash)
    throw new Error("prior catalog root differs");
  return { files, generation };
}

/** Filesystem composition only. Inputs here are NOT authenticated by a
 * self-consistent marker. The protected caller supplies the independently
 * authenticated previous generation and separately verified application tree.
 * Never use this low-level operation as admission or deployment authority. */
export async function composeSiteFiles(request: {
  previous: string | null;
  expected_previous_generation: string | null;
  application: string;
  application_root_sha256: string;
  output_parent: string;
  deadline?: number;
}) {
  remaining(request.deadline);
  if (
    !digest(request.application_root_sha256) ||
    ![
      request.application,
      request.output_parent,
      ...(request.previous ? [request.previous] : []),
    ].every((name) => path.isAbsolute(name)) ||
    (request.previous === null
      ? request.expected_previous_generation !== null
      : !digest(request.expected_previous_generation))
  )
    throw new Error("exact site composition identities unavailable");
  if (
    [request.application, ...(request.previous ? [request.previous] : [])].some((input) =>
      releasePathContains(input, request.output_parent),
    )
  )
    throw new Error("site output would mutate its input tree");
  const old = request.previous
    ? await tree(request.previous, request.deadline)
    : new Map<string, Buffer>();
  for (const name of old.keys())
    if (
      name !== "publication.json" &&
      name !== ".nojekyll" &&
      !name.startsWith("application/metadata/") &&
      !name.startsWith("application/targets/") &&
      !name.startsWith("catalog/")
    )
      throw new Error("prior site has an unowned component; preserve and reconcile");
  const prior = request.previous ? inspectPrior(old, request.expected_previous_generation!) : null;
  if (
    prior &&
    prior.application_root_sha256 !== request.application_root_sha256 &&
    !(
      prior.application_root_sha256 === null &&
      ![...old.keys()].some((name) => name.startsWith("application/"))
    )
  )
    throw new Error("prior application root differs");
  if (prior?.schema_version === 2 && prior.catalog_root_sha256 === request.application_root_sha256)
    throw new Error("application and catalog roots must differ");
  const app = await tree(request.application, request.deadline);
  const next: Files = new Map([...old].filter(([name]) => name.startsWith("catalog/")));
  for (const [name, bytes] of app) {
    if (!name.startsWith("metadata/") && !name.startsWith("targets/")) {
      if (name === "repository-manifest.json") continue; // internal TUF inventory, never served
      throw new Error("application component has unexpected publication content");
    }
    next.set(`application/${name}`, bytes);
  }
  if (!next.has("application/metadata/timestamp.json"))
    throw new Error("application timestamp absent");
  for (const [name, bytes] of old) {
    if (
      (name.startsWith("application/targets/") || /^application\/metadata\/\d+\./u.test(name)) &&
      !next.get(name)?.equals(bytes)
    )
      throw new Error(`immutable application history would be removed or changed: ${name}`);
  }
  next.set(".nojekyll", Buffer.alloc(0));
  const nextFiles = identities(next);
  if (prior && JSON.stringify(prior.files) === JSON.stringify(nextFiles))
    return {
      authority: "none",
      changed: false,
      output: request.previous!,
      generation: prior,
      qualification: "Exact existing site bytes; no deployment or new generation required",
    };
  if (
    next.size > maximumFiles ||
    [...next.values()].reduce((total, bytes) => total + bytes.length, 0) > maximumBytes
  )
    throw new Error("complete site exceeds fixed publication bound");
  const body =
    prior?.schema_version === 2
      ? {
          schema_version: 2 as const,
          previous_generation: request.expected_previous_generation,
          application_root_sha256: request.application_root_sha256,
          catalog_root_sha256: prior.catalog_root_sha256,
          files: nextFiles,
        }
      : {
          schema_version: 1 as const,
          previous_generation: request.expected_previous_generation,
          application_root_sha256: request.application_root_sha256,
          files: nextFiles,
        };
  const generation: Generation = { ...body, generation: capacityDigest(body) };
  next.set("publication.json", Buffer.from(JSON.stringify(generation)));
  if ([...next.values()].reduce((total, bytes) => total + bytes.length, 0) > maximumBytes)
    throw new Error("complete site including marker exceeds fixed publication bound");
  const output = await mkdtemp(path.join(request.output_parent, "site-"));
  await chmod(output, 0o700);
  for (const [name, bytes] of next) {
    remaining(request.deadline);
    await mkdir(path.dirname(path.join(output, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(output, name), bytes, { flag: "wx", mode: 0o600 });
  }
  const observed = await tree(output, request.deadline);
  inspectPrior(observed, generation.generation);
  return {
    authority: "none",
    changed: true,
    output,
    generation,
    qualification:
      "Complete-site bytes only; provider prior-state/executor/deployment/public readback remain required",
  };
}

/** Catalog byte composition only. The caller must independently verify the
 * catalog TUF tree and original whole-site generation. Neither input names nor
 * a self-consistent marker confer signing or deployment authority. */
export async function composeCatalogSiteFiles(request: {
  previous: string | null;
  expected_previous_generation: string | null;
  catalog: string;
  catalog_root_sha256: string;
  output_parent: string;
  deadline?: number;
}) {
  remaining(request.deadline);
  if (
    !digest(request.catalog_root_sha256) ||
    ![
      request.catalog,
      request.output_parent,
      ...(request.previous ? [request.previous] : []),
    ].every((name) => path.isAbsolute(name)) ||
    (request.previous === null
      ? request.expected_previous_generation !== null
      : !digest(request.expected_previous_generation)) ||
    [request.catalog, ...(request.previous ? [request.previous] : [])].some((input) =>
      releasePathContains(input, request.output_parent),
    )
  )
    throw new Error("exact independent catalog site identities unavailable");
  const old = request.previous
    ? await tree(request.previous, request.deadline)
    : new Map<string, Buffer>();
  for (const name of old.keys())
    if (
      name !== "publication.json" &&
      name !== ".nojekyll" &&
      !name.startsWith("application/metadata/") &&
      !name.startsWith("application/targets/") &&
      !name.startsWith("catalog/")
    )
      throw new Error("prior site has an unowned component");
  const prior = request.previous ? inspectPrior(old, request.expected_previous_generation!) : null;
  if (
    prior?.schema_version === 2 &&
    prior.catalog_root_sha256 !== null &&
    prior.catalog_root_sha256 !== request.catalog_root_sha256
  )
    throw new Error("catalog root replacement requires independent authority");
  if (prior?.application_root_sha256 === request.catalog_root_sha256)
    throw new Error("application and catalog roots must differ");
  const catalog = await tree(request.catalog, request.deadline);
  const next: Files = new Map([...old].filter(([name]) => name.startsWith("application/")));
  for (const [name, bytes] of catalog) {
    if (!name.startsWith("metadata/") && !name.startsWith("targets/")) {
      if (name === "repository-manifest.json") continue;
      throw new Error("catalog component has unexpected publication content");
    }
    next.set(`catalog/${name}`, bytes);
  }
  if (!next.has("catalog/metadata/timestamp.json")) throw new Error("catalog timestamp absent");
  for (const [name, bytes] of old)
    if (
      (name.startsWith("application/") ||
        name.startsWith("catalog/targets/") ||
        /^catalog\/metadata\/\d+\./u.test(name)) &&
      !next.get(name)?.equals(bytes)
    )
      throw new Error(`immutable site history would be removed or changed: ${name}`);
  next.set(".nojekyll", Buffer.alloc(0));
  const nextFiles = identities(next);
  if (
    prior?.schema_version === 2 &&
    prior.catalog_root_sha256 === request.catalog_root_sha256 &&
    JSON.stringify(prior.files) === JSON.stringify(nextFiles)
  )
    return {
      authority: "none",
      changed: false,
      output: request.previous!,
      generation: prior,
      qualification: "Exact existing site bytes; no deployment or new generation required",
    };
  const body = {
    schema_version: 2 as const,
    previous_generation: request.expected_previous_generation,
    application_root_sha256: prior?.application_root_sha256 ?? null,
    catalog_root_sha256: request.catalog_root_sha256,
    files: nextFiles,
  };
  const generation: Generation = { ...body, generation: capacityDigest(body) };
  next.set("publication.json", Buffer.from(JSON.stringify(generation)));
  if (
    next.size > maximumFiles ||
    [...next.values()].reduce((total, bytes) => total + bytes.length, 0) > maximumBytes
  )
    throw new Error("complete catalog site exceeds fixed publication bound");
  const output = await mkdtemp(path.join(request.output_parent, "site-"));
  await chmod(output, 0o700);
  for (const [name, bytes] of next) {
    remaining(request.deadline);
    await mkdir(path.dirname(path.join(output, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(output, name), bytes, { flag: "wx", mode: 0o600 });
  }
  inspectPrior(await tree(output, request.deadline), generation.generation);
  return {
    authority: "none",
    changed: true,
    output,
    generation,
    qualification:
      "Complete-site bytes only; catalog admission, provider/executor and public readback remain required",
  };
}

/** Fixed keyless TUF verification and assembly precede composition. No injected
 * verifier, imported success report, private key, candidate hook or network.
 * Root and previous generation expectations come from admitted configuration /
 * existing recovered coordinator, never from the component being verified. */
export async function assembleAuthenticatedApplicationSite(request: {
  input_root: string;
  context: string;
  signed_roles: string;
  trusted_root_sha256: string;
  verifier: string;
  verifier_sha256: string;
  previous_site: string | null;
  expected_previous_generation: string | null;
  output_parent: string;
  deadline?: number;
}) {
  remaining(request.deadline);
  if (
    !digest(request.trusted_root_sha256) ||
    !digest(request.verifier_sha256) ||
    ![
      request.input_root,
      request.context,
      request.signed_roles,
      request.verifier,
      request.output_parent,
    ].every((name) => path.isAbsolute(name))
  )
    throw new Error("fixed site verifier identities unavailable");
  if (releasePathContains(request.input_root, request.output_parent))
    throw new Error("site work would mutate public inputs");
  await assertOwnedUnlinkedPath(request.input_root, request.context, "public TUF context");
  await assertOwnedUnlinkedPath(request.input_root, request.signed_roles, "signed public roles");
  const contextBytes = await boundedFile(request.context, 64 * 1024);
  const context: unknown = JSON.parse(contextBytes.toString("utf8"));
  if (!isRecord(context) || context.schema_version !== 1)
    throw new Error("public TUF context unavailable");
  for (const name of [
    "trusted_root",
    "offline_targets",
    "payload_key_registry",
    "reconstructed_records",
    "previous_repository",
  ]) {
    if (typeof context[name] !== "string") throw new Error("complete public TUF context required");
    await assertOwnedUnlinkedPath(
      request.input_root,
      path.resolve(path.dirname(request.context), context[name]),
      "public TUF input",
    );
  }
  const root = path.resolve(path.dirname(request.context), String(context.trusted_root));
  if (sha(await boundedFile(root, 1024 * 1024)) !== request.trusted_root_sha256)
    throw new Error("independent application root differs");
  // Snapshot the complete public input tree. Its strict bounds reject unrelated
  // credential/hook/cache material; all actual inputs are checked again later.
  const before = identities(await tree(request.input_root, request.deadline));
  const tool = await boundedFile(request.verifier, 128 * 1024 * 1024, true);
  if (sha(tool) !== request.verifier_sha256) throw new Error("trusted keyless verifier changed");
  const work = await mkdtemp(path.join(request.output_parent, "compose-"));
  await chmod(work, 0o700);
  const executable = path.join(work, process.platform === "win32" ? "verify.exe" : "verify");
  await writeFile(executable, tool, { mode: 0o700, flag: "wx" });
  const assembly = path.join(work, "assembly.json");
  const assembled = path.join(work, "application");
  await writeFile(
    assembly,
    JSON.stringify({
      schema_version: 1,
      context: request.context,
      signed_roles: request.signed_roles,
      output: assembled,
    }),
    { mode: 0o600, flag: "wx" },
  );
  // Output cannot overlap the frozen public input tree, even by ancestry.
  if (
    releasePathContains(request.input_root, work) ||
    releasePathContains(work, request.input_root)
  )
    throw new Error("site work overlaps public inputs");
  let result: { stdout: string; stderr: string };
  const timeout = remaining(request.deadline);
  try {
    result = await run(executable, ["assemble-tuf", assembly], {
      cwd: work,
      timeout,
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
  } catch (error) {
    // Keep bounded process facts as well as streams. A silent timeout, signal or
    // spawn refusal must not be reported as an observed TUF validation failure.
    await writeFile(
      path.join(work, "verifier.failure.json"),
      JSON.stringify({
        stage: "keyless-TUF-process",
        timeout_ms: timeout,
        code:
          isRecord(error) && (typeof error.code === "string" || typeof error.code === "number")
            ? error.code
            : null,
        signal: isRecord(error) && typeof error.signal === "string" ? error.signal : null,
        killed: isRecord(error) && typeof error.killed === "boolean" ? error.killed : null,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    for (const name of ["stdout", "stderr"] as const)
      if (isRecord(error) && typeof error[name] === "string")
        await writeFile(
          path.join(work, `verifier.failed.${name}`),
          error[name].slice(0, 1024 * 1024),
          { flag: "wx", mode: 0o600 },
        );
    throw new Error(`keyless TUF assembly refused; retain ${work}`);
  }
  // Keep the actual verifier report, but never interpret its JSON as authority.
  await writeFile(path.join(work, "verifier.stdout.json"), result.stdout, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(path.join(work, "verifier.stderr.log"), result.stderr, {
    flag: "wx",
    mode: 0o600,
  });
  remaining(request.deadline);
  if (
    JSON.stringify(before) !==
      JSON.stringify(identities(await tree(request.input_root, request.deadline))) ||
    sha(await boundedFile(root, 1024 * 1024)) !== request.trusted_root_sha256 ||
    sha(await boundedFile(executable, 128 * 1024 * 1024)) !== request.verifier_sha256
  )
    throw new Error(`public TUF verification inputs changed; retain ${work}`);
  const report: unknown = JSON.parse(result.stdout);
  const publication =
    isRecord(report) && Object.hasOwn(report, "publication")
      ? inspectTufPublicationFacts(report.publication)
      : null;
  if (publication) {
    const publicFiles = await tree(assembled, request.deadline);
    publicFiles.delete("repository-manifest.json");
    const bytes = (name: string) => {
      const value = publicFiles.get(name);
      if (!value) throw new Error("actual assembled publication file missing");
      return value;
    };
    if (
      publication.root_sha256 !== request.trusted_root_sha256 ||
      publication.repository_sha256 !== capacityDigest(identities(publicFiles)) ||
      publication.timestamp_sha256 !== sha(bytes("metadata/timestamp.json")) ||
      publication.snapshot_sha256 !==
        sha(bytes(`metadata/${publication.versions.snapshot}.snapshot.json`)) ||
      publication.offline_targets_sha256 !==
        sha(bytes(`metadata/${publication.versions.targets}.targets.json`))
    )
      throw new Error("actual authenticated publication facts differ from assembled public bytes");
  }
  const site = await composeSiteFiles({
    previous: request.previous_site,
    expected_previous_generation: request.expected_previous_generation,
    application: assembled,
    application_root_sha256: request.trusted_root_sha256,
    output_parent: request.output_parent,
    ...(request.deadline === undefined ? {} : { deadline: request.deadline }),
  });
  return { ...site, publication };
}
