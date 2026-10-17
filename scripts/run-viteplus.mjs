import { resourceEntrypoint } from "./resource-command.mjs";
import { vitePlusCommand } from "./viteplus-cli.mjs";
import { spawnCommand } from "./dev-storage.mjs";
const cli = vitePlusCommand(process.cwd());
const run = () => {
  const result = spawnCommand(cli.command, [...cli.args, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
};
const args = process.argv.slice(2);
const action = args[0];
const heavy =
  action === "test" ||
  (["check", "lint"].includes(action) && args.slice(1).every((arg) => arg.startsWith("-")));
process.exitCode = heavy
  ? await resourceEntrypoint(action === "test" ? "browser" : "analysis", run)
  : run();
