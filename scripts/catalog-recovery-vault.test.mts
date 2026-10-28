import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink, link } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareRecoveryTools } from "./prepare-recovery-tools.mts";
import {
  prepareCatalogRecoveryPlan,
  inspectCatalogRecoveryPlan,
  createCatalogRecoveryVault,
  restoreCatalogRecoveryVault,
  readCatalogCustodyMaterial,
} from "./catalog-recovery-vault.mts";
import { disposableCatalogRecoveryFixture } from "./fixtures/catalog-recovery-fixture.mts";
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const run = promisify(execFile);

void test("catalog recovery refuses unpinned or incomplete public appointments before private reads", () => {
  assert.throws(
    () =>
      inspectCatalogRecoveryPlan({
        configuration: Buffer.from("{}"),
        expectedConfigurationSha256: "0".repeat(64),
        inventory: {},
        appPublicCaptures: {},
      }),
    /independent source pin/u,
  );
});

void test("complete catalog plan refuses profile, source, role, App and alias substitutions without private custody", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-public-plan-"));
  try {
    const fixture = await disposableCatalogRecoveryFixture(path.join(root, "fixture"));
    const configuration = Buffer.from(JSON.stringify(fixture.config));
    const options = {
      configuration,
      expectedConfigurationSha256: hash(configuration),
      inventory: fixture.inventory,
      appPublicCaptures: fixture.captures,
    };
    const plan = inspectCatalogRecoveryPlan(options);
    let privateRead = false;
    await assert.rejects(
      createCatalogRecoveryVault({
        plan,
        parent: root,
        toolParent: root,
        name: "forged-plan",
        recipient: "",
        owner: {
          read: async () => {
            privateRead = true;
            return Buffer.from("never");
          },
        },
      }),
      /locally inspected/u,
    );
    assert.equal(privateRead, false);
    assert.deepEqual(
      new Set(plan.bindings.map((entry) => entry.role)),
      new Set(fixture.material.keys()),
    );
    assert.throws(
      () =>
        inspectCatalogRecoveryPlan({
          ...options,
          inventory: { ...fixture.inventory, initial_root_profile: "legacy-two-of-three-v1" },
        }),
      /inventory differs/u,
    );
    assert.throws(
      () =>
        inspectCatalogRecoveryPlan({
          ...options,
          inventory: { ...fixture.inventory, root_sha256: "0".repeat(64) },
        }),
      /inventory differs/u,
    );
    assert.throws(
      () =>
        inspectCatalogRecoveryPlan({
          ...options,
          inventory: { ...fixture.inventory, keys: fixture.inventory.keys.slice(1) },
        }),
      /role absent/u,
    );
    const changed = structuredClone(fixture.inventory);
    changed.keys[1]!.key_id = changed.keys[0]!.key_id;
    assert.throws(() => inspectCatalogRecoveryPlan({ ...options, inventory: changed }), /alias/u);
    assert.throws(
      () =>
        inspectCatalogRecoveryPlan({
          ...options,
          appPublicCaptures: {
            ...fixture.captures,
            semantic: { ...fixture.captures.semantic!, app_id: 999 },
          },
        }),
      /App capture/u,
    );
    assert.throws(() => {
      (plan.bindings[0]!.public_key as Record<string, unknown>).keytype = "rsa";
    }, TypeError);
    for (const value of fixture.material.values()) value.fill(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test(
  "authorized custody reader refuses symlinks, hardlinks and oversized files at acquisition",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "catalog-custody-reader-"));
    try {
      const file = path.join(root, "disposable.key");
      await writeFile(file, Buffer.from("disposable"), { mode: 0o600 });
      assert.equal((await readCatalogCustodyMaterial(file)).toString(), "disposable");
      await symlink(file, path.join(root, "alias"));
      await assert.rejects(readCatalogCustodyMaterial(path.join(root, "alias")), /single-link/u);
      await link(file, path.join(root, "hardlink"));
      await assert.rejects(readCatalogCustodyMaterial(file), /single-link/u);
      const large = path.join(root, "large");
      await writeFile(large, Buffer.alloc(32769), { mode: 0o600 });
      await assert.rejects(readCatalogCustodyMaterial(large));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void test(
  "actual age and Tough recover the complete disposable appointed catalog set with refusal controls",
  {
    skip:
      !process.env.PORTCOVE_CATALOG_RECOVERY_QUALIFICATION_TOOL ||
      !process.env.PORTCOVE_CATALOG_RECOVERY_TOOL_PARENT,
    timeout: 360_000,
  },
  async () => {
    const tool = process.env.PORTCOVE_CATALOG_RECOVERY_QUALIFICATION_TOOL!;
    const expectedTool = process.env.PORTCOVE_CATALOG_RECOVERY_QUALIFICATION_SHA256;
    assert.ok(path.isAbsolute(tool) && expectedTool && /^[a-f0-9]{64}$/u.test(expectedTool));
    assert.equal(hash(await readFile(tool)), expectedTool);
    const toolParent = process.env.PORTCOVE_CATALOG_RECOVERY_TOOL_PARENT!;
    const root = await mkdtemp(path.join(os.tmpdir(), "catalog-recovery-actual-"));
    const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
    const command = async (executable: string, args: string[]) =>
      await run(executable, args, { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    try {
      const fixture = await disposableCatalogRecoveryFixture(path.join(root, "fixture"));
      const inventory = JSON.parse(
        (await command(tool, ["inspect-catalog-key-inventory", fixture.inventoryConfig])).stdout,
      ) as unknown;
      const configuration = Buffer.from(JSON.stringify(fixture.config));
      const options = {
        configuration,
        expectedConfigurationSha256: hash(configuration),
        inventory,
        appPublicCaptures: fixture.captures,
      };
      const plan = await prepareCatalogRecoveryPlan({
        ...options,
        verifier: tool,
        verifierSha256: expectedTool,
        sourceCommit: process.env.PORTCOVE_CATALOG_RECOVERY_SOURCE_COMMIT!,
        sourceTree: process.env.PORTCOVE_CATALOG_RECOVERY_SOURCE_TREE!,
        trustedRoot: path.join(root, "fixture", "root.json"),
        offlineTargets: path.join(root, "fixture", "targets.json"),
        parent: root,
      });
      assert.equal(plan.bindings.length, fixture.material.size);
      assert.deepEqual(
        new Set(plan.bindings.map((entry) => entry.role)),
        new Set(fixture.material.keys()),
      );
      const absent = structuredClone(inventory) as { keys: unknown[] };
      absent.keys.pop();
      assert.throws(
        () => inspectCatalogRecoveryPlan({ ...options, inventory: absent }),
        /role absent/u,
      );
      const alias = structuredClone(inventory) as { keys: { key_id: string }[] };
      alias.keys[1]!.key_id = alias.keys[0]!.key_id;
      assert.throws(() => inspectCatalogRecoveryPlan({ ...options, inventory: alias }), /alias/u);
      const changed = structuredClone(fixture.captures);
      changed.semantic!.app_id++;
      assert.throws(
        () => inspectCatalogRecoveryPlan({ ...options, appPublicCaptures: changed }),
        /App capture/u,
      );
      assert.throws(() => {
        (plan.bindings[0]!.public_key as Record<string, unknown>).keytype = "rsa";
      }, TypeError);
      const tools = await prepareRecoveryTools(toolParent);
      assert.ok(Array.isArray(tools.receipt.tools));
      const keygen = (tools.receipt.tools as { path: string }[]).find((item) =>
        item.path.endsWith("/age-keygen"),
      )!.path;
      const generated = (await command(keygen, [])).stdout;
      const identity = Buffer.from(
        generated.split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-"))! + "\n",
      );
      // age-keygen derives public recipients using -y and stdin, without a key file.
      const derive = async (value: Buffer) =>
        await new Promise<string>((resolve, reject) => {
          const child = import("node:child_process").then(({ spawn }) => {
            const process = spawn(keygen, ["-y"], { env, stdio: ["pipe", "pipe", "pipe"] });
            let output = "";
            process.stdout.on("data", (chunk) => {
              output += String(chunk);
            });
            process.stderr.resume();
            process.on("error", reject);
            process.on("close", (code) =>
              code === 0 ? resolve(output.trim()) : reject(new Error("fixture recipient refused")),
            );
            process.stdin.end(value);
          });
          void child;
        });
      const publicRecipient = await derive(identity);
      let reads = 0;
      const owner = {
        read: async (binding: (typeof plan.bindings)[number]) => {
          reads++;
          return Buffer.from(fixture.material.get(binding.role)!);
        },
      };
      await assert.rejects(
        createCatalogRecoveryVault({
          plan,
          toolParent,
          parent: root,
          name: "held-custody",
          recipient: publicRecipient,
          owner: {
            read: async () => {
              throw new Error("custody authorization held");
            },
          },
        }),
        /custody authorization held/u,
      );
      assert.deepEqual(await readdir(path.join(root, "held-custody")), []);
      await assert.rejects(
        createCatalogRecoveryVault({
          plan,
          toolParent,
          parent: root,
          name: "changed-private-key",
          recipient: publicRecipient,
          owner: {
            read: async () => Buffer.from(fixture.material.get("catalog-targets")!),
          },
        }),
      );
      assert.deepEqual(await readdir(path.join(root, "changed-private-key")), []);
      const created = await createCatalogRecoveryVault({
        plan,
        owner,
        toolParent,
        parent: root,
        name: "primary-backup",
        recipient: publicRecipient,
      });
      assert.equal(reads, plan.bindings.length);
      assert.equal(created.authority, "none");
      const cipher = path.join(root, "primary-backup", "catalog.age");
      const restore = {
        plan,
        toolParent,
        parent: root,
        ciphertext: cipher,
        expectedCiphertextSha256: created.encrypted_sha256,
        identity,
      };
      await assert.rejects(
        createCatalogRecoveryVault({
          plan,
          owner,
          toolParent,
          parent: root,
          name: "primary-backup",
          recipient: publicRecipient,
        }),
        /EEXIST/u,
      );
      const expectedPrivate = new Map(
        [...fixture.material].map(([role, value]) => [role, hash(value)]),
      );
      for (const bytes of fixture.material.values()) bytes.fill(0);
      fixture.material.clear(); // Lost primary, recovery is still possible.
      const recovered = await restoreCatalogRecoveryVault({
        ...restore,
        name: "recovered-quarantine",
      });
      assert.equal(recovered.completion, "quarantined-reprojected-only");
      assert.equal(recovered.authority, "none");
      assert.equal(reads, plan.bindings.length); // Restore never reopens primary custody.
      for (const [role, digest] of expectedPrivate)
        assert.equal(
          hash(await readFile(path.join(root, "recovered-quarantine", `${role}.key`))),
          digest,
        );
      await assert.rejects(
        restoreCatalogRecoveryVault({ ...restore, name: "recovered-quarantine" }),
        /EEXIST/u,
      );
      const wrongGenerated = (await command(keygen, [])).stdout;
      const wrongIdentity = Buffer.from(
        wrongGenerated.split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-"))! + "\n",
      );
      await assert.rejects(
        restoreCatalogRecoveryVault({
          ...restore,
          name: "wrong-recipient",
          identity: wrongIdentity,
        }),
        /age operation refused/u,
      );
      assert.deepEqual(await readdir(path.join(root, "wrong-recipient")), ["ciphertext.age"]);
      const bytes = await readFile(cipher);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      const corrupt = path.join(root, "corrupt.age");
      await writeFile(corrupt, bytes, { mode: 0o600 });
      await assert.rejects(
        restoreCatalogRecoveryVault({ ...restore, name: "changed-bytes", ciphertext: corrupt }),
        /ciphertext differs/u,
      );
      await assert.rejects(
        restoreCatalogRecoveryVault({
          ...restore,
          name: "authenticated-corruption",
          ciphertext: corrupt,
          expectedCiphertextSha256: hash(bytes),
        }),
        /age operation refused/u,
      );
      assert.deepEqual(await readdir(path.join(root, "authenticated-corruption")), [
        "ciphertext.age",
      ]);
      const link = path.join(root, "alias.age");
      await symlink(cipher, link);
      await assert.rejects(
        restoreCatalogRecoveryVault({ ...restore, name: "alias-refusal", ciphertext: link }),
        /single-link/u,
      );
      await assert.rejects(
        restoreCatalogRecoveryVault({
          ...restore,
          name: "lost-both",
          ciphertext: path.join(root, "missing.age"),
        }),
        /ENOENT/u,
      );
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(
        restoreCatalogRecoveryVault({ ...restore, name: "interrupted", signal: abort.signal }),
      );
      assert.deepEqual(await readdir(path.join(root, "interrupted")), []);
      // Recipient rotation is re-encryption of the same recovered appointments,
      // never generation/rotation of TUF Root or App identities.
      const rotated = await createCatalogRecoveryVault({
        plan,
        toolParent,
        parent: root,
        name: "rotated-copy",
        recipient: await derive(wrongIdentity),
        owner: {
          read: async (binding) =>
            await readFile(path.join(root, "recovered-quarantine", `${binding.role}.key`)),
        },
      });
      const rotation = await restoreCatalogRecoveryVault({
        ...restore,
        name: "rotated-quarantine",
        ciphertext: path.join(root, "rotated-copy", "catalog.age"),
        expectedCiphertextSha256: rotated.encrypted_sha256,
        identity: wrongIdentity,
      });
      assert.deepEqual(rotation.roles, recovered.roles);
      identity.fill(0);
      wrongIdentity.fill(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
