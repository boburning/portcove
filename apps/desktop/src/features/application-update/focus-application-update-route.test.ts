// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { focusApplicationUpdateRoute } from "./focus-application-update-route";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("focuses update options, check, and activity at their own destinations", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const settings = document.createElement("article");
  settings.className = "application-update-settings";
  settings.innerHTML = `
    <h2 id="application-update-settings-title" tabindex="-1">Choose how Portcove updates</h2>
    <button>Preview</button>
    <section><h3 id="application-check-title" tabindex="-1">Check for application updates</h3><button>Check for updates</button></section>
    <section><h3 id="application-status-title" tabindex="-1">Update activity</h3><button>Refresh update status</button></section>`;
  document.body.append(settings);

  focusApplicationUpdateRoute("choice");
  expect(document.activeElement?.textContent).toBe("Preview");
  focusApplicationUpdateRoute("check");
  expect(document.activeElement?.id).toBe("application-check-title");
  expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
  focusApplicationUpdateRoute("status");
  expect(document.activeElement?.id).toBe("application-status-title");
  expect(settings.querySelector<HTMLElement>("#application-check-title")?.tabIndex).toBe(-1);
});
