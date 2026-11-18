import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { captureParityState } from "../../test/parity-capture";
import { desktopApi } from "../api";
import { portDefinition, portStatus } from "../test-fixtures";
import type { PortCapabilityReport, PortListing } from "../types";
import { PortCapabilities } from "./PortCapabilities";

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function report(portId = "sample"): PortCapabilityReport {
  return {
    format_version: 1,
    port_id: portId,
    routes: [
      {
        route: "existing-copy",
        install_id: null,
        features: [
          {
            feature: "setup",
            mode: "manual",
            explanation: "Use your upstream-prepared copy.",
            next_step: "Select its executable.",
            action: null,
            listing_action: { action: "attach-existing", allowed: true },
          },
        ],
      },
    ],
    observations: [],
    settings: null,
    protection: null,
    source_readiness: null,
    detail_problems: [],
    advisory_state: "missing",
    advisories: [],
    setup_guide: null,
    pending_setup: null,
  };
}
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const status = portStatus();
  const entry = { ...portDefinition(), definition: portDefinition() };
  const render = (generation: number, listing?: PortListing) =>
    act(async () =>
      root.render(
        <PortCapabilities
          entry={listing ? { ...entry, listing } : entry}
          status={status}
          generation={generation}
        />,
      ),
    );
  return { host, render };
}

it("shows available manual setup and untested evidence independently without invoking an operation", async () => {
  const query = vi.spyOn(desktopApi, "portCapabilities").mockResolvedValue(report());
  const launch = vi.spyOn(desktopApi, "launch");
  const { host, render } = await mount();
  await render(1);
  expect(host.textContent).toContain("Manual · Not tested by this report");
  expect(host.textContent).toContain("Select its executable");
  expect(query).toHaveBeenCalledWith("sample", 1);
  expect(launch).not.toHaveBeenCalled();
});

it("discards an old library response and isolates unavailable optional details", async () => {
  let resolveOld!: (value: PortCapabilityReport) => void;
  vi.spyOn(desktopApi, "portCapabilities").mockImplementation((_id, generation) =>
    generation === 1
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.reject(new Error("Optional details unavailable")),
  );
  const { host, render } = await mount();
  await render(1);
  await render(2);
  await act(async () => resolveOld({ ...report(), detail_problems: ["OLD LIBRARY DETAIL"] }));
  expect(host.textContent).not.toContain("OLD LIBRARY DETAIL");
  expect(host.textContent).toContain("Feature details are unavailable");
});

it("refreshes changed listing advice with the same status and generation", async () => {
  let next!: (value: PortCapabilityReport) => void;
  const query = vi
    .spyOn(desktopApi, "portCapabilities")
    .mockResolvedValueOnce({ ...report(), detail_problems: ["OLD ADVICE"] })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          next = resolve;
        }),
    );
  const { host, render } = await mount();
  await render(1);
  expect(host.textContent).toContain("OLD ADVICE");
  await render(1, {
    id: "sample",
    name: "Sample",
    summary: "Updated instructions",
    project_url: "https://example.com",
    platforms: [],
    availability: "unknown",
    compatibility: { format_version: 1, records: [] },
  });
  expect(query).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain("OLD ADVICE");
  await act(async () => next({ ...report(), detail_problems: ["NEW ADVICE"] }));
  expect(host.textContent).toContain("NEW ADVICE");
});

