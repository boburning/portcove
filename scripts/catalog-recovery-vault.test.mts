import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  link,
  chmod,
  open,
  readlink,
  rename,
  lstat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareRecoveryTools } from "./prepare-recovery-tools.mts";
import {
  prepareCatalogRecoveryPlan,
  inspectCatalogRecoveryPlan,
  createCatalogRecoveryVault,
  restoreCatalogRecoveryVault,
  readCatalogCustodyMaterial,
  inspectPassphraseRecoveryHeader,
  inspectOwnerTerminalUtility,
} from "./catalog-recovery-vault.mts";
import {
  parseOwnerRecoveryArguments,
  prepareOwnerRecoveryReview,
} from "./catalog-recovery-vault-cli.mts";
import { disposableCatalogRecoveryFixture } from "./fixtures/catalog-recovery-fixture.mts";
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const run = promisify(execFile);

void test("owner passphrase entry refuses secret arguments, nonterminals and unbounded scrypt before custody", async () => {
  const utility = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o100755,
    size: 11352352,
  };
  inspectOwnerTerminalUtility(utility);
  for (const mode of [0o104755, 0o102755, 0o100775, 0o100757])
    assert.throws(() => inspectOwnerTerminalUtility({ ...utility, mode }), /root-maintained/u);
  assert.throws(() => inspectOwnerTerminalUtility({ ...utility, uid: 1000 }), /root-maintained/u);
  assert.throws(
    () => parseOwnerRecoveryArguments(["create", "--config", "/fixture", "--passphrase", "never"]),
    /unknown\/duplicate/u,
  );
  assert.throws(
    () => parseOwnerRecoveryArguments(["review", "--config", "/fixture"]),
    /complete explicit/u,
  );
  assert.throws(
    () =>
      inspectPassphraseRecoveryHeader(
        Buffer.from(
          "age-encryption.org/v1\n-> scrypt " +
            "A".repeat(22) +
            " 22\n" +
            "B".repeat(43) +
            "\n--- " +
            "C".repeat(43) +
            "\n",
        ),
      ),
    /logN18/u,
  );
  const result = await run(
    process.execPath,
    [
      "scripts/catalog-recovery-vault-cli.mts",
      "create",
      "--config",
      "/nonexistent-owner-custody",
      "--config-sha256",
      "0".repeat(64),
      "--expected-plan",
      "0".repeat(64),
      "--name",
      "never",
    ],
    { timeout: 5000, maxBuffer: 4096 },
  ).catch((error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "stderr" in error);
    return error as Error & { code: number; stderr: string };
  });
  assert.ok("code" in result);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /direct ordinary-owner terminal|offline ordinary-owner/u);
  assert.doesNotMatch(result.stderr, /ENOENT/u);
});

