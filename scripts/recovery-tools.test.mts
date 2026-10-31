import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  appendFile,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  link,
  chmod,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { readSync, type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { inspectRecoveryToolTar } from "./recovery-tool-archive.mts";
import {
  inspectRecoveryAttestation,
  recoveryToolPins,
  verifyRecoveryToolFiles,
  inspectRecoveryToolProof,
} from "./prepare-recovery-tools.mts";
import { parseAquaConfig, validateAquaChecksumLedger } from "./aqua-integrity.mts";
import { readRecoveryCiphertext } from "./catalog-recovery-vault.mts";

function tar(records: { name: string; bytes?: Buffer; type?: string; size?: number }[]) {
  const chunks: Buffer[] = [];
  for (const record of records) {
    const data = record.bytes ?? Buffer.from("inert");
    const header = Buffer.alloc(512);
    header.write(record.name, 0, 100);
    header.write(`${(record.size ?? data.length).toString(8).padStart(11, "0")}\0`, 124);
    header[156] = (record.type ?? "0").charCodeAt(0);
    header.write("ustar\0", 257);
    header.fill(32, 148, 156);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function attestation() {
  return [
    {
      verificationResult: {
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          subject: [
            {
              name: "age-v1.3.2-linux-amd64.tar.gz",
              digest: { sha256: recoveryToolPins.age.sha256 },
            },
          ],
          predicateType: "https://slsa.dev/provenance/v1",
          predicate: {
            buildDefinition: {
              externalParameters: {
                workflow: {
                  repository: "https://github.com/FiloSottile/age",
                  path: ".github/workflows/build.yml",
                  ref: "refs/tags/v1.3.2",
                },
              },
              resolvedDependencies: [
                {
                  uri: "git+https://github.com/FiloSottile/age@refs/tags/v1.3.2",
                  digest: { gitCommit: recoveryToolPins.age.source },
                },
              ],
            },
          },
        },
      },
    },
  ];
}

void test(
  "warm recovery cache rechecks bounded fixture archives, binaries and proof rather than trusting receipt hashes",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "recovery-cache-fixture-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const names = ["aqua", "gh", "age", "age-keygen"];
    const payloads = names.map((name) => Buffer.from(`inert ${name}`));
    const tools = names.map((name, i) => ({
      path: path.join(directory, name),
      sha256: hash(payloads[i]!),
    }));
    for (let i = 0; i < tools.length; i++)
      await writeFile(tools[i]!.path, payloads[i]!, { mode: 0o600 });
    const archives = {
      aqua: tar([
        { name: "aqua", bytes: payloads[0]! },
        { name: "LICENSE" },
        { name: "README.md" },
      ]),
      gh: tar([{ name: "gh_2.102.0_linux_amd64/bin/gh", bytes: payloads[1]! }]),
      age: tar([
        { name: "age/age", bytes: payloads[2]! },
        { name: "age/age-keygen", bytes: payloads[3]! },
      ]),
    };
    const pins = {
      aqua: { bytes: archives.aqua.length, sha256: hash(archives.aqua) },
      gh: { bytes: archives.gh.length, sha256: hash(archives.gh) },
      age: { bytes: archives.age.length, sha256: hash(archives.age) },
    };
    for (const [name, bytes] of Object.entries(archives))
      await writeFile(path.join(directory, name + ".tar.gz"), bytes, { mode: 0o600 });
    await verifyRecoveryToolFiles(directory, tools, pins);
    const archivePath = path.join(directory, "aqua.tar.gz");
    await writeFile(archivePath, Buffer.alloc(archives.aqua.length));
    await assert.rejects(verifyRecoveryToolFiles(directory, tools, pins), /archive changed/u);
    await writeFile(archivePath, archives.aqua);
    await writeFile(tools[0]!.path, "substitution");
    await assert.rejects(
      verifyRecoveryToolFiles(directory, tools, pins),
      /corruption or substitution/u,
    );
    await writeFile(tools[0]!.path, payloads[0]!);
    const proofPath = path.join(directory, "verified-attestation.stdout"),
      proof = Buffer.from(JSON.stringify(attestation()));
    await writeFile(proofPath, proof, { mode: 0o600 });
    // Inert producer-shaped data exercises integrity only, never cryptographic admission.
    await inspectRecoveryToolProof(directory, hash(proof), recoveryToolPins.age.sha256);
    await appendFile(proofPath, " ");
    await assert.rejects(
      inspectRecoveryToolProof(directory, hash(proof), recoveryToolPins.age.sha256),
      /cached attestation changed/u,
    );
    await assert.rejects(
      verifyRecoveryToolFiles(directory, tools.slice(0, 3), pins),
      /complete.*inventory/u,
    );
  },
);

void test("recovery-only configuration pins the two required tools without changing ordinary profiles", async () => {
  const config = await readFile(
    new URL("../.config/recovery-tools/aqua.yaml", import.meta.url),
    "utf8",
  );
  const ledger: unknown = JSON.parse(
    await readFile(
      new URL("../.config/recovery-tools/aqua-checksums.json", import.meta.url),
      "utf8",
    ),
  );
  const parsed = parseAquaConfig(config);
  assert.equal(validateAquaChecksumLedger(parsed, ledger).length, 4);
  assert.deepEqual(parsed.packages, [
    { name: "FiloSottile/age", version: "v1.3.2" },
    { name: "cli/cli", version: "v2.102.0" },
  ]);
  const ordinary = await readFile(new URL("../aqua.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(ordinary, /FiloSottile\/age|cli\/cli/u);
});

void test("raw recovery tar validates complete regular-file inventory before returning executable bytes", () => {
  const archive = tar([
    { name: "aqua" },
    { name: "LICENSE" },
    { name: "README.md" },
    { name: "third_party_licenses/a.txt" },
  ]);
  assert.equal(inspectRecoveryToolTar(archive, "aqua").size, 4);
  const age = tar([{ name: "age/age" }, { name: "age/age-keygen" }, { name: "age/age-plugin-pq" }]);
  assert.deepEqual(
    [...inspectRecoveryToolTar(age, "age").keys()],
    ["age/age", "age/age-keygen", "age/age-plugin-pq"],
  );
  assert.throws(() => inspectRecoveryToolTar(tar([{ name: "age/age" }]), "age"), /missing tool/u);
});

void test("raw recovery tar refuses extensions and links before declared-size buffering", () => {
  for (const type of ["x", "g", "L", "K", "1", "2", "S"])
    assert.throws(
      () => inspectRecoveryToolTar(tar([{ name: "aqua", type, size: 0x40000000 }]), "aqua"),
      /extension or link/u,
    );
});

void test("raw recovery tar accepts exactly 2048 records and refuses the next record", () => {
  const records = [
    { name: "aqua" },
    { name: "LICENSE" },
    { name: "README.md" },
    ...Array.from({ length: 2045 }, (_, i) => ({ name: `third_party_licenses/${i}` })),
  ];
  assert.equal(inspectRecoveryToolTar(tar(records), "aqua").size, 2048);
  assert.throws(
    () => inspectRecoveryToolTar(tar([...records, { name: "third_party_licenses/extra" }]), "aqua"),
    /record bound/u,
  );
});

void test("held recovery reader bounds actual temporary-file growth and refuses substitution and oversize", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recovery-held-read-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "inert");
  await writeFile(filename, "tiny");
  const expected = await stat(filename);
  await assert.rejects(readControllerToolFile(filename, 3, expected), /regular-file bound/u);
  await rename(filename, filename + ".old");
  await writeFile(filename, "tiny");
  await assert.rejects(readControllerToolFile(filename, 4, expected), /held identity differs/u);
  const current = await stat(filename);
  await assert.rejects(
    readControllerToolFile(filename, 4, {
      dev: current.dev,
      ino: Number.MAX_SAFE_INTEGER + 1,
      uid: current.uid,
      nlink: current.nlink,
    }),
    /held identity differs/u,
  );
  const probe = await open(filename, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  let mutated = false;
  const requests: number[] = [];
  t.mock.method(
    prototype,
    "read",
    async function (this: { fd: number }, buffer: Buffer, offset: number, length: number) {
      if (!mutated) {
        mutated = true;
        await appendFile(filename, Buffer.alloc(65536, 65));
      }
      requests.push(length);
      return { bytesRead: readSync(this.fd, buffer, offset, length, null), buffer };
    },
  );
  await assert.rejects(readControllerToolFile(filename, 4, current), /changed during acquisition/u);
  assert.equal(mutated, true);
  assert.ok(requests.every((length) => length <= 5));
  assert.equal((await stat(filename)).size, 65540);
});

void test("held reader preserves exact large identities and refuses rounded, colliding or changed descriptors", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recovery-bigint-read-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "ciphertext-fixture");
  await writeFile(filename, "bounded ciphertext fixture");
  const numeric = await stat(filename),
    exact = await stat(filename, { bigint: true });
  const probe = await open(filename, "r"),
    prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const originalStat = prototype.stat;
  let identity = exact.ino,
    changed = false,
    linksChanged = false,
    nanosChanged = false,
    stats = 0,
    reads = 0;
  t.mock.method(prototype, "stat", async function (this: FileHandle) {
    const result = (await originalStat.call(this, { bigint: true })) as BigIntStats;
    if (result.dev === exact.dev && result.ino === exact.ino) {
      stats++;
      Object.defineProperty(result, "ino", { value: identity + (changed && stats > 1 ? 1n : 0n) });
      if (linksChanged && stats > 1)
        Object.defineProperty(result, "nlink", { value: result.nlink + 1n });
      if (nanosChanged && stats > 1)
        Object.defineProperty(result, "ctimeNs", { value: result.ctimeNs + 1n });
    }
    return result;
  });
  t.mock.method(
    prototype,
    "read",
    async function (this: { fd: number }, buffer: Buffer, offset: number, length: number) {
      reads++;
      return { bytesRead: readSync(this.fd, buffer, offset, length, null), buffer };
    },
  );
  assert.equal(
    (await readControllerToolFile(filename, 64, numeric)).toString(),
    "bounded ciphertext fixture",
  );
  identity = 9007199254740993n;
  const descriptor = { dev: exact.dev, ino: identity, uid: exact.uid, nlink: exact.nlink };
  stats = reads = 0;
  assert.equal(
    (await readControllerToolFile(filename, 64, descriptor)).toString(),
    "bounded ciphertext fixture",
  );
  assert.ok(reads > 0);
  assert.equal(Number(identity), Number(identity - 1n));
  stats = reads = 0;
  await assert.rejects(
    readControllerToolFile(filename, 64, { ...descriptor, ino: identity - 1n }),
    /held identity differs/u,
  );
  assert.equal(reads, 0);
  await assert.rejects(
    readControllerToolFile(filename, 64, {
      dev: numeric.dev,
      ino: Number(identity),
      uid: numeric.uid,
      nlink: numeric.nlink,
    }),
    /held identity differs/u,
  );
  assert.equal(reads, 0);
  stats = reads = 0;
  changed = true;
  await assert.rejects(
    readControllerToolFile(filename, 64, descriptor),
    /changed during acquisition/u,
  );
  assert.ok(reads > 0);
  stats = reads = 0;
  changed = false;
  linksChanged = true;
  await assert.rejects(readControllerToolFile(filename, 64, descriptor), /held identity changed/u);
  assert.ok(reads > 0);
  stats = reads = 0;
  linksChanged = false;
  nanosChanged = true;
  await assert.rejects(
    readControllerToolFile(filename, 64, descriptor),
    /changed during acquisition/u,
  );
  assert.ok(reads > 0);
});

