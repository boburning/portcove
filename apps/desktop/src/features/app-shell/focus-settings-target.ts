import { focusAndReveal } from "../../focus";
import { scrollWorkspaceTo, workspaceScrollTop } from "../../workspace-scroll";
import type { SettingsCategory } from "./settings-categories";

export type ActivitySettingsTarget =
  | "source-profile"
  | "discover-sources"
  | "move-library"
  | "import-library"
  | "library-storage"
  | "application-updates"
  | "catalog-updates"
  | "diagnostics";
export type SettingsTarget = ActivitySettingsTarget | "add-game-file-root";

export function settingsCategoryForTarget(target: SettingsTarget): SettingsCategory {
  return target === "source-profile" ||
    target === "discover-sources" ||
    target === "add-game-file-root"
    ? "game-files"
    : target === "application-updates"
      ? "updates"
      : target === "catalog-updates" || target === "diagnostics"
        ? "advanced"
        : "library-storage";
}

export function focusSettingsTarget(target: SettingsTarget, sourceProfileId?: string) {
  const group = settingsCategoryForTarget(target);
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

export function revealSettingsHeading(targetId: string) {
  window.requestAnimationFrame(() => {
    const heading = document.getElementById(targetId);
    if (!heading || heading.closest("[hidden]")) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "nearest", inline: "nearest" });
    const navigation = heading
      .closest(".settings-grid")
      ?.querySelector<HTMLElement>(".settings-section-index");
    const workspace = heading.closest<HTMLElement>('[data-focus-region="workspace"]');
    if (!navigation || !workspace || getComputedStyle(navigation).position !== "sticky") return;
    const target = heading.getBoundingClientRect();
    const strip = navigation.getBoundingClientRect();
    // Wide category navigation sits beside the heading. Only a sticky strip
    // above the same reading column can cover its focus outline.
    if (target.left >= strip.right || target.right <= strip.left) return;
    const focusStyle = getComputedStyle(heading);
    const outlineRoom =
      Math.max(0, Number.parseFloat(focusStyle.outlineWidth)) +
      Math.max(0, Number.parseFloat(focusStyle.outlineOffset));
    const covered = strip.bottom + outlineRoom - target.top;
    if (covered > 0 && strip.top < target.bottom)
      scrollWorkspaceTo(workspace, workspaceScrollTop(workspace) - covered);
  });
}
