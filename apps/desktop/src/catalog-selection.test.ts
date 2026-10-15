import { describe, expect, it } from "vite-plus/test";
import { portDefinition } from "./test-fixtures";
import { defaultPortPlatform, defaultReleaseChannel } from "./view-model";

describe("validated catalog selections", () => {
  it("uses the offered order without inventing a platform or channel", () => {
    const port = {
      ...portDefinition(),
      channels: ["rolling", "beta"] as const,
      platforms: ["linux-x86-64", "windows-x86-64"] as const,
    };
    expect(
      defaultReleaseChannel({
        ...port,
        channels: [...port.channels],
        platforms: [...port.platforms],
      }),
    ).toBe("rolling");
    expect(
      defaultPortPlatform({
        ...port,
        channels: [...port.channels],
        platforms: [...port.platforms],
      }),
    ).toBe("linux-x86-64");
  });
  it("rejects malformed empty catalog projections at the selection boundary", () => {
    expect(() => defaultReleaseChannel({ ...portDefinition(), channels: [] })).toThrow(
      "no release channels",
    );
    expect(() => defaultPortPlatform({ ...portDefinition(), platforms: [] })).toThrow(
      "no platforms",
    );
  });
});
