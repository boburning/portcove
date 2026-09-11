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
const desktopRoot = path.join(projectRoot, "apps", "desktop");
const viteConfig = path.join(projectRoot, "apps", "desktop", "vite.config.ts");
const typeAwareTargets = targets.filter((target) => {
  const absolute = path.resolve(projectRoot, target);
  const extension = path.extname(absolute);
  return (
    absolute === viteConfig ||
    absolute === sourceRoot ||
    absolute.startsWith(`${sourceRoot}${path.sep}`) ||
    ((extension === ".ts" || extension === ".tsx") &&
      absolute.startsWith(`${desktopRoot}${path.sep}`))
  );
});
const baseArguments = [
  oxlint,
  "--config",
  path.join(projectRoot, ".oxlintrc.json"),
  "--max-warnings",
  "0",
  "--report-unused-disable-directives",
];
function run(args, stdio = "inherit") {
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${desktopBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    stdio,
    encoding: stdio === "pipe" ? "utf8" : undefined,
  });
}

function runPass(arguments_, label) {
  const result = run([...arguments_, "--format", "json"], "pipe");
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const displayed = run(arguments_);
    if (displayed.error) throw displayed.error;
    return displayed.status ?? result.status ?? 1;
  }
  if (result.stderr) process.stderr.write(result.stderr);
  const report = JSON.parse(result.stdout);
  if (report.number_of_files < 1 || report.number_of_rules < 1) {
    throw new Error(
      `Oxlint ${label} pass reported ${report.number_of_files} files and ${report.number_of_rules} rules; refusing a vacuous lint pass.`,
    );
  }
  console.log(
    `Oxlint ${label} pass: ${report.number_of_files} files with ${report.number_of_rules} active rules.`,
  );
  return 0;
}

const standardStatus = runPass([...baseArguments, ...targets], "standard");
if (standardStatus !== 0) {
  process.exitCode = standardStatus;
} else if (typeAwareTargets.length > 0) {
  process.exitCode = runPass([...baseArguments, "--type-aware", ...typeAwareTargets], "type-aware");
}
