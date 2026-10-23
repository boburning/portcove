import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, writeFile, readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GitHubRestReader } from "./github-api.mts";
import {
  inspectReleaseSourceTree,
  maximumReleaseSourceCommits,
} from "./release-source-changes.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { semanticSupervisorEnvironment } from "./release-semantic-runtime.mts";
import { runResourceCommand } from "./resource-command.mts";
import { isRecord } from "./runtime-values.mts";

const oid = (value: string) => /^[a-f0-9]{40}$/u.test(value);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const maximumBlob = 16 * 1024 * 1024;
const maximumSelected = 192 * 1024 * 1024;
const maximumStored = 512 * 1024 * 1024;
type FetchRequest = Readonly<{
  repository: string;
  home: string;
  oids: readonly string[];
  phase: "commits" | "blobs";
  timeout_ms: number;
  expires_at: number;
}>;

/** Resource routing only. The fixed Python launcher independently clears its
 * Git environment; this does not make a hosted semantic runtime permissible. */
export function semanticSourceResourceEnvironment(
  home: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...semanticSupervisorEnvironment(source),
    HOME: source.HOME ?? home,
    ...(source.GITHUB_ACTIONS === "true" ? { GITHUB_ACTIONS: "true" } : {}),
  };
}

/** Inert acquisition only. The optional transport is a disposable qualification
 * seam, never a runtime capture, semantic result, issuer or acceptance source. */
