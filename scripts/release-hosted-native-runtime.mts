/** Original admitted parent + original verified controller tools. No imported
 * manifest, runtime compiler, shared-cache fallback or native acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import {
  readControllerToolFile,
  inspectControllerToolManifest,
  type ControllerToolPlatform,
} from "./release-controller-tools.mts";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import {
  nativeRuntimeSupportProfile,
  inspectNativeRuntimeSupport,
  preparedNativeSupportDependencies,
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
    parentSource: Awaited<ReturnType<typeof requireActualHostedNativeParentSource>>;
    postParent?: object;
    postSource?: Awaited<ReturnType<typeof requireActualHostedNativeParentSource>>;
    postAttempted: boolean;
    deadline: number;
    entry: string;
    node: { bytes: number; sha256: string };
    tool_root: string;
    files: { path: string; bytes: number; sha256: string }[];
    manifest_sha256: string;
    root: string;
    binary: Buffer;
    metadata: ReturnType<typeof inspectNativeRuntimeSupport>;
    platform: ControllerToolPlatform;
    stopped: boolean;
    custody_files: string[];
    custody: NativeRuntimeCustody;
  }
>();
async function sameParentTools(toolsReceipt: object, parentReceipt: object) {
  assert.ok(process.platform === "linux" || process.platform === "win32");
  assert.equal(process.arch, "x64");
  const parent = await requireActualHostedNativeParentSource(parentReceipt);
  const tools = await verifiedControllerToolPaths(toolsReceipt);
  assert.equal(tools.identity.controller_revision, parent.producer.controller_revision);
  assert.equal(tools.identity.controller_ref, parent.producer.controller_ref);
  assert.equal(tools.identity.run_id, parent.producer.run_id);
  assert.equal(tools.identity.run_attempt, parent.producer.run_attempt);
  assert.equal(
    parent.platform_label,
    process.platform === "linux" ? "linux-x86_64" : "windows-x86_64",
  );
  assert.equal(tools.platform, parent.platform_label);
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
  const profile = nativeRuntimeSupportProfile(tools.platform);
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
  const manifest = inspectControllerToolManifest(
    JSON.parse(manifestBytes.toString("utf8")),
    tools.platform,
  );
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
  const sourceFile = path.join(executingRoot, profile.source);
  const source = await readControllerToolFile(sourceFile, 65536);
  const binaryFile = path.join(executingRoot, profile.binary);
  const binary = await readControllerToolFile(binaryFile, profile.maximumBinaryBytes);
  const metadata = inspectNativeRuntimeSupport(
    JSON.parse(
      (await readControllerToolFile(path.join(tools.root, profile.metadata), 65536)).toString(
        "utf8",
      ),
    ),
    source,
    binary,
    tools.platform,
  );
  const input = rustSupportInputIdentity({
    product: profile.product,
    source: sourceFile,
    compiler: metadata.compiler,
    rustcArgs: profile.arguments,
    platform: process.platform,
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
    parentSource: parent,
    postAttempted: false,
    deadline: parent.deadline,
    entry: executingEntry,
    node: { bytes: node.length, sha256: hash(node) },
    tool_root: tools.root,
    files: structuredClone(manifest.files),
    manifest_sha256: hash(manifestBytes),
    root: executingRoot,
    binary,
    metadata,
    platform: tools.platform,
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
    state &&
      !state.stopped &&
      (state.parent === parentReceipt || state.postParent === parentReceipt),
    "original native runtime required",
  );
  try {
    const { tools, parent } = await sameParentTools(state.tools, state.parent);
    state.deadline = Math.min(state.deadline, parent.deadline);
    if (state.postParent) {
      const post = await sameParentTools(state.tools, state.postParent);
      assert.deepEqual(post.parent.producer, parent.producer);
      assert.deepEqual(post.parent.configuration, parent.configuration);
      state.deadline = Math.min(state.deadline, post.parent.deadline);
      post.parent.recheck();
    }
    assert.equal(tools.root, state.tool_root);
    recheckNativeRuntimeCustody(state.custody_files, state.custody);
    for (const file of state.files) {
      const bytes = await readControllerToolFile(path.join(state.root, file.path), file.bytes);
      assert.equal(bytes.length, file.bytes);
      assert.equal(hash(bytes), file.sha256);
      parent.recheck();
      state.postSource?.recheck();
      assert.ok(
        !state.stopped && performance.now() < state.deadline,
        "joined native runtime stopped or expired",
      );
    }
    assert.equal(
      hash(await readControllerToolFile(path.join(state.root, "manifest.json"), 65536)),
      state.manifest_sha256,
    );
    const node = await readControllerToolFile(process.execPath, state.node.bytes);
    assert.equal(node.length, state.node.bytes);
    assert.equal(hash(node), state.node.sha256);
    const binary = await lstat(
      path.join(state.root, nativeRuntimeSupportProfile(state.platform).binary),
    );
    assert.equal(binary.mode & 0o777, state.metadata.output.mode);
    recheckNativeRuntimeCustody(state.custody_files, state.custody);
    parent.recheck();
    state.postSource?.recheck();
    assert.ok(
      !state.stopped && performance.now() < state.deadline,
      "original native runtime stopped or expired",
    );
    return {
      root: state.root,
      tools: state.tools,
      deadline: state.deadline,
      authority: "none" as const,
    };
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}

/** One Windows stage continuation in the original realm; never a renewed runtime. */
export async function joinHostedWindowsPostSignRuntime(
  receipt: object,
  preParent: object,
  postParent: object,
) {
  const state = runtimes.get(receipt);
  assert.ok(state && state.parent === preParent, "original Windows runtime/pre parent required");
  try {
    assert.ok(
      !state.stopped && !state.postAttempted && !attemptedParents.has(postParent),
      "one original post-parent association required",
    );
    state.postAttempted = true;
    attemptedParents.add(postParent);
    await requireHostedNativeRuntime(receipt, preParent);
    const pre = await requireActualHostedNativeParentSource(preParent),
      post = await requireActualHostedNativeParentSource(postParent);
    assert.equal(state.platform, "windows-x86_64");
    assert.equal(pre.platform_label, "windows-x86_64");
    assert.equal(post.platform_label, pre.platform_label);
    assert.equal(pre.stage, "payload-signing");
    assert.equal(post.stage, "release-publication");
    assert.ok(
      post.deadline <= pre.deadline && post.deadline <= state.deadline,
      "post parent cannot renew the original runtime deadline",
    );
    assert.equal(pre.configuration.purpose, "application");
    assert.deepEqual(post.configuration, pre.configuration);
    assert.deepEqual(post.producer, pre.producer);
    await sameParentTools(state.tools, postParent);
    pre.recheck();
    post.recheck();
    assert.ok(!state.stopped && performance.now() < Math.min(state.deadline, post.deadline));
    state.postParent = postParent;
    state.postSource = post;
    state.deadline = Math.min(state.deadline, pre.deadline, post.deadline);
    await requireHostedNativeRuntime(receipt, postParent);
    pre.recheck();
    post.recheck();
    assert.ok(!state.stopped && performance.now() < state.deadline);
    return receipt;
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
  await requireHostedNativeRuntime(receipt, parentReceipt);
  const state = runtimes.get(receipt)!;
  try {
    assert.equal(await realpath(outputParent), outputParent);
    const active = () => {
      if (state.stopped || performance.now() >= state.deadline) {
        state.stopped = true;
        throw new Error("original native runtime expired");
      }
      try {
        state.parentSource.recheck();
        state.postSource?.recheck();
        recheckNativeRuntimeCustody(state.custody_files, state.custody);
        if (state.stopped || performance.now() >= state.deadline)
          throw new Error("original native runtime expired");
      } catch (error) {
        state.stopped = true;
        throw error;
      }
    };
    const sourceFile = path.join(state.root, nativeRuntimeSupportProfile(state.platform).source);
    return preparedNativeSupportDependencies(
      {
        caller_root: state.root + path.sep,
        output_parent: outputParent,
        source_file: sourceFile,
        source: await readControllerToolFile(sourceFile, 65536),
        binary: state.binary,
        metadata: state.metadata,
      },
      active,
      () => {
        state.stopped = true;
      },
      state.platform,
    );
  } catch (error) {
    state.stopped = true;
    throw error;
  }
}
