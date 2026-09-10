import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    repository: { type: "string" },
    installer: { type: "string" },
    cli: { type: "string" },
    desktop: { type: "string" },
    predecessor: { type: "string" },
    "predecessor-version": { type: "string" },
    output: { type: "string" },
  },
});
for (const name of [
  "repository",
  "installer",
  "cli",
  "desktop",
  "predecessor",
  "predecessor-version",
  "output",
]) {
  if (!values[name]) throw new Error(`--${name} is required`);
}

const repository = path.resolve(values.repository);
const git = (...args) =>
  execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
const status = git("status", "--porcelain", "--untracked-files=no");
if (status)
  throw new Error(
    "Candidate checkout has tracked changes; build records require an exact clean checkout",
  );
const commit = git("rev-parse", "HEAD");
const tree = git("show", "-s", "--format=%T", commit);

function withinRepository(input, name) {
  const full = path.resolve(input);
  const relative = path.relative(repository, full);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${name} must be a file below the candidate checkout`);
  }
  return { full, relative: relative.replaceAll(path.sep, "/") };
}
async function describe(input, name) {
  const item = withinRepository(input, name);
  if (!(await stat(item.full)).isFile())
    throw new Error(`${name} must be a regular file`);
  const bytes = await readFile(item.full);
  return {
    relative_path: item.relative,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const tools = {};
for (const relative of [
  "scripts/windows-qualification-session.ps1",
  "scripts/test-windows-installer.ps1",
  "scripts/qualification-report.mjs",
]) {
  const disk = await readFile(path.join(repository, relative));
  execFileSync(
    "git",
    ["-C", repository, "diff", "--quiet", commit, "--", relative],
    { windowsHide: true },
  );
  tools[relative] = {
    relative_path: relative,
    bytes: disk.length,
    sha256: createHash("sha256").update(disk).digest("hex"),
  };
}

const record = {
  format: 1,
  generated_at: new Date().toISOString(),
  candidate: { commit, tree },
  artifacts: {
    installer: await describe(values.installer, "installer"),
    cli: await describe(values.cli, "cli"),
    desktop: await describe(values.desktop, "desktop"),
  },
  predecessor: {
    version: values["predecessor-version"],
    installer: await describe(values.predecessor, "predecessor"),
  },
  tools,
};
const output = path.resolve(values.output);
const body = `${JSON.stringify(record, null, 2)}\n`;
const handle = await open(output, "wx");
try {
  await handle.writeFile(body, "utf8");
} finally {
  await handle.close();
}
process.stdout.write(
  `${JSON.stringify({ output, commit, sha256: createHash("sha256").update(body).digest("hex") })}\n`,
);
