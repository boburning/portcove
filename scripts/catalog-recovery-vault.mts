/** Offline catalog custody adapter. Parsing appointments does not authorize a
 * private-key read. The invoking owner supplies the already-authorized private
 * custody and read-only Tough projection closures. No installation, activation,
 * Root rotation, signing, publication or grant operation exists here. */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { inspectSelectedPublicationAuthorityConfiguration } from "./release-authority-configuration-contract.mts";
import { prepareRecoveryTools } from "./prepare-recovery-tools.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const maximum = 1024 * 1024;
const keyMaximum = 32 * 1024;
function exact(value: unknown, fields: string): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== fields.split(",").sort().join(",")
  )
    throw new Error("recovery schema differs");
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error("recovery public identity differs");
}
type Binding = Readonly<{
  role: string;
  key_id: string;
  kind: "tuf" | "github-app";
  public_key: unknown;
}>;
type Plan = Readonly<{ context_sha256: string; bindings: readonly Binding[] }>;
const plans = new WeakSet<Plan>();
type PrivateInspector = (
  binding: Binding,
  material: Buffer,
) => Promise<{ public_key_id: string; authority: "none" }>;
const inspectors = new WeakMap<
  Plan,
  {
    inspectTuf: PrivateInspector;
    source_commit: string;
    source_tree: string;
    verifier_sha256: string;
  }
