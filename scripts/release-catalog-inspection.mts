import {
  inspectCatalogCoreReport,
  catalogPublicationInventory as inventory,
} from "./release-catalog-publication-contract.mts";
export { inspectCatalogCoreReport } from "./release-catalog-publication-contract.mts";
/** Actual fixed Core inspection, not publisher or semantic acceptance. Imported
 * reports and copied receipts cannot construct this process-local capability. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import { payloadSigningEnvironment } from "./release-payload-signing.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";

const run = promisify(execFile);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Strict inert machine-response reader shared by the actual inspector and its
 * real-CLI build fixture. It binds report bytes, never a private tool/inspection
 * receipt, semantic acceptance or publisher authority. Future schemas refuse. */
export function readCatalogCoreMachineEnvelope(
  stdout: string,
  stderr: string,
  files: ReadonlyMap<string, Buffer>,
) {
  if (
    stderr !== "" ||
    Buffer.byteLength(stdout) > 4 * 1024 ** 2 ||
    Buffer.from(stdout, "utf8").toString("utf8") !== stdout
  )
    throw new Error("actual Core machine response differs");
  const envelope: unknown = JSON.parse(stdout);
  if (
    !isRecord(envelope) ||
    Object.keys(envelope).sort().join(",") !== "command,data,error,ok,schema_version" ||
    (envelope.schema_version !== 84 && envelope.schema_version !== 85) ||
    envelope.ok !== true ||
    envelope.error !== null ||
    envelope.command !== "catalog.inspect-definition-publication"
  )
    throw new Error("actual Core machine response differs");
  return inspectCatalogCoreReport(envelope.data, files);
}

function remaining(deadline: number) {
  const left = Math.floor(deadline - performance.now());
  if (!Number.isFinite(deadline) || left < 1)
    throw new Error("catalog inspection deadline exhausted; retain attempt");
  return Math.min(left, 90000);
}
function target(name: string) {
  return (
    name === "definitions/index.json" ||
    name === "policy/official/catalog.listings.json" ||
    /^sha256\/[a-f0-9]{64}\.json$/u.test(name) ||
    /^policy\/official\/[a-z0-9][a-z0-9-]*(?:\.launch)?\.json$/u.test(name)
  );
}

/** Fixed Core producer bounds; this is not the larger historical TUF closure.
 * The downstream complete-site limit is independently smaller in file count. */
export async function readCatalogPublicationBundle(directory: string, deadline: number) {
  if (!path.isAbsolute(directory)) throw new Error("absolute catalog bundle required");
  const files = new Map<string, Buffer>();
  let total = 0,
    entries = 0;
  const walk = async (root: string, prefix: string, depth: number): Promise<void> => {
    remaining(deadline);
    const before = await lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink() || depth > 3)
      throw new Error("catalog bundle directory identity differs");
    for (const entry of await readdir(root, { withFileTypes: true })) {
      remaining(deadline);
      if (++entries > 16389 || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(entry.name))
        throw new Error("catalog bundle path/count exceeds bound");
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = await assertOwnedUnlinkedPath(
        directory,
        path.join(directory, name),
        "catalog bundle",
      );
      if (entry.isDirectory()) {
        if (!["definitions", "sha256", "policy", "policy/official"].includes(name))
          throw new Error("unreferenced catalog directory");
        await walk(filename, name, depth + 1);
      } else {
        const stat = await lstat(filename);
        if (
          !entry.isFile() ||
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          !target(name)
        )
          throw new Error("catalog bundle file identity differs");
        const bytes = await readControllerToolFile(
          filename,
          name === "policy/official/catalog.listings.json"
            ? 8 * 1024 ** 2
            : name.startsWith("policy/")
              ? 65536
              : 4 * 1024 ** 2,
        );
        total += bytes.length;
        if (total > 32 * 1024 ** 2 || files.size >= 16385)
          throw new Error("catalog bundle exceeds producer bound");
        files.set(name, bytes);
      }
    }
    const after = await lstat(root);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("catalog bundle directory changed during read");
  };
  await walk(directory, "", 0);
  if (!files.has("definitions/index.json")) throw new Error("catalog content index missing");
  return files;
}

interface InspectionReceipt {
  readonly kind: "actual-catalog-core-inspection";
}
interface PrivateInspection {
  tools: object;
  source: { commit: string; tree: string };
  directory: string;
  bundle: string;
  bundle_sha256: string;
  inspection_sha256: string;
  inspection: Record<string, unknown>;
  tool_sha256: string;
}
const inspected = new WeakMap<InspectionReceipt, PrivateInspection>();

