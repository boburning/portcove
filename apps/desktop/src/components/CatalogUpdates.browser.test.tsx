import { captureParityState as captureRenderedState } from "../../test/parity-capture";
import { prepareCaptureTarget } from "../../test/capture-target";
import { observeVisibleTarget } from "../../scripts/browser-readiness.mts";
import { fixtureValue } from "../test-fixtures";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { CatalogStatus, CatalogUpdatePlan, CatalogProvenance, DoctorReport } from "../types";
import { CatalogOrigin, CatalogSettings } from "./CatalogUpdates";
import { SettingsView } from "./Chrome";

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
    key_id: fixtureValue(status.trusted_keys[0], "status.trusted_keys[0]").key_id,
    sequence: 1,
    issued_at: 1789620000,
    expires_at: 1789706400,
    changed_port_ids: ["shipwright"],
    changed_ports: [{ id: "shipwright", name: "Ship of Harkinian" }],
    current: status.provenance,
    plan_sha256: "fe5c62deb351405b326acc1ccada7931fd11f224e8c4849c7731d3891be15947",
  };
  const zeroChangePlan: CatalogUpdatePlan = {
    ...plan,
    envelope_sha256: "e".repeat(64),
    sequence: 2,
    changed_port_ids: [],
    changed_ports: [],
    plan_sha256: "1437af5c9a99b06c3e1c634f9f564874ca1f820a58f96b3f46e896d946c750ab",
  };
  const manyChangePlan: CatalogUpdatePlan = {
    ...plan,
    envelope_sha256: "f".repeat(64),
    changed_port_ids: ["shipwright", "2ship2harkinian"],
    changed_ports: [
      { id: "shipwright", name: "Ship of Harkinian" },
      { id: "2ship2harkinian", name: "2Ship2Harkinian" },
    ],
    plan_sha256: "6eb79ca92dacff3ee56468a26c5675d4c5415f0a5eb8ce70b56baac32b5b8d22",
  };
  vi.spyOn(desktopApi, "catalogStatus").mockResolvedValue(status);
  vi.mocked(picker.pickSignedCatalogPath).mockResolvedValue("D:/catalog.json");
  const review = vi
    .spyOn(desktopApi, "planCatalogUpdate")
    .mockResolvedValueOnce(plan)
    .mockRejectedValueOnce({ code: "conflict", message: "Catalog source changed" })
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
      can_rollback: true,
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
    await act(async () => userEvent.click(button(label)));
  };
  try {
    await act(async () =>
      root.render(
        <CatalogSettings disabled={false} provenance={status.provenance} onChanged={refresh} />,
      ),
    );
    expect(review).not.toHaveBeenCalled();
    await click("Manage catalog updates");
    await expect.poll(() => document.activeElement?.id).toBe("catalog-update-title");
    expect(document.body.textContent).toContain(
      "Verify the publisher key through a trusted channel.",
    );
    expect(button("Stop trusting")).toBeDefined();
    expect(document.body.querySelector<HTMLElement>("#catalog-public-key")?.dataset.slot).toBe(
      "input",
    );
    expect(document.body.querySelector<HTMLElement>("#catalog-update-location")?.dataset.slot).toBe(
      "input",
    );
    expect(document.body.querySelector("#catalog-public-key")?.className).toContain(
      "border-pc-input",
    );
    expect(document.body.querySelector('label[for="catalog-public-key"]')?.className).toContain(
      "text-pc-muted-foreground",
    );
    await page.getByRole("combobox", { name: /^Update source/ }).click();
    const openPopup = document.body.querySelector<HTMLElement>(
      '[data-slot="select-content"][data-open]',
    );
    expect(openPopup).not.toBeNull();
    await expect
      .poll(() => document.activeElement?.closest('[data-slot="select-content"]'))
      .toBe(openPopup);
    await act(async () => userEvent.keyboard("{Escape}"));
    expect(document.body.querySelector('[aria-labelledby="catalog-update-title"]')).not.toBeNull();
    await expect
      .poll(() => document.activeElement)
      .toBe(document.body.querySelector("#catalog-update-source"));
    await click("Choose file");
    expect(apply).not.toHaveBeenCalled();
    await click("Review update");
    expect(review).toHaveBeenCalledWith(plan.source);
    expect(document.body.textContent).toContain("Review catalog information");
    expect(document.body.textContent).toContain("Signature verified with a trusted publisher key.");
    expect(document.body.textContent).toContain("Catalog information will change for 1 port.");
    expect(document.body.textContent).toContain("This does not install game updates.");
    expect(document.body.textContent).toContain(
      "Trusting a publisher allows changes to release download locations.",
    );
    expect(document.body.querySelector('[aria-label="Affected ports"]')?.textContent).toBe(
      "Ship of Harkinian",
    );
    const technical = document.body.querySelector(
      'summary[aria-label="Technical details for catalog update sequence 1"]',
    )?.parentElement;
    expect(technical?.textContent).toContain("shipwright");
    expect(technical?.textContent).toContain(plan.key_id);
    expect(technical?.textContent).toContain("1 accepted");
    expect(technical?.textContent).toContain(new Date(plan.expires_at * 1000).toLocaleString());
    expect(technical?.textContent).toContain(plan.envelope_sha256);
    const publisherSection = document.querySelector(".catalog-publisher-trust")!;
    const sourceReview = document.querySelector(".catalog-update-source-review")!;
    expect(
      sourceReview.getBoundingClientRect().top - publisherSection.getBoundingClientRect().bottom,
    ).toBeGreaterThanOrEqual(23);
    for (const group of [
      publisherSection,
      sourceReview,
      document.querySelector('[aria-label="Catalog update review"]')!,
    ]) {
      const children = Array.from(group.children);
      for (let index = 1; index < children.length; index++) {
        expect(
          children[index]!.getBoundingClientRect().top -
            children[index - 1]!.getBoundingClientRect().bottom,
        ).toBeGreaterThanOrEqual(11);
      }
    }
    await captureRenderedState("catalog-trust-reviewed-fixture");
    await click("Review update");
    expect(document.body.textContent).toContain("Catalog source changed");
    expect(button("Apply catalog update")).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    await click("Review update");
    expect(document.body.textContent).toContain("No port information will change.");
    expect(document.body.querySelector('[aria-label="Affected ports"]')).toBeNull();
    expect(
      document.body.querySelector(
        'summary[aria-label="Technical details for catalog update sequence 2"]',
      )?.parentElement?.textContent,
    ).toContain("2 accepted");
    await click("Review update");
    expect(document.body.textContent).toContain("Catalog information will change for 2 ports.");
    expect(document.body.querySelector('[aria-label="Affected ports"]')?.textContent).toBe(
      "Ship of Harkinian2Ship2Harkinian",
    );
    await click("Review update");
    expect(document.body.textContent).toContain("Catalog information will change for 1 port.");
    await click("Apply catalog update");
    expect(apply).toHaveBeenCalledWith(plan.source, plan.plan_sha256, expect.any(Function));
    expect(document.body.textContent).toContain("Catalog changed; review again");
    await captureRenderedState("catalog-update-stale-plan-fixture");
    expect(button("Apply catalog update")).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    await click("Review update");
    await click("Apply catalog update");
    expect(refresh).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Catalog update applied.");
    expect(document.body.textContent).toContain("Signed catalog · version 1");
    expect(button("Use built-in catalog").disabled).toBe(false);
    const restored = { ...status, highest_sequence: 1, can_use_cached: true };
    const rollback = vi.spyOn(desktopApi, "rollbackCatalog").mockResolvedValue(restored);
    await click("Restore previous catalog");
    expect(rollback).toHaveBeenCalledWith(status.state_sha256);
    expect(document.body.textContent).toContain("Previous catalog restored.");
    const cached = vi
      .spyOn(desktopApi, "useCachedCatalog")
      .mockResolvedValue({ ...restored, updates_enabled: true });
    await click("Use cached signed catalog");
    expect(cached).toHaveBeenCalledWith(status.state_sha256);
    expect(document.body.textContent).toContain("Cached signed catalog selected.");
    const embedded = vi.spyOn(desktopApi, "useEmbeddedCatalog").mockResolvedValue(restored);
    await click("Use built-in catalog");
    expect(embedded).toHaveBeenCalledWith(status.state_sha256);
    expect(document.body.textContent).toContain("Built-in catalog selected.");
    const revoked = { ...restored, trusted_keys: [], state_sha256: "b".repeat(64) };
    const revoke = vi
      .spyOn(desktopApi, "revokeCatalogKey")
      .mockRejectedValueOnce({ code: "cancelled", message: "Consent cancelled" })
      .mockResolvedValue(revoked);
    await click("Stop trusting");
    expect(document.body.textContent).toContain("Catalog action cancelled.");
    expect(document.body.textContent).not.toContain("Publisher trust removed.");
    expect(document.body.textContent).not.toContain("Catalog settings saved.");
    await click("Stop trusting");
    expect(revoke).toHaveBeenLastCalledWith(
      fixtureValue(status.trusted_keys[0], "status.trusted_keys[0]").key_id,
      status.state_sha256,
    );
    expect(document.body.textContent).toContain("Publisher trust removed.");
    const sourceField = document.body.querySelector<HTMLInputElement>("#catalog-update-location")!;
    const sourceMode = document.body.querySelector<HTMLElement>("#catalog-update-source")!;
    expect(sourceField.value).toBe(plan.source.value);
    const sourceModeBefore = sourceMode.textContent;
    expect(sourceModeBefore).toContain("Local file");
    const refreshCount = refresh.mock.calls.length;
    const applyCount = apply.mock.calls.length;
    review.mockRejectedValueOnce({
      code: "integrity",
      message: "Catalog signing key is not trusted",
    });
    await click("Review update");
    expect(review).toHaveBeenLastCalledWith(plan.source);
    expect(button("Apply catalog update")).toBeUndefined();
    const trust = vi
      .spyOn(desktopApi, "trustCatalogKey")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...restored, state_sha256: "c".repeat(64) });
    const key = document.body.querySelector<HTMLInputElement>("#catalog-public-key")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        key,
        fixtureValue(status.trusted_keys[0], "status.trusted_keys[0]").public_key,
      );
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const verificationCount = review.mock.calls.length;
    await click("Trust publisher");
    expect(document.body.textContent).toContain("Catalog action cancelled.");
    expect(page.getByRole("dialog").element().textContent).toContain("Built-in catalog");
    expect(sourceField.value).toBe(plan.source.value);
    expect(sourceMode.textContent).toBe(sourceModeBefore);
    expect(refresh).toHaveBeenCalledTimes(refreshCount);
    expect(review).toHaveBeenCalledTimes(verificationCount);
    expect(apply).toHaveBeenCalledTimes(applyCount);
    expect(button("Apply catalog update")).toBeUndefined();

    await click("Trust publisher");
    expect(trust).toHaveBeenLastCalledWith(
      fixtureValue(status.trusted_keys[0], "status.trusted_keys[0]").public_key,
    );
    expect(document.body.textContent).toContain("Publisher trusted.");
    expect(sourceField.value).toBe(plan.source.value);
    expect(sourceMode.textContent).toBe(sourceModeBefore);
    expect(refresh).toHaveBeenCalledTimes(refreshCount + 1);
    expect(review).toHaveBeenCalledTimes(verificationCount);
    expect(button("Apply catalog update")).toBeUndefined();
    expect(apply).toHaveBeenCalledTimes(applyCount);

    // A publisher can update the envelope at the same location. The first
    // publication's sequence remains consumed after returning to the built-in catalog.
    const verifiedAfterTrust = {
      ...zeroChangePlan,
      current: status.provenance,
      plan_sha256: "c".repeat(64),
    };
    review.mockResolvedValueOnce(verifiedAfterTrust);
    apply.mockResolvedValueOnce({
      ...restored,
      highest_sequence: verifiedAfterTrust.sequence,
      state_sha256: "d".repeat(64),
      updates_enabled: true,
      provenance: {
        ...status.provenance,
        origin: "signed_active",
        sequence: verifiedAfterTrust.sequence,
        expires_at: verifiedAfterTrust.expires_at,
        key_id: verifiedAfterTrust.key_id,
      },
    });
    await click("Review update");
    expect(review).toHaveBeenLastCalledWith(plan.source);
    expect(review).toHaveBeenCalledTimes(verificationCount + 1);
    expect(apply).toHaveBeenCalledTimes(applyCount);
    await click("Apply catalog update");
    expect(apply).toHaveBeenLastCalledWith(
      verifiedAfterTrust.source,
      verifiedAfterTrust.plan_sha256,
      expect.any(Function),
    );
    expect(apply).toHaveBeenCalledTimes(applyCount + 1);
    expect(page.getByRole("dialog").element().textContent).toContain("Signed catalog · version 2");
    await click("Close");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("labels selected definitions separately from a signed catalog version", () => {
  const expiresAt = 1789706400;
  const html = renderToStaticMarkup(
    <CatalogOrigin
      provenance={{
        origin: "definition_selected",
        catalog_sha256: "a".repeat(64),
        sequence: null,
        key_id: null,
        expires_at: expiresAt,
        fallback_reasons: [],
      }}
    />,
  );
  expect(html).toContain("Using selected catalog definitions");
  expect(html).toContain("Valid until");
  expect(html).toContain(new Date(expiresAt * 1000).toLocaleString());
  expect(html).not.toContain("Signed catalog");
});

