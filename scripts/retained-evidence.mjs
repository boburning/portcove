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
import { fileIdentity } from "./development-evidence.mjs";

const initializing = new Map();
const verifiedPrivateRoots = new Set();
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

export async function ensureRetainedEvidenceStore(root) {
  root = path.resolve(root);
  if (initializing.has(root)) return initializing.get(root);
  const task = (async () => {
    await validateEvidenceStore(root);
    let created = false;
    // Node on Windows rejects recursive mkdir of an existing volume root.
    // Validate existing ancestors without attempting to recreate them.
    try {
      await lstat(path.dirname(root));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
    }
    try {
      await mkdir(root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const marker = path.join(root, "retained-evidence.json");
    if (!created) {
      const record = JSON.parse(await readFile(marker, "utf8"));
      if (record.format_version !== 1 || record.kind !== "retained-evidence")
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
  outputRoot,
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

export async function validateEvidenceStore(root) {
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
      .some((part) =>
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
        if (error.code !== "ENOENT") throw error;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
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
}) {
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
  let output;
  let identity;
  try {
    const opened = await input.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Retention input identity changed before opening");
    output = await open(partial, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of input.createReadStream({ autoClose: false, signal })) {
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes > before.size) throw new Error("Retention input grew during capture");
      await output.writeFile(chunk);
    }
    await output.sync();
    await output.close();
    output = null;
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
    await chmod(partial, executable ? 0o500 : 0o400);
    await beforePublish({ partial, published, identity });
    signal?.throwIfAborted();
    const ready = await fileIdentity(partial, { maxBytes: bytes, signal });
    if (ready.sha256 !== identity.sha256 || ready.bytes !== bytes)
      throw new Error("Private retained input changed before publication");
    let deduplicated = false;
    try {
      await link(partial, published);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      deduplicated = true;
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
          error: error.message,
        }),
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      /* Keep original failure and any partial bytes. */
    }
    throw new Error(`${error.message}; retained partial evidence: ${partial}`, { cause: error });
  } finally {
    if (output) await output.close();
    await input.close();
  }
}

export async function verifyConsumedInputs(inputs, { livePaths = true, signal } = {}) {
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

export function executionAdmission(startedAt, budgetMs, now = Date.now) {
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
    async verify(inputs) {
      assertReady();
      await verifyConsumedInputs(inputs, { signal });
      assertReady();
    },
  };
}

export function retainedExecutableCanLaunch(input, drivers, platform = process.platform) {
  // Product metadata is provenance, never proof of a relocatable layout.
  // Only the bootstrap's standalone cached driver executables are established.
  return (
    (input.role === "driver" && input.path === drivers?.driver) ||
    (platform === "win32" && input.role === "native-driver" && input.path === drivers?.nativeDriver)
  );
}

export async function readPrelaunchCustody(
  file,
  { root, revision, plan, values, selectedScenarios, deadlineMs },
) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (
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
    manifest.pre_import_for !== "apps/desktop/scripts/desktop-test.mjs" ||
    JSON.stringify(manifest.selected_scenarios) !== JSON.stringify(selectedScenarios) ||
    !Array.isArray(manifest.inputs)
  )
    throw new Error("Prelaunch input custody does not bind this execution");
  const declared = plan.receiptInputs.map((input) =>
    ["executable", "argument-file"].includes(input.kind) ? input.name : input.path,
  );
  const roles = manifest.inputs.map((input) => input.role);
  if (
    new Set(roles).size !== roles.length ||
    JSON.stringify([...roles].sort()) !== JSON.stringify([...declared].sort())
  )
    throw new Error("Prelaunch input inventory is incomplete");
  for (const input of manifest.inputs) {
    const expected = plan.receiptInputs.find(
      (entry) =>
        (["executable", "argument-file"].includes(entry.kind) ? entry.name : entry.path) ===
        input.role,
    );
    if (
      !/^[a-f0-9]{64}$/u.test(input.sha256 ?? "") ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 0 ||
      !path.isAbsolute(input.retained?.path ?? "") ||
      (expected.kind === "argument-file"
        ? input.binding !== "retained-metadata-read" ||
          path.resolve(values[expected.name] ?? ".") !== input.retained.path
        : expected.kind === "executable"
          ? !["retained-artifact", "live-path-checked-cooperative"].includes(input.binding) ||
            path.resolve(values[expected.name] ?? ".") !==
              (input.binding === "retained-artifact" ? input.retained.path : input.path)
          : input.binding !== "live-path-checked-cooperative" ||
            input.path !== path.join(root, expected.path))
    )
      throw new Error("Consumed input differs from the prelaunch declaration");
  }
  await executionAdmission(manifest.execution_started_at, deadlineMs).verify(manifest.inputs);
  return manifest;
}
