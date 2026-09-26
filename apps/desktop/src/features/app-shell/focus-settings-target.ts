import { focusAndReveal } from "../../focus";

export type ActivitySettingsTarget =
  | "source-profile"
  | "discover-sources"
  | "move-library"
  | "import-library"
  | "library-storage"
  | "catalog-updates";
export type SettingsTarget = ActivitySettingsTarget | "add-game-file-root";

export function focusSettingsTarget(target: SettingsTarget, sourceProfileId?: string) {
  const group =
    target === "source-profile" || target === "discover-sources" || target === "add-game-file-root"
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
  if (target === "add-game-file-root") {
    const addButton = section?.querySelector<HTMLButtonElement>(
      '[data-settings-control="add-game-file-root"]',
    );
    if (!addButton?.disabled) return;
    const observer = new MutationObserver(() => {
      if (addButton.disabled || document.activeElement !== fallback || !addButton.isConnected)
        return;
      observer.disconnect();
      window.clearTimeout(expiry);
      focusAndReveal(addButton);
    });
    const expiry = window.setTimeout(() => observer.disconnect(), 5000);
    observer.observe(addButton, { attributes: true, attributeFilter: ["disabled"] });
  }
}
