// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { SourceDiscoveryReport, SourceProfile } from "../types";
import { SourceDiscoveryButton } from "./SourceDiscovery";

it("requires explicit scope and acceptance, and sends the discovered content digest", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const profile: SourceProfile = { id: "test", label: "Owned game source", kind: "file", accepted_extensions: ["z64"], accepted_sha1: [], accepted_sha256: ["a".repeat(64)], members: [] };
  const candidate = { profile_id: profile.id, path: "D:/Selected/game.z64", sha256: "a".repeat(64), size: 64, storage_sha256: "a".repeat(64), storage_size: 64, updated_at: 1 };
  const report: SourceDiscoveryReport = { searched_roots: ["D:/Selected"], searched_profiles: [profile.id], candidates: [candidate], entries_examined: 3, files_hashed: 1, hash_bytes: 64, symlinks_skipped: 0, limits_reached: [], issues: [], issues_omitted: 0 };
  vi.spyOn(picker, "pickInstallFolder").mockResolvedValue("D:/Selected");
  const search = vi.spyOn(desktopApi, "discoverSources").mockResolvedValue(report);
  const register = vi.spyOn(desktopApi, "addSource").mockRejectedValueOnce({ message: "Source changed after discovery" }).mockResolvedValue(candidate);
  const refresh = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const control = (label: string) => {
    const result = [...host.querySelectorAll<HTMLButtonElement>("button"), ...document.querySelectorAll<HTMLButtonElement>(".choice-menu button")].find(button => button.textContent?.includes(label));
    if (!result) throw new Error(`Missing ${label}`);
    return result;
  };
  const click = async (label: string) => { await act(async () => control(label).click()); };
  try {
    await act(async () => root.render(<SourceDiscoveryButton profiles={[profile]} disabled={false} onAdded={refresh} />));
    await click("Find source files"); expect(control("Search this folder").disabled).toBe(true);
    await click("Choose folder"); expect(search).not.toHaveBeenCalled();
    await click("Source profile"); await click("Owned game source");
    expect(search).not.toHaveBeenCalled(); await click("Search this folder");
    expect(search).toHaveBeenCalledWith({ roots: ["D:/Selected"], profile_ids: ["test"] });
    expect(register).not.toHaveBeenCalled(); await click("Use this file");
    expect(register).toHaveBeenCalledWith("test", candidate.path, candidate.sha256);
    expect(host.textContent).toContain("Source changed after discovery"); expect(refresh).not.toHaveBeenCalled();
    await click("Use this file"); expect(refresh).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Source registered"); expect(control("Registered").disabled).toBe(true);
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
