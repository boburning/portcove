import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { disposableTufKey } from "./fixtures/tuf-worker-fixture.mts";
import {
  initialCustodyTufRoles,
  inspectInitialKeyCustodyInventory,
} from "./initial-key-custody-contract.mts";
import {
  prepareInitialKeyCustodyRecoveryPlan,
  createInitialKeyCustodyRecoveryVault,
  restoreInitialKeyCustodyRecoveryVault,
  createCatalogRecoveryVault,
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
