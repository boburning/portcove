import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import type { GameUpdatePlan } from "../types";
import { UpdateReleaseNotes } from "./UpdateReleaseNotes";
import "../styles/index.css";

type Notes = NonNullable<GameUpdatePlan["release_notes"]>;

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

const notes: Notes = {
  releases_url: "https://github.com/owner/repo/releases",
  complete: true,
  entries: [
    {
      version: "v3",
      title: "Audio fixes",
      published_at: "2026-11-01T00:00:00Z",
      url: "https://github.com/owner/repo/releases/tag/v3",
      notes:
        '## Fixed\n- Audio <img src=x onerror="window.injected=1"><script>window.injected=2</script>\n- [link](javascript:alert(1))',
      notes_truncated: true,
    },
    {
      version: "v2",
      url: "https://github.com/owner/repo/releases/tag/v2",
      notes: "",
      notes_truncated: false,
    },
  ],
};

function links() {
  return [...container.querySelectorAll("a")].map((link) => [
    link.textContent,
    link.getAttribute("href"),
  ]);
}

it("shows every listed release as inert plain text with only Core-built links", async () => {
  const open = vi.spyOn(desktopApi, "openExternalUrl").mockResolvedValue();
  await root.rerender(<UpdateReleaseNotes notes={notes} currentVersion="v1" />);
  const section = container.querySelector("[data-update-release-notes]");
  expect(section?.querySelector("h3")?.textContent).toBe("What’s new since v1");
  expect(section?.querySelector("img, script")).toBeNull();
  expect((window as { injected?: number }).injected).toBeUndefined();
  expect(section?.textContent).toContain('<img src=x onerror="window.injected=1">');
  expect(section?.textContent).toContain("Audio fixes");
  expect(section?.textContent).toContain("These notes are shortened.");
  expect(section?.textContent).toContain("No notes were published for this release.");
  expect(section?.textContent).not.toContain("may not include every release");
  const region = section?.querySelector('[role="region"]');
  expect(region?.getAttribute("aria-labelledby")).toBe(section?.querySelector("h3")?.id);
  expect(links()).toEqual([
    ["Full notes for v3", "https://github.com/owner/repo/releases/tag/v3"],
    ["v2 release page", "https://github.com/owner/repo/releases/tag/v2"],
    ["All release notes", "https://github.com/owner/repo/releases"],
  ]);
  await act(async () => container.querySelector("a")?.click());
  expect(open).toHaveBeenCalledWith("https://github.com/owner/repo/releases/tag/v3");
});

it("says when the list may be incomplete", async () => {
  await root.rerender(<UpdateReleaseNotes notes={{ ...notes, complete: false }} />);
  expect(container.querySelector("h3")?.textContent).toBe("What’s new");
  expect(container.textContent).toContain(
    "This list may not include every release since your version.",
  );
});

it("falls back to the release page when Portcove has no notes", async () => {
  await root.rerender(
    <UpdateReleaseNotes notes={{ ...notes, entries: [], complete: false }} currentVersion="v1" />,
  );
  expect(container.querySelector('[role="region"]')).toBeNull();
  expect(container.textContent).toContain(
    "Portcove doesn’t have the release notes for this update.",
  );
  expect(links()).toEqual([["Release notes", "https://github.com/owner/repo/releases"]]);
});
