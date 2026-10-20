/** Fixed one-key Rust worker. This layer proves bytes, not current controls,
 * qualification, protected admission or publication. The controller owns those
 * checks and the pending operation before it releases the sole role key. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { payloadSigningEnvironment } from "./release-payload-signing.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import type { TufSigningRole } from "./release-control-phases.mts";
import { isRecord } from "./runtime-values.mts";

const run = promisify(execFile);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roles = ["releases", "preview", "stable", "snapshot", "timestamp"] as const;
type Identity = { filename: string; bytes: number; sha256: string };
export function inspectTufSigningRole(raw: unknown): TufSigningRole {
  if (!roles.some((role) => role === raw)) throw new Error("fixed online TUF role required");
  return raw as TufSigningRole;
}
export function tufRoleDependencies(raw: unknown): readonly TufSigningRole[] {
  const role = inspectTufSigningRole(raw);
  return Object.freeze(
    role === "timestamp" ? roles.slice(0, 4) : role === "snapshot" ? roles.slice(0, 3) : [],
  );
}
export function decodeTufRoleKey(raw: string): Buffer {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 32768 || !raw.length)
    throw new Error("bounded single TUF role key required");
  if (
    /^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----\r?\n?$/u.test(
      raw,
    )
  )
    return Buffer.from(raw);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(raw)) throw new Error("TUF role key encoding differs");
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length || bytes.toString("base64") !== raw)
    throw new Error("TUF role key encoding differs");
  return bytes;
}
function remaining(deadline: number) {
  const left = Math.floor(deadline - performance.now());
  if (!Number.isFinite(deadline) || left < 1) throw new Error("TUF role phase deadline exhausted");
  return Math.min(left, 90_000);
}
const inventory = (files: ReadonlyMap<string, Buffer>) =>
  [...files]
    .map(([filename, bytes]) => ({ filename, bytes: bytes.length, sha256: hash(bytes) }))
    .sort((a, b) => (a.filename < b.filename ? -1 : 1));

/** Only fixed public paths are consumed by the role tool. Reading path fields
 * must not round/re-serialize Rust's u64 version numbers. */
export function inspectTufContextPaths(bytes: Buffer) {
  if (!bytes.length || bytes.length > 65536 || !Buffer.from(bytes.toString("utf8")).equals(bytes))
    throw new Error("bounded UTF-8 TUF context required");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    Object.keys(value).sort().join(",") !==
      "expires,generated_at,offline_targets,payload_key_registry,previous_repository,reconstructed_records,schema_version,trusted_root,versions" ||
    value.trusted_root !== "trusted-root.json" ||
    value.offline_targets !== "offline-targets.json" ||
    value.payload_key_registry !== "payload.json" ||
    value.reconstructed_records !== "records" ||
    value.previous_repository !== "prior"
  )
    throw new Error("fixed routine TUF context paths required");
  return Object.freeze({ kind: "routine" as const });
}