it("keeps version-specific notices scoped and distinguishes settings support from initialization", async () => {
  const value = report();
  value.settings = {
    port_id: "sample",
    install_id: "copy",
    available: true,
    reason: null,
    files: [
      {
        id: "config",
        path: "config.json",
        available: false,
        reason: "Not initialized",
        configuration_sha256: null,
        settings: [],
      },
    ],
  };
  value.advisories = [
    {
      applicability: "context-required",
      notice: {
        id: "exit-defect",
        feature: "launch",
        platform: "windows-x86-64",
        route: "existing-copy",
        release: "v1",
        artifact_sha256: "a".repeat(64),
        edition: "original",
        explanation: "This exact fixture release fails on exit.",
        launch_behavior: {
          first_launch: "asks-for-game-files",
          repeat_launch: "starts-game-directly",
        },
        provenance: "https://example.com/fixture",
        observed_at: 1,
        evidence: "observed",
        workaround: null,
      },
    },
  ];
  value.advisory_state = "available";
  vi.spyOn(desktopApi, "portCapabilities").mockResolvedValue(value);
  const { host, render } = await mount();
  await render(1);
  expect(host.textContent).toContain("Settings are supported");
  expect(host.textContent).toContain(
    `Scope: windows-x86-64 · Explicit existing-copy selection · release v1 · edition original · artifact ${"a".repeat(64)}.`,
  );
  expect(host.textContent).toContain("Launch · observed · Exact context required");
  expect(host.textContent).toContain("Asks for game files");
  expect(host.textContent).toContain("Starts the game directly");
  const scope = [...host.querySelectorAll("p")].find((item) =>
    item.textContent?.startsWith("Scope:"),
  );
  expect([...(scope?.querySelectorAll("[dir=ltr]") ?? [])].map((item) => item.textContent)).toEqual(
    ["windows-x86-64", "v1", "original", "a".repeat(64)],
  );
  expect(host.querySelector("a[href='https://example.com/fixture']")?.textContent).toBe("Source");
  expect(host.textContent).toContain("These details apply to the scope shown above.");
});

it("presents feature details, scope and backup state in the active locale", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    const value = report();
    value.protection = { latest_completed_backup: null } as unknown as NonNullable<
      PortCapabilityReport["protection"]
    >;
    value.advisories = [
      {
        applicability: "current-route",
        notice: {
          id: "exit-defect",
          feature: "launch",
          platform: "windows-x86-64",
          route: "existing-copy",
          release: "v1",
          artifact_sha256: null,
          edition: null,
          explanation: "This exact fixture release fails on exit.",
          provenance: "https://example.com/fixture",
          observed_at: 1,
          evidence: "observed",
          workaround: null,
        },
      },
    ];
    value.advisory_state = "available";
    vi.spyOn(desktopApi, "portCapabilities").mockResolvedValue(value);
    const { host, render } = await mount();
    await render(1);
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe(
      "ما يعمل والمشكلات المعروفة",
    );
    expect(host.querySelector("h4")?.textContent).toBe("اختيار صريح لنسخة موجودة");
    expect(host.querySelector("dt")?.textContent).toBe("الإعداد");
    expect(host.textContent).toContain("يدوي · لم يختبره هذا التقرير");
    expect(host.textContent).toContain("التشغيل · observed · ينطبق على هذا المسار");
    expect(host.textContent).toContain(
      "النطاق: windows-x86-64 · اختيار صريح لنسخة موجودة · الإصدار v1.",
    );
    expect(host.textContent).toContain("آخر نسخة احتياطية مكتملة: لا توجد نسخة مسجّلة.");
    expect(host.textContent).toContain("Select its executable.");
    expect(host.querySelector("a[href='https://example.com/fixture']")?.textContent).toBe("المصدر");
  } finally {
    await localization.changeLanguage("en");
  }
});

it("labels backup, historical scope and unknown features while keeping ids visible", async () => {
  const value = report();
  value.protection = { latest_completed_backup: {} } as unknown as NonNullable<
    PortCapabilityReport["protection"]
  >;
  value.advisories = [
    {
      applicability: "historical",
      notice: {
        id: "future",
        feature: "future-feature" as "launch",
        platform: "linux-x86-64",
        route: "managed",
        release: null,
        artifact_sha256: null,
        edition: null,
        explanation: "Recorded on another build.",
        provenance: "https://example.com/history",
        observed_at: 1,
        evidence: "reported",
        workaround: null,
      },
    },
  ];
  value.advisory_state = "available";
  vi.spyOn(desktopApi, "portCapabilities").mockResolvedValue(value);
  const { host, render } = await mount();
  await render(1);
  expect(host.textContent).toContain(
    "Latest completed backup: Recorded; restore verifies the selected snapshot. Review Saves & backups for effective coverage and exclusions.",
  );
  expect(host.textContent).toContain("future-feature · reported · Historical / different scope");
  expect(host.textContent).toContain("Scope: linux-x86-64 · Managed setup.");
});

