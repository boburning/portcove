import { execFileSync } from "node:child_process";
import {
  coordinatorCommandTimeout,
  coordinatorCommandDeadline,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { preparationSourcePaths } from "../apps/desktop/scripts/prepare-release-version.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { inspectReleaseSourceTree } from "./release-source-changes.mts";
import type { GitHubRestReader } from "./github-operation.mts";
import { isRecord } from "./runtime-values.mts";
import { createReleaseCustodyProvider } from "./release-custody-provider.mts";

const base = "repos/boburning/portcove";
const maximumBlobBytes = 8 * 1024 * 1024;
const maximumTotalBytes = 16 * 1024 * 1024;
const oid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
type PreparationSource = { source_commit: string; source_tree: string };
type PreparationSourceOptions = { trustedReleaseWorkflow?: Buffer };
type PreparationRead = { collection: "commits" | "trees" | "blobs"; sha: string };

/** Populate only verified inert objects needed by the existing four-file version
 * preparer. No Git fetch, candidate checkout, hooks, ref changes or executable
 * application blobs are used. The admitted caller still owns source selection
 * and must supply a response-bounded provider reader. */
export function hydrateReleasePreparationSource(
  repository: string,
  source: PreparationSource,
  api: GitHubRestReader,
  options: PreparationSourceOptions = {},
) {
  const sequence = preparationSourceReads(repository, source, options, performance.now() + 120000);
  let step = sequence.next();
  while (!step.done) {
    const { collection, sha } = step.value;
    const query = collection === "trees" ? "?recursive=1" : "";
    const response = api.request("GET", `${base}/git/${collection}/${sha}${query}`);
    if (response.status !== 200)
      throw new Error("source preparation provider response unavailable or oversized");
    step = sequence.next(response.body);
  }
  return step.value;
}

/** Fixed coordinator adapter. Every hydration gets its own original 120-second
 * observation inside the shared coordinator deadline and exact object scope. */
export async function hydrateReleasePreparationSourceWithSdk(
  repository: string,
  source: PreparationSource,
  transport: {
    token: string;
    deadline: number;
    guard: () => void;
    currentDeadline: () => number;
    fetch?: typeof globalThis.fetch;
  },
  options: PreparationSourceOptions = {},
) {
  const deadline = Math.min(
    transport.deadline,
    coordinatorCommandDeadline() ?? Infinity,
    performance.now() + 120000,
  );
  transport.guard();
  const sequence = preparationSourceReads(repository, source, options, deadline);
  let step = sequence.next();
  const provider = await createReleaseCustodyProvider({
    token: transport.token,
    deadline,
    maxBytes: maximumTotalBytes,
    currentDeadline: transport.currentDeadline,
    chargeRead: transport.guard,
    beforeDispatch: transport.guard,
    afterRead: transport.guard,
    ...(transport.fetch ? { fetch: transport.fetch } : {}),
  });
  const read = {
    commits: (sha: string) => provider.commit(sha),
    trees: (sha: string) => provider.tree(sha),
    blobs: (sha: string) => provider.blob(sha),
  };
  while (!step.done) {
    const { collection, sha } = step.value;
    step = sequence.next(await read[collection](sha));
  }
  return step.value;
}

function* preparationSourceReads(
  repository: string,
  source: PreparationSource,
  options: PreparationSourceOptions,
  deadline: number,
) {
  const expected = structuredClone(source);
  const trustedWorkflow =
    options.trustedReleaseWorkflow === undefined
      ? null
      : Buffer.from(options.trustedReleaseWorkflow);
  if (trustedWorkflow && (trustedWorkflow.length < 1 || trustedWorkflow.length > 256 * 1024))
    throw new Error("trusted release workflow exceeds bound");
  if (
    !oid(expected.source_commit) ||
    !oid(expected.source_tree) ||
    Object.keys(expected).sort().join(",") !== "source_commit,source_tree"
  )
    throw new Error("preparation source requires exact identities");
  let requests = 0,
    bytes = 0;
  const check = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("source preparation duration exceeded");
  };
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (args: string[], input?: Buffer) => {
    check();
    const result = execFileSync(
      "git",
      [
        "-C",
        repository,
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "core.createObject=link",
        ...args,
      ],
      {
        input,
        encoding: "utf8",
        windowsHide: true,
        timeout: coordinatorCommandTimeout(30000),
        maxBuffer: maximumTotalBytes,
        env: { ...environment, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
      },
    );
    checkCoordinatorDeadline();
    check();
    return result.trim();
  };
  if (git(["rev-parse", "--is-bare-repository"]) !== "true")
    throw new Error("source preparation requires a caller-owned bare repository");
  function* get(
    collection: PreparationRead["collection"],
    sha: string,
  ): Generator<PreparationRead, unknown, unknown> {
    check();
    if (++requests > 68) throw new Error("source preparation request bound exceeded");
    const body: unknown = yield { collection, sha };
    check();
    if (Buffer.byteLength(JSON.stringify(body)) > maximumTotalBytes)
      throw new Error("source preparation provider response unavailable or oversized");
    return body;
  }
  const imported = new Set<string>();
  const store = (kind: "commit" | "tree" | "blob", expectedOid: string, contents: Buffer) => {
    if (imported.has(expectedOid)) return;
    bytes += contents.length;
    if (bytes > maximumTotalBytes)
      throw new Error("source preparation total object bytes exceeded");
    if (git(["hash-object", "-w", "-t", kind, "--stdin"], contents) !== expectedOid)
      throw new Error("source preparation imported identity differs");
    imported.add(expectedOid);
  };
  const original = inspectRemoteCommitObject(
    yield* get("commits", expected.source_commit),
    expected.source_commit,
  );
  if (original.tree !== expected.source_tree) throw new Error("source preparation tree differs");
  const trees = inspectReleaseSourceTree(
    yield* get("trees", expected.source_tree),
    expected.source_tree,
  );
  if (trustedWorkflow) {
    const entry = trees.entries.get(".github/workflows/release.yml");
    const expectedWorkflow = createHash("sha1")
      .update(`blob ${trustedWorkflow.length}\0`)
      .update(trustedWorkflow)
      .digest("hex");
    if (
      !entry ||
      entry.mode !== "100644" ||
      entry.type !== "blob" ||
      entry.oid !== expectedWorkflow
    )
      throw new Error("candidate release workflow differs from fixed trusted controller workflow");
  }
  // Every tree was reconstructed and hashed by the existing source verifier.
  for (const object of trees.objects) store("tree", object.oid, Buffer.from(object.bytes));
  store("commit", original.object.oid, Buffer.from(original.object.bytes));
  const blobs = new Map<string, Buffer>();
  function* blob(filename: string): Generator<PreparationRead, Buffer, unknown> {
    const entry = trees.entries.get(filename);
    if (!entry || entry.type !== "blob" || entry.mode !== "100644")
      throw new Error(`preparation authority is not an exact regular blob: ${filename}`);
    const existing = blobs.get(entry.oid);
    if (existing) return existing;
    const raw = yield* get("blobs", entry.oid);
    if (
      !isRecord(raw) ||
      raw.sha !== entry.oid ||
      raw.encoding !== "base64" ||
      typeof raw.content !== "string" ||
      typeof raw.size !== "number" ||
      !Number.isSafeInteger(raw.size) ||
      raw.size < 0 ||
      raw.size > maximumBlobBytes
    )
      throw new Error("preparation blob metadata differs or exceeds bound");
    const encoded = raw.content.replace(/\n/gu, "");
    if (
      encoded.length > Math.ceil(maximumBlobBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
    )
      throw new Error("preparation blob encoding exceeds bound or is invalid");
    const contents = Buffer.from(encoded, "base64");
    if (
      contents.length !== raw.size ||
      contents.toString("base64") !== encoded ||
      createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex") !==
        entry.oid
    )
      throw new Error("preparation blob bytes differ from source identity");
    store("blob", entry.oid, contents);
    blobs.set(entry.oid, contents);
    return contents;
  }
  const cargoBytes = yield* blob("Cargo.toml");
  const cargo = new TextDecoder("utf-8", { fatal: true }).decode(cargoBytes);
  const filenames = preparationSourcePaths(cargo);
  if (filenames.length > 64 || new Set(filenames).size !== filenames.length)
    throw new Error("preparation authority path count exceeds bound or duplicates");
  for (const filename of filenames) yield* blob(filename);
  check();
  return {
    ...expected,
    objects: imported.size,
    bytes,
    requests,
    paths: filenames,
    readiness: "version-preparation-only" as const,
    authority: "none" as const,
  };
}
