import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { libraryBrowsingKey } from "../app-shell/use-library-browsing-context";
import { readDownloadChoice, writeDownloadChoice, type DownloadChoice } from "./download-choice";

describe("saved download choices", () => {
  const root = "/owned/library";
  const id = "game";
  const upstream = "https://gitlab.com/owner/game/-/releases";
  const oldKey = `portcove.download-choice.v1:${libraryBrowsingKey(root)}:${id}`;
  const newKey = `portcove.download-choice.v2:${libraryBrowsingKey(root)}:${id}`;
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const legacy: DownloadChoice = {
    channel: "stable",
    release: 7,
    package: "7:11",
    destination: "/owned/games",
    extract: true,
  };
  it("reads legacy GitHub choices and preserves their bytes when writing the new format", () => {
    const bytes = JSON.stringify({ upstream, choice: legacy });
    storage.set(oldKey, bytes);
    expect(readDownloadChoice(root, id, upstream).choice).toEqual(legacy);
    expect(writeDownloadChoice(root, id, upstream, legacy)).toBeUndefined();
    expect(storage.get(oldKey)).toBe(bytes);
    expect(JSON.parse(storage.get(newKey)!)).toEqual({
      format_version: 2,
      upstream,
      choice: legacy,
    });
  });

  it("roundtrips foreign identities without coercion and requires fresh selection after malformed new data", () => {
    const choice: DownloadChoice = {
      ...legacy,
      release: { provider: "gitlab", project_id: 42, tag: "v1" },
      package: 'gitlab:[42,"v1",11,17]',
    };
    writeDownloadChoice(root, id, upstream, choice);
    expect(readDownloadChoice(root, id, upstream).choice).toEqual(choice);
    expect(readDownloadChoice(root, id, "https://gitlab.com/other/project")).toEqual({});
    storage.set(oldKey, JSON.stringify({ upstream, choice: legacy }));
    for (const invalid of [
      { upstream, choice },
      { format_version: 3, upstream, choice },
      { format_version: 2, upstream, choice: { ...choice, channel: ["stable"] } },
      {
        format_version: 2,
        upstream,
        choice: { ...choice, release: { ...(choice.release as object), project_id: "42" } },
      },
      {
        format_version: 2,
        upstream,
        choice: { ...choice, package: "[object Object]:[object Object]" },
      },
    ]) {
      storage.set(newKey, JSON.stringify(invalid));
      const result = readDownloadChoice(root, id, upstream);
      expect(result.choice).toBeUndefined();
      expect(result.warning).toBeTruthy();
    }
  });
});
