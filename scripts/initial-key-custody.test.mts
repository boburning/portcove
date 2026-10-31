import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { disposableTufKey } from "./fixtures/tuf-worker-fixture.mts";
import {
  initialCustodyTufRoles,
  inspectInitialKeyCustodyInventory,
  inspectCompleteKeyCustodyInventory,
} from "./initial-key-custody-contract.mts";
import {
  prepareInitialKeyCustodyRecoveryPlan,
  createInitialKeyCustodyRecoveryVault,
  restoreInitialKeyCustodyRecoveryVault,
  createCatalogRecoveryVault,
  prepareCompleteKeyCustodyRecoveryPlan,
  createCompleteKeyCustodyRecoveryVault,
  restoreCompleteKeyCustodyRecoveryVault,
} from "./catalog-recovery-vault.mts";
import { prepareRecoveryTools } from "./prepare-recovery-tools.mts";
import { isRecord } from "./runtime-values.mts";
import { prepareOwnerRecoveryReview } from "./catalog-recovery-vault-cli.mts";
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const material = new Map<string, Buffer>();
  const keys = initialCustodyTufRoles.map((role) => {
    const k = disposableTufKey();
    material.set(role, k.private.export({ format: "der", type: "pkcs8" }));
    return { role, key_id: k.id, public_key: k.public };
  });
  const apps = Object.fromEntries(
    ["semantic", "protection_observer"].map((role, i) => {
      const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
      material.set(`github-app-${role}`, Buffer.from(key.export({ format: "pem", type: "pkcs8" })));
      return [
        role,
        {
          app_id: 101 + i,
          installation_id: 201 + i,
          public_key_sha256: hash(createPublicKey(key).export({ format: "der", type: "spki" })),
        },
      ];
    }),
  );
  const inventory = {
    schema_version: 1,
    kind: "initial-pre-payload-key-custody-v1",
    repository_id: 1354613114,
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    creation_receipt_sha256: "c".repeat(64),
    payload_credential: "not-created-not-covered",
    keys,
    apps,
  };
  return { inventory, material };
}
void test("initial inventory covers exactly all created roles and refuses substituted profiles, keys and Apps", () => {
  const { inventory } = fixture();
  const inspect = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return inspectInitialKeyCustodyInventory(bytes, hash(bytes));
  };
  assert.equal(inspect(inventory).bindings.length, 15);
  const absent = structuredClone(inventory);
  absent.keys.pop();
  assert.throws(() => inspect(absent), /scope differs/u);
  const duplicate = structuredClone(inventory);
  duplicate.keys[1] = duplicate.keys[0]!;
  assert.throws(() => inspect(duplicate), /alias/u);
  const changed = structuredClone(inventory);
  changed.keys[0]!.public_key.keyval.public = "01".repeat(32);
  assert.throws(() => inspect(changed), /canonical public key/u);
  const role = structuredClone(inventory);
  role.keys[0]!.role = "payload" as (typeof role.keys)[0]["role"];
  assert.throws(() => inspect(role), /role differs/u);
  const omitted = structuredClone(inventory);
  omitted.payload_credential = "covered";
  assert.throws(() => inspect(omitted), /scope differs/u);
  const aliases = structuredClone(inventory);
  aliases.apps.protection_observer = aliases.apps.semantic!;
  assert.throws(() => inspect(aliases), /alias/u);
  const bytes = Buffer.from(JSON.stringify(inventory));
  assert.throws(() => inspectInitialKeyCustodyInventory(bytes, "0".repeat(64)), /independent pin/u);
});
void test("complete inventory requires the distinct payload public identity and preserves initial scope", () => {
  const f = fixture();
  const payloadKey = disposableTufKey();
  const publicBox = Buffer.from(
    `untrusted comment: disposable public fixture\n${Buffer.concat([
      Buffer.from("Ed"),
      Buffer.alloc(8, 7),
      Buffer.from(payloadKey.public.keyval.public, "hex"),
    ]).toString("base64")}\n`,
  ).toString("base64");
  const inventory = {
    ...f.inventory,
    kind: "complete-release-key-custody-v1",
    payload_credential: "covered",
    payload: {
      profile: "tauri-minisign-empty-password-v1",
      public_key_base64: publicBox,
      public_key_sha256: hash(publicBox),
      ed25519_public_key: payloadKey.public.keyval.public,
    },
  };
  const inspect = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return inspectCompleteKeyCustodyInventory(bytes, hash(bytes));
  };
  const complete = inspect(inventory);
  assert.equal(complete.bindings.length, 16);
  assert.equal(
    complete.bindings.find((binding) => binding.role === "application-payload")!.key_id,
    hash(Buffer.from(publicBox, "base64")),
  );
  const initial = Buffer.from(JSON.stringify(f.inventory));
  assert.notEqual(
    complete.context_sha256,
    inspectInitialKeyCustodyInventory(initial, hash(initial)).context_sha256,
  );
  assert.throws(() => inspect(f.inventory));
  const encoded = Buffer.from(JSON.stringify(inventory));
  assert.throws(() => inspectInitialKeyCustodyInventory(encoded, hash(encoded)));
  const absent: Record<string, unknown> = structuredClone(inventory);
  delete absent.payload;
  assert.throws(() => inspect(absent));
  const alias = structuredClone(inventory);
  alias.payload.ed25519_public_key = alias.keys[0]!.public_key.keyval.public;
  assert.throws(() => inspect(alias), /payload public identity/u);
  const wrongPublic = structuredClone(inventory);
  wrongPublic.payload.ed25519_public_key = "01".repeat(32);
  assert.throws(() => inspect(wrongPublic), /payload public encoding/u);
  const malformed = structuredClone(inventory);
  malformed.payload.public_key_base64 = Buffer.from("not a Minisign public box").toString("base64");
  malformed.payload.public_key_sha256 = hash(malformed.payload.public_key_base64);
  assert.throws(() => inspect(malformed), /payload public encoding/u);
  const changed = structuredClone(inventory);
  changed.payload.public_key_sha256 = "0".repeat(64);
  assert.throws(() => inspect(changed), /payload public identity/u);
  const missingRole = structuredClone(inventory);
  missingRole.keys.pop();
  assert.throws(() => inspect(missingRole), /scope differs/u);
});
void test(
  "actual complete vault reprojects a disposable Tauri payload and restores all sixteen roles without primary keys",
  {
    skip:
      !process.env.PORTCOVE_COMPLETE_CUSTODY_QUALIFICATION_TOOL ||
      !process.env.PORTCOVE_CATALOG_RECOVERY_TOOL_PARENT,
    timeout: 360000,
  },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "complete-custody-test-"));
    try {
      const f = fixture();
      const primary = path.join(root, "primary");
      await mkdir(primary, { mode: 0o700 });
      const payloadPath = path.join(primary, "payload.key");
      // --ci is ONLY for this disposable fixture. Actual custody generation keeps
      // the owning procedure's uncaptured interactive signer command, no --ci.
      await promisify(execFile)(
        process.execPath,
        [
          path.resolve("apps/desktop/node_modules/@tauri-apps/cli/tauri.js"),
          "signer",
          "generate",
          "--ci",
          "--write-keys",
          payloadPath,
        ],
        { timeout: 60000, maxBuffer: 65536 },
      );
      const publicBox = (await readFile(payloadPath + ".pub")).toString("utf8");
      const raw = Buffer.from(
        Buffer.from(publicBox, "base64").toString("utf8").trimEnd().split("\n")[1]!,
        "base64",
      );
      assert.equal(raw.length, 42);
      f.material.set("application-payload", await readFile(payloadPath));
      const inventory = Buffer.from(
        JSON.stringify({
          ...f.inventory,
          kind: "complete-release-key-custody-v1",
          payload_credential: "covered",
          payload: {
            profile: "tauri-minisign-empty-password-v1",
            public_key_base64: publicBox,
            public_key_sha256: hash(publicBox),
            ed25519_public_key: raw.subarray(10).toString("hex"),
          },
        }),
      );
      const tool = process.env.PORTCOVE_COMPLETE_CUSTODY_QUALIFICATION_TOOL!;
      const verifierSha256 = process.env.PORTCOVE_COMPLETE_CUSTODY_QUALIFICATION_SHA256!;
      assert.equal(hash(await readFile(tool)), verifierSha256);
      const inspector = {
        verifier: tool,
        verifierSha256,
        sourceCommit: process.env.PORTCOVE_COMPLETE_CUSTODY_SOURCE_COMMIT!,
        sourceTree: process.env.PORTCOVE_COMPLETE_CUSTODY_SOURCE_TREE!,
        parent: root,
      };
      const plan = await prepareCompleteKeyCustodyRecoveryPlan({
        ...inspector,
        inventory,
        expectedInventorySha256: hash(inventory),
      });
      const initialInventory = Buffer.from(JSON.stringify(f.inventory));
      const initialPlan = await prepareInitialKeyCustodyRecoveryPlan({
        ...inspector,
        inventory: initialInventory,
        expectedInventorySha256: hash(initialInventory),
      });
      const inventoryFile = path.join(root, "complete-inventory.json");
      await writeFile(inventoryFile, inventory, { mode: 0o600 });
      const keyPaths: Record<string, string> = {};
      const expected = new Map<string, string>();
      for (const [role, material] of f.material) {
        keyPaths[role] = path.join(primary, role + ".key");
        await writeFile(keyPaths[role], material, { mode: 0o600 });
        expected.set(role, hash(material));
      }
      const config = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          profile: "complete-release-owner-passphrase-tty-v1",
          inventory: { path: inventoryFile, sha256: hash(inventory) },
          inspector: {
            path: tool,
            sha256: verifierSha256,
            source_commit: inspector.sourceCommit,
            source_tree: inspector.sourceTree,
          },
          tool_parent: process.env.PORTCOVE_CATALOG_RECOVERY_TOOL_PARENT!,
          private_parent: root,
          key_paths: keyPaths,
        }),
      );
      const configFile = path.join(root, "complete-owner.json");
      await writeFile(configFile, config, { mode: 0o600 });
      const reviewed = await prepareOwnerRecoveryReview(configFile, "create", hash(config));
      assert.equal(reviewed.review.operation, "review-complete-release-owner-recovery");
      assert.equal(reviewed.appointments.length, 16);
      assert.equal(reviewed.plan.context_sha256, plan.context_sha256);
      const toolParent = process.env.PORTCOVE_CATALOG_RECOVERY_TOOL_PARENT!;
      const tools = await prepareRecoveryTools(toolParent);
      assert.ok(Array.isArray(tools.receipt.tools));
      const entry: unknown = tools.receipt.tools.find(
        (row: unknown) =>
          isRecord(row) && typeof row.path === "string" && row.path.endsWith("/age-keygen"),
      );
      assert.ok(isRecord(entry) && typeof entry.path === "string");
      const generated = (
        await promisify(execFile)(entry.path, [], { timeout: 30000, maxBuffer: 4096 })
      ).stdout;
      const recipient = /public key: (age1[a-z0-9]+)/u.exec(generated)?.[1];
      assert.ok(recipient);
      const identity = Buffer.from(
        generated.split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-"))! + "\n",
      );
      let reads = 0;
      const base = {
        plan: reviewed.plan,
        parent: root,
        toolParent,
        recipient,
        owner: {
          read: async (binding: { role: string }) => {
            reads++;
            return Buffer.from(f.material.get(binding.role)!);
          },
        },
      };
      await assert.rejects(
        createCatalogRecoveryVault({ ...base, name: "wrong-catalog" }),
        /catalog-only/u,
      );
      await assert.rejects(
        createInitialKeyCustodyRecoveryVault({ ...base, name: "wrong-initial" }),
        /pre-payload/u,
      );
      await assert.rejects(
        createCompleteKeyCustodyRecoveryVault({
          ...base,
          plan: initialPlan,
          name: "wrong-complete",
        }),
        /complete release/u,
      );
      assert.equal(reads, 0);
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(
        createCompleteKeyCustodyRecoveryVault({
          ...base,
          name: "cancelled",
          signal: aborted.signal,
        }),
      );
      assert.equal(reads, 0);
      await assert.rejects(readFile(path.join(root, "cancelled/complete.json")));
      const created = await createCompleteKeyCustodyRecoveryVault({ ...base, name: "encrypted" });
      assert.equal(created.operation, "create-complete-release-custody-recovery");
      assert.equal(reads, 16);
      for (const material of f.material.values()) material.fill(0);
      f.material.clear();
      await rm(primary, { recursive: true });
      await assert.rejects(readdir(primary));
      const recovered = await prepareOwnerRecoveryReview(configFile, "restore", hash(config));
      assert.equal(recovered.review.operation, "review-complete-release-owner-recovery");
      assert.equal(recovered.appointments.length, 0);
      const ciphertext = path.join(root, "encrypted/complete-custody.age");
      const ciphertextBytes = await readFile(ciphertext);
      const restore = {
        plan: recovered.plan,
        toolParent,
        parent: root,
        ciphertext,
        expectedCiphertextSha256: hash(ciphertextBytes),
        identity,
      };
      await assert.rejects(
        restoreInitialKeyCustodyRecoveryVault({
          ...restore,
          plan: initialPlan,
          name: "cross-profile",
        }),
      );
      await assert.rejects(readFile(path.join(root, "cross-profile/complete.json")));
      const corrupt = Buffer.from(ciphertextBytes);
      corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
      const corruptPath = path.join(root, "corrupt.age");
      await writeFile(corruptPath, corrupt, { mode: 0o600 });
      await assert.rejects(
        restoreCompleteKeyCustodyRecoveryVault({
          ...restore,
          ciphertext: corruptPath,
          expectedCiphertextSha256: hash(corrupt),
          name: "corrupt",
        }),
      );
      await assert.rejects(readFile(path.join(root, "corrupt/complete.json")));
      const restored = await restoreCompleteKeyCustodyRecoveryVault({
        ...restore,
        name: "restored",
      });
      assert.equal(restored.operation, "restore-complete-release-custody-recovery");
      assert.equal(restored.completion, "quarantined-reprojected-only");
      for (const [role, expectedHash] of expected)
        assert.equal(
          hash(await readFile(path.join(root, "restored", role + ".key"))),
          expectedHash,
        );
      assert.equal(
        (await readdir(path.join(root, "restored"))).filter((name) => name.endsWith(".key")).length,
        16,
      );
      await assert.rejects(createCompleteKeyCustodyRecoveryVault({ ...base, name: "encrypted" }));
      assert.equal(reads, 16);
      identity.fill(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
void test(
  "actual shared vault engine restores the complete disposable initial set and refuses wrong keys and purpose",
  {
    skip:
      !process.env.PORTCOVE_CATALOG_RECOVERY_QUALIFICATION_TOOL ||
      !process.env.PORTCOVE_CATALOG_RECOVERY_TOOL_PARENT,
    timeout: 360000,
  },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "initial-custody-test-"));
    try {
      const f = fixture();
      const inventory = Buffer.from(JSON.stringify(f.inventory));
      const tool = process.env.PORTCOVE_CATALOG_RECOVERY_QUALIFICATION_TOOL!;
      const toolParent = process.env.PORTCOVE_CATALOG_RECOVERY_TOOL_PARENT!;
      const verifierSha256 = process.env.PORTCOVE_CATALOG_RECOVERY_QUALIFICATION_SHA256!;
      assert.equal(hash(await readFile(tool)), verifierSha256);
      const plan = await prepareInitialKeyCustodyRecoveryPlan({
        inventory,
        expectedInventorySha256: hash(inventory),
        verifier: tool,
        verifierSha256,
        sourceCommit: process.env.PORTCOVE_CATALOG_RECOVERY_SOURCE_COMMIT!,
        sourceTree: process.env.PORTCOVE_CATALOG_RECOVERY_SOURCE_TREE!,
        parent: root,
      });
      const tools = await prepareRecoveryTools(toolParent);
      assert.ok(Array.isArray(tools.receipt.tools));
      const entry: unknown = tools.receipt.tools.find(
        (entry: unknown) =>
          isRecord(entry) && typeof entry.path === "string" && entry.path.endsWith("/age-keygen"),
      );
      assert.ok(isRecord(entry) && typeof entry.path === "string");
      const keygen = entry.path;
      const generated = (
        await promisify(execFile)(keygen, [], {
          timeout: 30000,
          maxBuffer: 4096,
        })
      ).stdout;
      const recipient = /public key: (age1[a-z0-9]+)/u.exec(generated)?.[1];
      assert.ok(recipient);
      const identity =
        generated.split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-"))! + "\n";
      let reads = 0;
      const base = {
        plan,
        toolParent,
        parent: root,
        owner: {
          read: async (binding: { role: string }) => {
            reads++;
            return Buffer.from(f.material.get(binding.role)!);
          },
        },
        recipient,
      };
      await assert.rejects(
        createCatalogRecoveryVault({ ...base, name: "wrong-purpose" }),
        /catalog-only/u,
      );
      assert.equal(reads, 0);
      await assert.rejects(readdir(path.join(root, "wrong-purpose")));
      await assert.rejects(
        createInitialKeyCustodyRecoveryVault({
          ...base,
          name: "wrong-key",
          owner: { read: async () => Buffer.from(f.material.get("application-targets")!) },
        }),
      );
      await assert.rejects(readFile(path.join(root, "wrong-key/complete.json")));
      const created = await createInitialKeyCustodyRecoveryVault({ ...base, name: "encrypted" });
      assert.equal(created.operation, "create-initial-pre-payload-custody-recovery");
      assert.equal(reads, 15);
      const ciphertext = path.join(root, "encrypted/initial-setup.age");
      const restored = await restoreInitialKeyCustodyRecoveryVault({
        plan,
        toolParent,
        parent: root,
        name: "restored",
        ciphertext,
        expectedCiphertextSha256: hash(await readFile(ciphertext)),
        identity: Buffer.from(identity),
      });
      assert.equal(restored.completion, "quarantined-reprojected-only");
      for (const [role, bytes] of f.material)
        assert.equal(hash(await readFile(path.join(root, "restored", role + ".key"))), hash(bytes));
      await assert.rejects(createInitialKeyCustodyRecoveryVault({ ...base, name: "encrypted" }));
      assert.equal(reads, 15);
      const inventoryFile = path.join(root, "initial-inventory.json");
      await writeFile(inventoryFile, inventory, { mode: 0o600 });
      const keyPaths: Record<string, string> = {};
      for (const [role, material] of f.material) {
        keyPaths[role] = path.join(root, role + ".key");
        await writeFile(keyPaths[role], material, { mode: 0o600 });
      }
      const configFile = path.join(root, "initial-owner.json");
      const config = Buffer.from(
        JSON.stringify({
          schema_version: 1,
          profile: "initial-pre-payload-owner-passphrase-tty-v1",
          inventory: { path: inventoryFile, sha256: hash(inventory) },
          inspector: {
            path: tool,
            sha256: verifierSha256,
            source_commit: process.env.PORTCOVE_CATALOG_RECOVERY_SOURCE_COMMIT,
            source_tree: process.env.PORTCOVE_CATALOG_RECOVERY_SOURCE_TREE,
          },
          tool_parent: toolParent,
          private_parent: root,
          key_paths: keyPaths,
        }),
      );
      await writeFile(configFile, config, { mode: 0o600 });
      await assert.rejects(
        prepareOwnerRecoveryReview(configFile, "create", "0".repeat(64)),
        /configuration pin differs before tool execution/u,
      );
      const tty = async (args: string[]) => {
        const response = await promisify(execFile)(
          "python3",
          [
            "scripts/fixtures/catalog-recovery-tty.py",
            "correct",
            process.execPath,
            "scripts/fixtures/catalog-recovery-tty-entry.mts",
            ...args,
          ],
          { timeout: 190000, maxBuffer: 131072 },
        );
        const observed: unknown = JSON.parse(response.stdout);
        assert.ok(isRecord(observed));
        assert.equal(observed.exit_code, 0);
        assert.equal(observed.terminal_restored, true);
        assert.equal(observed.checked_before_caller_exit, true);
      };
      const reviewed = await prepareOwnerRecoveryReview(configFile, "create", hash(config));
      assert.equal(reviewed.review.operation, "review-initial-pre-payload-owner-recovery");
      await tty([
        "create",
        "--config",
        configFile,
        "--config-sha256",
        hash(config),
        "--expected-plan",
        reviewed.review.expected_plan,
        "--name",
        "tty-encrypted",
      ]);
      for (const filename of Object.values(keyPaths)) await rm(filename);
      const recovery = await prepareOwnerRecoveryReview(configFile, "restore", hash(config));
      const ttyCiphertext = path.join(root, "tty-encrypted/initial-setup.age");
      await tty([
        "restore",
        "--config",
        configFile,
        "--config-sha256",
        hash(config),
        "--expected-plan",
        recovery.review.expected_plan,
        "--name",
        "tty-restored",
        "--ciphertext",
        ttyCiphertext,
        "--sha256",
        hash(await readFile(ttyCiphertext)),
      ]);
      for (const [role, bytes] of f.material)
        assert.equal(
          hash(await readFile(path.join(root, "tty-restored", role + ".key"))),
          hash(bytes),
        );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
