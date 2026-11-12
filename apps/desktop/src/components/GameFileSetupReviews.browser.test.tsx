import { captureParityState } from "../../test/parity-capture";
import { fixtureValue } from "../test-fixtures";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { SetupReviewSelectionProvider } from "../features/game-file-discovery/setup-review-selection";
import { portDefinition, portStatus, preliminarySourceInspection } from "../test-fixtures";
import { GameFileSetupReviews } from "./GameFileSetupReviews";

const source = {
  profile_id: "game",
  path: "D:/original.z64",
  sha256: "a".repeat(64),
  storage_sha256: "a".repeat(64),
  storage_size: 64,
  size: 64,
  updated_at: 1,
};
const ports = Array.from({ length: 18 }, (_, i) => ({
  ...portDefinition(),
  id: `p${i}`,
  name: `Port ${i}`,
  source_profile: "game",
}));
const statuses = new Map(
  ports.map((port) => [
    port.id,
    {
      ...portStatus(),
      port_id: port.id,
      port_actions: [
        {
          action: "install" as const,
          availability: "allowed" as const,
          reason: "available" as const,
        },
      ],
    },
  ]),
);
const element = document.createElement("div");
document.body.append(element);
const root = createRoot(element);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterEach(async () => {
  await act(async () => root.render(null));
});
const button = (name: string) =>
  [...element.querySelectorAll("button")].find((b) => b.textContent === name)!;

it("keeps registered preliminary inputs distinct while opening only fresh Core-eligible setup reviews", async () => {
  const record = { ...source, path: "D:/selected-disc.iso" };
  const inspection = preliminarySourceInspection(record);
  const open = vi.fn();
  const render = (
    current = true,
    registeredSources = [record],
    eligible = true,
    selections = [inspection],
  ) =>
    root.render(
      <SetupReviewSelectionProvider>
        <GameFileSetupReviews
          ports={ports}
          statuses={eligible ? statuses : new Map()}
          candidates={[]}
          preliminarySelections={selections}
          registeredSources={registeredSources}
          current={current}
          busy={false}
          onOpenPort={open}
        />
      </SetupReviewSelectionProvider>,
    );
  await act(async () => render());
  expect(element.querySelectorAll("[data-setup-review-port]")).toHaveLength(18);
  expect(element.textContent).toContain("Validation has not run for a selected input");
  expect(element.textContent).not.toContain("Edition identified");
  await act(async () =>
    fixtureValue(
      element.querySelectorAll<HTMLInputElement>("input")[0],
      'element.querySelectorAll<HTMLInputElement>("input")[0]',
    ).click(),
  );
  await act(async () =>
    fixtureValue(
      element.querySelectorAll<HTMLInputElement>("input")[1],
      'element.querySelectorAll<HTMLInputElement>("input")[1]',
    ).click(),
  );
  await act(async () => button("Review Port 0 setup").click());
  expect(open).toHaveBeenCalledWith("p0", "game-file-libraries-setup");
  await act(async () => render(false));
  expect(button("Review Port 0 setup").disabled).toBe(true);
  await act(async () => render(true, []));
  expect(button("Review Port 0 setup").disabled).toBe(true);
  await act(async () => render(true, [{ ...record, sha256: "b".repeat(64) }]));
  expect(button("Review Port 1 setup").disabled).toBe(true);
  await act(async () => render(true, [record], false));
  expect(button("Review Port 1 setup").disabled).toBe(true);
  await act(async () =>
    render(true, [record], true, [
      { ...inspection, validator: { ...inspection.validator!, result: "passed" } },
    ]),
  );
  expect(button("Review Port 1 setup").disabled).toBe(true);
  await act(async () => render());
  expect(button("Review Port 1 setup").disabled).toBe(false);
  expect(element.textContent).toContain("2 selected ·");
  await captureParityState("game-files-selected-setup-reviews-fixture");
});

