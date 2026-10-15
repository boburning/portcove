import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "node_modules/vite-plus/bin/vp");

// Vite+ 1.2 writes --local, which is shared across linked worktrees. Keep its
// generated dispatcher and stage engine; isolate only installation preferences.
export function configureHooks(directory = root, mode = "install", environment = process.env) {
  if (!["install", "enable", "disable", "status"].includes(mode))
    throw new Error("Unknown hook operation");
  const invoke = (command, args, cwd = directory) => {
    const result = spawnSync(command, args, {
      cwd,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return result;
  };
  const git = (...args) => invoke("git", args);
  const get = (...args) => git("config", ...args).stdout?.trim() ?? "";
  const checked = (result) => {
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Hook setup failed");
    return result.stdout;
  };
  if (git("rev-parse", "--is-inside-work-tree").status !== 0)
    return "Source archive: hooks skipped";
  if (environment.VP_GIT_HOOKS === "0" || environment.CI === "true")
    return "Non-development setup: hooks skipped";
  const hookPath = get("--get", "core.hooksPath").replaceAll("\\", "/");
  if (hookPath && ![".husky/_", ".vite-hooks/_"].includes(hookPath))
    return `Existing hook manager preserved: ${hookPath}`;
  if (hookPath === ".husky/_" && mode === "install")
    return "Legacy Husky hook preserved; review it, then run pnpm hooks:enable";
  if (get("--bool", "--get", "extensions.worktreeConfig") !== "true") {
    const gitDir = checked(git("rev-parse", "--path-format=absolute", "--git-dir")).trim();
    const common = checked(git("rev-parse", "--path-format=absolute", "--git-common-dir")).trim();
    if (gitDir !== common)
      return "Linked checkout: enable Git worktreeConfig before installing isolated hooks";
    return checked(
      invoke(process.execPath, [
        cli,
        ...(mode === "install" ? ["config", "--no-agent"] : ["hooks", mode]),
      ]),
    );
  }
  if (mode === "status")
    return `Worktree hooks: path=${hookPath || "disabled"}; disabled=${get("--bool", "--get", "vp.hooks.disabled") || "false"}`;
  if (mode === "disable") {
    checked(git("config", "--worktree", "vp.hooks.disabled", "true"));
    checked(git("config", "--worktree", "core.hooksPath", ""));
    return "Hooks disabled in this worktree";
  }
  if (mode === "install" && get("--bool", "--get", "vp.hooks.disabled") === "true")
    return "Hooks remain disabled in this worktree";
  const scratchRoot = path.join(directory, "work/hook-setup");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(path.join(scratchRoot, "dispatcher-"));
  checked(invoke("git", ["init", "-q"], scratch));
  checked(invoke(process.execPath, [cli, "hooks", "enable"], scratch));
  cpSync(path.join(scratch, ".vite-hooks/_"), path.join(directory, ".vite-hooks/_"), {
    recursive: true,
  });
  checked(git("config", "--worktree", "vp.hooks.dir", ".vite-hooks"));
  checked(git("config", "--worktree", "vp.hooks.disabled", "false"));
  checked(git("config", "--worktree", "core.hooksPath", ".vite-hooks/_"));
  return "Vite+ dispatcher installed with worktree-local preferences";
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(configureHooks(root, process.argv[2]));
