import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { ExternalLink } from "./ExternalLink";

let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
});

it("reports a failed browser launch with the exact failure text in the current language", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  // A failure that looks like markup or interpolation must render verbatim.
  vi.spyOn(desktopApi, "openExternalUrl").mockRejectedValue(new Error("no handler {{x}} <b>"));
  await act(async () => {
    await root.rerender(<ExternalLink href="https://example.invalid">Project page</ExternalLink>);
  });
  await act(async () => container.querySelector("a")?.click());
  const alert = () => container.querySelector('[role="alert"]');
  await expect
    .poll(() => alert()?.textContent)
    .toBe("Couldn’t open the browser: no handler {{x}} <b>");
  try {
    await act(async () => {
      await localization.changeLanguage("ar-XB");
    });
    await expect.poll(() => alert()?.textContent).toBe("تعذر فتح المتصفح: no handler {{x}} <b>");
    expect(alert()?.querySelector("bdi")?.textContent).toBe("no handler {{x}} <b>");
  } finally {
    await act(async () => {
      await localization.changeLanguage("en");
    });
  }
});
