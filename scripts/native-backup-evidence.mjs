// Lossless bounded retention for the one on-demand backup-focus job, in free job logs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const byteLimit = 12 * 1024 * 1024;
const payloadLimit = 20 * 1024 * 1024;
const compressedLimit = 8 * 1024 * 1024;
const prefix = "PORTCOVE_BACKUP_EVIDENCE_V1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ownedName = /^(?:[a-zA-Z0-9_.-]+\/){0,3}[a-zA-Z0-9_.-]+\.(?:png|json|jsonl|log)$/u;

async function filesIn(directory, extensions) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!extensions.has(path.extname(entry.name))) continue;
    assert.ok(entry.isFile(), "Evidence must be regular files, never links");
    result.push(path.join(directory, entry.name));
  }
  return result;
}

export async function encodeBackupEvidence(root) {
  assert.ok((await lstat(root)).isDirectory(), "Owned evidence root must be a regular directory");
  const files = await filesIn(root, new Set([".json"]));
  const runs = path.join(root, "desktop-verify");
  if (await lstat(runs).catch(() => null)) {
    assert.ok((await lstat(runs)).isDirectory(), "Owned run root must be a regular directory");
    const entries = await readdir(runs, { withFileTypes: true });
    assert.equal(entries.length, 1, "One manual probe must retain exactly one run");
    assert.ok(entries[0].isDirectory(), "Run must be a regular directory");
    const run = path.join(runs, entries[0].name);
    files.push(...(await filesIn(run, new Set([".json", ".log"]))));
    const native = path.join(run, "native");
    if (await lstat(native).catch(() => null)) {
      assert.ok((await lstat(native)).isDirectory(), "Native output must be a regular directory");
      files.push(...(await filesIn(native, new Set([".json", ".jsonl", ".log", ".png"]))));
    }
  }
  return encodeFiles(root, files);
}

async function encodeFiles(root, files) {
  assert.ok(files.length > 0 && files.length <= 128, "Missing or excessive native evidence");
  let total = 0;
  const records = [];
  for (const file of files.sort()) {
    const name = path.relative(root, file).split(path.sep).join("/");
    assert.ok(
      ownedName.test(name) && !name.split("/").includes(".."),
      "Invalid owned evidence path",
    );
    const metadata = await lstat(file);
    assert.ok(metadata.isFile() && metadata.size <= byteLimit, "Non-regular or excessive evidence");
    const bytes = await readFile(file);
    total += bytes.length;
    assert.ok(total <= byteLimit, "Native evidence exceeds its explicit retention bound");
    records.push({
      name,
      bytes: bytes.length,
      sha256: digest(bytes),
      base64: bytes.toString("base64"),
    });
  }
  const payload = Buffer.from(JSON.stringify({ format_version: 1, files: records }));
  assert.ok(payload.length <= payloadLimit);
  const compressed = gzipSync(payload);
  assert.ok(compressed.length <= compressedLimit);
  const hash = digest(compressed);
  const encoded = compressed.toString("base64");
  const count = Math.ceil(encoded.length / 4096);
  return Array.from(
    { length: count },
    (_, index) =>
      `${prefix} ${index + 1}/${count} ${hash} ${encoded.slice(index * 4096, (index + 1) * 4096)}`,
  ).join("\n");
}

// Fixed hosted jobs retain only their isolated reports, raw logs and PNGs.
// The original one-backup-run inventory remains unchanged above.
export async function encodeHostedEvidence(root) {
  const files = [];
  async function visit(directory, depth) {
    assert.ok(depth <= 3 && (await lstat(directory)).isDirectory(), "Unsupported evidence tree");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), "Evidence cannot contain links");
      if (entry.isDirectory()) {
        // Runtime SQLite/library and WebView profiles are not evidence artifacts.
        if (depth === 1 && ["library", "webview"].includes(entry.name)) continue;
        assert.ok(depth === 0 && entry.name === "native", "Unsupported artifact directory");
        await visit(file, depth + 1);
      } else {
        assert.ok(
          entry.isFile() && /\.(?:png|json|jsonl|log)$/u.test(entry.name),
          "Unsupported evidence file",
        );
        files.push(file);
        assert.ok(files.length <= 128, "Excessive hosted evidence inventory");
      }
    }
  }
  await visit(root, 0);
  assert.ok(files.includes(path.join(root, "binding.json")), "Missing execution binding");
  return encodeFiles(root, files);
}

