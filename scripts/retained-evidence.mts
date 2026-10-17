import type { FileHandle } from "node:fs/promises";
import type { FileIdentity } from "./development-evidence.mts";
import type { ReceiptInput } from "./native-helper-dependencies.mts";
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EVIDENCE_READ_CHUNK_BYTES, fileIdentity } from "./development-evidence.mts";

export interface ConsumedInput extends FileIdentity {
  retained: FileIdentity;
  binding: "retained-artifact" | "retained-metadata-read" | "live-path-checked-cooperative";
  role?: string;
  kind?: string;
}
export interface RetainedInput extends ConsumedInput {
  captured_at: string;
  deduplicated: boolean;
}
interface RetentionOptions {
  root: string;
  file: string;
  executable?: boolean;
  signal?: AbortSignal;
  capacity?: (root: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  beforePublish?: (input: {
    partial: string;
    published: string;
    identity: FileIdentity;
  }) => Promise<unknown>;
  afterPublish?: (input: {
    published: string;
    identity: FileIdentity;
    deduplicated: boolean;
  }) => Promise<unknown>;
}
const initializing = new Map<string, Promise<string>>();
const verifiedPrivateRoots = new Set<string>();
const windowsPrivateStore = String.raw`
$ErrorActionPreference='Stop'
$directory=[IO.DirectoryInfo]::new($env:PORTCOVE_PRIVATE_EVIDENCE_PATH)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544')
if($env:PORTCOVE_PRIVATE_EVIDENCE_NEW -eq '1') {
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  foreach($principal in $allowed) {
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($principal),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
  }
  [IO.FileSystemAclExtensions]::SetAccessControl($directory,$acl)
}
$observed=[IO.FileSystemAclExtensions]::GetAccessControl($directory)
if($observed.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $observed.AreAccessRulesProtected){throw 'Evidence directory is not privately owned'}
foreach($rule in $observed.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){throw 'Evidence directory permits another principal'}
}
`;

export async function ensureRetainedEvidenceStore(root: string) {
  root = path.resolve(root);
  const existing = initializing.get(root);
  if (existing) return existing;
  const task = (async () => {
    await validateEvidenceStore(root);
    let created = false;
    // Node on Windows rejects recursive mkdir of an existing volume root.
    // Validate existing ancestors without attempting to recreate them.
    try {
      await lstat(path.dirname(root));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    }
    try {
      await mkdir(root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const marker = path.join(root, "retained-evidence.json");
    if (!created) {
      const record: unknown = JSON.parse(await readFile(marker, "utf8"));
      if (!isRecord(record) || record.format_version !== 1 || record.kind !== "retained-evidence")
        throw new Error("Unknown evidence directory; refusing initialization");
    }
    if (!verifiedPrivateRoots.has(root)) {
      if (process.platform === "win32") {
        const result = spawnSync(
          "pwsh.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsPrivateStore],
          {
            encoding: "utf8",
            timeout: 15_000,
            windowsHide: true,
            env: {
              ...process.env,
              PORTCOVE_PRIVATE_EVIDENCE_PATH: root,
              PORTCOVE_PRIVATE_EVIDENCE_NEW: created ? "1" : "0",
            },
          },
        );
        if (result.error || result.status !== 0)
          throw new Error("Private evidence ACL initialization/verification failed", {
            cause: result.error ?? new Error(result.stderr),
          });
      } else if (((await lstat(root)).mode & 0o077) !== 0)
        throw new Error("Evidence directory permits another principal");
      verifiedPrivateRoots.add(root);
    }
    if (created)
      await writeFile(marker, JSON.stringify({ format_version: 1, kind: "retained-evidence" }), {
        flag: "wx",
        mode: 0o600,
      });
    return root;
  })();
  initializing.set(root, task);
  try {
    return await task;
  } finally {
    initializing.delete(root);
  }
}

export function retainedEvidenceRoot(
  outputRoot: string,
  environment = process.env,
  platform = process.platform,
) {
  const configured = environment.PORTCOVE_RETAINED_EVIDENCE_DIR;
  if (configured && !path.isAbsolute(configured))
    throw new Error("Retained evidence root must be absolute");
  return (
    configured ??
    (platform === "win32"
      ? path.join(path.parse(outputRoot).root, "Portcove-Retained-Evidence")
      : path.join(os.homedir(), ".local/share/portcove-retained-evidence"))
  );
}

export async function validateEvidenceStore(root: string) {
  if (!path.isAbsolute(root)) throw new Error("Retained evidence root must be absolute");
  const workspace = fileURLToPath(new URL("../", import.meta.url));
  const relative = path.relative(workspace, root);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    throw new Error("Retained evidence must be outside the checkout and its cleanup roots");
  // Cargo clean can remove an absent or untagged target later. Tags alone do
  // not establish retention. Also refuse common dependency/cache roots in
  // other checkouts; nested incremental storage is covered by target.
  if (
    path
      .resolve(root)
      .split(path.sep)
      .some((part: string) =>
        ["target", "node_modules", "pnpm-store", "browser-cache"].includes(part.toLowerCase()),
      )
  )
    throw new Error("Retained evidence cannot live in disposable cleanup roots");
  let current = path.resolve(root);
  for (;;) {
    try {
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink())
        throw new Error("Retained evidence refuses linked/non-directory ancestry");
      try {
        await lstat(path.join(current, "CACHEDIR.TAG"));
        throw new Error("Retained evidence cannot live in disposable cache ancestry");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function retainEvidenceInput({
  root,
  file,
  executable = false,
  capacity = statfs,
  beforePublish = async () => {},
  afterPublish = async () => {},
  signal,
}: RetentionOptions): Promise<RetainedInput> {
  await ensureRetainedEvidenceStore(root);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Retention requires an ordinary input file");
  const space = await capacity(root);
  if (
    !Number.isFinite(Number(space.bavail) * Number(space.bsize)) ||
    Number(space.bavail) * Number(space.bsize) < before.size
  )
    throw new Error("Insufficient observed capacity for retained input");
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await validateEvidenceStore(staging);
  const partial = path.join(staging, `${randomUUID()}.partial`);
  const input = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: FileHandle | null | undefined;
  let identity: FileIdentity | undefined;
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Retention input identity changed before opening");
    output = await open(partial, "wx", 0o600);
    signal?.throwIfAborted();
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of input.createReadStream({
      autoClose: false,
      signal,
      highWaterMark: EVIDENCE_READ_CHUNK_BYTES,
    })) {
      const data: unknown = chunk;
      if (!Buffer.isBuffer(data)) throw new Error("Retention stream did not produce bytes");
      hash.update(data);
      bytes += data.length;
      if (bytes > before.size) throw new Error("Retention input grew during capture");
      await output.writeFile(data);
    }
    identity = { path: path.resolve(file), bytes, sha256: hash.digest("hex") };
    const after = await fileIdentity(file, { maxBytes: bytes, signal });
    const current = await lstat(file);
    if (
      bytes !== before.size ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      after.bytes !== bytes ||
      after.sha256 !== identity.sha256
    )
      throw new Error("Retention input content or identity changed during capture");
    const retained = await fileIdentity(partial, { maxBytes: bytes, signal });
    if (retained.bytes !== bytes || retained.sha256 !== identity.sha256)
      throw new Error("Private retained input verification failed");
    const directory = path.join(root, "objects", identity.sha256.slice(0, 2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await validateEvidenceStore(directory);
    const published = path.join(
      directory,
      `${identity.sha256}${executable ? (process.platform === "win32" ? ".exe" : ".executable") : ".input"}`,
    );
    let deduplicated = false;
    try {
      const existing = await fileIdentity(published, { maxBytes: bytes, signal });
      if (existing.sha256 !== identity.sha256 || existing.bytes !== bytes)
        throw new Error("Published evidence is corrupt; refusing overwrite");
      deduplicated = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    // Only a new object needs this private copy durably flushed. A verified
    // published object already has custody; never publish the unsynced copy
    // if that object disappears before the final verification.
    if (!deduplicated) await output.sync();
    await output.close();
    output = null;
    await chmod(partial, executable ? 0o500 : 0o400);
    await beforePublish({ partial, published, identity });
    signal?.throwIfAborted();
    const ready = await fileIdentity(partial, { maxBytes: bytes, signal });
    if (ready.sha256 !== identity.sha256 || ready.bytes !== bytes)
      throw new Error("Private retained input changed before publication");
    if (!deduplicated) {
      try {
        await link(partial, published);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        deduplicated = true;
      }
    }
    await afterPublish({ published, identity, deduplicated });
    const actual = await fileIdentity(published);
    if (actual.sha256 !== identity.sha256 || actual.bytes !== bytes)
      throw new Error("Published evidence is corrupt; refusing overwrite");
    await unlink(partial);
    return {
      ...identity,
      retained: actual,
      captured_at: new Date().toISOString(),
      deduplicated,
      binding: executable ? "retained-artifact" : "live-path-checked-cooperative",
    };
  } catch (error) {
    const failure = `${partial}.failure.json`;
    try {
      await writeFile(
        failure,
        JSON.stringify({
          captured_at: new Date().toISOString(),
          input: identity ?? { path: path.resolve(file) },
          partial,
          error: errorMessage(error),
        }),
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      /* Keep original failure and any partial bytes. */
    }
    throw new Error(`${errorMessage(error)}; retained partial evidence: ${partial}`, {
      cause: error,
    });
  } finally {
    if (output) await output.close();
    await input.close();
  }
}

export async function verifyConsumedInputs(
  inputs: readonly ConsumedInput[],
  { livePaths = true, signal }: { livePaths?: boolean; signal?: AbortSignal | undefined } = {},
) {
  for (const input of inputs) {
    const retained = await fileIdentity(input.retained.path, { maxBytes: input.bytes, signal });
    if (retained.sha256 !== input.sha256 || retained.bytes !== input.bytes)
      throw new Error("Retained execution input changed");
    if (livePaths && input.binding === "live-path-checked-cooperative") {
      const live = await fileIdentity(input.path, { maxBytes: input.bytes, signal });
      if (live.sha256 !== input.sha256 || live.bytes !== input.bytes)
        throw new Error("Live execution input changed after capture");
    }
  }
}

export function executionAdmission(startedAt: string, budgetMs: number, now = Date.now) {
  const expires = Date.parse(startedAt) + budgetMs;
  if (!Number.isFinite(expires) || !Number.isFinite(budgetMs) || budgetMs <= 0)
    throw new Error("Invalid execution deadline");
  const remaining = () => expires - now();
  const signal = AbortSignal.timeout(Math.max(0, Math.min(2_147_483_647, remaining())));
  function assertReady() {
    signal.throwIfAborted();
    if (remaining() <= 0) throw new Error("Execution deadline expired before launch");
  }
  return {
    signal,
    assertReady,
    async verify(inputs: readonly ConsumedInput[]) {
      assertReady();
      await verifyConsumedInputs(inputs, { signal });
      assertReady();
    },
  };
}

export function retainedExecutableCanLaunch(
  input: { role: string; path: string },
  drivers: { driver?: string; nativeDriver?: string } | null | undefined,
  platform: NodeJS.Platform = process.platform,
) {
  // Product metadata is provenance, never proof of a relocatable layout.
  // Only the bootstrap's standalone cached driver executables are established.
  return (
    (input.role === "driver" && input.path === drivers?.driver) ||
    (platform === "win32" && input.role === "native-driver" && input.path === drivers?.nativeDriver)
  );
}

export async function readPrelaunchCustody(
  file: string,
  {
    root,
    revision,
    plan,
    values,
    selectedScenarios,
    deadlineMs,
  }: {
    root: string;
    revision: string;
    plan: { receiptInputs: readonly ReceiptInput[] };
    values: Record<string, unknown>;
    selectedScenarios: readonly string[];
    deadlineMs: number;
  },
) {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  const manifest = object(raw);
  if (
    typeof manifest.execution_started_at !== "string" ||
    typeof manifest.created_at !== "string" ||
    !Number.isFinite(Date.parse(manifest.execution_started_at)) ||
    !Number.isFinite(Date.parse(manifest.created_at)) ||
    Date.parse(manifest.execution_started_at) > Date.parse(manifest.created_at) ||
    Date.parse(manifest.created_at) > Date.now()
  )
    throw new Error("Prelaunch execution timing is invalid");
  if (
    manifest.format_version !== 1 ||
    manifest.root !== root ||
    manifest.revision !== revision ||
    manifest.pre_import_for !== "apps/desktop/scripts/desktop-test.mts" ||
    JSON.stringify(manifest.selected_scenarios) !== JSON.stringify(selectedScenarios) ||
    !Array.isArray(manifest.inputs)
  )
    throw new Error("Prelaunch input custody does not bind this execution");
  const declared = plan.receiptInputs.map((input) =>
    input.kind === "file" ? input.path : input.name,
  );
  const inputs: unknown[] = manifest.inputs;
  const records = inputs.map(object);
  const roles = records.map((input) => string(input.role));
  if (
    new Set(roles).size !== roles.length ||
    JSON.stringify([...roles].sort()) !== JSON.stringify([...declared].sort())
  )
    throw new Error("Prelaunch input inventory is incomplete");
  const consumed: (ConsumedInput & { role: string })[] = [];
  for (const input of records) {
    const expected = plan.receiptInputs.find(
      (entry) => (entry.kind === "file" ? entry.path : entry.name) === input.role,
    );
    if (
      !expected ||
      typeof input.role !== "string" ||
      typeof input.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      typeof input.bytes !== "number" ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 0 ||
      !isRecord(input.retained) ||
      typeof input.retained.path !== "string" ||
      !path.isAbsolute(input.retained.path) ||
      (expected.kind === "argument-file"
        ? input.binding !== "retained-metadata-read" ||
          path.resolve(string(values[expected.name] ?? ".")) !== input.retained.path
        : expected.kind === "executable"
          ? (input.binding !== "retained-artifact" &&
              input.binding !== "live-path-checked-cooperative") ||
            path.resolve(string(values[expected.name] ?? ".")) !==
              (input.binding === "retained-artifact" ? input.retained.path : input.path)
          : input.binding !== "live-path-checked-cooperative" ||
            input.path !== path.join(root, string(expected.path)))
    )
      throw new Error("Consumed input differs from the prelaunch declaration");
    consumed.push(consumedInput(input));
  }
  await executionAdmission(manifest.execution_started_at, deadlineMs).verify(consumed);
  return {
    ...manifest,
    execution_started_at: manifest.execution_started_at,
    created_at: manifest.created_at,
    inputs: consumed,
    retained_metadata: manifest.retained_metadata,
    limitations: manifest.limitations,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Retained custody must be an object");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Retained custody path must be a string");
  return value;
}
function consumedInput(input: Record<string, unknown>): ConsumedInput & { role: string } {
  const retained = object(input.retained);
  if (input.kind !== undefined && typeof input.kind !== "string")
    throw new Error("Consumed input kind must be a string");
  if (
    typeof input.bytes !== "number" ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0 ||
    typeof retained.bytes !== "number" ||
    !Number.isSafeInteger(retained.bytes) ||
    retained.bytes < 0 ||
    typeof retained.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(retained.sha256) ||
    (input.binding !== "retained-artifact" &&
      input.binding !== "retained-metadata-read" &&
      input.binding !== "live-path-checked-cooperative")
  )
    throw new Error("Consumed input differs from the prelaunch declaration");
  return {
    ...input,
    ...(typeof input.kind === "string" ? { kind: input.kind } : {}),
    path: string(input.path),
    bytes: input.bytes,
    sha256: string(input.sha256),
    role: string(input.role),
    binding: input.binding,
    retained: {
      ...retained,
      path: string(retained.path),
      bytes: retained.bytes,
      sha256: retained.sha256,
    },
  };
}