>();
const tufRoles = [
  "catalog-root",
  "catalog-targets",
  "catalog-snapshot",
  "catalog-timestamp",
  "catalog-official-definitions",
  "catalog-official-policy",
];
const appRoles = ["semantic", "protection_observer"] as const;
function freeze(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** inventory must be the actual read-only inspect-catalog-key-inventory output
 * from the independently selected release-tools binary/source, not a grant.
 * expectedConfigurationSha256 is an independently approved public source pin.
 * Historical metadata can recover identities without granting fresh signing. */
export function inspectCatalogRecoveryPlan(options: {
  configuration: Buffer;
  expectedConfigurationSha256: string;
  inventory: unknown;
  appPublicCaptures: unknown;
}) {
  digest(options.expectedConfigurationSha256);
  if (
    !Buffer.isBuffer(options.configuration) ||
    options.configuration.length > 32768 ||
    hash(options.configuration) !== options.expectedConfigurationSha256
  )
    throw new Error("recovery configuration differs from independent source pin");
  const selected = inspectSelectedPublicationAuthorityConfiguration(
    JSON.parse(options.configuration.toString("utf8")),
  );
  if (selected.purpose !== "catalog-publication") throw new Error("catalog-only recovery required");
  const inventory = options.inventory;
  exact(
    inventory,
    "schema_version,operation,initial_root_profile,root_sha256,targets_sha256,root_version,targets_version,keys,freshness,authority",
  );
  if (
    inventory.schema_version !== 1 ||
    inventory.operation !== "inspect-catalog-key-inventory" ||
    inventory.initial_root_profile !== "single-owner-one-of-one-v1" ||
    inventory.authority !== "none" ||
    inventory.freshness !== "not-evaluated-historical-key-bindings-only" ||
    inventory.root_sha256 !== selected.catalog.public_source.root.sha256 ||
    inventory.targets_sha256 !== selected.catalog.public_source.offline_targets.sha256 ||
    typeof inventory.root_version !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(inventory.root_version) ||
    typeof inventory.targets_version !== "string" ||
    !/^[1-9][0-9]{0,19}$/u.test(inventory.targets_version) ||
    !Array.isArray(inventory.keys) ||
    inventory.keys.length < 1 ||
    inventory.keys.length > 32
  )
    throw new Error("catalog recovery public inventory differs");
  const bindings: Binding[] = inventory.keys.map((entry: unknown) => {
    exact(entry, "role,key_id,public_key");
    digest(entry.key_id);
    if (
      typeof entry.role !== "string" ||
      !tufRoles.includes(entry.role) ||
      !isRecord(entry.public_key)
    )
      throw new Error("catalog recovery role differs");
    return Object.freeze({
      role: entry.role,
      key_id: entry.key_id,
      kind: "tuf" as const,
      public_key: freeze(structuredClone(entry.public_key)),
    });
  });
  if (tufRoles.some((role) => !bindings.some((entry) => entry.role === role)))
    throw new Error("catalog recovery role absent");
  exact(options.appPublicCaptures, "semantic,protection_observer");
  for (const role of appRoles) {
    const capture = options.appPublicCaptures[role];
    exact(capture, "app_id,public_key_sha256");
    digest(capture.public_key_sha256);
    if (capture.app_id !== selected.journal.apps[role].app_id)
      throw new Error("recovery App capture differs from appointment");
    bindings.push(
      Object.freeze({
        role: `github-app-${role}`,
        key_id: capture.public_key_sha256,
        kind: "github-app",
        public_key: freeze({ app_id: capture.app_id, spki_sha256: capture.public_key_sha256 }),
      }),
    );
  }
  if (
    new Set(bindings.map((entry) => entry.key_id)).size !== bindings.length ||
    new Set(bindings.map((entry) => entry.role)).size !== bindings.length
  )
    throw new Error("recovery private identities or roles alias");
  bindings.sort((a, b) => a.role.localeCompare(b.role));
  const plan = Object.freeze({
    context_sha256: hash(
      JSON.stringify({
        configuration_sha256: options.expectedConfigurationSha256,
        inventory,
        app_public_captures: options.appPublicCaptures,
      }),
    ),
    bindings: Object.freeze(bindings),
  });
  return plan;
}
/** Like the existing renewal adapter, snapshot an independently ratified local
 * executable and its pinned public inputs. This local preparation is not a
 * protected-controller receipt and never grants private custody or signing. */
export async function prepareCatalogRecoveryPlan(request: {
  configuration: Buffer;
  expectedConfigurationSha256: string;
  appPublicCaptures: unknown;
  verifier: string;
  verifierSha256: string;
  sourceCommit: string;
  sourceTree: string;
  trustedRoot: string;
  offlineTargets: string;
  parent: string;
}) {
  if (!Buffer.isBuffer(request.configuration) || request.configuration.length > 32768)
    throw new Error("bounded catalog configuration bytes required");
  const options = {
    ...request,
    configuration: Buffer.from(request.configuration),
    appPublicCaptures: structuredClone(request.appPublicCaptures),
  };
  digest(options.verifierSha256);
  if (!/^[a-f0-9]{40}$/u.test(options.sourceCommit) || !/^[a-f0-9]{40}$/u.test(options.sourceTree))
    throw new Error("independently ratified recovery inspector source required");
  digest(options.expectedConfigurationSha256);
  if (hash(options.configuration) !== options.expectedConfigurationSha256)
    throw new Error("independent configuration pin differs");
  const selected = inspectSelectedPublicationAuthorityConfiguration(
    JSON.parse(options.configuration.toString("utf8")),
  );
  if (selected.purpose !== "catalog-publication") throw new Error("catalog-only recovery required");
  await privateParent(options.parent);
  const boundedPublic = async (filename: string, bound: number) => {
    const stat = await lstat(filename);
    if (
      !path.isAbsolute(filename) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (await realpath(filename)) !== filename
    )
      throw new Error("owned bounded inspector public input required");
    return await readControllerToolFile(filename, bound, stat);
  };
  const binary = await boundedPublic(options.verifier, 128 * 1024 ** 2);
  if (hash(binary) !== options.verifierSha256)
    throw new Error("qualified recovery inspector differs");
  const root = await boundedPublic(options.trustedRoot, 1024 * 1024),
    top = await boundedPublic(options.offlineTargets, 1024 * 1024);
  if (
    hash(root) !== selected.catalog.public_source.root.sha256 ||
    root.length !== selected.catalog.public_source.root.bytes ||
    hash(top) !== selected.catalog.public_source.offline_targets.sha256 ||
    top.length !== selected.catalog.public_source.offline_targets.bytes
  )
    throw new Error("catalog public recovery source differs");
  const work = await mkdtemp(path.join(options.parent, "catalog-inspector-"));
  const verifier = path.join(work, "inspector");
  await durableFile(verifier, binary);
  await chmod(verifier, 0o700);
  await durableFile(path.join(work, "root.json"), root);
  await durableFile(path.join(work, "targets.json"), top);
  await durableFile(
    path.join(work, "inventory.json"),
    JSON.stringify({
      schema_version: 1,
      initial_root_profile: "single-owner-one-of-one-v1",
      trusted_root: "root.json",
      trusted_root_sha256: hash(root),
      offline_targets: "targets.json",
      offline_targets_sha256: hash(top),
    }),
  );
  const command = async (operation: string, config: string) => {
    if (hash(await readPrivate(verifier, 128 * 1024 ** 2)) !== options.verifierSha256)
      throw new Error("recovery inspector changed");
    try {
      const result = await promisify(execFile)(verifier, [operation, config], {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("read-only recovery inspector refused");
    }
  };
  const result = inspectCatalogRecoveryPlan({
    configuration: options.configuration,
    expectedConfigurationSha256: options.expectedConfigurationSha256,
    appPublicCaptures: options.appPublicCaptures,
    inventory: await command("inspect-catalog-key-inventory", path.join(work, "inventory.json")),
  });
  const inspectTuf: PrivateInspector = async (binding, material) => {
    const temporary = await mkdtemp(path.join(work, "private-inspection-"));
    try {
      const publicBytes = Buffer.from(JSON.stringify(binding.public_key));
      await durableFile(path.join(temporary, "public.json"), publicBytes);
      await durableFile(path.join(temporary, "private.key"), material);
      const config = path.join(temporary, "request.json");
      await durableFile(
        config,
        JSON.stringify({
          schema_version: 1,
          private_key: "private.key",
          expected_public_key: { path: "public.json", sha256: hash(publicBytes) },
        }),
      );
      const report = await command("inspect-existing-tuf-key", config);
      exact(report, "schema_version,operation,public_key_id,authority");
      if (
        report.schema_version !== 1 ||
        report.operation !== "inspect-existing-tuf-key" ||
        typeof report.public_key_id !== "string" ||
        report.authority !== "none"
      )
        throw new Error("recovery inspector key report differs");
      return { public_key_id: report.public_key_id, authority: "none" };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
  plans.add(result);
  inspectors.set(result, {
    inspectTuf,
    source_commit: options.sourceCommit,
    source_tree: options.sourceTree,
    verifier_sha256: options.verifierSha256,
  });
  return result;
}
function plan(value: Plan) {
  if (!plans.has(value)) throw new Error("locally inspected catalog recovery plan required");
}
export type CatalogRecoveryOwner = {
  /** Actual caller must already hold the separate custody/read authorization.
   * The callback is invoked only with the complete derived public appointment,
   * must be bounded, and transfers a fresh buffer that this adapter clears. */
  read: (binding: Binding) => Promise<Buffer>;
};
async function inspect(binding: Binding, material: Buffer, inspector: PrivateInspector) {
  if (!Buffer.isBuffer(material) || !material.length || material.length > keyMaximum)
    throw new Error("bounded recovery private material required");
  if (binding.kind === "tuf") {
    const result = await inspector(binding, material);
    if (result.public_key_id !== binding.key_id || result.authority !== "none")
      throw new Error("recovery Tough projection differs");
  } else {
    const privateKey = createPrivateKey(material);
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      hash(createPublicKey(privateKey).export({ format: "der", type: "spki" })) !== binding.key_id
    )
      throw new Error("recovery App public projection differs");
  }
}
async function privateParent(parent: string) {
  if (process.platform !== "linux" || !path.isAbsolute(parent))
    throw new Error("offline Linux private parent required");
  const stat = await lstat(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(parent)) !== parent
  )
    throw new Error("owned canonical private recovery parent required");
}
async function durableFile(filename: string, bytes: Buffer | string) {
  const file = await open(filename, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(directory: string) {
  const file = await open(directory, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function readPrivate(filename: string, bound: number) {
  const before = await lstat(filename);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o077) !== 0 ||
    (await realpath(filename)) !== filename
  )
    throw new Error("owned single-link private recovery file required");
  const bytes = await readControllerToolFile(filename, bound, before);
  const after = await lstat(filename);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.ctimeMs !== before.ctimeMs ||
    after.mtimeMs !== before.mtimeMs ||
    after.mode !== before.mode ||
    after.nlink !== 1 ||
    (await realpath(filename)) !== filename
  )
    throw new Error("recovery file changed during acquisition");
  return bytes;
}
/** Bounded ordinary-owner custody file acquisition for the authorized read
 * callback. Calling this function requires the separate custody grant; neither
 * its path nor a prepared public plan grants access or selects a private file. */
export async function readCatalogCustodyMaterial(filename: string) {
  return await readPrivate(filename, keyMaximum);
}
/** Pinned age only. No inherited credentials, shell, plugins, proxy, hooks,
 * terminal/passphrase prompt or private material in command arguments. The
 * identity is sent over a private fd; stdout is accepted only after exit0. */
async function age(
  toolParent: string,
  input: Buffer,
  recipient: string | undefined,
  identity: Buffer | undefined,
  directory: string,
  signal?: AbortSignal,
) {
  const tools = await prepareRecoveryTools(toolParent);
  const receipt = tools.receipt;
  if (!isRecord(receipt) || !Array.isArray(receipt.tools))
    throw new Error("verified recovery tool unavailable");
  const entry: unknown = receipt.tools.find(
    (item: unknown) =>
      isRecord(item) && typeof item.path === "string" && item.path.endsWith("/age"),
  );
  if (
    !isRecord(entry) ||
    typeof entry.path !== "string" ||
    typeof entry.sha256 !== "string" ||
    hash(await readControllerToolFile(entry.path, 64 * 1024 ** 2)) !== entry.sha256
  )
    throw new Error("verified age executable changed");
  if (recipient !== undefined && !/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/u.test(recipient))
    throw new Error("native age recipient required; no plugin or arbitrary recipient file");
  if (
    identity !== undefined &&
    (!identity.length ||
      identity.length > 4096 ||
      !/^AGE-SECRET-KEY-1[0-9A-Z]+\n?$/u.test(identity.toString("ascii")))
  )
    throw new Error("bounded native age identity required");
  signal?.throwIfAborted();
  // A regular held ciphertext fd avoids reopening the input pathname. Native
  // identity travels on stdin: Node's extra pipe descriptors are sockets and
  // cannot safely stand in for an age identity filename on Linux.
  const ciphertext = identity
    ? await open(path.join(directory, "ciphertext.age"), "wx+", 0o600)
    : undefined;
  try {
    if (ciphertext) {
      await ciphertext.writeFile(input);
      await ciphertext.sync();
    }
    signal?.throwIfAborted();
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        entry.path as string,
        recipient
          ? ["--encrypt", "--recipient", recipient]
          : ["--decrypt", "--identity", "-", "/dev/fd/3"],
        {
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          stdio: ["pipe", "pipe", "pipe", ciphertext?.fd ?? "ignore"],
        },
      );
      const chunks: Buffer[] = [];
      let total = 0,
        failed = false;
      const fail = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(fail, 30_000);
      signal?.addEventListener("abort", fail, { once: true });
      child.stdout!.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maximum) {
          fail();
          return;
        }
        chunks.push(chunk);
      });
      child.stderr!.resume(); // Never retain diagnostics that might expose private inputs.
      child.stdin!.on("error", fail);
      child.on("error", () => {
        failed = true;
      });
      child.stdin!.end(identity ?? input);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", fail);
        if (failed || code !== 0 || !total) {
          for (const chunk of chunks) chunk.fill(0);
          reject(new Error("recovery age operation refused or interrupted; no plaintext accepted"));
        } else {
          const result = Buffer.concat(chunks);
          for (const chunk of chunks) chunk.fill(0);
          resolve(result);
        }
      });
    });
  } finally {
    await ciphertext?.close();
  }
}
function name(value: string) {
  if (!/^[a-z][a-z0-9-]{0,70}$/u.test(value))
    throw new Error("fixed recovery output name required");
  return value;
}

