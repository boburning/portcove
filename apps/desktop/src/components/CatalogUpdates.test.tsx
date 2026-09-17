// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { CatalogStatus, CatalogUpdatePlan } from "../types";
import { CatalogSettings } from "./CatalogUpdates";

it("requires explicit review, invalidates changed candidates and uses core provenance after publication", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const status: CatalogStatus = {
    provenance: {
      origin: "embedded",
      catalog_sha256: "a".repeat(64),
      sequence: null,
      key_id: null,
      expires_at: null,
      fallback_reasons: [],
    },
    trusted_keys: [{ key_id: "b".repeat(64), public_key: "c".repeat(64) }],
    highest_sequence: 0,
    updates_enabled: false,
    can_rollback: false,
    can_use_cached: false,
    state_sha256: "initial",
  };
  const plan: CatalogUpdatePlan = {
    source: { kind: "file", value: "D:/catalog.json" },
    envelope_sha256: "d".repeat(64),
    key_id: "b".repeat(64),
    sequence: 1,
    issued_at: 1800000000,
    expires_at: 1800003600,
    changed_port_ids: ["example"],
    current: status.provenance,
    plan_sha256: "review",
  };
  vi.spyOn(desktopApi, "catalogStatus").mockResolvedValue(status);
  vi.spyOn(picker, "pickSignedCatalogPath").mockResolvedValue("D:/catalog.json");
  const review = vi.spyOn(desktopApi, "planCatalogUpdate").mockResolvedValue(plan);
  const apply = vi
    .spyOn(desktopApi, "applyCatalogUpdate")
    .mockRejectedValueOnce({
      code: "conflict",
      message: "Catalog changed; review again",
    })
    .mockResolvedValue({
      ...status,
      highest_sequence: 1,
      updates_enabled: true,
      provenance: {
        ...status.provenance,
        origin: "signed_active",
        sequence: 1,
      },
    });
  const refresh = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === label,
    )!;
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  try {
    await act(async () =>
      root.render(
        <CatalogSettings disabled={false} provenance={status.provenance} onChanged={refresh} />,
      ),
    );
    expect(review).not.toHaveBeenCalled();
    await click("Manage catalog updates");
    expect(host.textContent).toContain("Verify the publisher key through a trusted channel.");
    expect(button("Stop trusting")).toBeDefined();
    await click("Choose file");
    expect(apply).not.toHaveBeenCalled();
    await click("Review update");
    expect(review).toHaveBeenCalledWith(plan.source);
    expect(host.textContent).toContain("Catalog update ready");
    expect(host.textContent).toContain("Catalog signature valid");
    expect(host.textContent).toContain("Signed by");
    expect(host.textContent).toContain(plan.key_id);
    expect(host.textContent).toContain("Publisher trusted");
    expect(host.textContent).toContain("Sequence 1 accepted");
    expect(host.textContent).toContain("1 port will change.");
    const technical = host.querySelector(
      'summary[aria-label="Technical details for catalog update sequence 1"]',
    )?.parentElement;
    expect(technical?.textContent).toContain("example");
    expect(technical?.textContent).toContain(plan.envelope_sha256);
    await click("Apply catalog update");
    expect(apply).toHaveBeenCalledWith(plan.source, "review", expect.any(Function));
    expect(host.textContent).toContain("Catalog changed; review again");
    expect(button("Apply catalog update")).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    await click("Review update");
    await click("Apply catalog update");
    expect(refresh).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Signed catalog · version 1");
    expect(button("Use built-in catalog").disabled).toBe(false);
    await click("Close");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("keeps fallback diagnostics in distinct technical disclosures with safe summaries", () => {
  const reasons = [
    "catalog signing key is not trusted",
    "catalog sequence or validity interval is invalid, future-dated, or expired",
    "selected definition was not loaded: future internal diagnostic",
    "future opaque catalog diagnostic",
  ];
  const html = renderToStaticMarkup(
    <CatalogSettings
      disabled={false}
      provenance={{
        origin: "embedded",
        catalog_sha256: "a".repeat(64),
        sequence: null,
        key_id: null,
        expires_at: null,
        fallback_reasons: reasons,
      }}
    />,
  );
  expect(html).toContain("signed by a publisher that is no longer trusted");
  expect(html).toContain("expired or had invalid dates");
  expect(html).toContain("selected catalog definition could not be loaded");
  expect(html).toContain("A saved catalog could not be used");
  const host = document.createElement("div");
  host.innerHTML = html;
  const disclosures = [...host.querySelectorAll("details")];
  expect(disclosures).toHaveLength(reasons.length);
  for (const [index, reason] of reasons.entries()) {
    expect(html).toContain(
      `aria-label="Technical details for catalog fallback ${index + 1} of ${reasons.length}"`,
    );
    expect(disclosures[index].textContent).toContain(reason);
  }
  for (const disclosure of disclosures) disclosure.remove();
  for (const reason of reasons) expect(host.textContent).not.toContain(reason);
  expect(html).not.toContain("Update unavailable:");
});
