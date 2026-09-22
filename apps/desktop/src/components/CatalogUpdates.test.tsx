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
    trusted_keys: [
      {
        key_id: "21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9",
        public_key: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      },
    ],
    highest_sequence: 0,
    updates_enabled: false,
    can_rollback: false,
    can_use_cached: false,
    state_sha256: "e".repeat(64),
  };
  const plan: CatalogUpdatePlan = {
    source: { kind: "file", value: "D:/catalog.json" },
    envelope_sha256: "d".repeat(64),
    key_id: status.trusted_keys[0].key_id,
    sequence: 1,
    issued_at: 1789620000,
    expires_at: 1789706400,
    changed_port_ids: ["shipwright"],
    current: status.provenance,
    plan_sha256: "fe5c62deb351405b326acc1ccada7931fd11f224e8c4849c7731d3891be15947",
  };
  const zeroChangePlan: CatalogUpdatePlan = {
    ...plan,
    envelope_sha256: "e".repeat(64),
    changed_port_ids: [],
    plan_sha256: "1437af5c9a99b06c3e1c634f9f564874ca1f820a58f96b3f46e896d946c750ab",
  };
  const manyChangePlan: CatalogUpdatePlan = {
    ...plan,
    envelope_sha256: "f".repeat(64),
    changed_port_ids: ["shipwright", "2ship2harkinian"],
    plan_sha256: "6eb79ca92dacff3ee56468a26c5675d4c5415f0a5eb8ce70b56baac32b5b8d22",
  };
  vi.spyOn(desktopApi, "catalogStatus").mockResolvedValue(status);
  vi.spyOn(picker, "pickSignedCatalogPath").mockResolvedValue("D:/catalog.json");
  const review = vi
    .spyOn(desktopApi, "planCatalogUpdate")
    .mockResolvedValueOnce(plan)
    .mockResolvedValueOnce(zeroChangePlan)
    .mockResolvedValueOnce(manyChangePlan)
    .mockResolvedValue(plan);
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
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(label),
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
    expect(document.body.textContent).toContain(
      "Verify the publisher key through a trusted channel.",
    );
    expect(button("Stop trusting")).toBeDefined();
    expect(document.body.querySelector("#catalog-public-key")?.className).toContain(
      "border-pc-input",
    );
    expect(document.body.querySelector('label[for="catalog-public-key"]')?.className).toContain(
      "text-pc-muted-foreground",
    );
    await click("Update source");
    const openPopup = document.body.querySelector<HTMLElement>(
      '[data-slot="select-content"][data-open]',
    );
    expect(openPopup).not.toBeNull();
    await act(async () => {
      openPopup?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[aria-labelledby="catalog-update-title"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.body.querySelector("#catalog-update-source"));
    await click("Choose file");
    expect(apply).not.toHaveBeenCalled();
    await click("Review update");
    expect(review).toHaveBeenCalledWith(plan.source);
    expect(document.body.textContent).toContain("Catalog update ready");
    expect(document.body.textContent).toContain("Catalog signature valid");
    expect(document.body.textContent).toContain("Signed by");
    expect(document.body.textContent).toContain(plan.key_id);
    expect(document.body.textContent).toContain("Publisher trusted");
    expect(document.body.textContent).toContain("Sequence 1 accepted");
    expect(document.body.textContent).toContain(
      `Valid until ${new Date(plan.expires_at * 1000).toLocaleString()}.`,
    );
    expect(document.body.textContent).toContain("1 port will change.");
    const technical = document.body.querySelector(
      'summary[aria-label="Technical details for catalog update sequence 1"]',
    )?.parentElement;
    expect(technical?.textContent).toContain("shipwright");
    expect(technical?.textContent).toContain(plan.envelope_sha256);
    await click("Review update");
    expect(document.body.textContent).toContain("No port information will change.");
    await click("Review update");
    expect(document.body.textContent).toContain("2 ports will change.");
    await click("Review update");
    expect(document.body.textContent).toContain("1 port will change.");
    await click("Apply catalog update");
    expect(apply).toHaveBeenCalledWith(plan.source, plan.plan_sha256, expect.any(Function));
    expect(document.body.textContent).toContain("Catalog changed; review again");
    expect(button("Apply catalog update")).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    await click("Review update");
    await click("Apply catalog update");
    expect(refresh).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Signed catalog · version 1");
    expect(button("Use built-in catalog").disabled).toBe(false);
    await click("Close");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
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
    "future cache lease expired during recovery",
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
  expect(disclosures[3].parentElement?.querySelector("p")?.textContent).toBe(
    "A saved catalog could not be used. Portcove continued with the available catalog information.",
  );
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
