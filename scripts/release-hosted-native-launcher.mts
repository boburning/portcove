/** Source-bound private runtime preparation only. No process, candidate, key,
 * privilege, provider mutation or native acceptance is created by a plan. */
import assert from "node:assert/strict";
import { mkdir, writeFile, chmod, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { readActualHostedLinuxBootstrapScope } from "./release-hosted-native-bootstrap.mts";
import { controllerToolPaths, readControllerToolFile } from "./release-controller-tools.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  type NativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import { controllerNodeVersion } from "./controller-node-runtime.mts";
import { currentNativeJobDeadline } from "./release-signing-job-budget.mts";
import { isRecord } from "./runtime-values.mts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Scope = Awaited<ReturnType<typeof readActualHostedLinuxBootstrapScope>>;
type Tools = Awaited<ReturnType<typeof verifiedControllerToolPaths>>;
interface OriginalTools {
  receipt: object;
  tools: Tools;
  files: string[];
  custody: NativeRuntimeCustody;
  binding: string;
  stopped: boolean;
}
interface OriginalLaunch {
  scope: Scope;
  deadline: number;
  files: string[];
  custody: NativeRuntimeCustody;
  original_node: NativeRuntimeCustody;
  plan_file: string;
  plan_bytes: Buffer;
  binding_file: string;
  binding_bytes: Buffer;
  tools: OriginalTools | undefined;
  claimed: boolean;
  stopped: boolean;
}
const originalTools = new Map<string, OriginalTools>();
const originalLaunches = new WeakMap<object, OriginalLaunch>();

/** The ordinary hosted broker owns this private Node/temp tree. Its copied Node
 * is data until actual artifact authentication and executable custody pass; the bootstrap must still match it to
 * the independently attested runtime before importing the native runner. */
export async function prepareFixedHostedLinuxLaunch(operation: unknown) {
  const scope = await readActualHostedLinuxBootstrapScope(operation);
  assert.equal(process.versions.node, controllerNodeVersion);
  const home = process.env.HOME;
  assert.ok(home && path.isAbsolute(home) && path.normalize(home) === home);
  assert.equal(await realpath(home), home);
  const uid = process.getuid?.();
  assert.ok(uid !== undefined && uid !== 0);
  const info = await lstat(home);
  assert.ok(
    info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o022) === 0,
  );
  const { identity } = scope;
  assert.ok(
    /^[1-9][0-9]{0,15}$/u.test(identity.run_id) &&
      identity.run_attempt === 1 &&
      /^[a-f0-9]{40}$/u.test(identity.controller_revision),
  );
  const root = path.join(
    home,
    `.portcove-native-${identity.run_id}-${identity.run_attempt}-${identity.controller_revision}`,
  );
  const node = path.join(root, "bootstrap-node");
  const bindingFile = path.join(root, "launcher-binding.json");
  const deadline = currentNativeJobDeadline(
    "linux-x86_64",
    identity,
    fileURLToPath(new URL("..", import.meta.url)),
    performance.now() + 570000,
  );
  const active = () => {
    scope.unchanged();
    assert.ok(performance.now() < deadline, "original native setup budget exhausted");
  };
  active();
  if (scope.operation === "pre-sign") {
    await mkdir(root, { mode: 0o700 });
    active();
    // Authenticate data before choosing the next executable. Version of this
    // running process cannot authenticate a replaced shared setup-node path.
    const receipt = await receiveControllerTools(root, scope.artifact, scope.bundle, { deadline });
    active();
    const tools = await verifiedControllerToolPaths(receipt);
    active();
    const files = [
      ...controllerToolPaths.map((name) => path.join(tools.root, name)),
      path.join(tools.root, "manifest.json"),
    ];
    const toolCustody = inspectNativeRuntimeCustody(files);
    const bytes = await readControllerToolFile(tools.node);
    await verifiedControllerToolPaths(receipt);
    recheckNativeRuntimeCustody(files, toolCustody);
    active();
    await writeFile(node, bytes, { flag: "wx", mode: 0o600 });
    await chmod(node, 0o700);
    const custody = inspectNativeRuntimeCustody([node]);
    assert.equal(hash(await readControllerToolFile(node)), hash(bytes));
    recheckNativeRuntimeCustody([node], custody);
    active();
    const bindingBytes = Buffer.from(
      JSON.stringify({
        schema_version: 1,
        binding: scope.binding,
        node: { path: node, bytes: bytes.length, sha256: hash(bytes) },
        node_custody: [...custody],
        authority: "none",
      }),
    );
    assert.ok(bindingBytes.length <= 4096);
    await writeFile(bindingFile, bindingBytes, { flag: "wx", mode: 0o600 });
    recheckNativeRuntimeCustody([node], custody);
    active();
    originalTools.set(root, {
      receipt,
      tools,
      files,
      custody: toolCustody,
      binding: scope.binding,
      stopped: false,
    });
  }
  const custody = inspectNativeRuntimeCustody([node, bindingFile]);
  const retained: unknown = JSON.parse(
    (await readControllerToolFile(bindingFile, 4096)).toString("utf8"),
  );
  assert.ok(
    isRecord(retained) &&
      Object.keys(retained).sort().join(",") ===
        "authority,binding,node,node_custody,schema_version",
  );
  assert.equal(retained.schema_version, 1);
  assert.equal(retained.binding, scope.binding);
  assert.equal(retained.authority, "none");
  assert.ok(
    isRecord(retained.node) && Object.keys(retained.node).sort().join(",") === "bytes,path,sha256",
  );
  assert.equal(retained.node.path, node);
  assert.ok(Array.isArray(retained.node_custody));
  const originalCustody = new Map<string, string>();
  for (const entry of retained.node_custody as unknown[]) {
    assert.ok(
      Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    );
    assert.ok(!originalCustody.has(entry[0]));
    originalCustody.set(entry[0], entry[1]);
  }
  recheckNativeRuntimeCustody([node], originalCustody);
  const current = await readControllerToolFile(node);
  assert.equal(current.length, retained.node.bytes);
  assert.equal(hash(current), retained.node.sha256);
  recheckNativeRuntimeCustody([node, bindingFile], custody);
  recheckNativeRuntimeCustody([node], originalCustody);
  active();
  const plan = {
    schema_version: 1,
    operation: scope.operation,
    binding: scope.binding,
    command: node,
    arguments: Object.freeze([
      fileURLToPath(new URL("./release-hosted-native-bootstrap.mts", import.meta.url)),
      scope.operation,
    ]),
    temporary: root,
    original_job_deadline_established_by: "native bootstrap provider/shared clock",
    authority: "none",
    native_acceptance: "not-established",
  };
  // No replacement/repeated stage. A partial preparation requires readback and
  // explicit recovery; this API never deletes a retained root or copied Node.
  const planBytes = Buffer.from(JSON.stringify(plan));
  assert.ok(planBytes.length <= 4096);
  const planFile = path.join(root, `${scope.operation}-launch.json`);
  await writeFile(planFile, planBytes, {
    flag: "wx",
    mode: 0o600,
  });
  recheckNativeRuntimeCustody([node, bindingFile], custody);
  recheckNativeRuntimeCustody([node], originalCustody);
  active();
  const files = [node, bindingFile, planFile];
  originalLaunches.set(plan, {
    scope,
    deadline,
    files,
    custody: inspectNativeRuntimeCustody(files),
    original_node: originalCustody,
    plan_file: planFile,
    plan_bytes: planBytes,
    binding_file: bindingFile,
    binding_bytes: await readControllerToolFile(bindingFile, 4096),
    tools: originalTools.get(root),
    claimed: false,
    stopped: false,
  });
  active();
  return Object.freeze(plan);
}