export interface IsolatedTufRoleRequest {
  role: TufSigningRole;
  context_directory: string;
  tool: { path: string; sha256: string };
  signed_roles: readonly (Identity & { path: string })[];
  output: string;
}
export interface TufRoleLifecycle {
  /** Actual controller rechecks controls/pending/custody immediately before key release. */
  beforeKey: () => Promise<void>;
  keyMaterial: () => Promise<Buffer>;
  deadline: number;
}
export function inspectIsolatedTufRoleRequest(raw: unknown): IsolatedTufRoleRequest {
  const value: unknown = structuredClone(raw);
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "context_directory,output,role,signed_roles,tool" ||
    !isRecord(value.tool) ||
    Object.keys(value.tool).sort().join(",") !== "path,sha256" ||
    typeof value.context_directory !== "string" ||
    !path.isAbsolute(value.context_directory) ||
    typeof value.output !== "string" ||
    !path.isAbsolute(value.output) ||
    typeof value.tool.path !== "string" ||
    !path.isAbsolute(value.tool.path) ||
    typeof value.tool.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.tool.sha256) ||
    !Array.isArray(value.signed_roles)
  )
    throw new Error("exact fixed TUF role request required");
  const role = inspectTufSigningRole(value.role),
    dependencies = tufRoleDependencies(role);
  const files: readonly unknown[] = value.signed_roles;
  if (files.length !== dependencies.length)
    throw new Error("complete exact signed TUF dependencies required");
  const signed_roles = files.map((file, index) => {
    if (
      !isRecord(file) ||
      Object.keys(file).sort().join(",") !== "bytes,filename,path,sha256" ||
      file.filename !== `${dependencies[index]}.json` ||
      typeof file.path !== "string" ||
      !path.isAbsolute(file.path) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 512 * 1024 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new Error("complete exact signed TUF dependencies required");
    return {
      filename: String(file.filename),
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  });
  return {
    role,
    context_directory: value.context_directory,
    output: value.output,
    tool: { path: value.tool.path, sha256: value.tool.sha256 },
    signed_roles,
  };
}

/** No subprocess, signer result, shell command or environment can be injected.
 * A pinned executable is a caller trust input at this data-only utility layer;
 * the protected wrapper must derive it from verifiedControllerToolPaths. */
export async function signIsolatedTufRole(
  raw: IsolatedTufRoleRequest,
  lifecycle: TufRoleLifecycle,
) {
  const request = inspectIsolatedTufRoleRequest(raw),
    role = request.role,
    { deadline, beforeKey, keyMaterial } = lifecycle;
  remaining(deadline);
  if (
    releasePathContains(request.context_directory, request.output) ||
    releasePathContains(request.output, request.context_directory) ||
    releasePathContains(request.output, request.tool.path)
  )
    throw new Error("TUF output overlaps trusted inputs");
  await assertOwnedUnlinkedPath(path.dirname(request.output), request.output, "TUF output");
  const dependencies = tufRoleDependencies(role);
  const contextFiles = await readBoundedReleaseContextFiles(request.context_directory);
  const contextBytes = contextFiles.get("context.json");
  if (!contextBytes) throw new Error("TUF context missing");
  inspectTufContextPaths(contextBytes);
  const inputs = inventory(contextFiles),
    inputDigest = digest(inputs);
  const toolBytes = await readControllerToolFile(request.tool.path);
  if (hash(toolBytes) !== request.tool.sha256) throw new Error("TUF tool bytes differ");
  remaining(deadline);
  await mkdir(request.output, { mode: 0o700 });
  const scratch = path.join(request.output, "private-work"),
    publicRoot = path.join(request.output, "public-inputs"),
    envelope = path.join(request.output, `${role}.json`);
  let phase = "stage-public-inputs";
  let secret: Buffer | undefined;
  try {
    await mkdir(scratch, { mode: 0o700 });
    await mkdir(publicRoot, { mode: 0o700 });
    for (const [name, bytes] of contextFiles) {
      remaining(deadline);
      const destination = await assertOwnedUnlinkedPath(
        publicRoot,
        path.join(publicRoot, name),
        "TUF public input",
      );
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    const signedRoot = path.join(request.output, "signed-inputs");
    if (dependencies.length) await mkdir(signedRoot, { mode: 0o700 });
    for (const file of request.signed_roles) {
      const bytes = await readControllerToolFile(file.path, file.bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error("TUF dependency bytes differ");
      await writeFile(path.join(signedRoot, file.filename), bytes, { flag: "wx", mode: 0o600 });
    }
    const env = payloadSigningEnvironment(scratch);
    for (const directory of new Set(
      Object.values(env).filter(
        (value): value is string => typeof value === "string" && value.startsWith(scratch),
      ),
    ))
      await mkdir(directory, { recursive: true, mode: 0o700 });
    const tool = path.join(
      scratch,
      process.platform === "win32" ? "release-tools.exe" : "release-tools",
    );
    await writeFile(tool, toolBytes, { flag: "wx", mode: 0o700 });
    await chmod(tool, 0o700);
    const config = path.join(scratch, "sign.json"),
      keyPath = path.join(scratch, "role.key");
    await writeFile(
      config,
      JSON.stringify({
        schema_version: 1,
        context: path.join(publicRoot, "context.json"),
        signing_key: keyPath,
        output: envelope,
        ...(dependencies.length ? { signed_roles: signedRoot } : {}),
      }),
      { flag: "wx", mode: 0o600 },
    );
    phase = "fresh-controls-before-key";
    await beforeKey();
    remaining(deadline);
    if (
      digest(inventory(await readBoundedReleaseContextFiles(request.context_directory))) !==
        inputDigest ||
      digest(inventory(await readBoundedReleaseContextFiles(publicRoot))) !== inputDigest ||
      hash(await readControllerToolFile(request.tool.path)) !== request.tool.sha256 ||
      hash(await readControllerToolFile(tool)) !== request.tool.sha256
    )
      throw new Error("TUF input custody changed before key release");
    for (const file of request.signed_roles) {
      const bytes = await readControllerToolFile(path.join(signedRoot, file.filename), file.bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error("TUF staged dependency changed before key release");
    }
    phase = "single-role-key";
    secret = await keyMaterial();
    if (!Buffer.isBuffer(secret) || secret.length < 1 || secret.length > 32768)
      throw new Error("bounded single TUF key bytes required");
    remaining(deadline);
    await writeFile(keyPath, secret, { flag: "wx", mode: 0o600 });
    secret.fill(0);
    secret = undefined;
    phase = "fixed-rust-sign";
    const result = await run(tool, ["sign-tuf-role", role, config], {
      cwd: scratch,
      env,
      timeout: remaining(deadline),
      maxBuffer: 65536,
      encoding: "utf8",
      windowsHide: true,
    });
    remaining(deadline);
    const report: unknown = JSON.parse(result.stdout);
    const bytes = await readControllerToolFile(envelope, 512 * 1024);
    if (
      result.stderr ||
      !isRecord(report) ||
      Object.keys(report).sort().join(",") !==
        "authority,bytes,changed,output,role,schema_version,sha256" ||
      report.schema_version !== 1 ||
      report.role !== role ||
      report.authority !== "none" ||
      report.changed !== true ||
      report.output !== envelope ||
      report.bytes !== bytes.length ||
      report.sha256 !== hash(bytes)
    )
      throw new Error("actual TUF tool report/output differs");
    if (
      digest(inventory(await readBoundedReleaseContextFiles(publicRoot))) !== inputDigest ||
      hash(await readControllerToolFile(tool)) !== request.tool.sha256
    )
      throw new Error("TUF staged public inputs/tool changed");
    remaining(deadline);
    const receipt = Object.freeze({
      schema_version: 1,
      role,
      filename: `${role}.json`,
      path: envelope,
      bytes: bytes.length,
      sha256: hash(bytes),
      context_inventory_sha256: inputDigest,
      tool_sha256: request.tool.sha256,
      authority: "none" as const,
    });
    await writeFile(path.join(request.output, "result.json"), JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
    return receipt;
  } catch {
    let partial: Identity | null = null;
    try {
      const bytes = await readControllerToolFile(envelope, 512 * 1024);
      partial = { filename: `${role}.json`, bytes: bytes.length, sha256: hash(bytes) };
    } catch {
      /* No arbitrary diagnostic or credential bytes are copied. */
    }
    await writeFile(
      path.join(request.output, "refusal.json"),
      JSON.stringify({
        schema_version: 1,
        phase,
        role,
        input_inventory_sha256: inputDigest,
        tool_sha256: request.tool.sha256,
        partial_envelope: partial,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("isolated TUF role refused; public evidence retained");
  } finally {
    secret?.fill(0);
    await rm(scratch, { recursive: true, force: true });
  }
}