export async function recoverHostedEvidence(log, destination, expected) {
  const names = await recoverBackupEvidence(log, destination);
  const binding = JSON.parse(await readFile(path.join(destination, "binding.json"), "utf8"));
  for (const key of [
    "source",
    "controller",
    "base",
    "run",
    "attempt",
    "job",
    "phase",
    "binding_sha256",
  ])
    assert.ok(
      expected[key] !== undefined && binding[key] === expected[key],
      `Recovered ${key} differs`,
    );
  assert.ok(names.includes("execution.json"), "No terminal command evidence");
  const execution = JSON.parse(await readFile(path.join(destination, "execution.json"), "utf8"));
  for (const key of [
    "source",
    "controller",
    "base",
    "run",
    "attempt",
    "job",
    "phase",
    "binding_sha256",
  ])
    assert.equal(execution[key], expected[key], `Terminal ${key} differs`);
  assert.ok(Number.isInteger(execution.exit_code), "Missing terminal exit status");
  if (execution.phase === "audit" && execution.exit_code === 0)
    assert.ok(
      names.includes("complete-audit-receipt.json"),
      "Audit success requires its maintained raw receipt",
    );
  if (execution.phase === "native" && execution.exit_code === 0)
    assert.ok(
      names.some((name) => name.endsWith(".png")),
      "Native success requires actual PNG bytes",
    );
  return { names, phase: execution.phase, exit_code: execution.exit_code };
}

export async function recoverBackupEvidence(log, destination) {
  const matches = [
    ...log.matchAll(
      /PORTCOVE_BACKUP_EVIDENCE_V1 (\d+)\/(\d+) ([a-f0-9]{64}) ([A-Za-z0-9+/=]+)$/gmu,
    ),
  ];
  assert.ok(matches.length > 0 && matches.length <= 3000, "Missing or excessive evidence records");
  const count = Number(matches[0][2]);
  const hash = matches[0][3];
  assert.equal(matches.length, count, "Incomplete evidence records");
  for (const [index, match] of matches.entries()) {
    assert.equal(Number(match[1]), index + 1, "Reordered or duplicate evidence records");
    assert.equal(Number(match[2]), count);
    assert.equal(match[3], hash);
    assert.ok(match[4].length <= 4096);
  }
  const compressed = Buffer.from(matches.map((match) => match[4]).join(""), "base64");
  assert.ok(compressed.length <= compressedLimit);
  assert.equal(digest(compressed), hash, "Evidence payload hash mismatch");
  const payload = JSON.parse(gunzipSync(compressed, { maxOutputLength: payloadLimit }));
  assert.equal(payload.format_version, 1);
  assert.ok(
    Array.isArray(payload.files) && payload.files.length > 0 && payload.files.length <= 128,
  );
  let total = 0;
  const names = new Set();
  const decoded = payload.files.map((file) => {
    assert.ok(ownedName.test(file.name) && !file.name.split("/").includes(".."));
    assert.ok(!names.has(file.name), "Duplicate evidence path");
    names.add(file.name);
    assert.ok(typeof file.base64 === "string");
    const bytes = Buffer.from(file.base64, "base64");
    assert.equal(bytes.length, file.bytes);
    assert.equal(digest(bytes), file.sha256, "Evidence file hash mismatch");
    total += bytes.length;
    assert.ok(total <= byteLimit);
    return { name: file.name, bytes };
  });
  // Validate the complete payload before creating any output; never overwrite evidence.
  await mkdir(destination);
  for (const file of decoded) {
    const target = path.join(destination, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes, { flag: "wx" });
  }
  return decoded.map((file) => file.name);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, output] = process.argv.slice(2);
  assert.ok(
    input &&
      ((["emit", "emit-hosted"].includes(mode) && !output) ||
        (["recover", "recover-hosted"].includes(mode) && output)),
    "usage: native-backup-evidence.mjs emit[-hosted] <owned-root> | recover[-hosted] <job-log> <new-directory> [expected-binding.json]",
  );
  if (mode === "emit") console.log(await encodeBackupEvidence(path.resolve(input)));
  else if (mode === "emit-hosted") console.log(await encodeHostedEvidence(path.resolve(input)));
  else if (mode === "recover-hosted")
    console.log(
      await recoverHostedEvidence(
        await readFile(input, "utf8"),
        path.resolve(output),
        JSON.parse(await readFile(process.argv[5], "utf8")),
      ),
    );
  else
    console.log(await recoverBackupEvidence(await readFile(input, "utf8"), path.resolve(output)));
}