it("keeps complete advisory and recorded scopes readable in narrow detail columns", async () => {
  const previousViewport = { width: innerWidth, height: innerHeight };
  const previousTheme = document.documentElement.dataset.theme;
  const artifact = "a".repeat(64);
  const release = `synthetic-release-${"r".repeat(96)}`;
  const edition = `synthetic-edition-${"e".repeat(96)}`;
  const recordedScope = {
    artifact_id: artifact,
    edition_id: edition,
    environment_id: "synthetic-recorded-device",
    game_id: "sample-game",
    platform: "windows-x86-64" as const,
    port_id: "sample",
    release_id: release,
    route_id: "existing-copy",
    source_profile_id: "synthetic-original-files",
  };
  const value = report();
  value.advisory_state = "available";
  value.advisories = [
    {
      applicability: "context-required",
      notice: {
        id: "synthetic-exact-scope",
        feature: "launch",
        platform: "windows-x86-64",
        route: "existing-copy",
        release,
        artifact_sha256: artifact,
        edition,
        explanation: "Synthetic exact-context caution, not an assessment of this installation.",
        provenance: "https://example.com/fixture",
        observed_at: 1,
        evidence: "observed",
        workaround: null,
      },
    },
  ];
  value.observations = [
    {
      id: "synthetic-recorded-scope",
      dimension: "gameplay",
      claim: { kind: "unknown" },
      kind: "artifact-inspected",
      explanation: "Synthetic recorded scope with no gameplay conclusion.",
      observed_at: 1,
      scope: recordedScope,
      source: "https://example.com/history",
      supersedes: [],
    },
  ];
  vi.spyOn(desktopApi, "portCapabilities").mockResolvedValue(value);
  try {
    document.documentElement.dataset.theme = "light";
    const { host, render } = await mount();
    // Match the narrow App's navigation rail and padded detail column.
    host.style.cssText =
      "display:grid;grid-template-columns:minmax(0,1fr);width:calc(100% - 60px);margin-inline-start:60px;padding:20px;box-sizing:border-box";
    await render(1);
    const scope = [...host.querySelectorAll("p")].find((item) =>
      item.textContent?.startsWith("Scope:"),
    )!;
    const history = [...host.querySelectorAll("summary")].find(
      (item) => item.textContent === "Historical observations and exact applicability",
    )!;
    const assertContained = (element: HTMLElement) => {
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
      const bounds = host.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      for (const rect of range.getClientRects()) {
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
        expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
      }
    };
    for (const width of [430, 320]) {
      await page.viewport(width, 780);
      await document.fonts.ready;
      expect(scope.textContent).toContain(release);
      expect(scope.textContent).toContain(edition);
      expect(scope.querySelector("code")?.textContent).toBe(artifact);
      expect(host.textContent).toContain("Launch · observed · Exact context required");
      scope.scrollIntoView({ block: "center" });
      assertContained(scope);
      await captureParityState("capabilities-complete-advisory-scope");
      history.focus();
      await userEvent.keyboard("{Enter}");
      expect(history.parentElement?.hasAttribute("open")).toBe(true);
      const recorded = [...host.querySelectorAll("p")].find(
        (item) => item.textContent === JSON.stringify(recordedScope),
      )!;
      expect(recorded.textContent).toBe(JSON.stringify(recordedScope));
      expect(host.textContent).toContain("the results remain historical");
      recorded.scrollIntoView({ block: "center" });
      assertContained(recorded);
      await captureParityState("capabilities-complete-historical-scope");
      history.focus();
      await userEvent.keyboard("{Enter}");
      expect(history.parentElement?.hasAttribute("open")).toBe(false);
    }
  } finally {
    await page.viewport(previousViewport.width, previousViewport.height);
    if (previousTheme === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = previousTheme;
  }
});
