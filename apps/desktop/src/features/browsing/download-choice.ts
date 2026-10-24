import { libraryBrowsingKey } from "../app-shell/use-library-browsing-context";

export interface DownloadChoice {
  channel: "stable" | "beta";
  release: number | null;
  package: string;
  destination: string;
  extract: boolean;
}

function key(root: string, id: string) {
  return `portcove.download-choice.v1:${libraryBrowsingKey(root)}:${id}`;
}

/** UI inputs only. A restored choice always needs a fresh Core preview. */
export function readDownloadChoice(root: string | undefined, id: string, upstream: string) {
  if (!root) return {};
  try {
    const bytes = localStorage.getItem(key(root, id));
    if (!bytes) return {};
    if (bytes.length > 16384) throw new Error("Oversized choice");
    const value: unknown = JSON.parse(bytes);
    if (!value || typeof value !== "object" || !("upstream" in value))
      throw new Error("Invalid choice");
    // A different origin invalidates the former selection, without erasing it.
    if (value.upstream !== upstream) return {};
    if (!("choice" in value) || !value.choice || typeof value.choice !== "object")
      throw new Error("Invalid choice");
    const choice = value.choice;
    if (
      !("channel" in choice) ||
      !["stable", "beta"].includes(String(choice.channel)) ||
      !("release" in choice) ||
      !(
        choice.release === null ||
        (Number.isSafeInteger(choice.release) && Number(choice.release) > 0)
      ) ||
      !("package" in choice) ||
      typeof choice.package !== "string" ||
      !/^(?:[1-9][0-9]*:[1-9][0-9]*)?$/u.test(choice.package) ||
      !("destination" in choice) ||
      typeof choice.destination !== "string" ||
      choice.destination.length > 4096 ||
      !("extract" in choice) ||
      typeof choice.extract !== "boolean"
    )
      throw new Error("Invalid choice");
    return { choice: choice as DownloadChoice };
  } catch {
    return {
      warning: "Saved download options could not be read. Choose them again before downloading.",
    };
  }
}

export function writeDownloadChoice(
  root: string | undefined,
  id: string,
  upstream: string,
  choice: DownloadChoice,
) {
  if (!root) return undefined;
  try {
    localStorage.setItem(key(root, id), JSON.stringify({ upstream, choice }));
    return undefined;
  } catch {
    return "Download options could not be saved for your next visit. Your current choices still apply on this screen.";
  }
}
