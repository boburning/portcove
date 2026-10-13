import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isOwnedOxfmtPath } from "./oxfmt-ownership.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const inventory = spawnSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: projectRoot, encoding: "utf8" },
);
if (inventory.error) throw inventory.error;
if (inventory.status !== 0) {
  process.stderr.write(inventory.stderr);
  process.exit(inventory.status ?? 1);
}
const files = inventory.stdout
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"))
  .filter(isOwnedOxfmtPath);
if (files.length === 0) {
  throw new Error("Oxfmt inventory is empty; refusing to report a vacuous formatting pass.");
}
console.log(`Oxfmt inventory: ${files.length} repository-owned files.`);

const oxfmt = path.join(projectRoot, "node_modules", "oxfmt", "bin", "oxfmt");
const args = process.argv.slice(2);
const hasTarget = args.some((argument) => !argument.startsWith("-"));
const result = spawnSync(process.execPath, [oxfmt, ...args, ...(hasTarget ? [] : ["."])], {
  cwd: projectRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
