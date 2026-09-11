import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const supportedExtension = /\.(?:astro|cjs|css|html|js|json|json5|jsonc|jsx|less|md|mdx|mjs|mts|scss|svelte|ts|tsx|vue|ya?ml)$/i;
const excludedPath = /^(?:apps\/desktop\/(?:dist|node_modules|src-tauri\/gen)\/|target\/|work\/|outputs\/|release-assets\/|\.codex-remote-attachments\/|\.fallow(?:-review)?\/|\.rscheck\/|\.semdup\/|\.tmp\/|mutants\.out(?:\.old)?\/|Portcove-CI-FiveMinutes\/|integrations\/playnite\/(?:bin|obj|tests\/(?:bin|obj))\/|crates\/portcove-core\/catalog\/|crates\/[^/]+\/tests\/fixtures\/|docs\/archive\/|docs\/releases\/\d+\.md$)/;
const excludedFile = /(?:\.generated\.[^/]+$|(?:^|\/)pnpm-lock\.yaml$|integrations\/playnite\/(?:tests\/)?packages\.lock\.json$)/;

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
  .filter((file) => supportedExtension.test(file) && !excludedPath.test(file) && !excludedFile.test(file));
if (files.length === 0) {
  throw new Error("Oxfmt inventory is empty; refusing to report a vacuous formatting pass.");
}
console.log(`Oxfmt inventory: ${files.length} repository-owned files.`);

const oxfmt = path.join(
  projectRoot,
  "apps",
  "desktop",
  "node_modules",
  "oxfmt",
  "bin",
  "oxfmt",
);
const args = process.argv.slice(2);
const hasTarget = args.some((argument) => !argument.startsWith("-"));
const result = spawnSync(process.execPath, [oxfmt, ...args, ...(hasTarget ? [] : ["."])], {
  cwd: projectRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