it("keeps fallback diagnostics in distinct technical disclosures with safe summaries", () => {
  const reasons = [
    "Publisher trust changed",
    "Cache dates are inconsistent",
    "Definition restoration is temporarily unavailable",
    "Selected definition was rejected: signer threshold unavailable",
    "A saved listing directory was not selected",
    "catalog signing key is not trusted",
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
        fallback_codes: [
          "untrusted_key",
          "invalid_validity",
          "selected_definition_unavailable",
          "signature_invalid",
          "listing_directory_unavailable",
          "unknown",
        ],
      }}
    />,
  );
  expect(html).toContain("signed by a publisher that is no longer trusted");
  expect(html).toContain("expired or had invalid dates");
  expect(html).toContain("selected catalog definition could not be loaded");
  expect(html).toContain("did not pass signature verification");
  expect(html).toContain("A saved catalog could not be used");
  const host = document.createElement("div");
  host.innerHTML = html;
  const disclosures = [...host.querySelectorAll(".catalog-fallback-reason details")];
  expect(disclosures).toHaveLength(reasons.length);
  expect(
    fixtureValue(disclosures[5], "disclosures[5]").parentElement?.querySelector("p")?.textContent,
  ).toBe(
    "A saved catalog could not be used. Portcove continued with the available catalog information.",
  );
  expect(
    fixtureValue(disclosures[4], "listing fallback").parentElement?.querySelector("p")?.textContent,
  ).toBe("Portcove could not use the saved listing directory.");
  for (const [index, reason] of reasons.entries()) {
    expect(html).toContain(
      `aria-label="Technical details for catalog fallback ${index + 1} of ${reasons.length}"`,
    );
    expect(fixtureValue(disclosures[index], "disclosures[index]").textContent).toContain(reason);
  }
  for (const disclosure of disclosures) disclosure.remove();
  for (const reason of reasons) expect(host.textContent).not.toContain(reason);
  expect(html).not.toContain("Update unavailable:");
});

