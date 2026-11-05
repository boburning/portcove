import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
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
  expect(host.textContent).toContain("release v1");
  expect(host.textContent).toContain("Later releases do not inherit a failure or a fix");
});
