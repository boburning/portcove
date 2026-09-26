import { focusAndReveal } from "../../focus";

export type ApplicationUpdateRoute = "choice" | "check" | "status";

export function focusApplicationUpdateRoute(route: ApplicationUpdateRoute) {
  const settings = document.querySelector<HTMLElement>(".application-update-settings");
  const heading = settings?.querySelector<HTMLElement>(
    route === "choice"
      ? "#application-update-settings-title"
      : route === "check"
        ? "#application-check-title"
        : "#application-status-title",
  );
  if (!heading) return;
  const control =
    route === "choice"
      ? settings?.querySelector<HTMLElement>("button:not(:disabled), a[href]")
      : undefined;
  if (control) return focusAndReveal(control);
  heading.tabIndex = 0;
  focusAndReveal(heading);
  heading.addEventListener("blur", () => (heading.tabIndex = -1), { once: true });
}
