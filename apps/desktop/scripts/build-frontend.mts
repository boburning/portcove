import { errorMessage, errorCode } from "../../../scripts/runtime-values.mts";
import { resourceEntrypoint } from "../../../scripts/resource-command.mts";
import { fileURLToPath } from "node:url";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import path from "node:path";
import { resolvePhysicalPath, spawnCommand } from "../../../scripts/dev-storage.mts";
import { vitePlusCommand } from "../../../scripts/viteplus-cli.mts";
import type { SpawnSyncOptions } from "node:child_process";

type FrontendRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => { status: number | null };

export function parseBuildArguments(args: readonly string[]) {
  const options: { fresh: boolean; profile?: string; debug?: string | true; filter?: string } = {
    fresh: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    if (!["--fresh", "--profile", "--debug", "--filter"].includes(flag))
      throw new Error(`Unsupported frontend build argument: ${argument}`);
    if (seen.has(flag)) throw new Error(`Duplicate frontend build argument: ${flag}`);
    seen.add(flag);
    let value = equals < 0 ? undefined : argument.slice(equals + 1);
    if (flag === "--fresh") {
      if (value !== undefined) throw new Error("--fresh does not accept a value");
      options.fresh = true;
      continue;
    }
    if (value === undefined && args[index + 1] && !args[index + 1]!.startsWith("-"))
      value = args[++index];
    if (
      value !== undefined &&
      (!value.trim() ||
        Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }))
    )
      throw new Error(`${flag} requires a nonempty value without control characters`);
    if (flag === "--profile") {
      if (
        value !== undefined &&
        (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value) ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(value))
      )
        throw new Error(
          "--profile name must be a portable basename (letters, digits, _ or -, max 64)",
        );
      options.profile = value ?? "build";
    } else if (flag === "--debug") {
      if (value !== undefined && !/^[a-zA-Z0-9_*:-]+(?:,[a-zA-Z0-9_*:-]+)*$/u.test(value))
        throw new Error("--debug expects comma-separated Vite debug features");
      options.debug = value ?? true;
    } else {
      if (value === undefined || value.startsWith("-"))
        throw new Error("--filter requires a debug-log substring");
      options.filter = value;
    }
  }
  if (options.filter !== undefined && options.debug === undefined)
    throw new Error("--filter requires --debug");
  return options;
}

function diagnosticDirectory(cwd: string) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  let directory = root;
  for (const segment of ["work", "frontend-diagnostics"]) {
    directory = path.join(directory, segment);
    const details = lstatSync(directory, { throwIfNoEntry: false });
    if (details && (!details.isDirectory() || details.isSymbolicLink()))
      throw new Error("Frontend diagnostics must use ordinary owned directories");
    if (!details) mkdirSync(directory);
    if (
      resolvePhysicalPath(directory) !==
      path.join(resolvePhysicalPath(root), path.relative(root, directory))
    )
      throw new Error("Frontend diagnostics escape the checkout");
  }
  const output = mkdtempSync(path.join(directory, "run-"));
  return { output, relative: path.relative(cwd, output).split(path.sep).join("/") };
}

export function frontendEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.toUpperCase().startsWith("TAURI_SIGNING_"),
    ),
  );
}

export function buildFrontend(
  environment = process.env,
  run: FrontendRunner = spawnCommand,
  fresh = false,
  directory = fileURLToPath(new URL("../", import.meta.url)),
  args: readonly string[] = [],
) {
  let log: number | undefined;
  try {
    const options = parseBuildArguments(args);
    const cwd = path.resolve(directory);
    const cli = vitePlusCommand(cwd);
    const diagnostic = options.profile !== undefined || options.debug !== undefined;
    const forwarded: string[] = [];
    if (diagnostic) {
      const destination = diagnosticDirectory(cwd);
      console.error(`Frontend diagnostics: ${destination.output}`);
      log = openSync(path.join(destination.output, "build.log"), "wx");
      if (options.profile !== undefined)
        forwarded.push("--profile", `${destination.relative}/${options.profile}`);
      if (options.debug !== undefined) {
        forwarded.push("--debug");
        if (typeof options.debug === "string") forwarded.push(options.debug);
      }
      if (options.filter !== undefined) forwarded.push("--filter", options.filter);
    }
    const output = path.join(cwd, "dist");
    const details = lstatSync(output, { throwIfNoEntry: false });
    if (details) {
      if (
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        resolvePhysicalPath(output) !== path.join(resolvePhysicalPath(cwd), "dist")
      )
        throw new Error("Frontend dist must be an ordinary owned directory");
      // Task replay restores captured files but retains unrelated output files.
      // Mirror Vite's emptyOutDir boundary before either execute or restore.
      rmSync(output, { recursive: true });
    }
    const result = run(
      cli.command,
      [
        ...cli.args,
        "run",
        ...(fresh || options.fresh || diagnostic ? ["--no-cache"] : []),
        "frontend:bundle",
        ...(diagnostic ? ["--", ...forwarded] : []),
      ],
      {
        cwd,
        env: frontendEnvironment(environment),
        stdio: log === undefined ? "inherit" : ["inherit", log, log],
      },
    );
    return result.status ?? 1;
  } catch (error) {
    console.error(`Frontend build failed: ${errorMessage(error)}`);
    if (["MODULE_NOT_FOUND", "ENOENT"].includes(errorCode(error) ?? ""))
      console.error(
        "Install the declared local tools with pnpm install --frozen-lockfile from the repository root.",
      );
    return 1;
  } finally {
    if (log !== undefined) closeSync(log);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await resourceEntrypoint("browser", () =>
    buildFrontend(process.env, spawnCommand, false, undefined, process.argv.slice(2)),
  );
