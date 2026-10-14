import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const oxlint = path.join(projectRoot, "node_modules", "oxlint", "bin", "oxlint");
const workspaceBin = path.join(projectRoot, "node_modules", ".bin");
const defaultTargets = [
  "scripts",
  "apps/desktop/scripts",
  "apps/desktop/src",
  "apps/desktop/vite.config.ts",
];

// This selects the obligation, never a subset of the full repository lint scan.
export function isRepositoryLintInput(file) {
  return (
    /^(?:scripts|apps\/desktop\/(?:scripts|src))\/.*\.(?:[cm]?[jt]sx?)$/u.test(file) ||
    /^apps\/desktop\/src\/.*\.css$/u.test(file) ||
    /^apps\/desktop\/(?:vite\.config\.ts|(?:.*\/)?tsconfig[^/]*\.json|stylelint\.config\.mjs)$/u.test(
      file,
    ) ||
    /^(?:apps\/desktop\/)?(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/u.test(
      file,
    ) ||
    [".oxlintrc.json", ".gitignore", ".node-version"].includes(file)
  );
}

export function runOxlint(
  targets = defaultTargets,
  {
    spawn = spawnSync,
    out = (text) => process.stdout.write(text),
    error = (text) => process.stderr.write(text),
  } = {},
) {
  const sourceRoot = path.join(projectRoot, "apps", "desktop", "src");
  const desktopRoot = path.join(projectRoot, "apps", "desktop");
  const viteConfig = path.join(desktopRoot, "vite.config.ts");
  const typed = targets.filter((target) => {
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
  const base = [
    oxlint,
    "--config",
    path.join(projectRoot, ".oxlintrc.json"),
    "--max-warnings",
    "0",
    "--report-unused-disable-directives",
  ];
  const passes = [
    ["standard", [...base, ...targets]],
    ...(typed.length ? [["type-aware", [...base, "--type-aware", ...typed]]] : []),
  ];
  let status = 0;
  for (const [label, args] of passes) {
    let passStatus = 1;
    let captured = "";
    try {
      const result = spawn(process.execPath, [...args, "--format", "json"], {
        cwd: projectRoot,
        env: { ...process.env, PATH: `${workspaceBin}${path.delimiter}${process.env.PATH ?? ""}` },
        stdio: "pipe",
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.stderr) error(result.stderr);
      captured = result.stdout ?? "";
      if (result.error) throw result.error;
      if (result.signal || !Number.isInteger(result.status) || result.status < 0)
        throw new Error(
          `Oxlint ${label} process did not complete normally (${result.signal ?? "unknown status"}).`,
        );
      passStatus = result.status;
      const report = JSON.parse(result.stdout);
      if (
        !Number.isInteger(report.number_of_files) ||
        report.number_of_files < 1 ||
        !Number.isInteger(report.number_of_rules) ||
        report.number_of_rules < 1 ||
        !Array.isArray(report.diagnostics)
      )
        throw new Error(
          `Oxlint ${label} report has invalid or empty file/rule inventory or diagnostics.`,
        );
      out(
        `Oxlint ${label} pass: ${report.number_of_files} files with ${report.number_of_rules} active rules.\n`,
      );
      for (const diagnostic of report.diagnostics) {
        const location = diagnostic.labels?.[0]?.span;
        error(
          `[${label}] ${diagnostic.filename ?? "<input>"}:${location?.line ?? "?"}:${location?.column ?? "?"} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`,
        );
      }
      if (report.diagnostics.length) passStatus ||= 1;
    } catch (failure) {
      error(`Oxlint ${label}: ${failure.message}\n`);
      if (captured) error(`Oxlint ${label} captured output:\n${captured}\n`);
      passStatus ||= 1;
    }
    status ||= passStatus;
  }
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runOxlint(process.argv.length > 2 ? process.argv.slice(2) : undefined);
}
