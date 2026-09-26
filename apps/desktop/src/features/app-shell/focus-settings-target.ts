import { focusAndReveal } from "../../focus";

export type ActivitySettingsTarget =
  | "source-profile"
  | "discover-sources"
  | "move-library"
  | "import-library"
  | "catalog-updates";

export function focusSettingsTarget(target: ActivitySettingsTarget, sourceProfileId?: string) {
  const group =
    target === "source-profile" || target === "discover-sources"
      ? "game-files"
      : target === "catalog-updates"
        ? "updates"
        : "library-storage";
  const heading = document.getElementById(`settings-${group}-heading`);
  const section = heading?.closest("[data-settings-group]");
  const sourceRow =
    target === "source-profile" && sourceProfileId
      ? ([
          ...(section?.querySelectorAll<HTMLElement>(".source-health-row[data-source-profile]") ??
            []),
        ].find((candidate) => candidate.dataset.sourceProfile === sourceProfileId) ??
        [
          ...(section?.querySelectorAll<HTMLElement>(".source-requirement[data-source-profile]") ??
            []),
        ].find((candidate) => candidate.dataset.sourceProfile === sourceProfileId))
      : undefined;
  const control =
    target === "source-profile"
      ? sourceRow?.querySelector<HTMLElement>(
          sourceRow.classList.contains("source-health-row")
            ? '[data-settings-control="relink-source"]:not(:disabled)'
            : "button:not(:disabled)",
        )
      : section?.querySelector<HTMLElement>(`[data-settings-control="${target}"]:not(:disabled)`);
  if (control) return focusAndReveal(control);
  const fallback = sourceRow ?? heading;
  if (!fallback) return;
  fallback.tabIndex = 0;
  focusAndReveal(fallback);
  fallback.addEventListener("blur", () => (fallback.tabIndex = -1), { once: true });
}
