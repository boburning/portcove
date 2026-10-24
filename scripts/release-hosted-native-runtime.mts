/** Original admitted parent + original verified controller tools. No imported
 * manifest, runtime compiler, shared-cache fallback or native acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
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
import { performance } from "node:perf_hooks";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import {
  readControllerToolFile,
  inspectControllerToolManifest,
} from "./release-controller-tools.mts";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import {
  nativeRuntimeSupport,
  inspectNativeRuntimeSupport,
} from "./release-native-runtime-support.mts";
import { rustSupportInputIdentity } from "./rust-support-cache.mts";
import type { RustRunDependencies } from "./run-rust-tests.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  type NativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const attemptedParents = new WeakSet<object>();
const runtimes = new WeakMap<
  object,
  {
    tools: object;
    parent: object;
    entry: string;
    node: { bytes: number; sha256: string };
    tool_root: string;
    files: { path: string; bytes: number; sha256: string }[];
    manifest_sha256: string;
    root: string;
    binary: Buffer;
    metadata: ReturnType<typeof inspectNativeRuntimeSupport>;
    stopped: boolean;
    custody_files: string[];
    custody: NativeRuntimeCustody;
  }
>();
async function sameParentTools(toolsReceipt: object, parentReceipt: object) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const parent = await requireActualHostedNativeParentSource(parentReceipt);
  const tools = await verifiedControllerToolPaths(toolsReceipt);
  assert.equal(tools.identity.controller_revision, parent.producer.controller_revision);
  assert.equal(tools.identity.controller_ref, parent.producer.controller_ref);
  assert.equal(tools.identity.run_id, parent.producer.run_id);
  assert.equal(tools.identity.run_attempt, parent.producer.run_attempt);
  assert.equal(parent.platform_label, "linux-x86_64");
  assert.ok(
    parent.stage === "payload-signing" || parent.stage === "release-publication",
    "authenticated native stage required",
  );
  parent.recheck();
  return { parent, tools };
}

/** The executing fixed entry and Node must match the independently verified
 * artifact. Receipts are module-private and cannot cross a serialized handoff. */
export async function prepareHostedNativeRuntime(
  toolsReceipt: object,
  parentReceipt: object,
  executingEntry: string,
) {
  assert.ok(
    !attemptedParents.has(parentReceipt),
    "one original native runtime; explicit recovery required",
  );
  attemptedParents.add(parentReceipt);
  const { tools, parent } = await sameParentTools(toolsReceipt, parentReceipt);
  assert.ok(path.isAbsolute(executingEntry));
  assert.equal(path.basename(executingEntry), "release-hosted-native-runner.bundle.mjs");
  assert.equal(await realpath(executingEntry), executingEntry);
  const executingRoot = path.dirname(path.dirname(executingEntry));
  assert.equal(
    executingEntry,
    path.join(executingRoot, "scripts/release-hosted-native-runner.bundle.mjs"),
  );
  assert.equal(await realpath(executingRoot), executingRoot);
  const manifestBytes = await readControllerToolFile(path.join(tools.root, "manifest.json"), 65536);
  const manifest = inspectControllerToolManifest(JSON.parse(manifestBytes.toString("utf8")));
  assert.equal(manifest.source_commit, tools.identity.controller_revision);
  assert.equal(manifest.source_tree, tools.identity.source_tree);
  const custodyFiles = [
    ...manifest.files.map((file) => path.join(executingRoot, file.path)),
    path.join(executingRoot, "manifest.json"),
    process.execPath,
  ];
  const custody = inspectNativeRuntimeCustody(custodyFiles);
  // The fixed bundle re-verifies its own complete materialization against the
  // original attested receipt in this bundle's realm. No cross-bundle brand.
  for (const file of manifest.files) {
    const bytes = await readControllerToolFile(path.join(executingRoot, file.path), file.bytes);
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256);
  }
  assert.equal(
    hash(await readControllerToolFile(path.join(executingRoot, "manifest.json"), 65536)),
    hash(manifestBytes),
  );
  const node = await readControllerToolFile(process.execPath);
  assert.ok(node.equals(await readControllerToolFile(tools.node)));
  const sourceFile = path.join(executingRoot, nativeRuntimeSupport.source);
  const source = await readControllerToolFile(sourceFile, 65536);
  const binaryFile = path.join(executingRoot, nativeRuntimeSupport.binary);
  const binary = await readControllerToolFile(binaryFile, nativeRuntimeSupport.maximumBinaryBytes);
  const metadata = inspectNativeRuntimeSupport(
    JSON.parse(
      (
        await readControllerToolFile(path.join(tools.root, nativeRuntimeSupport.metadata), 65536)
      ).toString("utf8"),
    ),
    source,
    binary,
  );
  const input = rustSupportInputIdentity({
    product: nativeRuntimeSupport.product,
    source: sourceFile,
    compiler: metadata.compiler,
    rustcArgs: nativeRuntimeSupport.arguments,
    platform: "linux",
    architecture: "x64",
  });
  assert.equal(input.fingerprint, metadata.input_fingerprint);
  const binaryStat = await lstat(binaryFile);
  assert.ok(binaryStat.isFile() && !binaryStat.isSymbolicLink());
  assert.equal(binaryStat.mode & 0o777, metadata.output.mode);
  parent.recheck();
  await sameParentTools(toolsReceipt, parentReceipt);
  recheckNativeRuntimeCustody(custodyFiles, custody);
  parent.recheck();
  const receipt = Object.freeze({ kind: "original-hosted-native-runtime", authority: "none" });
  runtimes.set(receipt, {
    tools: toolsReceipt,
    parent: parentReceipt,
    entry: executingEntry,
    node: { bytes: node.length, sha256: hash(node) },
    tool_root: tools.root,
    files: structuredClone(manifest.files),
    manifest_sha256: hash(manifestBytes),
    root: executingRoot,
    binary,
    metadata,
    stopped: false,
    custody_files: custodyFiles,
    custody,
  });
  return receipt;
}