it("retains independent selections through details/back and never treats opening as completion", async () => {
  const open = vi.fn();
  const render = (visible: boolean, current = true, registeredSources = [source]) =>
    root.render(
      <SetupReviewSelectionProvider>
        {visible && (
          <GameFileSetupReviews
            ports={ports}
            statuses={statuses}
            candidates={[source]}
            registeredSources={registeredSources}
            current={current}
            busy={false}
            onOpenPort={open}
          />
        )}
      </SetupReviewSelectionProvider>,
    );
  await act(async () => render(true));
  await act(async () =>
    fixtureValue(
      element.querySelectorAll<HTMLInputElement>("input")[0],
      'element.querySelectorAll<HTMLInputElement>("input")[0]',
    ).click(),
  );
  await act(async () =>
    fixtureValue(
      element.querySelectorAll<HTMLInputElement>("input")[1],
      'element.querySelectorAll<HTMLInputElement>("input")[1]',
    ).click(),
  );
  await act(async () => button("Review Port 0 setup").click());
  expect(open).toHaveBeenCalledWith("p0", "game-file-libraries-setup");
  await act(async () => render(false));
  await act(async () => render(true));
  expect(element.textContent).toContain("2 selected ·");
  await act(async () => render(true, false));
  expect(button("Review Port 0 setup").disabled).toBe(true);
  await act(async () => render(true, true, []));
  expect(button("Review Port 1 setup").disabled).toBe(true);
  expect(element.textContent).toContain("2 selected ·");
  await act(async () => render(true));
  await act(async () => button("Remove Port 0 from selection").click());
  expect(element.textContent).toContain("1 selected ·");
  expect(button("Review Port 1 setup").disabled).toBe(false);
});

it("selects beyond sixteen games, and replaces the selection with the library workspace", async () => {
  const render = (key: string) =>
    root.render(
      <SetupReviewSelectionProvider key={key}>
        <GameFileSetupReviews
          ports={ports}
          statuses={statuses}
          candidates={[source]}
          registeredSources={[source]}
          current
          busy={false}
          onOpenPort={vi.fn()}
        />
      </SetupReviewSelectionProvider>,
    );
  await act(async () => render("old"));
  for (let i = 0; i < 17; i++)
    await act(async () =>
      fixtureValue(
        element.querySelectorAll<HTMLInputElement>("input")[i],
        'element.querySelectorAll<HTMLInputElement>("input")[i]',
      ).click(),
    );
  expect(element.querySelectorAll("input")).toHaveLength(18);
  expect(element.textContent).toContain("17 selected ·");
  expect(
    fixtureValue(
      element.querySelectorAll<HTMLInputElement>("input")[17],
      'element.querySelectorAll<HTMLInputElement>("input")[17]',
    ).disabled,
  ).toBe(false);
  await act(async () => render("new"));
  expect(element.textContent).toContain("0 selected ·");
});

it("selects every eligible game at once but leaves versions of the same game to the player", async () => {
  const independent = Array.from({ length: 20 }, (_, i) => ({
    ...portDefinition(),
    id: `solo${i}`,
    name: `Solo ${i}`,
    source_profile: `solo-${i}`,
  }));
  const versions = ["a", "b"].map((suffix) => ({
    ...portDefinition(),
    id: `fork-${suffix}`,
    name: `Fork ${suffix}`,
    source_profile: "shared",
  }));
  const all = [...independent, ...versions];
  const allStatuses = new Map(
    all.map((port) => [
      port.id,
      { ...fixtureValue(statuses.get("p0"), "status"), port_id: port.id },
    ]),
  );
  const files = all.map((port) => ({
    ...source,
    profile_id: port.source_profile,
    path: `D:/${port.id}`,
  }));
  const install = vi.fn();
  await act(async () =>
    root.render(
      <SetupReviewSelectionProvider>
        <GameFileSetupReviews
          ports={all}
          statuses={allStatuses}
          candidates={files}
          registeredSources={files}
          current
          busy={false}
          onOpenPort={vi.fn()}
          onReviewInstall={install}
        />
      </SetupReviewSelectionProvider>,
    ),
  );
  expect(element.textContent).toContain("0 selected · 20 eligible · 1 game needs a version choice");
  await act(async () => button("Select all 20 eligible").click());
  expect(element.textContent).toContain("20 selected · 20 eligible");
  // Focus stays in the section after the button goes away.
  expect(element.contains(document.activeElement)).toBe(true);
  await act(async () => button("Review installing 20 selected").click());
  const chosen = install.mock.calls[0]![0] as string[];
  expect(chosen).toHaveLength(20);
  expect(chosen.some((id) => id.startsWith("fork-"))).toBe(false);
});

