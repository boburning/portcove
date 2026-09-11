import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const taploCli = fileURLToPath(import.meta.resolve("@taplo/cli/dist/cli.js"));
const config = path.join(root, "taplo.toml");
const check = process.argv.slice(2).includes("--check");

if (process.argv.length > (check ? 3 : 2)) {
  throw new Error("usage: node scripts/format-toml.mjs [--check]");
}

const inventory = spawnSync(
  "git",
  [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ":(top,glob)*.toml",
    ":(top,glob).config/**/*.toml",
    ":(top,glob)apps/**/*.toml",
    ":(top,glob)crates/**/*.toml",
  ],
  { cwd: root, encoding: "utf8" },
);

if (inventory.error || inventory.status !== 0) {
  throw new Error(
    `could not enumerate TOML files: ${inventory.error?.message ?? inventory.stderr.trim()}`,
  );
}

const files = inventory.stdout
  .split("\0")
  .filter(Boolean)
  .filter((file) => !file.startsWith("apps/desktop/src-tauri/gen/"))
  .sort();

if (files.length === 0) {
  throw new Error("no repository-owned TOML files were found");
}

const changed = [];

for (const file of files) {
  const absolute = path.join(root, ...file.split("/"));
  const input = await readFile(absolute, "utf8");
  const formatted = spawnSync(
    process.execPath,
    [taploCli, "format", "--config", config, "--stdin-filepath", file, "-"],
    { cwd: root, encoding: "utf8", input, maxBuffer: 10 * 1024 * 1024 },
  );

  if (formatted.error || formatted.status !== 0) {
    throw new Error(
      `Taplo could not format ${file}: ${formatted.error?.message ?? formatted.stderr.trim()}`,
    );
  }
  if (input === formatted.stdout) {
    continue;
  }

  changed.push(file);
  if (!check) {
    await writeFile(absolute, formatted.stdout, "utf8");
  }
}

if (changed.length === 0) {
  console.log(`Taplo checked ${files.length} TOML files.`);
} else if (check) {
  console.error(`TOML formatting differs: ${changed.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`Taplo formatted ${changed.length} of ${files.length} TOML files.`);
}
