/** Ordinary-owner passphrase entry point for the existing catalog vault. Public
 * config/pins and a review fingerprint never grant private custody or signing.
 * Real invocation remains conditional on the separate approved custody scope. */
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import {
  prepareCatalogRecoveryPlan,
  createCatalogRecoveryVault,
  restoreCatalogRecoveryVault,
  readCatalogCustodyMaterial,
  requireOwnerRecoveryTty,
  prepareInitialKeyCustodyRecoveryPlan,
  createInitialKeyCustodyRecoveryVault,
  restoreInitialKeyCustodyRecoveryVault,
  prepareCompleteKeyCustodyRecoveryPlan,
  createCompleteKeyCustodyRecoveryVault,
  restoreCompleteKeyCustodyRecoveryVault,
} from "./catalog-recovery-vault.mts";

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function exact(value: unknown, fields: string): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== fields.split(",").sort().join(",")
  )
    throw new Error("closed owner recovery configuration differs");
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 4096 || /[\0\r\n]/u.test(value))
    throw new Error("bounded owner recovery text required");
  return value;
}
function absolute(value: unknown): string {
  const result = text(value);
  if (!path.isAbsolute(result) || path.normalize(result) !== result)
    throw new Error("explicit canonical absolute owner path required");
  return result;
}
function hex(value: unknown, size = 64): string {
  const result = text(value);
  if (result.length !== size || !/^[a-f0-9]+$/u.test(result))
    throw new Error("independently ratified source identity required");
  return result;
}
function parse(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("bounded public recovery JSON malformed");
  }
}
function pin(value: unknown) {
  exact(value, "path,sha256");
  return { path: absolute(value.path), sha256: hex(value.sha256) };
}
export async function inspectOwnerCustodyPath(filename: string) {
  const value = absolute(filename),
    stat = await lstat(value);
  if (
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size < 1 ||
    stat.size > 32768 ||
    (await realpath(value)) !== value ||
    ![stat.dev, stat.ino, stat.uid, stat.nlink, stat.size, stat.mode].every(Number.isSafeInteger)
  )
    throw new Error("bounded private ordinary-owner single-link custody appointment required");
  return {
    path: value,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    nlink: stat.nlink,
    size: stat.size,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}
function configuration(value: unknown) {
  exact(
    value,
    "schema_version,profile,configuration,app_public_captures,inspector,public_inputs,tool_parent,private_parent,key_paths",
  );
  if (value.schema_version !== 1 || value.profile !== "catalog-owner-passphrase-tty-v1")
    throw new Error("explicit approved ordinary-owner passphrase profile required");
  const configured = pin(value.configuration);
  exact(value.inspector, "path,sha256,source_commit,source_tree");
  const inspector = {
    path: absolute(value.inspector.path),
    sha256: hex(value.inspector.sha256),
    source_commit: hex(value.inspector.source_commit, 40),
    source_tree: hex(value.inspector.source_tree, 40),
  };
  exact(value.public_inputs, "trusted_root,offline_targets");
  if (!isRecord(value.key_paths) || Object.keys(value.key_paths).length > 32)
    throw new Error("derived role key-path appointments required");
  const key_paths = Object.fromEntries(
    Object.entries(value.key_paths).map(([role, value]) => [role, absolute(value)]),
  );
  if (new Set(Object.values(key_paths)).size !== Object.keys(key_paths).length)
    throw new Error("private custody paths alias");
  return {
    schema_version: 1,
    profile: "catalog-owner-passphrase-tty-v1",
    configuration: configured,
    inspector,
    public_inputs: {
      trusted_root: absolute(value.public_inputs.trusted_root),
      offline_targets: absolute(value.public_inputs.offline_targets),
    },
    app_public_captures: structuredClone(value.app_public_captures),
    tool_parent: absolute(value.tool_parent),
    private_parent: absolute(value.private_parent),
    key_paths,
  };
}
function initialConfiguration(value: unknown, complete = false) {
  exact(value, "schema_version,profile,inventory,inspector,tool_parent,private_parent,key_paths");
  const profile = complete
    ? ("complete-release-owner-passphrase-tty-v1" as const)
    : ("initial-pre-payload-owner-passphrase-tty-v1" as const);
  const count = complete ? 16 : 15;
  if (value.schema_version !== 1 || value.profile !== profile)
    throw new Error("explicit initial pre-payload custody profile required");
  exact(value.inspector, "path,sha256,source_commit,source_tree");
  if (!isRecord(value.key_paths) || Object.keys(value.key_paths).length !== count)
    throw new Error("complete initial pre-payload custody paths required");
  const key_paths = Object.fromEntries(
    Object.entries(value.key_paths).map(([role, filename]) => [role, absolute(filename)]),
  );
  if (new Set(Object.values(key_paths)).size !== count)
    throw new Error("private custody paths alias");
  return {
    schema_version: 1,
    profile,
    inventory: pin(value.inventory),
    inspector: {
      path: absolute(value.inspector.path),
      sha256: hex(value.inspector.sha256),
      source_commit: hex(value.inspector.source_commit, 40),
      source_tree: hex(value.inspector.source_tree, 40),
    },
    tool_parent: absolute(value.tool_parent),
    private_parent: absolute(value.private_parent),
    key_paths,
  };
}
export async function prepareOwnerRecoveryReview(
  filename: string,
  operation: "create" | "restore",
  expectedConfigurationSha256: string,
) {
  const configBytes = await readControllerToolFile(absolute(filename), 65536);
  if (hash(configBytes) !== hex(expectedConfigurationSha256))
    throw new Error("independently retained owner configuration pin differs before tool execution");
  const raw = parse(configBytes);
  const config =
    isRecord(raw) && raw.profile === "complete-release-owner-passphrase-tty-v1"
      ? initialConfiguration(raw, true)
      : isRecord(raw) && raw.profile === "initial-pre-payload-owner-passphrase-tty-v1"
        ? initialConfiguration(raw)
        : configuration(raw);
  const inspector = {
    verifier: config.inspector.path,
    verifierSha256: config.inspector.sha256,
    sourceCommit: config.inspector.source_commit,
    sourceTree: config.inspector.source_tree,
    parent: config.private_parent,
  };
  const prepare = async () => {
    if ("inventory" in config)
      return await (
        config.profile === "complete-release-owner-passphrase-tty-v1"
          ? prepareCompleteKeyCustodyRecoveryPlan
          : prepareInitialKeyCustodyRecoveryPlan
      )({
        ...inspector,
        inventory: await readControllerToolFile(config.inventory.path, 65536),
        expectedInventorySha256: config.inventory.sha256,
      });
    const publicConfiguration = await readControllerToolFile(config.configuration.path, 32768);
    if (hash(publicConfiguration) !== config.configuration.sha256)
      throw new Error("independent catalog configuration pin differs");
    return await prepareCatalogRecoveryPlan({
      ...inspector,
      configuration: publicConfiguration,
      expectedConfigurationSha256: config.configuration.sha256,
      appPublicCaptures: config.app_public_captures,
      trustedRoot: config.public_inputs.trusted_root,
      offlineTargets: config.public_inputs.offline_targets,
    });
  };
  const plan = await prepare();
  const expected = plan.bindings.map((binding) => binding.role).sort();
  if (
    !Object.keys(config.key_paths)
      .sort()
      .every((role, index) => role === expected[index]) ||
    Object.keys(config.key_paths).length !== expected.length
  )
    throw new Error("private paths must cover exactly the actual complete appointed role set");
  const appointments =
    operation === "create"
      ? await Promise.all(
          plan.bindings.map(async (binding) => ({
            role: binding.role,
            key_id: binding.key_id,
            metadata: await inspectOwnerCustodyPath(config.key_paths[binding.role]!),
          })),
        )
      : [];
  if (
    new Set(appointments.map((row) => `${row.metadata.dev}:${row.metadata.ino}`)).size !==
    appointments.length
  )
    throw new Error("physical private custody appointments alias");
  const expected_plan = releaseCanonicalDigest({
    operation,
    config_sha256: hash(configBytes),
    context_sha256: plan.context_sha256,
    inspector: config.inspector,
    appointments,
    private_parent: config.private_parent,
    tool_parent: config.tool_parent,
    profile: config.profile,
  });
  return {
    config,
    plan,
    appointments,
    review: {
      schema_version: 1,
      operation:
        config.profile === "complete-release-owner-passphrase-tty-v1"
          ? "review-complete-release-owner-recovery"
          : "inventory" in config
            ? "review-initial-pre-payload-owner-recovery"
            : "review-catalog-owner-recovery",
      review_for: operation,
      profile: config.profile,
      config_sha256: hash(configBytes),
      context_sha256: plan.context_sha256,
      expected_plan,
      roles: plan.bindings.map(({ role, key_id }) => ({
        role,
        key_id,
        path: config.key_paths[role],
      })),
      private_key_content_read: false,
      authority: "none",
      next_action:
        "After separate custody prerequisites, run create/restore in the ordinary owner's private controlling terminal; enter a nonempty passphrase directly into age. No agent-captured terminal, env, argument or recording channel.",
    },
  };
}
type Command = {
  operation: "review" | "create" | "restore";
  config: string;
  configSha256: string;
  reviewFor?: "create" | "restore";
  expectedPlan?: string;
  name?: string;
  ciphertext?: string;
  sha256?: string;
};
export function parseOwnerRecoveryArguments(argv: string[]): Command {
  const [operation, ...rest] = argv;
  if (!["review", "create", "restore"].includes(operation ?? "") || rest.length % 2)
    throw new Error(
      "usage: catalog-recovery-vault-cli.mts review|create|restore --config ABSOLUTE_FILE --config-sha256 RATIFIED_SHA; review also --for create|restore; create/restore also --expected-plan SHA --name NEW_NAME; restore also --ciphertext ABSOLUTE_FILE --sha256 SHA",
    );
  const values: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!,
      value = rest[index + 1]!;
    if (
      ![
        "--config",
        "--config-sha256",
        "--for",
        "--expected-plan",
        "--name",
        "--ciphertext",
        "--sha256",
      ].includes(key) ||
      Object.hasOwn(values, key)
    )
      throw new Error(
        "unknown/duplicate recovery option; no passphrase/identity argument is accepted",
      );
    values[key] = value;
  }
  const fields =
    operation === "review"
      ? ["--config", "--config-sha256", "--for"]
      : operation === "create"
        ? ["--config", "--config-sha256", "--expected-plan", "--name"]
        : ["--config", "--config-sha256", "--expected-plan", "--name", "--ciphertext", "--sha256"];
  if (Object.keys(values).sort().join(",") !== fields.sort().join(","))
    throw new Error("complete explicit owner operation inputs required");
  if (operation === "review" && !["create", "restore"].includes(values["--for"]!))
    throw new Error("review requires explicit --for create|restore");
  return {
    operation: operation as Command["operation"],
    ...(operation === "review" ? { reviewFor: values["--for"] as "create" | "restore" } : {}),
    config: absolute(values["--config"]),
    configSha256: hex(values["--config-sha256"]),
    ...(operation === "review"
      ? {}
      : { expectedPlan: hex(values["--expected-plan"]), name: text(values["--name"]) }),
    ...(operation === "restore"
      ? { ciphertext: absolute(values["--ciphertext"]), sha256: hex(values["--sha256"]) }
      : {}),
  };
}
export async function runOwnerRecoveryCommand(command: Command, signal?: AbortSignal) {
  if (command.operation !== "review") requireOwnerRecoveryTty(); // Before private metadata/content or tool effects.
  const prepared = await prepareOwnerRecoveryReview(
    command.config,
    command.operation === "review" ? command.reviewFor! : command.operation,
    command.configSha256,
  );
  if (command.operation === "review") return prepared.review;
  if (command.expectedPlan !== prepared.review.expected_plan)
    throw new Error("owner recovery review is stale; no custody content read");
  signal?.throwIfAborted();
  if (command.operation === "create")
    return await (
      "inventory" in prepared.config
        ? prepared.config.profile === "complete-release-owner-passphrase-tty-v1"
          ? createCompleteKeyCustodyRecoveryVault
          : createInitialKeyCustodyRecoveryVault
        : createCatalogRecoveryVault
    )({
      plan: prepared.plan,
      toolParent: prepared.config.tool_parent,
      parent: prepared.config.private_parent,
      name: command.name!,
      passphraseTTY: true,
      ...(signal ? { signal } : {}),
      owner: {
        read: async (binding) => {
          const appointment = prepared.appointments.find(
            (row) => row.role === binding.role && row.key_id === binding.key_id,
          );
          if (
            !appointment ||
            releaseCanonicalDigest(await inspectOwnerCustodyPath(appointment.metadata.path)) !==
              releaseCanonicalDigest(appointment.metadata)
          )
            throw new Error("custody appointment changed after review");
          return await readCatalogCustodyMaterial(appointment.metadata.path, appointment.metadata);
        },
      },
    });
  return await (
    "inventory" in prepared.config
      ? prepared.config.profile === "complete-release-owner-passphrase-tty-v1"
        ? restoreCompleteKeyCustodyRecoveryVault
        : restoreInitialKeyCustodyRecoveryVault
      : restoreCatalogRecoveryVault
  )({
    plan: prepared.plan,
    toolParent: prepared.config.tool_parent,
    parent: prepared.config.private_parent,
    name: command.name!,
    passphraseTTY: true,
    ciphertext: command.ciphertext!,
    expectedCiphertextSha256: command.sha256!,
    ...(signal ? { signal } : {}),
  });
}
export async function ownerRecoveryMain() {
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("owner interrupted recovery"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const result = await runOwnerRecoveryCommand(
      parseOwnerRecoveryArguments(process.argv.slice(2)),
      abort.signal,
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        status: "refused",
        reason: error instanceof Error ? error.message : "owner recovery refused",
        authority: "none",
        automatic_retry: false,
      }) + "\n",
    );
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await ownerRecoveryMain();
