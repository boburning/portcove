/** Inert full source custody for the existing exact-candidate finalizer. No
 * checkout, filters, hooks, network Git transport or candidate code is run. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { inspectReleaseSourceTree } from "./release-source-changes.mts";
import {
  coordinatorCommandTimeout,
  checkCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectRiskVersionPreparation706 } from "./linux-beta-risk-706-preparation.mts";

const base = "repos/boburning/portcove";
const hash = (kind: string, bytes: Buffer) =>
  createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
/** Public GitHub objects are data. These checks do not select the controller or
 * candidate; the actual caller supplies both from independently admitted facts. */
export async function materializePublicationSourceRepository(
  parent: string,
  identity: { controller_commit: string; candidate_commit: string; candidate_tree: string },
  options: { api?: Pick<GitHubApiClient, "request" | "graphql"> } = {},
) {
  identity = structuredClone(identity);
  if (!path.isAbsolute(parent) || Object.values(identity).some((id) => !/^[a-f0-9]{40}$/u.test(id)))
    throw new Error("exact publication source identities required");
  checkCoordinatorDeadline();
  const directory = await mkdtemp(path.join(parent, "publication-source-"));
  const repository = path.join(directory, "repository.git"),
    home = path.join(directory, "home");
  await mkdir(home, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: home,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[], input?: Buffer) => {
    const result = spawnSync("git", args, {
      cwd: directory,
      env,
      input,
      encoding: null,
      timeout: coordinatorCommandTimeout(),
      maxBuffer: 16 * 1024 ** 2,
      windowsHide: true,
    });
    checkCoordinatorDeadline();
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout))
      throw new Error(`publication source import refused; retain ${directory}`);
    return result.stdout.toString("utf8");
  };
  git(["init", "--bare", "--template", home, repository]);
  let calls = 0,
    total = 0;
  const objects = new Map<string, { kind: string; bytes: number }>();
  const blobs = new Map<string, Buffer>();
  const add = (kind: string, id: string, bytes: Buffer) => {
    if (hash(kind, bytes) !== id) throw new Error("publication raw Git object differs");
    const old = objects.get(id);
    if (old) {
      if (old.kind !== kind || old.bytes !== bytes.length)
        throw new Error("publication Git object collision");
      return;
    }
    total += bytes.length;
    if (total > 256 * 1024 ** 2 || objects.size >= 20000 || bytes.length > 16 * 1024 ** 2)
      throw new Error("publication source closure exceeds finite bounds");
    if (
      git(["--git-dir", repository, "hash-object", "-w", "-t", kind, "--stdin"], bytes).trim() !==
      id
    )
      throw new Error("publication Git import differs");
    objects.set(id, { kind, bytes: bytes.length });
    if (kind === "blob") blobs.set(id, bytes);
  };
  const api =
    options.api ??
    new GitHubApiClient((args, input) => {
      if (++calls > 180) throw new Error("publication source API bound exhausted");
      return createGitHubRunner({
        cwd: directory,
        maxBuffer: 24 * 1024 ** 2,
        timeoutMs: coordinatorCommandTimeout(15000),
      })([...args, "--hostname", "github.com"], input);
    });
  const get = (suffix: string) => {
    const result = api.request("GET", `${base}/${suffix}`);
    if (result.status !== 200) throw new Error("publication source unavailable");
    return result.body;
  };
  const commits = new Map<string, ReturnType<typeof inspectReleaseSourceTree>>();
  const roots = new Map<string, string>();
  const rawCommits = new Map<string, string>();
  const load = (id: string) => {
    if (commits.has(id)) return commits.get(id)!;
    // Candidate, fixed controller, exact version-preparation parent, and #706
    // baseline only. The shared object/byte/deadline bounds remain unchanged.
    if (commits.size >= 4) throw new Error("publication source commit closure exceeded");
    const commit = inspectRemoteCommitObject(get(`git/commits/${id}`), id);
    roots.set(id, commit.tree);
    rawCommits.set(id, commit.object.bytes.toString("utf8"));
    add("commit", id, commit.object.bytes);
    const tree = inspectReleaseSourceTree(get(`git/trees/${commit.tree}?recursive=1`), commit.tree);
    for (const object of tree.objects) add(object.kind, object.oid, object.bytes);
    commits.set(id, tree);
    const sizes = new Map<string, number>();
    // Tree inventory's declared byte sizes are checked before any blob request.
    const raw = get(`git/trees/${commit.tree}?recursive=1`);
    if (!isRecord(raw) || !Array.isArray(raw.tree)) throw new Error("source tree inventory absent");
    const again = inspectReleaseSourceTree(raw, commit.tree);
    if (again.entries.size !== tree.entries.size) throw new Error("publication tree changed");
    for (const row of raw.tree as unknown[]) {
      if (!isRecord(row) || row.type === "tree") continue;
      if (
        row.type !== "blob" ||
        !["100644", "100755"].includes(String(row.mode)) ||
        typeof row.sha !== "string" ||
        typeof row.size !== "number" ||
        !Number.isSafeInteger(row.size) ||
        row.size < 0 ||
        row.size > 16 * 1024 ** 2
      )
        throw new Error("source link, submodule or oversized blob refused");
      if (sizes.has(row.sha) && sizes.get(row.sha) !== row.size)
        throw new Error("source blob size collision");
      sizes.set(row.sha, row.size);
    }
    if (
      total +
        [...sizes].filter(([oid]) => !objects.has(oid)).reduce((sum, [, size]) => sum + size, 0) >
      256 * 1024 ** 2
    )
      throw new Error("publication expanded source exceeds bound");
    const pending = [...sizes].filter(([oid]) => !objects.has(oid));
    while (pending.length) {
      const batch: [string, number][] = [];
      let bytes = 0;
      while (pending.length && batch.length < 48 && bytes + pending[0]![1] <= 4 * 1024 ** 2) {
        const row = pending.shift()!;
        batch.push(row);
        bytes += row[1];
      }
      if (!batch.length) batch.push(pending.shift()!);
      const query = `query { repository(owner:"boburning",name:"portcove") { id databaseId ${batch.map(([oid], i) => `b${i}:object(expression:"${oid}") { __typename ... on Blob { oid byteSize isBinary text } }`).join(" ")} } }`;
      const response: unknown = api.graphql(query).data;
      if (
        !isRecord(response) ||
        !isRecord(response.repository) ||
        response.repository.databaseId !== 1354613114
      )
        throw new Error("publication source repository differs");
      for (const [index, [oid, size]] of batch.entries()) {
        const row = response.repository[`b${index}`];
        if (!isRecord(row) || row.__typename !== "Blob" || row.oid !== oid || row.byteSize !== size)
          throw new Error("publication source blob metadata differs");
        let content: Buffer;
        if (row.isBinary === false && typeof row.text === "string") content = Buffer.from(row.text);
        else {
          const raw = get(`git/blobs/${oid}`);
          if (
            !isRecord(raw) ||
            raw.sha !== oid ||
            raw.size !== size ||
            raw.encoding !== "base64" ||
            typeof raw.content !== "string" ||
            raw.content.length > Math.ceil(size / 3) * 4 + 1024
          )
            throw new Error("publication binary source blob differs");
          content = Buffer.from(raw.content, "base64");
        }
        if (content.length !== size) throw new Error("publication source blob bytes differ");
        add("blob", oid, content);
      }
    }
    return tree;
  };
  const candidate = load(identity.candidate_commit);
  if (roots.get(identity.candidate_commit) !== identity.candidate_tree)
    throw new Error("publication prepared tree differs");
  load(identity.controller_commit);
  const rawCandidate = rawCommits.get(identity.candidate_commit)!;
  if (rawCandidate.includes("\nPortcove-Preparation-SHA256:")) {
    const parent = /^tree [a-f0-9]{40}\nparent ([a-f0-9]{40})\n/u.exec(rawCandidate)?.[1];
    if (!parent) throw new Error("publication preparation parent unavailable");
    load(parent);
    // These are exact object roots, not a complete ancestry traversal. Tell Git
    // where history deliberately stops before asking it for commit metadata.
    await writeFile(path.join(repository, "shallow"), [...roots.keys()].join("\n") + "\n", {
      flag: "wx",
    });
    await inspectRiskVersionPreparation706(identity.candidate_commit, (args) =>
      git(["--git-dir", repository, ...args]),
    );
  }
  const approval = candidate.entries.get(".github/linux-beta-risk-706.json");
  const bytes = approval && blobs.get(approval.oid);
  if (!bytes || bytes.length > 65536) throw new Error("source qualification baseline unavailable");
  const risk: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(risk) ||
    typeof risk.reconfirmedHead !== "string" ||
    !/^[a-f0-9]{40}$/u.test(risk.reconfirmedHead)
  )
    throw new Error("source qualification baseline identity differs");
  load(risk.reconfirmedHead);
  await writeFile(path.join(repository, "shallow"), [...roots.keys()].join("\n") + "\n");
  git(["--git-dir", repository, "update-ref", "HEAD", identity.controller_commit]);
  return { repository, directory, calls, bytes: total, authority: "none" as const };
}
