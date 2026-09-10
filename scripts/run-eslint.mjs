import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const eslint = path.join(
  projectRoot,
  "apps",
  "desktop",
  "node_modules",
  "eslint",
  "bin",
  "eslint.js",
);
const targets =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [
        "scripts",
        "apps/desktop/scripts",
        "apps/desktop/src",
        "apps/desktop/vite.config.ts",
      ];
const result = spawnSync(
  process.execPath,
  [
    eslint,
    "--config",
    path.join(projectRoot, "eslint.config.mjs"),
    "--max-warnings",
    "0",
    "--report-unused-disable-directives",
    ...targets,
  ],
  { cwd: projectRoot, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
