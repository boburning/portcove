import { focusAndReveal } from "../../focus";

/** Moves focus to the available update in Settings, or to the section heading. */
export function focusApplicationUpdate() {
  const settings = document.querySelector<HTMLElement>(".application-update-settings");
  const heading =
    settings?.querySelector<HTMLElement>("#application-update-available-title") ??
    settings?.querySelector<HTMLElement>("#application-update-settings-title");
  if (!heading) return;
  heading.tabIndex = 0;
  focusAndReveal(heading);
  heading.addEventListener("blur", () => (heading.tabIndex = -1), { once: true });
}