export async function materializeSemanticSource(
  parent: string,
  expected: {
    source_commit: string;
    source_tree: string;
    base_commit: string;
    published_object: string;
  },
  api: GitHubRestReader,
  tools: { git_sha256: string; python_sha256: string },
  qualification: { fetchObjects?: (request: FetchRequest) => Promise<void>; git?: string } = {},
) {
  expected = structuredClone(expected);
  tools = structuredClone(tools);
  const injectedFetch = qualification.fetchObjects;
  const executable = qualification.git ?? "/usr/bin/git";
  if (qualification.git !== undefined && !injectedFetch)
    throw new Error("qualified Git executable requires an explicitly injected inert transport");
  if (
    Object.keys(expected).sort().join(",") !==
      "base_commit,published_object,source_commit,source_tree" ||
    !Object.values(expected).every(oid) ||
    Object.keys(tools).sort().join(",") !== "git_sha256,python_sha256" ||
    !Object.values(tools).every((value) => /^[a-f0-9]{64}$/u.test(value))
  )
    throw new Error("semantic source requires exact fixed identities");
  const deadline = performance.now() + 120000;
  const expiresAt = Date.now() + 120000;
  const active = () => {
    const left = Math.floor(deadline - performance.now());
    if (left < 1) throw new Error("semantic source acquisition deadline exhausted");
    return Math.min(30000, left);
  };
  const environment = {
    PATH: process.platform === "win32" && injectedFetch ? process.env.PATH : "/usr/bin:/bin",
    HOME: parent,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.platform === "win32" && injectedFetch
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
  const repository = path.join(parent, "source.git");
  const reviewRepository = path.join(parent, "review.git");
  const home = path.join(parent, "source-home");
  await mkdir(home, { mode: 0o700 });
  let requestIndex = 0;
  const git = (args: string[], input?: Buffer, maximum = 256 * 1024) => {
    if (!injectedFetch) {
      const operation = args[0] === "init" ? args : args.slice(2);
      let phase: string;
      let objects: string[] = [];
      if (operation[0] === "init") phase = "init";
      else if (operation[0] === "for-each-ref") phase = "refs";
      else if (operation[0] === "rev-parse") {
        phase = "peel";
        objects = [operation[2]!.replace(/\^\{commit\}$/u, "")];
      } else if (operation[0] === "rev-list") {
        phase = "history";
        objects = [operation[2]!, operation[3]!.replace(/^\^/u, "")];
      } else if (operation[0] === "cat-file" && operation[1] === "commit") {
        phase = "commit";
        objects = [operation[2]!];
      } else if (operation[0] === "cat-file" && operation[1] === "tag") {
        phase = "tag";
        objects = [operation[2]!];
      } else if (operation[0] === "cat-file" && operation[1] === "-t") {
        phase = "kind";
        objects = [operation[2]!];
      } else if (operation[0] === "cat-file" && operation[1]?.startsWith("--batch-check="))
        phase = "sizes";
      else if (operation[0] === "hash-object") phase = "tree";
      else if (operation[0] === "pack-objects") phase = "pack";
      else throw new Error("unsupported fixed local semantic Git operation");
      const filename = path.join(parent, `source-local-${requestIndex++}.json`);
      writeFileSync(
        filename,
        JSON.stringify({
          schema_version: 1,
          repository: operation[0] === "init" ? operation.at(-1) : args[1],
          home,
          oids: objects,
          phase,
          git_sha256: tools.git_sha256,
          timeout_ms: active(),
          expires_at: expiresAt,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const output = execFileSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-B",
          fileURLToPath(new URL("semantic-source-git.py", import.meta.url)),
          filename,
        ],
        {
          input,
          env: environment,
          timeout: active(),
          maxBuffer: maximum,
        },
      );
      active();
      return output;
    }
    const output = execFileSync(
      executable,
      [
        "--no-optional-locks",
        "--no-replace-objects",
        "-C",
        parent,
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      {
        env: environment,
        input,
        timeout: active(),
        maxBuffer: maximum,
        windowsHide: true,
      },
    );
    active();
    return output;
  };
  const inRepository = (args: string[], input?: Buffer, maximum?: number) =>
    git(["--git-dir", repository, ...args], input, maximum);
  const verifyTools = async () => {
    if (!injectedFetch) {
      if (process.platform !== "linux" || !process.getuid?.())
        throw new Error("fixed semantic acquisition requires its ordinary Linux parent");
      for (const [file, expectedHash] of [
        ["/usr/bin/git", tools.git_sha256],
        ["/usr/bin/python3", tools.python_sha256],
      ] as const) {
        const resolved = await realpath(file);
        if (!resolved.startsWith("/usr/bin/"))
          throw new Error("source tool leaves fixed system directory");
        const bytes = await readBoundedPublicBuildInputFile(
          path.dirname(resolved),
          path.basename(resolved),
          64 * 1024 * 1024,
        );
        if (hash(bytes) !== expectedHash)
          throw new Error("fixed source acquisition tool bytes changed");
      }
    }
    active();
  };
  await verifyTools();
  git(["init", "--bare", "--quiet", "--template=", repository]);
  const stored = async (directory: string): Promise<number> => {
    let total = 0;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("source store contains a symbolic link");
      const filename = path.join(directory, entry.name);
      total += entry.isDirectory() ? await stored(filename) : (await lstat(filename)).size;
      if (total > maximumStored) throw new Error("semantic source object store exceeds bound");
    }
    active();
    return total;
  };
  const fetchObjects = async (phase: "commits" | "blobs", objects: string[]) => {
    await verifyTools();
    const request: FetchRequest = Object.freeze({
      repository,
      home,
      oids: Object.freeze([...objects]),
      phase,
      timeout_ms: active(),
      expires_at: expiresAt,
    });
    if (injectedFetch) await injectedFetch(request);
    else {
      const filename = path.join(parent, `source-fetch-${requestIndex++}.json`);
      await writeFile(
        filename,
        JSON.stringify({ schema_version: 1, ...request, git_sha256: tools.git_sha256 }),
        { flag: "wx", mode: 0o600 },
      );
      const helper = fileURLToPath(new URL("semantic-source-git.py", import.meta.url));
      const status = await runResourceCommand(
        "analysis",
        "/usr/bin/python3",
        ["-I", "-S", "-B", helper, filename],
        { environment: semanticSourceResourceEnvironment(home), queueDeadline: deadline },
      );
      if (status !== 0) throw new Error("bounded semantic source fetch refused; retain attempt");
    }
    active();
    await verifyTools();
    await stored(repository);
    if (inRepository(["for-each-ref", "--format=%(refname)"]).length)
      throw new Error("semantic source fetch unexpectedly wrote a ref");
  };
  await fetchObjects("commits", [
    ...new Set([expected.source_commit, expected.base_commit, expected.published_object]),
  ]);
  const published = inRepository(["rev-parse", "--verify", `${expected.published_object}^{commit}`])
    .toString("utf8")
    .trim();
  if (!oid(published)) throw new Error("published semantic source is not an exact commit");
  const commits = [...new Set([expected.source_commit, expected.base_commit, published])];
  const changed = inRepository([
    "rev-list",
    `--max-count=${maximumReleaseSourceCommits + 1}`,
    expected.source_commit,
    `^${expected.base_commit}`,
  ])
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  if (changed.length > maximumReleaseSourceCommits)
    throw new Error("semantic source change history exceeds bound");
  const selectedCommits = [...new Set([...commits, ...changed])];
  const commitRows = inRepository(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    Buffer.from(selectedCommits.join("\n") + "\n"),
    256 * 1024,
  )
    .toString("utf8")
    .trim()
    .split("\n");
  let commitBytes = 0;
  if (
    commitRows.length !== selectedCommits.length ||
    commitRows.some((row, index) => {
      const match = /^([a-f0-9]{40}) commit ([0-9]+)$/u.exec(row);
      const size = Number(match?.[2]);
      commitBytes += size;
      return (
        match?.[1] !== selectedCommits[index] ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 128 * 1024 ||
        commitBytes > 32 * 1024 * 1024
      );
    })
  )
    throw new Error("semantic source raw commit preflight exceeds bound");
  const selectedObjects = new Set(selectedCommits);
  let tagged = expected.published_object;
  for (let depth = 0; ; depth++) {
    const kind = inRepository(["cat-file", "-t", tagged]).toString("utf8").trim();
    if (kind === "commit") {
      if (tagged !== published) throw new Error("publication tag chain differs");
      break;
    }
    if (kind !== "tag" || depth >= 4) throw new Error("publication tag chain exceeds bound");
    selectedObjects.add(tagged);
    const raw = inRepository(["cat-file", "tag", tagged], undefined, 128 * 1024);
    const next = /^object ([a-f0-9]{40})\ntype (?:commit|tag)\n/u.exec(raw.toString("utf8"))?.[1];
    if (!next) throw new Error("publication tag chain is malformed");
    tagged = next;
  }
  const blobs = new Map<string, number>();
  let selectedBytes = 0;
  const trees = new Set<string>();
  let treeBytes = 0;
  for (const commit of commits) {
    // A treeless fetch deliberately has no tree yet. Peeling ^{tree} would
    // require that missing object (or trigger a prohibited lazy fetch).
    const rawCommit = inRepository(["cat-file", "commit", commit], undefined, 128 * 1024);
    const tree = /^tree ([a-f0-9]{40})\n/u.exec(rawCommit.toString("utf8"))?.[1] ?? "";
    if (!oid(tree) || (commit === expected.source_commit && tree !== expected.source_tree))
      throw new Error("semantic source commit/tree binding differs");
    if (trees.has(tree)) continue;
    trees.add(tree);
    const response = api.request("GET", `repos/boburning/portcove/git/trees/${tree}?recursive=1`);
    active();
    if (
      response.status !== 200 ||
      Buffer.byteLength(JSON.stringify(response.body)) > 16 * 1024 * 1024
    )
      throw new Error("semantic source tree response unavailable or oversized");
    const inventory = inspectReleaseSourceTree(response.body, tree);
    if (!isRecord(response.body) || !Array.isArray(response.body.tree))
      throw new Error("semantic source tree missing");
    for (const raw of response.body.tree) {
      if (!isRecord(raw) || typeof raw.path !== "string")
        throw new Error("semantic source tree entry missing");
      const entry = inventory.entries.get(raw.path)!;
      if (entry.type === "tree") continue;
      if (
        entry.type !== "blob" ||
        !["100644", "100755"].includes(entry.mode) ||
        typeof raw.size !== "number" ||
        !Number.isSafeInteger(raw.size) ||
        raw.size < 0 ||
        raw.size > maximumBlob
      )
        throw new Error("semantic source snapshot contains unsupported or oversized object");
      const prior = blobs.get(entry.oid);
      if (prior !== undefined && prior !== raw.size)
        throw new Error("semantic source blob size drift");
      if (prior === undefined) {
        blobs.set(entry.oid, raw.size);
        selectedBytes += raw.size;
      }
      if (blobs.size > 20000 || selectedBytes > maximumSelected)
        throw new Error("semantic source selected snapshot exceeds bound");
    }
    for (const object of inventory.objects) {
      if (!selectedObjects.has(object.oid)) treeBytes += object.bytes.length;
      if (treeBytes > 16 * 1024 * 1024)
        throw new Error("semantic source raw tree bytes exceed bound");
      selectedObjects.add(object.oid);
      if (
        inRepository(["hash-object", "-w", "-t", "tree", "--stdin"], Buffer.from(object.bytes))
          .toString("utf8")
          .trim() !== object.oid
      )
        throw new Error("semantic source imported tree differs");
    }
  }
  const objects = [...blobs.keys()];
  for (let index = 0; index < objects.length; index += 256)
    await fetchObjects("blobs", objects.slice(index, index + 256));
  const rows = inRepository(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    Buffer.from(objects.join("\n") + "\n"),
    2 * 1024 * 1024,
  )
    .toString("utf8")
    .trim()
    .split("\n");
  if (
    rows.length !== objects.length ||
    rows.some((row, index) => row !== `${objects[index]} blob ${blobs.get(objects[index]!)}`)
  )
    throw new Error("semantic source materialized object types/sizes differ");
  await stored(repository);
  // Export only preflighted consumed objects with delta reuse disabled. The
  // existing freezer must not inherit network-supplied delta-base expansion.
  for (const object of objects) selectedObjects.add(object);
  git(["init", "--bare", "--quiet", "--template=", reviewRepository]);
  inRepository(
    [
      "pack-objects",
      "--no-reuse-delta",
      "--no-reuse-object",
      "--window=0",
      "--depth=0",
      path.join(reviewRepository, "objects/pack/pack"),
    ],
    Buffer.from([...selectedObjects].join("\n") + "\n"),
  );
  await writeFile(path.join(reviewRepository, "shallow"), `${expected.base_commit}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await stored(reviewRepository);
  active();
  return {
    repository: reviewRepository,
    commits,
    selected_bytes: selectedBytes,
    blobs: blobs.size,
    evidence_scope: injectedFetch
      ? "injected-source-qualification"
      : "fixed-public-git-acquisition",
    authority: "none",
  } as const;
}