export async function inspectActualCatalogPublication(request: {
  tools: object;
  source_commit: string;
  source_tree: string;
  bundle: string;
  output_parent: string;
  deadline: number;
}) {
  // Preserve the private tool receipt identity, while detaching all primitive
  // arguments before the first await. A caller cannot extend this phase clock.
  request = { ...request };
  remaining(request.deadline);
  const tools = await verifiedControllerToolPaths(request.tools);
  if (
    !/^[a-f0-9]{40}$/u.test(request.source_commit) ||
    !/^[a-f0-9]{40}$/u.test(request.source_tree) ||
    !path.isAbsolute(request.output_parent) ||
    !path.isAbsolute(request.bundle) ||
    releasePathContains(request.bundle, request.output_parent)
  )
    throw new Error("catalog inspection requires exact source context and disjoint paths");
  const original = await readCatalogPublicationBundle(request.bundle, request.deadline);
  const bundleDigest = digest(inventory(original));
  const binary = await readControllerToolFile(tools.cli);
  const directory = await mkdtemp(path.join(request.output_parent, "catalog-inspection-"));
  await chmod(directory, 0o700);
  const bundle = path.join(directory, "bundle"),
    scratch = path.join(directory, "work");
  let phase = "stage-inert-bundle";
  try {
    await mkdir(bundle, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    for (const [name, bytes] of original) {
      await mkdir(path.dirname(path.join(bundle, name)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(bundle, name), bytes, { flag: "wx", mode: 0o600 });
    }
    const tool = path.join(scratch, process.platform === "win32" ? "portcove.exe" : "portcove");
    await writeFile(tool, binary, { flag: "wx", mode: 0o700 });
    await chmod(tool, 0o700);
    const env = payloadSigningEnvironment(scratch);
    for (const value of new Set(Object.values(env)))
      if (typeof value === "string" && value.startsWith(scratch))
        await mkdir(value, { recursive: true, mode: 0o700 });
    phase = "actual-fixed-Core-invocation";
    const result = await run(
      tool,
      ["--json", "catalog", "inspect-definition-publication", bundle],
      {
        cwd: scratch,
        env,
        timeout: remaining(request.deadline),
        maxBuffer: 4 * 1024 ** 2,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    await writeFile(path.join(directory, "stdout.json"), result.stdout, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(directory, "stderr.txt"), result.stderr, { flag: "wx", mode: 0o600 });
    phase = "bind-actual-report";
    const report = readCatalogCoreMachineEnvelope(result.stdout, result.stderr, original);
    const inspection = Buffer.from(`${JSON.stringify(report)}\n`);
    await writeFile(path.join(directory, "inspection.json"), inspection, {
      flag: "wx",
      mode: 0o600,
    });
    if (
      digest(inventory(await readCatalogPublicationBundle(bundle, request.deadline))) !==
        bundleDigest ||
      digest(inventory(await readCatalogPublicationBundle(request.bundle, request.deadline))) !==
        bundleDigest ||
      hash(await readControllerToolFile(tool)) !== hash(binary)
    )
      throw new Error("catalog inputs/tool changed across Core invocation");
    await verifiedControllerToolPaths(request.tools);
    remaining(request.deadline);
    const receipt: InspectionReceipt = Object.freeze({ kind: "actual-catalog-core-inspection" });
    inspected.set(receipt, {
      tools: request.tools,
      source: { commit: request.source_commit, tree: request.source_tree },
      directory,
      bundle,
      bundle_sha256: bundleDigest,
      inspection_sha256: hash(inspection),
      inspection: report,
      tool_sha256: hash(binary),
    });
    await writeFile(
      path.join(directory, "invocation.json"),
      JSON.stringify({
        source_commit: request.source_commit,
        source_tree: request.source_tree,
        controller_source: tools.identity,
        tool_sha256: hash(binary),
        command: "catalog.inspect-definition-publication",
        stdout_sha256: hash(Buffer.from(result.stdout)),
        inspection_sha256: hash(inspection),
        bundle_sha256: bundleDigest,
        authority: "none",
        scope: "actual-Core-compatibility-inspection-only",
        source_binding: "caller-context-only; authenticated materialization remains required",
      }),
      { flag: "wx", mode: 0o600 },
    );
    remaining(request.deadline);
    return receipt;
  } catch (error) {
    // execFile may have partial output even on timeout/refusal. Retain it without
    // treating an incomplete response or normal exit as semantic acceptance.
    if (isRecord(error))
      for (const key of ["stdout", "stderr"])
        if (typeof error[key] === "string")
          await writeFile(path.join(directory, `failed-${key}.txt`), error[key], {
            flag: "wx",
            mode: 0o600,
          }).catch(() => {});
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({ phase, automatic_retry: false, authority: "none" }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`catalog inspection refused; retain ${directory}`);
  }
}

export async function requireActualCatalogInspection(receipt: InspectionReceipt, deadline: number) {
  const actual = inspected.get(receipt);
  if (!actual) throw new Error("actual same-process Core inspection required");
  const tools = await verifiedControllerToolPaths(actual.tools);
  if (
    hash(await readControllerToolFile(tools.cli)) !== actual.tool_sha256 ||
    digest(inventory(await readCatalogPublicationBundle(actual.bundle, deadline))) !==
      actual.bundle_sha256 ||
    hash(
      await readControllerToolFile(path.join(actual.directory, "inspection.json"), 4 * 1024 ** 2),
    ) !== actual.inspection_sha256
  )
    throw new Error("retained Core inspection changed");
  remaining(deadline);
  return Object.freeze({
    tools_receipt: actual.tools,
    tool_sha256: actual.tool_sha256,
    source: Object.freeze({ ...actual.source }),
    bundle: actual.bundle,
    bundle_sha256: actual.bundle_sha256,
    inspection_sha256: actual.inspection_sha256,
    inspection: structuredClone(actual.inspection),
    directory: actual.directory,
    authority: "none" as const,
  });
}
