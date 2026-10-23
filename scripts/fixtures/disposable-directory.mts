import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

/** Own only the freshly created directory; callers must drain writers before teardown. */
export function disposableDirectory(context: { after(cleanup: () => void): void }, prefix: string) {
  const directory = mkdtempSync(path.resolve(prefix));
  context.after(() => {
    const metadata = lstatSync(directory, { throwIfNoEntry: false });
    if (!metadata) return;
    if (
      realpathSync(path.dirname(directory)) !== parent ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== identity.dev ||
      metadata.ino !== identity.ino
    )
      throw new Error(`Disposable fixture root was replaced: ${directory}`);
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const identity = lstatSync(directory);
  const parent = realpathSync(path.dirname(directory));
  return directory;
}