void test("ciphertext transport preserves read bounds and refuses aliases without requiring plaintext permissions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ciphertext-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "backup.age");
  await writeFile(filename, "fixture ciphertext");
  await chmod(filename, 0o777);
  assert.equal((await readRecoveryCiphertext(filename, 64)).toString(), "fixture ciphertext");
  await assert.rejects(readRecoveryCiphertext(filename, 1), /regular-file bound/u);
  await link(filename, path.join(root, "alias.age"));
  await assert.rejects(readRecoveryCiphertext(filename, 64), /single-link/u);
});

void test("raw recovery tar rejects traversal, duplicate aliases, foreign members, truncation and oversized records", () => {
  for (const name of [
    "../aqua",
    "/aqua",
    "./aqua",
    "aqua/../aqua",
    "C:/aqua",
    "third_party_licenses/../../aqua",
    "foreign",
  ])
    assert.throws(() => inspectRecoveryToolTar(tar([{ name }]), "aqua"));
  assert.throws(
    () => inspectRecoveryToolTar(tar([{ name: "aqua" }, { name: "aqua" }]), "aqua"),
    /alias/u,
  );
  assert.throws(
    () => inspectRecoveryToolTar(tar([{ name: "aqua", size: 128 * 1024 ** 2 }]), "aqua"),
    /declared limit/u,
  );
  const bytes = tar([{ name: "aqua" }]);
  assert.throws(() => inspectRecoveryToolTar(bytes.subarray(0, bytes.length - 3), "aqua"));
});

