/** One fixed prepared Linux support product. Metadata is interpretation only;
 * authentication belongs to the original verified controller-tool receipt. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import type { CompilerIdentity } from "./rust-support-cache.mts";

export const nativeRuntimeSupport = Object.freeze({
  product: "linux-process-tree-reaper",
  source: "scripts/fixtures/linux-process-tree-reaper.rs.txt",
  binary: "bin/native-linux-tree-reaper",
  metadata: "native-linux-support.json",
  arguments: Object.freeze([
    "--edition=2024",
    "--crate-name",
    "portcove_linux_process_tree_reaper",
  ]),
  maximumBinaryBytes: 16 * 1024 ** 2,
});
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const exact = (raw: unknown, keys: string): raw is Record<string, unknown> =>
  isRecord(raw) && Object.keys(raw).sort().join(",") === keys;
function compilerIdentity(raw: unknown): CompilerIdentity {
  assert.ok(exact(raw, "commands,environment,sysroot,verbose_version"));
  assert.ok(
    typeof raw.verbose_version === "string" &&
      raw.verbose_version.length > 0 &&
      raw.verbose_version.length <= 8192,
  );
  assert.ok(
    typeof raw.sysroot === "string" && raw.sysroot.startsWith("/") && raw.sysroot.length <= 4096,
  );
  assert.ok(Array.isArray(raw.commands) && raw.commands.length > 0 && raw.commands.length <= 16);
  const commands = raw.commands.map((command: unknown) => {
    assert.ok(isRecord(command));
    const keys = Object.keys(command).sort().join(",");
    assert.ok(keys === "command,resolved" || keys === "bytes,command,resolved,sha256");
    assert.ok(
      typeof command.command === "string" &&
        command.command.length > 0 &&
        command.command.length <= 4096,
    );
    assert.ok(
      command.resolved === null ||
        (typeof command.resolved === "string" &&
          command.resolved.startsWith("/") &&
          command.resolved.length <= 4096),
    );
    if (keys === "command,resolved") {
      assert.equal(command.resolved, null);
      return { command: command.command, resolved: null };
    }
    assert.ok(Number.isSafeInteger(command.bytes) && Number(command.bytes) > 0);
    assert.equal(typeof command.resolved, "string");
    assert.ok(typeof command.sha256 === "string" && /^[a-f0-9]{64}$/u.test(command.sha256));
    return {
      command: command.command,
      resolved: command.resolved as string,
      bytes: Number(command.bytes),
      sha256: command.sha256,
    };
  });
  assert.ok(Array.isArray(raw.environment) && raw.environment.length <= 64);
  const environment = raw.environment.map((entry: unknown) => {
    assert.ok(exact(entry, "name,value_sha256"));
    assert.ok(typeof entry.name === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(entry.name));
    assert.ok(typeof entry.value_sha256 === "string" && /^[a-f0-9]{64}$/u.test(entry.value_sha256));
    return { name: entry.name, value_sha256: entry.value_sha256 };
  });
  return { verbose_version: raw.verbose_version, sysroot: raw.sysroot, commands, environment };
}

/** Closed fixed-product metadata; valid JSON alone supplies no authenticity. */
export function inspectNativeRuntimeSupport(raw: unknown, source: Buffer, binary: Buffer) {
  assert.ok(
    exact(
      raw,
      "compiler,input_fingerprint,output,platform,product,rustc_arguments,schema_version,source",
    ),
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.product, nativeRuntimeSupport.product);
  assert.equal(raw.platform, "linux-x86_64");
  assert.deepEqual(raw.rustc_arguments, nativeRuntimeSupport.arguments);
  assert.ok(
    typeof raw.input_fingerprint === "string" && /^[a-f0-9]{64}$/u.test(raw.input_fingerprint),
  );
  assert.ok(exact(raw.source, "bytes,sha256"));
  assert.ok(source.length > 0 && source.length <= 65536);
  assert.equal(raw.source.bytes, source.length);
  assert.equal(raw.source.sha256, hash(source));
  assert.ok(exact(raw.output, "bytes,mode,sha256"));
  assert.ok(binary.length >= 64 && binary.length <= nativeRuntimeSupport.maximumBinaryBytes);
  // The fixed product is ELF64, little-endian, x86-64. No selected runtime path.
  assert.ok(binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
  assert.equal(binary[4], 2);
  assert.equal(binary[5], 1);
  assert.equal(binary.readUInt16LE(18), 62);
  assert.equal(raw.output.bytes, binary.length);
  assert.equal(raw.output.sha256, hash(binary));
  assert.equal(raw.output.mode, 0o700);
  const compiler = compilerIdentity(raw.compiler);
  return {
    compiler,
    input_fingerprint: raw.input_fingerprint,
    output: { bytes: binary.length, sha256: hash(binary), mode: 0o700 },
    source: { bytes: source.length, sha256: hash(source) },
  };
}
