import { lstatSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";

type FixtureContext = { after(cleanup: () => void | Promise<void>): void };
interface DisposalOptions {
  drain?: () => void | Promise<void>;
  sharedLinks?: readonly string[];
}

/** Register only a directory freshly created by this test, including Git worktree siblings. */
export function registerDisposableDirectory(
  context: FixtureContext,
  directory: string,
  options: DisposalOptions = {},
) {
  directory = path.resolve(directory);
  context.after(async () => {
    await options.drain?.();
    const metadata = lstatSync(directory, { throwIfNoEntry: false, bigint: true });
    if (!metadata) return;
    if (
      realpathSync(path.dirname(directory)) !== parent ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino
    )
      throw new Error(`Disposable fixture root was replaced: ${directory}`);
    for (const name of options.sharedLinks ?? []) {
      if (!name || name === "." || name === ".." || path.basename(name) !== name)
        throw new Error("Shared fixture link must be an immediate child");
      const link = path.join(directory, name);
      const metadata = lstatSync(link, { throwIfNoEntry: false });
      if (!metadata) continue;
      if (!metadata.isSymbolicLink()) throw new Error(`Fixture shared link was replaced: ${link}`);
      unlinkSync(link);
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const identity = lstatSync(directory, { bigint: true });
  const parent = realpathSync(path.dirname(directory));
}

/** Create owned scratch and register teardown before any caller initialization can fail. */
export function disposableDirectory(
  context: FixtureContext,
  prefix: string,
  options: DisposalOptions = {},
) {
  const directory = mkdtempSync(path.resolve(prefix));
  registerDisposableDirectory(context, directory, options);
  return directory;
}