/** One same-process claim for the fixed executor. JSON plans and a new process
 * have no original tool receipt. This is executable custody, never admission,
 * coordinator ownership, a capacity reservation or native acceptance. */
export async function claimPreparedHostedLinuxLaunch(plan: object) {
  const state = originalLaunches.get(plan);
  assert.ok(
    state && !state.stopped && !state.claimed && state.tools && !state.tools.stopped,
    "original unclaimed native launch required",
  );
  state.claimed = true;
  const tools = state.tools;
  const refuse = () => {
    state.stopped = true;
    tools.stopped = true;
  };
  const recheck = () => {
    try {
      assert.ok(!state.stopped && !tools.stopped, "original native launch stopped");
      state.scope.unchanged();
      assert.ok(performance.now() < state.deadline, "original native launch expired");
      assert.equal(tools.binding, state.scope.binding);
      recheckNativeRuntimeCustody(state.files, state.custody);
      recheckNativeRuntimeCustody([state.files[0]!], state.original_node);
      recheckNativeRuntimeCustody(tools.files, tools.custody);
    } catch (error) {
      refuse();
      throw error;
    }
  };
  try {
    recheck();
    const current = await verifiedControllerToolPaths(tools.receipt);
    assert.equal(current.root, tools.tools.root);
    assert.deepEqual(current.identity, state.scope.artifact);
    assert.ok((await readControllerToolFile(state.plan_file, 4096)).equals(state.plan_bytes));
    assert.ok((await readControllerToolFile(state.binding_file, 4096)).equals(state.binding_bytes));
    recheck();
    return Object.freeze({
      scope: state.scope,
      deadline: state.deadline,
      tools_root: current.root,
      recheck,
      refuse,
    });
  } catch (error) {
    refuse();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const attempt =
    process.argv.length === 3
      ? prepareFixedHostedLinuxLaunch(process.argv[2])
      : Promise.reject(new Error("fixed native preparation required"));
  attempt
    .then((plan) => console.log(JSON.stringify(plan)))
    .catch(() => {
      console.error(
        "fixed native launch preparation refused; retain original root and partial effects; no automatic retry",
      );
      process.exitCode = 2;
    });
}