export async function createCatalogRecoveryVault(options: {
  plan: Plan;
  owner: CatalogRecoveryOwner;
  toolParent: string;
  parent: string;
  name: string;
  recipient: string;
  signal?: AbortSignal;
}) {
  plan(options.plan);
  await privateParent(options.parent);
  name(options.name);
  await prepareRecoveryTools(options.toolParent);
  // Reserve before private reads; partial output remains a non-overwritable,
  // incomplete attempt. A retry must use a new explicit owner-selected name.
  const directory = path.join(options.parent, options.name);
  await mkdir(directory, { mode: 0o700 });
  const material: Buffer[] = [];
  let plaintext: Buffer | undefined;
  try {
    const keys = [];
    for (const binding of options.plan.bindings) {
      options.signal?.throwIfAborted();
      const value = await options.owner.read(binding);
      if (!Buffer.isBuffer(value)) throw new Error("bounded recovery private material required");
      material.push(value);
      options.signal?.throwIfAborted();
      await inspect(binding, value, inspectors.get(options.plan)!.inspectTuf);
      options.signal?.throwIfAborted();
      keys.push({
        role: binding.role,
        key_id: binding.key_id,
        material_base64: value.toString("base64"),
      });
    }
    plaintext = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        kind: "catalog-owner-recovery-v1",
        context_sha256: options.plan.context_sha256,
        keys,
      }),
    );
    if (plaintext.length > maximum - 65536) throw new Error("recovery bundle exceeds bound");
    const encrypted = await age(
      options.toolParent,
      plaintext,
      options.recipient,
      undefined,
      directory,
      options.signal,
    );
    options.signal?.throwIfAborted();
    await durableFile(path.join(directory, "catalog.age"), encrypted);
    options.signal?.throwIfAborted();
    const result = {
      schema_version: 1,
      operation: "create-catalog-recovery",
      context_sha256: options.plan.context_sha256,
      encrypted_sha256: hash(encrypted),
      encrypted_bytes: encrypted.length,
      inspector: {
        source_commit: inspectors.get(options.plan)!.source_commit,
        source_tree: inspectors.get(options.plan)!.source_tree,
        verifier_sha256: inspectors.get(options.plan)!.verifier_sha256,
      },
      roles: options.plan.bindings.map(({ role, key_id }) => ({ role, key_id })),
      authority: "none",
      activation: "not-performed",
      completion: "encrypted-only",
    };
    await durableFile(path.join(directory, "complete.json"), JSON.stringify(result));
    await syncDirectory(directory);
    await syncDirectory(options.parent);
    return result;
  } finally {
    plaintext?.fill(0);
    for (const value of material) value.fill(0);
  }
}