vi.mock("../file-picker", { spy: true });

it("renders mounted typed and legacy fallback summaries in the actual Advanced Settings context", async () => {
  const signature = "Timestamp signer threshold did not match the admitted repository";
  const unknown = `Opaque future diagnostic: ${"repository-metadata-context/".repeat(8)}`;
  const variants: {
    name: string;
    theme: "dark" | "light";
    width: number;
    reasons: string[];
    summary: string;
    codes?: CatalogProvenance["fallback_codes"];
  }[] = [
    {
      name: "typed",
      theme: "dark",
      width: 960,
      reasons: [signature],
      summary:
        "Catalog information did not pass signature verification. Portcove kept the available catalog information.",
      codes: ["signature_invalid"],
    },
    {
      name: "unknown-and-legacy",
      theme: "light",
      width: 430,
      reasons: [unknown, "Legacy text-only catalog diagnostic"],
      summary:
        "A saved catalog could not be used. Portcove continued with the available catalog information.",
      codes: ["unknown"],
    },
  ];
  vi.spyOn(desktopApi, "listingDeliveryStatus").mockResolvedValue({
    delivery_schema: 1,
    revision: null,
    selected: false,
    anchor_sha256: null,
    repository_root_sha256: null,
    target_sha256: null,
    expires_at: null,
    listing_count: 0,
    withdrawn_ids: [],
    fallback_reason: null,
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    for (const variant of variants) {
      await page.viewport(variant.width, 800);
      document.documentElement.dataset.theme = variant.theme;
      const provenance: CatalogProvenance = {
        origin: "embedded",
        catalog_sha256: "a".repeat(64),
        sequence: null,
        key_id: null,
        expires_at: null,
        fallback_reasons: variant.reasons,
        ...(variant.codes ? { fallback_codes: variant.codes } : {}),
      };
      const doctor: DoctorReport = {
        platform: "windows-x86-64",
        library: {
          library_root: "C:/Fixture library",
          volume_total_bytes: 1024,
          volume_available_bytes: 512,
        },
        catalog_port_count: 1,
        catalog_provenance: provenance,
        installed_port_count: 0,
        registered_source_count: 0,
        repair: { generated_at: 1, items: [] },
        host_tools: [],
      };
      await act(async () => root.render(<SettingsView category="advanced" doctor={doctor} />));
      const section = host.querySelector<HTMLElement>('[data-settings-group="advanced"]')!;
      const rows = [...section.querySelectorAll<HTMLElement>(".catalog-fallback-reason")];
      expect(rows).toHaveLength(variant.reasons.length);
      expect(section.closest(".settings-grid")).not.toBeNull();
      expect(rows[0]?.closest(".settings-row")).not.toBeNull();
      expect(rows[0]?.isConnected).toBe(true);
      expect(rows[0]?.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(
        variant.reasons.map(() => variant.summary),
      );
      await expect
        .element(
          page
            .getByRole("region", { name: "Advanced", exact: true })
            .getByText(variant.summary, { exact: true })
            .first(),
        )
        .toBeVisible();
      for (const [index, row] of rows.entries()) {
        // Identify the real mounted row without assuming its sibling element types.
        const target = `catalog-fallback-${variant.name}-${index}`;
        row.dataset.captureFallback = target;
        const actualSelector = `[data-capture-fallback="${target}"]`;
        await prepareCaptureTarget({
          target: actualSelector,
          label: target,
          scroll: () => row.scrollIntoView({ block: "center" }),
          observe: () => observeVisibleTarget(actualSelector, "visual"),
        });
        await captureRenderedState(`${target}-collapsed`);
        const disclosure = row.querySelector<HTMLDetailsElement>("details")!;
        expect(disclosure.open).toBe(false);
        await userEvent.click(disclosure.querySelector("summary")!);
        expect(disclosure.open).toBe(true);
        expect(disclosure.textContent).toContain(variant.reasons[index]);
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
        await prepareCaptureTarget({
          target: actualSelector,
          label: `${target} expanded`,
          scroll: () => row.scrollIntoView({ block: "center" }),
          observe: () => observeVisibleTarget(actualSelector, "visual"),
        });
        await captureRenderedState(`${target}-expanded`);
        await userEvent.click(disclosure.querySelector("summary")!);
        expect(disclosure.open).toBe(false);
      }
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete document.documentElement.dataset.theme;
    vi.restoreAllMocks();
  }
}, 30_000);

it("refreshes descriptive directory data through Core and reloads the workspace", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const initial = {
    delivery_schema: 1,
    revision: null,
    selected: false,
    anchor_sha256: null,
    repository_root_sha256: null,
    target_sha256: null,
    expires_at: null,
    listing_count: 0,
    withdrawn_ids: [],
    fallback_reason: "The saved listing directory could not be read",
    fallback_code: "listing_directory_unavailable",
  } satisfies Awaited<ReturnType<typeof desktopApi.listingDeliveryStatus>>;
  const read = vi
    .spyOn(desktopApi, "listingDeliveryStatus")
    .mockRejectedValueOnce(new Error("Status unavailable"))
    .mockResolvedValue(initial);
  const apply = vi.spyOn(desktopApi, "refreshCatalogListings").mockResolvedValue({
    ...initial,
    revision: 2,
    selected: true,
    listing_count: 1,
    fallback_reason: null,
    fallback_code: null,
  });
  const changed = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<CatalogSettings disabled={false} onChanged={changed} />));
    await expect
      .element(page.getByRole("alert"))
      .toMatchTextContent("Game listing status is unknown");
    await page.getByRole("button", { name: "Retry listing status", exact: true }).click();
    const builtIn = page.getByText("Using the built-in directory", { exact: true });
    await expect.element(builtIn).toBeVisible();
    expect(builtIn.elements()).toHaveLength(1);
    await expect
      .element(
        page.getByText("Portcove could not use the saved listing directory.", { exact: true }),
      )
      .toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
    const diagnostic = page.getByText(initial.fallback_reason, { exact: true });
    await expect.element(diagnostic).not.toBeVisible();
    const details = page.getByText("Technical details", { exact: true });
    await expect
      .element(details)
      .toHaveAttribute("aria-label", "Technical details for catalog fallback 1 of 1");
    await details.click();
    await expect.element(diagnostic).toBeVisible();
    const settings = page.getByText("Listing refresh settings", { exact: true });
    await expect.element(settings).toBeVisible();
    expect(settings.element().closest("details")?.open).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    await settings.click();
    await page
      .getByRole("textbox", { name: "Catalog metadata address" })
      .fill("https://catalog.example/metadata/");
    await page
      .getByRole("textbox", { name: "Catalog content address" })
      .fill("https://catalog.example/targets/");
    await page.getByRole("button", { name: "Refresh game listings", exact: true }).click();
    await expect.poll(() => changed.mock.calls.length).toBe(1);
    expect(apply).toHaveBeenCalledWith(
      "https://catalog.example/metadata/",
      "https://catalog.example/targets/",
      expect.any(Function),
    );
    expect(document.body.textContent).toContain("Game listings revision 2 · 1 published listing");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
