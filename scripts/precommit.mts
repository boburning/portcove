import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { vitePlusCommand } from "./viteplus-cli.mts";

const required = readFileSync(".node-version", "utf8").trim();
if (process.versions.node !== required) {
  console.error(`Hook runtime mismatch: activate Node ${required} and run pnpm hooks:enable.`);
  process.exit(1);
}
const vp = vitePlusCommand(process.cwd());
for (const [command, args] of [
  ["git", ["diff", "--cached", "--check"]],
  [process.execPath, ["scripts/node-test-inventory.mts", "--staged"]],
  [process.execPath, ["scripts/catalog-staged-check.mts", "--staged"]],
  [vp.command, [...vp.args, "staged", "--relative"]],
] as const) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