it("offers independent Core-eligible ports when a scanned BIOS completes previously registered game inputs", async () => {
  const bios = { ...source, profile_id: "bios", path: "D:/new-folder/bios.bin" };
  const choices = [
    { ...fixtureValue(ports[0], "ports[0]"), bios_source_profile: "bios" },
    { ...fixtureValue(ports[1], "ports[1]"), bios_source_profile: "bios" },
  ];
  const open = vi.fn();
  const render = (current = true, records = [source, bios], held = false) =>
    root.render(
      <SetupReviewSelectionProvider>
        <GameFileSetupReviews
          ports={choices}
          statuses={
            held
              ? new Map(
                  choices.map((port) => [
                    port.id,
                    {
                      ...statuses.get(port.id)!,
                      port_actions: [
                        {
                          action: "install" as const,
                          availability: "waiting" as const,
                          reason: "missing_source" as const,
                        },
                      ],
                    },
                  ]),
                )
              : statuses
          }
          candidates={[bios]}
          registeredSources={records}
          current={current}
          busy={false}
          onOpenPort={open}
        />
      </SetupReviewSelectionProvider>,
    );
  await act(async () => render());
  expect(element.querySelectorAll("[data-setup-review-port]")).toHaveLength(2);
  await act(async () => element.querySelector<HTMLInputElement>("input")!.click());
  await act(async () => button("Review Port 0 setup").click());
  expect(open).toHaveBeenCalledWith("p0", "game-file-libraries-setup");
  await act(async () => render(false));
  expect(button("Review Port 0 setup").disabled).toBe(true);
  await act(async () => render(true, [source]));
  expect(button("Review Port 0 setup").disabled).toBe(true);
  await act(async () => render(true, [source, { ...bios, sha256: "b".repeat(64) }]));
  expect(button("Review Port 0 setup").disabled).toBe(true);
  await act(async () => render(true, [bios], true));
  expect(button("Review Port 0 setup").disabled).toBe(true);
  await act(async () => render());
  expect(button("Review Port 0 setup").disabled).toBe(false);
  expect(element.textContent).toContain("1 selected ·");
});

it("still asks for a version choice when the other version is already installed", async () => {
  const versions = ["a", "b"].map((suffix) => ({
    ...portDefinition(),
    id: `fork-${suffix}`,
    name: `Fork ${suffix}`,
    source_profile: "shared",
  }));
  const reviewable = { ...fixtureValue(statuses.get("p0"), "status"), port_id: "fork-b" };
  const installed = { ...reviewable, port_id: "fork-a", port_actions: [] };
  const file = { ...source, profile_id: "shared" };
  await act(async () =>
    root.render(
      <SetupReviewSelectionProvider>
        <GameFileSetupReviews
          ports={versions}
          statuses={
            new Map([
              ["fork-a", installed],
              ["fork-b", reviewable],
            ])
          }
          candidates={[file]}
          registeredSources={[file]}
          current
          busy={false}
          onOpenPort={vi.fn()}
        />
      </SetupReviewSelectionProvider>,
    ),
  );
  expect(element.textContent).toContain("0 selected · 0 eligible · 1 game needs a version choice");
  expect(
    [...element.querySelectorAll("button")].some((item) => item.textContent?.startsWith("Select")),
  ).toBe(false);
});

it("labels setup review selection in the current language", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    const record = { ...source, path: "D:/selected-disc.iso" };
    await act(async () =>
      root.render(
        <SetupReviewSelectionProvider>
          <GameFileSetupReviews
            ports={ports}
            statuses={statuses}
            candidates={[]}
            preliminarySelections={[preliminarySourceInspection(record)]}
            registeredSources={[record]}
            current
            busy={false}
            onOpenPort={vi.fn()}
          />
        </SetupReviewSelectionProvider>,
      ),
    );
    expect(element.querySelector("h3")?.textContent).toBe("تحديد ألعاب لمراجعة إعدادها");
    expect(element.querySelector('[role="status"]')?.textContent).toBe("0 محددة");
    expect(element.textContent).not.toContain("Select games for setup review");
  } finally {
    await localization.changeLanguage("en");
  }
});
