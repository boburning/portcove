import { createContext, useContext, useState, type ReactNode } from "react";
import type { SetupChoice } from "./setup-choice";

function createLaunchDrafts() {
  const drafts = new Map<string, { scope: string; choice: SetupChoice }>();
  return {
    read(slot: string, scope: string) {
      const draft = drafts.get(slot);
      return draft?.scope === scope ? draft.choice : undefined;
    },
    write(slot: string, scope: string, choice: SetupChoice) {
      drafts.set(slot, { scope, choice });
    },
    clear(slot: string, scope: string) {
      if (drafts.get(slot)?.scope === scope) drafts.delete(slot);
    },
    retireOtherTarget(slot: string, scope: string) {
      const draft = drafts.get(slot);
      if (draft && draft.scope !== scope) drafts.delete(slot);
    },
  };
}

const LaunchDrafts = createContext<ReturnType<typeof createLaunchDrafts> | undefined>(undefined);

/** Lives for one library generation so Back can remount the editor and retain its inputs. */
export function SetupLaunchDraftsProvider({ children }: { children: ReactNode }) {
  const [drafts] = useState(createLaunchDrafts);
  return <LaunchDrafts.Provider value={drafts}>{children}</LaunchDrafts.Provider>;
}

export function useSetupLaunchDrafts() {
  return useContext(LaunchDrafts);
}
