/** One fixed prepared Linux support product. Metadata is interpretation only;
 * authentication belongs to the original verified controller-tool receipt. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import type { CompilerIdentity } from "./rust-support-cache.mts";
import type { RustRunDependencies } from "./run-rust-tests.mts";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

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

/** Fixed support materialization, not provenance. Callers establish original
 * source/artifact custody and supply its live recheck. Never compiles or queries
 * a shared cache; only the exact prepared reaper may cross this dependency seam. */
export function preparedNativeSupportDependencies(
  input: {
    caller_root: string;
    output_parent: string;
    source_file: string;
    source: Buffer;
    binary: Buffer;
    metadata: ReturnType<typeof inspectNativeRuntimeSupport>;
  },
  recheck: () => void,
  refuse: () => void,
): Pick<RustRunDependencies, "rustSupportCompilerIdentity" | "prepareSupportArtifact"> {
  assert.ok(
    input.source.length > 0 &&
      input.source.length <= 65536 &&
      input.binary.length >= 64 &&
      input.binary.length <= nativeRuntimeSupport.maximumBinaryBytes,
  );
  const source = Buffer.from(input.source),
    binary = Buffer.from(input.binary);
  const metadata = structuredClone(input.metadata);
  let stopped = false;
  const active = () => {
    assert.ok(!stopped, "prepared native support stopped");
    try {
      recheck();
    } catch (error) {
      stopped = true;
      refuse();
      throw error;
    }
  };
  active();
  assert.equal(hash(source), metadata.source.sha256);
  assert.equal(source.length, metadata.source.bytes);
  assert.equal(hash(binary), metadata.output.sha256);
  assert.equal(binary.length, metadata.output.bytes);
  assert.equal(realpathSync(input.output_parent), input.output_parent);
  return {
    rustSupportCompilerIdentity: () => {
      active();
      return structuredClone(metadata.compiler);
    },
    prepareSupportArtifact: (options) => {
      try {
        active();
        assert.equal(options.root, input.caller_root);
        assert.equal(options.product, nativeRuntimeSupport.product);
        assert.equal(options.source, nativeRuntimeSupport.source);
        assert.deepEqual(options.rustcArgs, nativeRuntimeSupport.arguments);
        assert.deepEqual(options.compiler, metadata.compiler);
        assert.equal(options.platform, "linux");
        assert.equal(options.architecture, "x64");
        const directory = path.dirname(options.output);
        assert.equal(path.dirname(directory), input.output_parent);
        assert.match(path.basename(directory), /^portcove-host-tool-fixture-[A-Za-z0-9]{6}$/u);
        assert.equal(path.basename(options.output), "portcove-linux-process-tree-reaper");
        assert.equal(realpathSync(directory), directory);
        const owner = lstatSync(directory);
        assert.ok(
          owner.isDirectory() &&
            !owner.isSymbolicLink() &&
            owner.uid === process.getuid?.() &&
            (owner.mode & 0o077) === 0,
        );
        const current = readFileSync(input.source_file);
        assert.equal(current.length, metadata.source.bytes);
        assert.equal(hash(current), metadata.source.sha256);
        const fd = openSync(options.output, "wx", 0o700);
        try {
          writeFileSync(fd, binary);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const copied = lstatSync(options.output);
        assert.ok(copied.isFile() && copied.nlink === 1 && copied.uid === process.getuid?.());
        assert.equal(copied.mode & 0o777, metadata.output.mode);
        assert.equal(hash(readFileSync(options.output)), metadata.output.sha256);
        active();
        return { outcome: "hit", fingerprint: metadata.input_fingerprint, elapsed_ms: 0 };
      } catch (error) {
        stopped = true;
        refuse();
        throw error;
      }
    },
  };
}