/** Recheck original artifact/parent, including executing entry/Node bytes.
 * Observed drift permanently stops this runtime even after restoration. */
export async function requireHostedNativeRuntime(receipt: object, parentReceipt: object) {
  const state = runtimes.get(receipt);
  assert.ok(
    state && !state.stopped && state.parent === parentReceipt,
    "original native runtime required",
  );
  try {
    const { tools, parent } = await sameParentTools(state.tools, state.parent);
    assert.equal(tools.root, state.tool_root);
    recheckNativeRuntimeCustody(state.custody_files, state.custody);
    for (const file of state.files) {
      const bytes = await readControllerToolFile(path.join(state.root, file.path), file.bytes);
      assert.equal(bytes.length, file.bytes);
      assert.equal(hash(bytes), file.sha256);
      parent.recheck();
    }
    assert.equal(
      hash(await readControllerToolFile(path.join(state.root, "manifest.json"), 65536)),
      state.manifest_sha256,
    );
    const node = await readControllerToolFile(process.execPath, state.node.bytes);
    assert.equal(node.length, state.node.bytes);
    assert.equal(hash(node), state.node.sha256);
    const binary = await lstat(path.join(state.root, nativeRuntimeSupport.binary));
    assert.equal(binary.mode & 0o777, state.metadata.output.mode);
    recheckNativeRuntimeCustody(state.custody_files, state.custody);
    parent.recheck();
    return { root: state.root, deadline: parent.deadline, authority: "none" as const };
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}

/** Existing resource-supervisor dependency seam, closed over original custody.
 * It supplies both callbacks together. No runtime compiler or cache is queried. */
export async function hostedNativeSupportDependencies(
  receipt: object,
  parentReceipt: object,
  outputParent: string,
): Promise<Pick<RustRunDependencies, "rustSupportCompilerIdentity" | "prepareSupportArtifact">> {
  const runtime = await requireHostedNativeRuntime(receipt, parentReceipt);
  const state = runtimes.get(receipt)!;
  assert.equal(await realpath(outputParent), outputParent);
  const active = () => {
    if (state.stopped || performance.now() >= runtime.deadline) {
      state.stopped = true;
      throw new Error("original native runtime expired");
    }
    try {
      recheckNativeRuntimeCustody(state.custody_files, state.custody);
      if (performance.now() >= runtime.deadline) throw new Error("original native runtime expired");
    } catch (error) {
      state.stopped = true;
      throw error;
    }
  };
  return {
    rustSupportCompilerIdentity: () => {
      active();
      return structuredClone(state.metadata.compiler);
    },
    prepareSupportArtifact: (options) => {
      try {
        active();
        assert.equal(options.root, state.root + path.sep);
        assert.equal(options.product, nativeRuntimeSupport.product);
        assert.equal(options.source, nativeRuntimeSupport.source);
        assert.deepEqual(options.rustcArgs, nativeRuntimeSupport.arguments);
        assert.deepEqual(options.compiler, state.metadata.compiler);
        assert.equal(options.platform, "linux");
        assert.equal(options.architecture, "x64");
        const directory = path.dirname(options.output);
        assert.equal(path.dirname(directory), outputParent);
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
        const source = readFileSync(path.join(state.root, nativeRuntimeSupport.source));
        assert.equal(source.length, state.metadata.source.bytes);
        assert.equal(hash(source), state.metadata.source.sha256);
        const fd = openSync(options.output, "wx", 0o700);
        try {
          writeFileSync(fd, state.binary);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const copied = lstatSync(options.output);
        assert.ok(copied.isFile() && copied.nlink === 1 && copied.uid === process.getuid?.());
        assert.equal(copied.mode & 0o777, state.metadata.output.mode);
        assert.equal(hash(readFileSync(options.output)), state.metadata.output.sha256);
        active();
        return { outcome: "hit", fingerprint: state.metadata.input_fingerprint, elapsed_ms: 0 };
      } catch (error) {
        state.stopped = true;
        throw error;
      }
    },
  };
}