void test("verified tool attestation binds exact subject, source, workflow, tag and predicate", () => {
  const result = inspectRecoveryAttestation(attestation(), recoveryToolPins.age.sha256);
  assert.equal(result.source, recoveryToolPins.age.source);
  const multi = attestation();
  multi[0]!.verificationResult.statement.subject.push({
    name: "age-v1.3.2-windows-amd64.zip",
    digest: { sha256: "f48d8f8f9ebe903ab5027ed067652f2cc1db94bc206976430133b905dcd8e8c7" },
  });
  assert.equal(inspectRecoveryAttestation(multi, recoveryToolPins.age.sha256).statements, 1);
  multi[0]!.verificationResult.statement.subject.push(
    multi[0]!.verificationResult.statement.subject[0]!,
  );
  assert.throws(() => inspectRecoveryAttestation(multi, recoveryToolPins.age.sha256));
  for (const change of [
    (value: ReturnType<typeof attestation>) => {
      value[0]!.verificationResult.statement.subject[0]!.digest.sha256 = "0".repeat(64);
    },
    (value: ReturnType<typeof attestation>) => {
      value[0]!.verificationResult.statement.predicate.buildDefinition.externalParameters.workflow.repository =
        "https://github.com/foreign/age";
    },
    (value: ReturnType<typeof attestation>) => {
      value[0]!.verificationResult.statement.predicate.buildDefinition.externalParameters.workflow.path =
        ".github/workflows/foreign.yml";
    },
    (value: ReturnType<typeof attestation>) => {
      value[0]!.verificationResult.statement.predicate.buildDefinition.externalParameters.workflow.ref =
        "refs/heads/main";
    },
    (value: ReturnType<typeof attestation>) => {
      value[0]!.verificationResult.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit =
        "0".repeat(40);
    },
    (value: ReturnType<typeof attestation>) => {
      value[0]!.verificationResult.statement.predicateType = "unsupported";
    },
  ]) {
    const value = attestation();
    change(value);
    assert.throws(() => inspectRecoveryAttestation(value, recoveryToolPins.age.sha256));
  }
  for (const value of [
    null,
    [],
    [{ attestation: attestation() }],
    Array.from({ length: 17 }, () => attestation()[0]),
  ])
    assert.throws(() => inspectRecoveryAttestation(value, recoveryToolPins.age.sha256));
});
