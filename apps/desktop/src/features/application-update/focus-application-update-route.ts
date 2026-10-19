import { focusAndReveal } from "../../focus";

export type ApplicationUpdateRoute = "choice" | "check" | "status";

export function focusApplicationUpdateRoute(route: ApplicationUpdateRoute) {
  const settings = document.querySelector<HTMLElement>(".application-update-settings");
  const heading =
    route === "choice"
      ? (settings?.querySelector<HTMLElement>("#application-preferences-title") ??
        settings?.querySelector<HTMLElement>("#application-update-settings-title"))
      : settings?.querySelector<HTMLElement>(
          route === "check" ? "#application-check-title" : "#application-status-title",
        );
  if (!heading) return;
  const control =
    route === "choice"
      ? settings?.querySelector<HTMLElement>(
          '[aria-label="Application update channel"] button:not(:disabled)',
        )
      : undefined;
  if (control) return focusAndReveal(control);
  heading.tabIndex = 0;
  focusAndReveal(heading);
  heading.addEventListener("blur", () => (heading.tabIndex = -1), { once: true });
}
