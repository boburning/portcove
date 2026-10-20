import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { capacityDigest } from "./release-capacity.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";

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
interface Generation {
  schema_version: 1;
  previous_generation: string | null;
  application_root_sha256: string;
  files: SiteFile[];
  generation: string;
}
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

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
export const isSafeSitePath = (name: string) =>
  name === ".nojekyll" ||
  (name.length <= 512 &&
    name.split("/").length <= 16 &&
    name
      .split("/")
      .every(
        (segment) =>
          /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(segment) && segment !== "." && segment !== "..",
      ));
async function tree(root: string): Promise<Files> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("site input root is linked or not a directory");
  const files: Files = new Map();
  let total = 0,
    entries = 0;
  const walk = async (relative: string, depth: number) => {
    if (depth > 16) throw new Error("site input depth exceeded");
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
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
        total += bytes.length;
        if (total > maximumBytes) throw new Error("site input aggregate byte bound exceeded");
        files.set(name, bytes);
      }
    }
  };
  await walk("", 0);
  return files;
}
function identities(files: Files): SiteFile[] {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) }));
}
function inspectPrior(files: Files, expected: string, rootHash: string) {
  const marker = files.get("publication.json");
  if (!marker || marker.length > 4 * 1024 * 1024)
    throw new Error("prior site generation marker unavailable");
  const value: unknown = JSON.parse(marker.toString("utf8"));
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "application_root_sha256,files,generation,previous_generation,schema_version" ||
    value.schema_version !== 1 ||
    value.generation !== expected ||
    value.application_root_sha256 !== rootHash ||
    !(value.previous_generation === null || digest(value.previous_generation)) ||
    !Array.isArray(value.files)
  )
    throw new Error("prior site generation identity differs");
  const original = new Map(files);
  original.delete("publication.json");
  const wanted = {
    schema_version: 1 as const,
    previous_generation: value.previous_generation,
    application_root_sha256: rootHash,
    files: identities(original),
  };
  if (
    JSON.stringify(value.files) !== JSON.stringify(wanted.files) ||
    capacityDigest(wanted) !== expected
  )
    throw new Error("prior site bytes differ from independently expected generation");
  return { ...wanted, generation: expected };
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
}) {
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
  const old = request.previous ? await tree(request.previous) : new Map<string, Buffer>();
  for (const name of old.keys())
    if (
      name !== "publication.json" &&
      name !== ".nojekyll" &&
      !name.startsWith("application/metadata/") &&
      !name.startsWith("application/targets/") &&
      !name.startsWith("catalog/")
    )
      throw new Error("prior site has an unowned component; preserve and reconcile");
  const prior = request.previous
    ? inspectPrior(old, request.expected_previous_generation!, request.application_root_sha256)
    : null;
  const app = await tree(request.application);
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
  const body = {
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
    await mkdir(path.dirname(path.join(output, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(output, name), bytes, { flag: "wx", mode: 0o600 });
  }
  const observed = await tree(output);
  inspectPrior(observed, generation.generation, request.application_root_sha256);
  return {
    authority: "none",
    changed: true,
    output,
    generation,
    qualification:
      "Complete-site bytes only; provider prior-state/executor/deployment/public readback remain required",
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
}) {
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
  const before = identities(await tree(request.input_root));
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
  try {
    result = await run(executable, ["assemble-tuf", assembly], {
      cwd: work,
      timeout: 120000,
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
  if (
    JSON.stringify(before) !== JSON.stringify(identities(await tree(request.input_root))) ||
    sha(await boundedFile(root, 1024 * 1024)) !== request.trusted_root_sha256 ||
    sha(await boundedFile(executable, 128 * 1024 * 1024)) !== request.verifier_sha256
  )
    throw new Error(`public TUF verification inputs changed; retain ${work}`);
  return composeSiteFiles({
    previous: request.previous_site,
    expected_previous_generation: request.expected_previous_generation,
    application: assembled,
    application_root_sha256: request.trusted_root_sha256,
    output_parent: request.output_parent,
  });
}
