import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppShellState, type BrowsingInputs } from "./use-app-shell-state";
import { useWorkspaceContinuity, type WorkspaceBrowsingPositions } from "../../keyboard-shortcuts";

export type LibraryBrowsingContext = {
  inputs: BrowsingInputs;
  positions: WorkspaceBrowsingPositions;
};

const emptyProfileLandingKey = "portcove.empty-profile-landing.v1";
const maximumStoredCharacters = 64 * 1024;
const browsingSections = ["library", "catalog", "updates", "settings"] as const;

type PreferenceFailure = "read" | "write";

function preferenceFeedback(initial: PreferenceFailure | undefined) {
  let failure = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => failure,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (next: PreferenceFailure | undefined) => {
      if (failure === next) return;
      failure = next;
      for (const listener of listeners) listener();
    },
  };
}

export function libraryBrowsingPreferenceKey(root: string): string {
  return `portcove.browsing-inputs.v1:${libraryBrowsingKey(root)}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function storedSectionValid(
  inputs: unknown,
  version: unknown,
  section: (typeof browsingSections)[number],
): boolean {
  if (
    !object(inputs) ||
    !onlyKeys(
      inputs,
      version === 2 && section === "library"
        ? ["query", "filter", "readiness", "sort"]
        : ["query", "filter"],
    ) ||
    (inputs.readiness !== undefined && typeof inputs.readiness !== "string") ||
    (inputs.sort !== undefined &&
      (typeof inputs.sort !== "string" ||
        !["name", "name-desc", "recent"].includes(inputs.sort))) ||
    typeof inputs.query !== "string" ||
    !(typeof inputs.filter === "string" || object(inputs.filter))
  )
    return false;
  return true;
}

function storedInputs(value: unknown, root: string): BrowsingInputs | undefined {
  if (
    !object(value) ||
    !onlyKeys(value, ["version", "library", "inputs"]) ||
    (value.version !== 1 && value.version !== 2) ||
    value.library !== libraryBrowsingKey(root) ||
    !object(value.inputs) ||
    !onlyKeys(value.inputs, ["sections", "catalogSort"]) ||
    typeof value.inputs.catalogSort !== "string" ||
    !["catalog", "name", "name-desc", "installed-first"].includes(value.inputs.catalogSort) ||
    !object(value.inputs.sections) ||
    !onlyKeys(value.inputs.sections, browsingSections)
  )
    return undefined;
  for (const section of browsingSections) {
    if (!storedSectionValid(value.inputs.sections[section], value.version, section))
      return undefined;
  }
  // Query objects and unknown legacy identifiers remain intact. The existing
  // evaluator/restoration owns supported predicates and explicit correction.
  return value.inputs as BrowsingInputs;
}

function readBrowsingInputs(root: string | null): {
  inputs?: BrowsingInputs;
  existed: boolean;
  failure?: PreferenceFailure;
} {
  if (!root) return { existed: false };
  try {
    const serialized = window.localStorage.getItem(libraryBrowsingPreferenceKey(root));
    if (serialized === null) return { existed: false };
    if (serialized.length > maximumStoredCharacters) throw new Error("oversized preference");
    const inputs = storedInputs(JSON.parse(serialized), root);
    if (!inputs) throw new Error("unreadable preference");
    return { inputs, existed: true };
  } catch {
    return { existed: true, failure: "read" };
  }
}

function writeBrowsingInputs(root: string, serializedInputs: string): void {
  const serialized = JSON.stringify({
    version: 2,
    library: libraryBrowsingKey(root),
    inputs: JSON.parse(serializedInputs) as unknown,
  });
  if (serialized.length > maximumStoredCharacters) throw new Error("oversized preference");
  window.localStorage.setItem(libraryBrowsingPreferenceKey(root), serialized);
}

export function libraryBrowsingKey(root: string): string {
  if (root.startsWith("\\\\?\\UNC\\")) return `\\\\${root.slice(8)}`;
  return root.startsWith("\\\\?\\") ? root.slice(4) : root;
}

export function useLibraryBrowsingContext({
  root,
  initial,
  returnToSelection,
  remember,
  switchLibrary,
  resetLibrary,
  ready = true,
  installedCount,
  catalogCount,
}: {
  root: string | null;
  initial?: LibraryBrowsingContext | undefined;
  returnToSelection?: "switch" | "reset" | undefined;
  remember: (root: string, context: LibraryBrowsingContext) => void;
  switchLibrary: (path: string) => Promise<void>;
  resetLibrary: () => Promise<void>;
  ready?: boolean;
  installedCount?: number | undefined;
  catalogCount?: number | undefined;
}) {
  const [restored] = useState(() => {
    const stored = readBrowsingInputs(root);
    return {
      ...stored,
      inputs: initial?.inputs ?? stored.inputs,
      existed: Boolean(initial) || stored.existed,
    };
  });
  const [feedback] = useState(() =>
    preferenceFeedback("failure" in restored ? restored.failure : undefined),
  );
  const preferenceFailure = useSyncExternalStore(feedback.subscribe, feedback.read, feedback.read);
  const unreadablePreference = useRef(preferenceFailure === "read");
  const [mountedRoot] = useState(root);
  const ui = useAppShellState(
    returnToSelection ? "settings" : "library",
    restored.inputs,
    returnToSelection ? "library-storage" : "appearance",
  );
  const serializedInputs = JSON.stringify(ui.browsingInputs);
  const [initialInputs] = useState(serializedInputs);
  const saveBrowsingPreferences = () => {
    if (!root || root !== mountedRoot) return false;
    try {
      writeBrowsingInputs(root, serializedInputs);
      unreadablePreference.current = false;
      feedback.publish(undefined);
      return true;
    } catch {
      feedback.publish(unreadablePreference.current ? "read" : "write");
      return false;
    }
  };
  useEffect(() => {
    if (
      !root ||
      root !== mountedRoot ||
      unreadablePreference.current ||
      (!restored.existed && serializedInputs === initialInputs)
    )
      return;
    try {
      writeBrowsingInputs(root, serializedInputs);
      feedback.publish(undefined);
    } catch {
      feedback.publish("write");
    }
  }, [root, mountedRoot, restored.existed, serializedInputs, initialInputs, feedback]);
  const { view, setView } = ui;
  const interactedBeforeReady = useRef(false);
  useEffect(() => {
    if (ready) return;
    const markInteraction = () => {
      interactedBeforeReady.current = true;
    };
    document.addEventListener("pointerdown", markInteraction);
    document.addEventListener("keydown", markInteraction);
    return () => {
      document.removeEventListener("pointerdown", markInteraction);
      document.removeEventListener("keydown", markInteraction);
    };
  }, [ready]);
  useEffect(() => {
    if (
      !ready ||
      catalogCount === undefined ||
      catalogCount === 0 ||
      installedCount !== 0 ||
      restored.existed ||
      returnToSelection
    )
      return;
    try {
      const storage = window.localStorage;
      if (storage.getItem(emptyProfileLandingKey)) return;
      const autoLanding = view === "library" && !interactedBeforeReady.current;
      storage.setItem(emptyProfileLandingKey, autoLanding ? "catalog" : "dismissed");
      if (autoLanding) setView("catalog");
    } catch {
      // Browsing still works when the host denies optional view-preference storage.
    }
  }, [ready, catalogCount, installedCount, restored.existed, returnToSelection, view, setView]);
  const { browsingPositions, switchView, workspace } = useWorkspaceContinuity(
    ui.view,
    initial?.positions,
    !returnToSelection,
    ready,
  );
  const save = () => {
    if (root)
      remember(root, {
        inputs: ui.browsingInputs,
        positions: browsingPositions(),
      });
  };
  const switchLibraryWithContext = async (path: string) => {
    save();
    await switchLibrary(path);
  };
  const resetLibraryWithContext = async () => {
    save();
    await resetLibrary();
  };
  return {
    ui,
    switchView,
    workspace,
    switchLibraryWithContext,
    resetLibraryWithContext,
    preferenceFailure,
    saveBrowsingPreferences,
  };
}
