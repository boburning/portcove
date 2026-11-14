import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { focusableControls } from "../focus";
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
  coverage: "complete",
  entries: [
    {
      version: "v3",
      title: "Audio fixes",
      published_at: "2026-11-01T00:00:00Z",
      notes:
        '## Fixed\n- Audio <img src=x onerror="window.injected=1"><script>window.injected=2</script>\n- [link](javascript:alert(1))',
      notes_truncated: true,
    },
    {
      version: "v2",
      published_at: "not a date",
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

it("shows every listed release as inert plain text with only the release list link", async () => {
  const open = vi.spyOn(desktopApi, "openExternalUrl").mockResolvedValue();
  await root.rerender(<UpdateReleaseNotes notes={notes} currentVersion="v1" />);
  const section = container.querySelector("[data-update-release-notes]");
  expect(section?.querySelector("h3")?.textContent).toBe("What’s new since v1");
  expect(section?.querySelector("img, script")).toBeNull();
  expect((window as { injected?: number }).injected).toBeUndefined();
  expect(section?.textContent).toContain('<img src=x onerror="window.injected=1">');
  expect(section?.textContent).toContain("Audio fixes");
  expect(section?.textContent).toContain("· Published ");
  expect(section?.textContent).not.toContain("not a date");
  expect(section?.textContent).toContain(
    "These notes are shortened. The full notes are on the project’s release page.",
  );
  expect(section?.textContent).toContain("No notes were published for this release.");
  expect(section?.textContent).not.toContain("may not include");
  // One labelled landmark; the scrolling list is not a second one.
  expect(section?.querySelectorAll('[role="region"]')).toHaveLength(0);
  // Keyboard and controller navigation can reach the scrolling notes.
  const list = section?.querySelector<HTMLElement>("[data-update-release-notes-list]");
  expect(list?.getAttribute("aria-labelledby")).toBe(section?.querySelector("h3")?.id);
  expect(focusableControls(document)).toContain(list);
  expect(links()).toEqual([["All release notes", "https://github.com/owner/repo/releases"]]);
  await act(async () => container.querySelector("a")?.click());
  expect(open).toHaveBeenCalledWith("https://github.com/owner/repo/releases");
});

it.each([
  ["shortened", "Only the newest 2 releases are shown."],
  ["installed_not_listed", "Portcove couldn’t find your version in the project’s release list"],
  ["rolling_release", "This release is updated in place, so only its current notes are shown."],
] as const)("explains %s coverage", async (coverage, text) => {
  await root.rerender(<UpdateReleaseNotes notes={{ ...notes, coverage }} />);
  expect(container.querySelector("h3")?.textContent).toBe("What’s new");
  expect(container.textContent).toContain(text);
});

it("shows only the offered release when the installed version is newer", async () => {
  await root.rerender(
    <UpdateReleaseNotes
      notes={{ ...notes, coverage: "installed_newer", entries: [notes.entries[1]!] }}
      currentVersion="v9"
    />,
  );
  expect(container.querySelector("h3")?.textContent).toBe("Release notes for v2");
  expect(container.textContent).toContain(
    "The version you’re using is newer than this update, so only this release’s notes are shown.",
  );
});

it("offers no link when Portcove may not open the release list", async () => {
  const { releases_url: _omitted, ...withoutLink } = notes;
  await root.rerender(<UpdateReleaseNotes notes={withoutLink} currentVersion="v1" />);
  expect(links()).toEqual([]);
  expect(container.textContent).toContain("These notes are shortened.");
  expect(container.textContent).not.toContain("The full notes are on");
  await root.rerender(
    <UpdateReleaseNotes notes={{ ...withoutLink, coverage: "shortened" }} currentVersion="v1" />,
  );
  expect(container.textContent).toContain("Earlier changes since your version aren’t listed here.");
  expect(container.textContent).not.toContain("release page");
});

it("falls back to the release page when Portcove has no notes", async () => {
  await root.rerender(
    <UpdateReleaseNotes
      notes={{ ...notes, entries: [], coverage: "unavailable" }}
      currentVersion="v1"
    />,
  );
  expect(container.querySelector("[data-update-release-notes-list]")).toBeNull();
  expect(container.textContent).toContain(
    "Portcove doesn’t have the release notes for this update.",
  );
  expect(links()).toEqual([["All release notes", "https://github.com/owner/repo/releases"]]);
});