void test(
  "actual private-terminal age passphrase create, lost-primary restore and interruption preserve the complete catalog set",
  {
    skip:
      !process.env.PORTCOVE_CATALOG_RECOVERY_QUALIFICATION_TOOL ||
      !process.env.PORTCOVE_CATALOG_RECOVERY_TOOL_PARENT,
    timeout: 900000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "catalog-owner-tty-"));
    try {
      const fixture = await disposableCatalogRecoveryFixture(path.join(root, "fixture"));
      const publicConfig = path.join(root, "catalog.json"),
        configPath = path.join(root, "owner.json");
      const publicBytes = Buffer.from(JSON.stringify(fixture.config));
      await writeFile(publicConfig, publicBytes, { mode: 0o600 });
      const key_paths: Record<string, string> = {};
      for (const [role, bytes] of fixture.material) {
        key_paths[role] = path.join(root, role + ".primary");
        await writeFile(key_paths[role], bytes, { mode: 0o600 });
      }
      await writeFile(
        configPath,
        JSON.stringify({
          schema_version: 1,
          profile: "catalog-owner-passphrase-tty-v1",
          configuration: { path: publicConfig, sha256: hash(publicBytes) },
          app_public_captures: fixture.captures,
          inspector: {
            path: process.env.PORTCOVE_CATALOG_RECOVERY_QUALIFICATION_TOOL,
            sha256: process.env.PORTCOVE_CATALOG_RECOVERY_QUALIFICATION_SHA256,
            source_commit: process.env.PORTCOVE_CATALOG_RECOVERY_SOURCE_COMMIT,
            source_tree: process.env.PORTCOVE_CATALOG_RECOVERY_SOURCE_TREE,
          },
          public_inputs: {
            trusted_root: path.join(root, "fixture", "root.json"),
            offline_targets: path.join(root, "fixture", "targets.json"),
          },
          tool_parent: process.env.PORTCOVE_CATALOG_RECOVERY_TOOL_PARENT,
          private_parent: root,
          key_paths,
        }),
        { mode: 0o600 },
      );
      const tty = async (mode: string, args: string[]) => {
        const observed = JSON.parse(
          (
            await run(
              "python3",
              [
                "scripts/fixtures/catalog-recovery-tty.py",
                mode,
                process.execPath,
                "scripts/fixtures/catalog-recovery-tty-entry.mts",
                ...args,
              ],
              { timeout: 190000, maxBuffer: 131072 },
            )
          ).stdout,
        ) as {
          exit_code: number;
          prompts: number;
          terminal_restored: boolean;
          checked_before_caller_exit: boolean;
          output: string;
        };
        t.diagnostic(
          JSON.stringify({
            operation: args[0],
            attempt: args[args.indexOf("--name") + 1],
            mode,
            exit_code: observed.exit_code,
            prompts: observed.prompts,
            terminal_restored: observed.terminal_restored,
            checked_before_caller_exit: observed.checked_before_caller_exit,
          }),
        );
        return observed;
      };
      const configSha = hash(await readFile(configPath));
      const approvedConfigBytes = await readFile(configPath);
      const substitutedConfig = JSON.parse(approvedConfigBytes.toString()) as {
        inspector: { path: string; sha256: string };
      };
      const unapproved = path.join(root, "unreviewed-inspector"),
        marker = path.join(root, "unreviewed-inspector-invoked");
      const unapprovedBytes = Buffer.from("#!/bin/sh\nprintf invoked > '" + marker + "'\n");
      await writeFile(unapproved, unapprovedBytes, { mode: 0o700 });
      substitutedConfig.inspector.path = unapproved;
      substitutedConfig.inspector.sha256 = hash(unapprovedBytes);
      await writeFile(configPath, JSON.stringify(substitutedConfig), { mode: 0o600 });
      await assert.rejects(
        prepareOwnerRecoveryReview(configPath, "create", configSha),
        /configuration pin differs before tool execution/u,
      );
      await assert.rejects(readFile(marker));
      await writeFile(configPath, approvedConfigBytes, { mode: 0o600 });
      const replaced = (args: string[], flag: string, value: string) => {
        const next = [...args];
        next[next.indexOf(flag) + 1] = value;
        return next;
      };
      const createReview = await prepareOwnerRecoveryReview(configPath, "create", configSha);
      const createArgs = [
        "create",
        "--config",
        configPath,
        "--config-sha256",
        configSha,
        "--expected-plan",
        createReview.review.expected_plan,
        "--name",
        "encrypted",
      ];
      const stale = await tty("correct", replaced(createArgs, "--expected-plan", "0".repeat(64)));
      assert.equal(stale.exit_code, 1);
      assert.equal(stale.prompts, 0);
      assert.match(stale.output, /review is stale/u);
      const created = await tty("correct", createArgs);
      assert.equal(created.exit_code, 0, created.output);
      assert.equal(created.prompts, 2);
      assert.equal(created.terminal_restored, true);
      const ciphertext = path.join(root, "encrypted", "catalog.age"),
        encrypted = await readFile(ciphertext);
      inspectPassphraseRecoveryHeader(encrypted);
      const interrupted = await tty("interrupt", replaced(createArgs, "--name", "interrupted"));
      assert.equal(interrupted.exit_code, 1, interrupted.output);
      assert.equal(interrupted.prompts, 1);
      assert.equal(interrupted.terminal_restored, true);
      assert.equal(interrupted.checked_before_caller_exit, true);
      await assert.rejects(readFile(path.join(root, "interrupted", "complete.json")));
      const overwritten = await tty("correct", createArgs);
      assert.equal(overwritten.exit_code, 1);
      assert.equal(overwritten.prompts, 0);
      for (const filename of Object.values(key_paths)) await rm(filename);
      // Public restore preparation intentionally never stats or reads missing primary custody.
      const restoreReview = await prepareOwnerRecoveryReview(configPath, "restore", configSha);
      assert.equal(restoreReview.review.private_key_content_read, false);
      const restoreArgs = [
        "restore",
        "--config",
        configPath,
        "--config-sha256",
        configSha,
        "--expected-plan",
        restoreReview.review.expected_plan,
        "--name",
        "restored",
        "--ciphertext",
        ciphertext,
        "--sha256",
        hash(encrypted),
      ];
      const wrong = await tty("wrong", replaced(restoreArgs, "--name", "wrong"));
      assert.equal(wrong.exit_code, 1, wrong.output);
      assert.equal(wrong.prompts, 1);
      assert.equal(wrong.terminal_restored, true);
      await assert.rejects(readFile(path.join(root, "wrong", "complete.json")));
      const highKdf = Buffer.from(encrypted);
      const factor = highKdf.indexOf(Buffer.from(" 18\n"));
      assert.ok(factor > 0);
      highKdf.write(" 22\n", factor);
      const hostile = path.join(root, "hostile.age");
      await writeFile(hostile, highKdf, { mode: 0o600 });
      const hostileResult = await tty(
        "correct",
        replaced(
          replaced(replaced(restoreArgs, "--name", "hostile"), "--ciphertext", hostile),
          "--sha256",
          hash(highKdf),
        ),
      );
      assert.equal(hostileResult.exit_code, 1);
      assert.equal(hostileResult.prompts, 0);
      assert.match(hostileResult.output, /logN18/u);
      const corrupt = Buffer.from(encrypted);
      corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
      const corruptPath = path.join(root, "corrupt.age");
      await writeFile(corruptPath, corrupt, { mode: 0o600 });
      const corruptResult = await tty(
        "correct",
        replaced(
          replaced(replaced(restoreArgs, "--name", "corrupt"), "--ciphertext", corruptPath),
          "--sha256",
          hash(corrupt),
        ),
      );
      assert.equal(corruptResult.exit_code, 1);
      assert.equal(corruptResult.prompts, 1);
      await assert.rejects(readFile(path.join(root, "corrupt", "complete.json")));
      const restored = await tty("correct", restoreArgs);
      assert.equal(restored.exit_code, 0, restored.output);
      assert.equal(restored.prompts, 1);
      for (const [role, bytes] of fixture.material)
        assert.deepEqual(await readFile(path.join(root, "restored", role + ".key")), bytes);
      await assert.rejects(prepareOwnerRecoveryReview(configPath, "create", configSha), /ENOENT/u);
      for (const bytes of fixture.material.values()) bytes.fill(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

void test("Actions custody refusal occurs before any private file is opened", async () => {
  const result = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {readCatalogCustodyMaterial} from "./scripts/catalog-recovery-vault.mts"; try { await readCatalogCustodyMaterial("/nonexistent-catalog-custody-fixture"); throw new Error("unexpected acceptance"); } catch(error) { if(error.message!=="offline ordinary-owner recovery outside Actions required") throw error; console.log("refused-before-open"); }',
    ],
    { env: { PATH: "/usr/bin:/bin", GITHUB_ACTIONS: "true" }, timeout: 5000, maxBuffer: 4096 },
  );
  assert.equal(result.stdout.trim(), "refused-before-open");
});

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
  "authorized custody reader enforces offline owner and bounded single-link acquisition",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "catalog-custody-reader-"));
    try {
      const file = path.join(root, "disposable.key");
      await writeFile(file, Buffer.from("disposable"), { mode: 0o600 });
      if (
        process.env.GITHUB_ACTIONS !== undefined ||
        process.env.GITHUB_RUN_ID !== undefined ||
        process.getuid?.() === 0
      ) {
        await assert.rejects(readCatalogCustodyMaterial(file), /offline ordinary-owner/u);
        return;
      }
      assert.equal((await readCatalogCustodyMaterial(file)).toString(), "disposable");
      const approved = await lstat(file);
      const moved = path.join(root, "original-approved");
      await rename(file, moved);
      await writeFile(file, Buffer.from("substituted-unapproved-private-content"), { mode: 0o600 });
      const handle = await open(file, "r");
      const prototype: FileHandle = Object.getPrototypeOf(handle) as FileHandle;
      await handle.close();
      let reads = 0;
      const original = prototype.read;
      const spy = t.mock.method(
        prototype,
        "read",
        function (this: FileHandle, ...args: Parameters<FileHandle["read"]>) {
          reads++;
          return original.apply(this, args);
        },
      );
      await assert.rejects(
        readCatalogCustodyMaterial(file, approved),
        /reviewed custody metadata differs|held identity differs/u,
      );
      assert.equal(
        reads,
        0,
        "renamed substitution is rejected by approved metadata/held identity before any content read",
      );
      spy.mock.restore();
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
  async (t) => {
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
      const probe = await open(path.join(root, "sync-probe"), "wx", 0o600);
      const prototype = Object.getPrototypeOf(probe) as FileHandle,
        originalSync = prototype.sync;
      await probe.close();
      const syncs: string[] = [];
      let failDirectory: string | undefined;
      t.mock.method(prototype, "sync", async function (this: FileHandle) {
        const filename = await readlink(`/proc/self/fd/${this.fd}`);
        if (filename === failDirectory) throw new Error("injected payload-directory flush failure");
        await originalSync.call(this);
        syncs.push(filename);
      });
      const publicationOrder = (start: number, directory: string, payload: string[]) =>
        assert.deepEqual(
          syncs
            .slice(start)
            .filter(
              (filename) =>
                filename === root ||
                filename === directory ||
                filename.startsWith(directory + path.sep),
            ),
          [
            ...payload.map((name) => path.join(directory, name)),
            directory,
            path.join(directory, "complete.json"),
            directory,
            root,
          ],
        );
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
      failDirectory = path.join(root, "create-flush-failure");
      await assert.rejects(
        createCatalogRecoveryVault({
          plan,
          toolParent,
          parent: root,
          name: "create-flush-failure",
          recipient: publicRecipient,
          owner: { read: async (binding) => Buffer.from(fixture.material.get(binding.role)!) },
        }),
        /injected payload-directory flush/u,
      );
      assert.deepEqual(await readdir(failDirectory), ["catalog.age"]);
      failDirectory = undefined;
      const createStart = syncs.length;
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
      publicationOrder(createStart, path.join(root, "primary-backup"), ["catalog.age"]);
      const cipher = path.join(root, "primary-backup", "catalog.age");
      await chmod(cipher, 0o644); // Ciphertext transport is separate from private plaintext custody.
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
      failDirectory = path.join(root, "restore-flush-failure");
      await assert.rejects(
        restoreCatalogRecoveryVault({ ...restore, name: "restore-flush-failure" }),
        /injected payload-directory flush/u,
      );
      assert.deepEqual(
        (await readdir(failDirectory)).sort(),
        ["ciphertext.age", ...plan.bindings.map((binding) => `${binding.role}.key`)].sort(),
      );
      failDirectory = undefined;
      const restoreStart = syncs.length;
      const recovered = await restoreCatalogRecoveryVault({
        ...restore,
        name: "recovered-quarantine",
      });
      assert.equal(recovered.completion, "quarantined-reprojected-only");
      assert.equal(recovered.authority, "none");
      publicationOrder(restoreStart, path.join(root, "recovered-quarantine"), [
        "ciphertext.age",
        ...plan.bindings.map((binding) => `${binding.role}.key`),
      ]);
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
