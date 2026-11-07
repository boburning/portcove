import { describe, expect, it } from "vite-plus/test";
import { upstreamUpdatesDestination } from "./upstream-links";

describe("general upstream navigation", () => {
  it.each([
    [
      "https://github.com/CorsixTH/CorsixTH",
      "https://github.com/CorsixTH/CorsixTH/releases/tag/v0.70.1",
      "https://github.com/CorsixTH/CorsixTH/releases",
    ],
    [
      "https://example.org/game",
      "https://github.com/owner/game/releases/tag/v2",
      "https://github.com/owner/game/releases",
    ],
    [
      "https://gitlab.com/group/subgroup/game",
      "https://gitlab.com/group/subgroup/game/-/releases/v2",
      "https://gitlab.com/group/subgroup/game/-/releases",
    ],
    ["https://github.com/owner/game.git", null, "https://github.com/owner/game/releases"],
  ])("derives stable provider navigation from %s", (project, release, expected) => {
    expect(upstreamUpdatesDestination(project, release)).toEqual({ url: expected, releases: true });
  });

  it("keeps historical custom links out of general updates and labels the project fallback", () => {
    expect(
      upstreamUpdatesDestination("https://example.org/game", "https://example.org/notes/v1"),
    ).toEqual({
      url: "https://example.org/game",
      releases: false,
    });
  });

  it.each([
    "https://github.com.evil.example/owner/game/releases/tag/v2",
    "https://player:secret@github.com/owner/game/releases/tag/v2",
    "https://github.com:8443/owner/game/releases/tag/v2",
    "http://github.com/owner/game/releases/tag/v2",
    "https://github.com/owner/game/blob/main/README.md",
    "https://gitlab.com/group/game/-/blob/main/README.md",
    "https://gitlab.com/group/%2e%2e/game/-/releases/v2",
    "javascript:alert(1)",
    " https://github.com/owner/game",
    "https://github.com/owner/game\n",
    `https://github.com/owner/game/releases?note=${"x".repeat(4096)}`,
    `https://github.com/owner/game/releases?note=${"🎮".repeat(2000)}`,
    "https://github.com/owner/game/releases/\u0085",
  ])("does not reinterpret an unrelated or unsafe URL as provider identity: %s", (release) => {
    expect(upstreamUpdatesDestination("https://example.org/game", release)).toEqual({
      url: "https://example.org/game",
      releases: false,
    });
  });
});
