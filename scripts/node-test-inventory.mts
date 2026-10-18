import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "./runtime-values.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const nodeTest = /^scripts\/[^/]+\.test\.[cm]?[jt]s$/u;
const inventoryInputs = [
  ".github/workflows/ci.yml",
  "justfile",
  "scripts/run-windows-qualification.ps1",
];

export function requireNodeTestInventory(
  files: readonly string[],
  required: string,
  local: string,
) {
  if (!files.length) throw new Error("Node test inventory must be nonempty");
  for (const file of files) {
    if (!required.includes(file)) throw new Error(`${file} is absent from required CI`);
    if (!local.includes(file)) throw new Error(`${file} is absent from local quality checks`);
  }
}

export function checkStagedNodeTestInventory(cwd = root) {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Cannot inspect staged Node inventory: ${result.stderr}`);
    return result.stdout;
  };
  const changed = git("diff", "--cached", "--name-only", "--no-renames", "-z")
    .split("\0")
    .filter(Boolean);
  if (!changed.some((file) => nodeTest.test(file) || inventoryInputs.includes(file)))
    return { checked: false, files: 0 };
  if (git("ls-files", "--unmerged", "-z")) throw new Error("Cannot inspect an unmerged index");
  const files = git("ls-files", "-z", "--", "scripts")
    .split("\0")
    .filter((file) => nodeTest.test(file));
  const [workflow, recipes, runner] = inventoryInputs.map((file) => git("show", `:${file}`));
  requireNodeTestInventory(files, `${workflow}\n${runner}`, `${recipes}\n${runner}`);
  return { checked: true, files: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).join(" ") !== "--staged")
      throw new Error("usage: node scripts/node-test-inventory.mts --staged");
    const result = checkStagedNodeTestInventory();
    if (result.checked)
      console.log(`Node test inventory: ${result.files} indexed files registered`);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
