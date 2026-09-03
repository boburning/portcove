// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { CatalogStatus, CatalogUpdatePlan } from "../types";
import { CatalogSettings } from "./CatalogUpdates";

it("requires explicit review, invalidates changed candidates and uses core provenance after publication", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const status: CatalogStatus = { provenance: { origin: "embedded", catalog_sha256: "a".repeat(64), sequence: null, key_id: null, expires_at: null, fallback_reasons: [] }, trusted_keys: [{ key_id: "b".repeat(64), public_key: "c".repeat(64) }], highest_sequence: 0, updates_enabled: false, can_rollback: false, can_use_cached: false, state_sha256: "initial" };
  const plan: CatalogUpdatePlan = { source: { kind: "file", value: "D:/catalog.json" }, envelope_sha256: "d".repeat(64), key_id: "b".repeat(64), sequence: 1, issued_at: 1800000000, expires_at: 1800003600, changed_port_ids: ["example"], current: status.provenance, plan_sha256: "review" };
  vi.spyOn(desktopApi, "catalogStatus").mockResolvedValue(status);
  vi.spyOn(picker, "pickSignedCatalogPath").mockResolvedValue("D:/catalog.json");
  const review = vi.spyOn(desktopApi, "planCatalogUpdate").mockResolvedValue(plan);
  const apply = vi.spyOn(desktopApi, "applyCatalogUpdate").mockRejectedValueOnce({ code: "conflict", message: "Catalog changed; review again" })
    .mockResolvedValue({ ...status, highest_sequence: 1, updates_enabled: true, provenance: { ...status.provenance, origin: "signed_active", sequence: 1 } });
  const refresh = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!;
  const click = async (label: string) => { await act(async () => button(label).click()); };
  try {
    await act(async () => root.render(<CatalogSettings disabled={false} provenance={status.provenance} onChanged={refresh} />));
    expect(review).not.toHaveBeenCalled();
    await click("Manage catalog updates"); await click("Choose file");
    expect(apply).not.toHaveBeenCalled(); await click("Review update");
    expect(review).toHaveBeenCalledWith(plan.source);
    expect(host.textContent).toContain("Verified version 1");
    await click("Apply reviewed update");
    expect(apply).toHaveBeenCalledWith(plan.source, "review", expect.any(Function));
    expect(host.textContent).toContain("Catalog changed; review again");
    expect(button("Apply reviewed update")).toBeUndefined(); expect(refresh).not.toHaveBeenCalled();
    await click("Review update"); await click("Apply reviewed update");
    expect(refresh).toHaveBeenCalledOnce(); expect(host.textContent).toContain("Signed catalog · version 1");
    expect(button("Use built-in catalog").disabled).toBe(false);
    await click("Close"); expect(host.querySelector('[role="dialog"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