export async function restoreCatalogRecoveryVault(options: {
  plan: Plan;
  toolParent: string;
  parent: string;
  name: string;
  ciphertext: string;
  expectedCiphertextSha256: string;
  identity: Buffer;
  signal?: AbortSignal;
}) {
  plan(options.plan);
  digest(options.expectedCiphertextSha256);
  await privateParent(options.parent);
  name(options.name);
  const directory = path.join(options.parent, options.name);
  await mkdir(directory, { mode: 0o700 });
  const encrypted = await readPrivate(options.ciphertext, maximum);
  if (hash(encrypted) !== options.expectedCiphertextSha256)
    throw new Error("recovery ciphertext differs from retained copy identity");
  let plaintext: Buffer | undefined;
  const material: Buffer[] = [];
  try {
    plaintext = await age(
      options.toolParent,
      encrypted,
      undefined,
      options.identity,
      directory,
      options.signal,
    );
    let bundle: unknown;
    try {
      bundle = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("authenticated recovery bundle malformed");
    }
    exact(bundle, "schema_version,kind,context_sha256,keys");
    if (
      bundle.schema_version !== 1 ||
      bundle.kind !== "catalog-owner-recovery-v1" ||
      bundle.context_sha256 !== options.plan.context_sha256 ||
      !Array.isArray(bundle.keys) ||
      bundle.keys.length !== options.plan.bindings.length
    )
      throw new Error("recovery bundle appointments differ");
    for (let index = 0; index < options.plan.bindings.length; index++) {
      const expected = options.plan.bindings[index]!,
        entry: unknown = bundle.keys[index];
      exact(entry, "role,key_id,material_base64");
      if (
        entry.role !== expected.role ||
        entry.key_id !== expected.key_id ||
        typeof entry.material_base64 !== "string" ||
        entry.material_base64.length > keyMaximum * 2
      )
        throw new Error("recovery bundle key inventory differs");
      const bytes = Buffer.from(entry.material_base64, "base64");
      material.push(bytes);
      if (bytes.toString("base64") !== entry.material_base64)
        throw new Error("recovery private encoding differs");
      await inspect(expected, bytes, inspectors.get(options.plan)!.inspectTuf);
      options.signal?.throwIfAborted();
    }
    // All keys and the authenticated ciphertext have passed before any recovered
    // file is written. This directory is quarantine, never a signing-key store.
    for (let index = 0; index < material.length; index++) {
      options.signal?.throwIfAborted();
      await durableFile(
        path.join(directory, `${options.plan.bindings[index]!.role}.key`),
        material[index]!,
      );
    }
    options.signal?.throwIfAborted();
    const result = {
      schema_version: 1,
      operation: "restore-catalog-recovery",
      context_sha256: options.plan.context_sha256,
      encrypted_sha256: hash(encrypted),
      inspector: {
        source_commit: inspectors.get(options.plan)!.source_commit,
        source_tree: inspectors.get(options.plan)!.source_tree,
        verifier_sha256: inspectors.get(options.plan)!.verifier_sha256,
      },
      roles: options.plan.bindings.map(({ role, key_id }) => ({ role, key_id })),
      authority: "none",
      activation: "not-performed",
      completion: "quarantined-reprojected-only",
    };
    await durableFile(path.join(directory, "complete.json"), JSON.stringify(result));
    await syncDirectory(directory);
    await syncDirectory(options.parent);
    return result;
  } finally {
    plaintext?.fill(0);
    for (const value of material) value.fill(0);
  }
}
