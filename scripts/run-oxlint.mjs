import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const oxlint = path.join(projectRoot, "apps", "desktop", "node_modules", "oxlint", "bin", "oxlint");
const desktopBin = path.join(projectRoot, "apps", "desktop", "node_modules", ".bin");
const targets =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ["scripts", "apps/desktop/scripts", "apps/desktop/src", "apps/desktop/vite.config.ts"];
const sourceRoot = path.join(projectRoot, "apps", "desktop", "src");
const typeAwareTargets = targets.filter((target) => {
  const absolute = path.resolve(projectRoot, target);
  return absolute === sourceRoot || absolute.startsWith(`${sourceRoot}${path.sep}`);
});
const baseArguments = [
  oxlint,
  "--config",
  path.join(projectRoot, ".oxlintrc.json"),
  "--max-warnings",
  "0",
  "--report-unused-disable-directives",
];
function run(args) {
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${desktopBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: "inherit",
  });
}

const standard = run([...baseArguments, ...targets]);
if (standard.error) throw standard.error;
if (standard.status !== 0) {
  process.exitCode = standard.status ?? 1;
} else if (typeAwareTargets.length > 0) {
  const typeAware = run([...baseArguments, "--type-aware", ...typeAwareTargets]);
  if (typeAware.error) throw typeAware.error;
  process.exitCode = typeAware.status ?? 1;
}
