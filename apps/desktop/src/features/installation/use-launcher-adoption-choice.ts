import { useRef, useState } from "react";
import type { LauncherLibraryEntry } from "../../types";

/**
 * A launcher app chosen for copying names its own folder and, when exactly one
 * game matched, that game. The choice applies only while its folder is the
 * reviewed path; editing the path restores the dialog's ordinary port scope.
 */
export function useLauncherAdoptionChoice(path: string, fallbackPortId: string | undefined) {
  const [choice, setChoice] = useState<{ path: string; portId?: string }>();
  const pendingReview = useRef(false);
  const chosen = choice?.path === path ? choice : undefined;
  return {
    /** Port scope for the ordinary adoption review. */
    portId: chosen ? chosen.portId : fallbackPortId,
    choose(entry: LauncherLibraryEntry, setPath: (path: string) => void) {
      if (!entry.install_path) return;
      setChoice({
        path: entry.install_path,
        ...(entry.adopt_port_id ? { portId: entry.adopt_port_id } : {}),
      });
      pendingReview.current = true;
      setPath(entry.install_path);
    },
    /** True once, after the chosen folder became the reviewed path. */
    takePendingReview() {
      if (!pendingReview.current || !chosen) return false;
      pendingReview.current = false;
      return true;
    },
  };
}
