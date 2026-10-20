import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { existsSync } from "node:fs";

const project = fileURLToPath(new URL("..", import.meta.url));
const maximumBytes = 256 * 1024 * 1024;
/** Raw Git materialization, never checkout/filter/hooks/candidate scripts. Both
 * commit and tree are independently admitted expectations from the reservation.
 * Local Git mutations are confined to one fresh retained qualification root. */
export async function materializeReleaseQualificationSource(
  sourceRepository: string,
  privateRoot: string,
  commit: string,
  tree: string,
) {
  if (
    ![sourceRepository, privateRoot].every((value) => path.isAbsolute(value)) ||
    !/^[a-f0-9]{40}$/u.test(commit) ||
    !/^[a-f0-9]{40}$/u.test(tree)
  )
    throw new Error("candidate qualification requires exact source/tree identities");
  const directory = await mkdtemp(path.join(privateRoot, "qualification-source-"));
  const home = path.join(directory, "home");
  await mkdir(home, { mode: 0o700 });
  const root = path.join(directory, "source");
  await mkdir(root, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: home,
  };
  const git = (cwd: string, args: string[], bound = 4 * 1024 * 1024) => {
    const result = spawnSync("git", args, {
      cwd,
      env,
      encoding: null,
      timeout: 120000,
      maxBuffer: bound,
      windowsHide: true,
      shell: false,
    });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout))
      throw new Error(`candidate raw Git operation refused; retain ${directory}`);
    return result.stdout;
  };
  if (
    git(sourceRepository, ["rev-parse", `${commit}^{tree}`])
      .toString()
      .trim() !== tree
  )
    throw new Error("candidate prepared tree differs");
  const listing = git(sourceRepository, ["ls-tree", "-r", "-l", "-z", commit]).toString("utf8");
  let total = 0;
  const paths = new Set<string>();
  const entries = listing
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const parsed = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/u.exec(line);
      if (!parsed) throw new Error("candidate source has non-blob/submodule/link content");
      const filename = parsed[4]!;
      const bytes = Number(parsed[3]);
      total += bytes;
      if (
        !Number.isSafeInteger(bytes) ||
        bytes > 16 * 1024 * 1024 ||
        total > maximumBytes ||
        filename.length > 512 ||
        filename.split("/").length > 24 ||
        filename
          .split("/")
          .some(
            (part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git",
          ) ||
        paths.has(filename.toLowerCase()) ||
        filename
          .split("/")
          .some(
            (part) =>
              /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part),
          ) ||
        filename.includes("\\") ||
        filename.includes(":") ||
        filename.split("").some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      )
        throw new Error("candidate raw source exceeds bounded safe materialization");
      paths.add(filename.toLowerCase());
      return { filename, oid: parsed[2]!, bytes };
    });
  if (entries.length < 1 || entries.length > 12000)
    throw new Error("candidate source file bound exceeded");
  // Cargo metadata/deny do not build packages. Configuration capable of changing
  // tool selection, aliases, credential routes or wrappers must exactly match
  // the fixed reviewed controller. Candidate Cargo manifests remain inert data.
  const configuration = (revision: string) =>
    git(sourceRepository, [
      "ls-tree",
      "-r",
      revision,
      "--",
      ".cargo",
      "rust-toolchain.toml",
    ]).toString("utf8");
  if (configuration(commit) !== configuration("HEAD"))
    throw new Error(
      "candidate Cargo/toolchain execution configuration differs from fixed controller",
    );
  git(root, ["init", "--template", home]);
  git(root, ["config", "core.filemode", "false"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, [
    "-c",
    "protocol.file.allow=always",
    "fetch",
    "--no-tags",
    "--depth=1",
    sourceRepository,
    commit,
  ]);
  git(root, ["update-ref", "HEAD", commit]);
  git(root, ["read-tree", commit]);
  for (const entry of entries) {
    const bytes = git(sourceRepository, ["cat-file", "blob", entry.oid], entry.bytes + 1);
    if (bytes.length !== entry.bytes) throw new Error("candidate raw blob length differs");
    await mkdir(path.dirname(path.join(root, entry.filename)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, entry.filename), bytes, { flag: "wx", mode: 0o600 });
  }
  const approval: unknown = JSON.parse(
    git(root, ["show", `${commit}:.github/linux-beta-risk-706.json`], 64 * 1024).toString("utf8"),
  );
  if (
    !isRecord(approval) ||
    typeof approval.reconfirmedHead !== "string" ||
    !/^[a-f0-9]{40}$/u.test(approval.reconfirmedHead)
  )
    throw new Error("candidate source qualification approval baseline unavailable");
  // Existing #706 checks compare this exact source baseline. A depth-one fetch
  // avoids copying unrelated history and never changes the source repository.
  if (approval.reconfirmedHead !== commit) {
    const baseline = git(sourceRepository, ["ls-tree", "-r", "-l", "-z", approval.reconfirmedHead])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    let baselineBytes = 0;
    if (
      baseline.length > 12000 ||
      baseline.some((entry) => {
        const size = /^\d+ blob [a-f0-9]{40}\s+(\d+)\t/u.exec(entry);
        if (!size) return true;
        baselineBytes += Number(size[1]);
        return baselineBytes > maximumBytes;
      })
    )
      throw new Error("qualification baseline source exceeds bounded fetch scope");
    git(root, [
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--no-tags",
      "--depth=1",
      sourceRepository,
      approval.reconfirmedHead,
    ]);
  }
  if (
    git(root, ["rev-parse", "HEAD^{tree}"]).toString().trim() !== tree ||
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).toString().trim()
  )
    throw new Error("materialized source differs from exact prepared tree");
  return {
    root,
    directory,
    commit,
    tree,
    files: entries.length,
    bytes: total,
    candidate_execution: "none; raw blobs and fixed Cargo/toolchain configuration only",
    authority: "none",
  };
}

