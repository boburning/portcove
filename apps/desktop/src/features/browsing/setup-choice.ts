import { libraryBrowsingKey } from "../app-shell/use-library-browsing-context";

export interface SetupChoice {
  executable: string;
  workingDirectory: string;
  argumentLines: string;
  argumentsEdited: boolean;
  targetEdited: boolean;
}

function key(root: string, id: string, pending: string) {
  return `portcove.setup-choice.v1:${libraryBrowsingKey(root)}:${id}:${pending}`;
}

/** Retain only setup inputs. Core rechecks the target and issues fresh consent. */
export function readSetupChoice(root: string | undefined, id: string, pending: string | undefined) {
  if (!root || !pending) return {};
  try {
    const bytes = localStorage.getItem(key(root, id, pending));
    if (!bytes) return {};
    if (bytes.length > 128 * 1024) throw new Error("Oversized setup choice");
    const value: unknown = JSON.parse(bytes);
    if (
      !value ||
      typeof value !== "object" ||
      !("executable" in value) ||
      typeof value.executable !== "string" ||
      value.executable.length > 4096 ||
      !("workingDirectory" in value) ||
      typeof value.workingDirectory !== "string" ||
      value.workingDirectory.length > 4096 ||
      !("argumentLines" in value) ||
      typeof value.argumentLines !== "string" ||
      value.argumentLines.length > 65536 ||
      !("argumentsEdited" in value) ||
      typeof value.argumentsEdited !== "boolean" ||
      !("targetEdited" in value) ||
      typeof value.targetEdited !== "boolean"
    )
      throw new Error("Invalid setup choice");
    return { choice: value as SetupChoice };
  } catch {
    return { warning: "Saved launch details could not be read. Review your selection again." };
  }
}

export function writeSetupChoice(
  root: string | undefined,
  id: string,
  pending: string | undefined,
  choice: SetupChoice,
) {
  if (!root || !pending) return undefined;
  try {
    const bytes = JSON.stringify(choice);
    if (bytes.length > 128 * 1024) throw new Error("Oversized setup choice");
    localStorage.setItem(key(root, id, pending), bytes);
    return undefined;
  } catch {
    return "Launch details could not be saved for your next visit. Your current choices still apply on this screen.";
  }
}
