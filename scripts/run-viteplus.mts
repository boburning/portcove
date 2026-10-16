import { vitePlusCommand } from "./viteplus-cli.mts";
import { spawnCommand } from "./dev-storage.mts";
const cli = vitePlusCommand(process.cwd());
const result = spawnCommand(cli.command, [...cli.args, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