/** The existing fixed finalizer performs the maintained exact-source scanner /
 * #706 check once against the inert candidate root. It is never imported from
 * candidate content. Caller supplies a separately scoped read credential; no
 * publisher, signer, observer or issuer credential is inherited implicitly. */
export function finalizeQualifiedReleaseCandidate(
  request: {
    qualification_root: string;
    prepared_commit: string;
    version: string;
    assets: string;
    inventory: string;
    sbom_subjects: string;
  },
  readToken: string,
) {
  if (!/^[a-f0-9]{40}$/u.test(request.prepared_commit) || !readToken || readToken.length > 16384)
    throw new Error("exact candidate and isolated read credential required for qualification");
  // CARGO_HOME alone does not suppress hierarchical Cargo configuration. Never
  // inherit another checkout/user's aliases, wrappers or credential providers.
  for (
    let ancestor = path.dirname(request.qualification_root);
    ;
    ancestor = path.dirname(ancestor)
  ) {
    if (["config", "config.toml"].some((name) => existsSync(path.join(ancestor, ".cargo", name))))
      throw new Error("qualification root inherits unreviewed ancestor Cargo configuration");
    if (path.dirname(ancestor) === ancestor) break;
  }
  const module = new URL("./finalize-release-assets.mts", import.meta.url).href;
  const script = `import {finalizeReleaseAssets} from ${JSON.stringify(module)}; const r=JSON.parse(process.argv[1]); const result=await finalizeReleaseAssets(r.assets,r.inventory,{projectRoot:${JSON.stringify(project)},sbomSubjectChecksums:r.sbom_subjects,linuxQualificationRoot:r.qualification_root}); console.log(JSON.stringify({scope:"fixed-finalizer-exact-candidate",assets:result.assets}));`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script, JSON.stringify(request)],
    {
      cwd: request.qualification_root,
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      shell: false,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: path.join(request.qualification_root, "..", "home"),
        USERPROFILE: path.join(request.qualification_root, "..", "home"),
        CARGO_HOME: path.join(request.qualification_root, "..", "cargo-home"),
        RUSTUP_HOME:
          process.env.RUSTUP_HOME ??
          path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".rustup"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GH_HOST: "github.com",
        GH_TOKEN: readToken,
        GITHUB_SHA: request.prepared_commit,
        GITHUB_REF_NAME: `v${request.version}`,
      },
    },
  );
  return result;
}
