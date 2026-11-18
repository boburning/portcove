import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import {
  requestStandingSetup,
  useStandingSetupCatchUp,
} from "../features/game-file-discovery/use-standing-setup";
import { LocalizationProvider } from "../localization";
import { portDefinition } from "../test-fixtures";
import type { ModSetupsView } from "../types";
import { DetailLayout } from "./DetailLayout";
import { ModSetupsControl } from "./ModSetupsControl";

let mounted: { root: Root; host: HTMLElement } | undefined;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.root.unmount());
    mounted.host.remove();
    mounted = undefined;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function StandingPassRefresh() {
  useStandingSetupCatchUp(7, true, null, null, async () => {});
  return null;
}

// The native regression accumulated whole package-area wrappers while the Saves
// panel stayed mounted under an initially selected Overview tab.
it("keeps one package area through repeated reads in the mounted hidden Saves panel", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const profile = {
    originals: [],
    build_availability: "verified",
    profile: {
      id: "default",
      port_id: "shipwright",
      display_name: "Default",
      is_default: true,
      current_revision: 1,
    },
    revision: { profile_id: "default", revision: 1, packages: [], orderings: [] },
  };
  const inventory = {
    port_id: "shipwright",
    supported: true,
    package_types: ["o2r", "otr"],
    later_mods_take_priority: true,
    held_updates: [],
    provider: null,
    inventory: { port_id: "shipwright", profiles: [profile] },
    live: {
      profile_id: "default",
      revision: 1,
      unmanaged: [],
      changed_owned: [],
      native_list: { state: "in-sync" },
    },
  } as unknown as ModSetupsView;
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockImplementation(async () => structuredClone(inventory));
  const pass = vi.spyOn(desktopApi, "runStandingSetup").mockResolvedValue({
    already_running: false,
    assessments: [],
    not_assessed: 0,
    batches: [],
    failures: [],
  });
  const localeApi = {
    localePreference: vi.fn().mockResolvedValue({ locale: "en" }),
    setLocalePreference: vi.fn().mockResolvedValue({ locale: "en" }),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  const tree = () => (
    <StrictMode>
      <LocalizationProvider api={localeApi}>
        <StandingPassRefresh />
        <DetailLayout
          port={{ ...portDefinition(), id: "shipwright" }}
          initialSection="overview"
          readiness="Ready to play"
          installation="Managed installation"
          close={() => {}}
          action={() => null}
        >
          {() => ({
            overview: <p>Overview</p>,
            saves: <ModSetupsControl portId="shipwright" generation={7} busy={false} />,
          })}
        </DetailLayout>
      </LocalizationProvider>
    </StrictMode>
  );
  await act(async () => root.render(tree()));
  const assertPackageArea = () => {
    const sections = host.querySelectorAll('section[aria-label="Mods in Default"]');
    expect(sections).toHaveLength(1);
    const section = sections[0]!;
    expect(section.querySelectorAll(':scope > div[tabindex="-1"]')).toHaveLength(1);
    expect(
      [...section.querySelectorAll("p")].filter(
        (paragraph) =>
          paragraph.textContent === "No mods. The game plays without changes in this setup.",
      ),
    ).toHaveLength(1);
  };
  assertPackageArea();
  expect(host.querySelector('[data-detail-section="overview"]')).not.toBeNull();
  expect(host.querySelector("#detail-section-saves")?.closest("[hidden][inert]")).not.toBeNull();

  for (let refresh = 0; refresh < 80; refresh++) {
    const before = read.mock.calls.length;
    await act(async () => {
      root.render(tree());
      requestStandingSetup();
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(read.mock.calls.length).toBeGreaterThan(before);
    assertPackageArea();
  }
  expect(pass).toHaveBeenCalledTimes(80);
  const saves = [...host.querySelectorAll('[role="tab"]')].find(
    (tab) => tab.textContent === "Saves & backups",
  );
  if (!(saves instanceof HTMLElement)) throw new Error("Missing Saves tab");
  await act(async () => saves.click());
  assertPackageArea();
  expect(host.querySelector("#detail-section-saves")?.closest("[hidden]")).toBeNull();
});
