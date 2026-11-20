import { useRef, useState } from "react";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { auditAccessibility } from "../../../test/accessibility";
import { desktopApi } from "../../api";
import { initializeLocalization } from "../../localization";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog";
import { useGamepadNavigation } from "../../gamepad";
import type { LibraryOrganization } from "../../types";
import { useOrganization } from "../organization/use-organization";
import { GameComparisonControls, GameComparisonEvidence } from "./GameComparisonEvidence";
import { comparisonFixture } from "./comparison-test-fixture";
import { useGameComparison } from "./use-game-comparison";
import "../../styles/index.css";

let pressed: number[] = [];
const back = vi.fn();
function Fixture({
  generation = 1,
  siblings = false,
}: {
  generation?: number;
  siblings?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const organization = useOrganization(generation);
  const comparison = useGameComparison({
    portId: open ? "sample" : undefined,
    generation,
    observationKey: String(organization.snapshot?.revision),
  });
  useGamepadNavigation(back);
  return (
    <main>
      <Button ref={trigger} onClick={() => setOpen(true)}>
        Compare projects
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          finalFocus={trigger}
          aria-describedby={undefined}
          reviewSize="large"
          className="port-comparison-dialog"
        >
          <DialogTitle>Compare independent projects</DialogTitle>
          <GameComparisonControls comparison={comparison} />
          <GameComparisonEvidence
            comparison={comparison}
            portId="sample"
            organization={organization}
          />
          {siblings && (
            <GameComparisonEvidence
              comparison={comparison}
              portId="sibling"
              organization={organization}
            />
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
const frames = async (count: number) => {
  for (let index = 0; index < count; index++) await new Promise(globalThis.requestAnimationFrame);
};
async function press(button: number) {
  pressed = [button];
  await frames(3);
  pressed = [];
  await frames(3);
}
beforeEach(async () => {
  pressed = [];
  back.mockClear();
  vi.spyOn(globalThis.navigator, "getGamepads").mockImplementation(() => [
    {
      id: "Owned comparison virtual-controller adapter",
      index: 0,
      mapping: "standard",
      axes: [0, 0],
      buttons: Array.from({ length: 16 }, (_, index) => ({
        pressed: pressed.includes(index),
        touched: pressed.includes(index),
        value: pressed.includes(index) ? 1 : 0,
      })),
    } as unknown as Gamepad,
  ]);
  let organization: LibraryOrganization = {
    revision: 0,
    followed_port_ids: [],
    followed_release_acknowledgments: {},
    collections: {},
    hidden_port_ids: [],
    saved_game_ids: [],
    update_notices: {},
    setup_confirmations: [],
  };
  vi.spyOn(desktopApi, "organizationPreferences").mockImplementation(async () =>
    globalThis.structuredClone(organization),
  );
  vi.spyOn(desktopApi, "changeOrganization").mockImplementation(async (revision, change) => {
    if (revision !== organization.revision || change.kind !== "set_followed_project")
      throw new Error("Unexpected organization fixture change");
    organization = {
      ...organization,
      revision: organization.revision + 1,
      followed_port_ids: change.followed
        ? [...new Set([...organization.followed_port_ids, change.port_id])]
        : organization.followed_port_ids.filter((id) => id !== change.port_id),
    };
    return globalThis.structuredClone(organization);
  });
  vi.spyOn(desktopApi, "compareGamePorts").mockImplementation(async (request) => {
    const report = comparisonFixture();
    report.required_capabilities = request.required_capabilities ?? [];
    report.ports[0]!.followed = organization.followed_port_ids.includes("sample");
    report.ports.push({
      ...report.ports[0]!,
      port_id: "sibling",
      name: "Sibling project",
      followed: organization.followed_port_ids.includes("sibling"),
    });
    if (request.required_capabilities?.includes("multiplayer")) {
      report.assessment!.status = "insufficient-evidence";
      report.assessment!.candidates[0]!.recommendation_eligible = false;
      report.assessment!.candidates[0]!.reasons = ["requirement-unknown"];
    }
    return report;
  });
  vi.spyOn(desktopApi, "openExternalUrl").mockResolvedValue(undefined);
  await page.viewport(960, 800);
});
afterEach(async () => {
  await cleanup();
  await initializeLocalization().changeLanguage("en");
  delete globalThis.document.documentElement.dataset.inputMode;
  vi.restoreAllMocks();
});

// Whole-suite5c retained the completed axe observation before the15s outer limit.
// Give this full keyboard/disclosure/follow+axe journey finite45s headroom;
// inner assertions, product waits, zero retries and cleanup remain unchanged.
it("shows the shared facts, accepts keyboard requirements and keeps following explicitly opt-in", async (context) => {
  await render(<Fixture />);
  const trigger = page.getByRole("button", { name: "Compare projects", exact: true });
  trigger.element().focus();
  await userEvent.keyboard("{Enter}");
  const dialog = page.getByRole("dialog", { name: "Compare independent projects" });
  await expect.element(dialog).toBeVisible();
  await expect
    .element(
      page.getByText(
        "Only one port has been assessed, so there isn’t enough information to compare it with the others.",
      ),
    )
    .toBeVisible();
  expect(desktopApi.changeOrganization).not.toHaveBeenCalled();
  const why = page.getByText("Why this port? — Fixture project", { exact: true });
  why.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByText("Synthetic assertion for presentation tests, not real gameplay."))
    .toBeVisible();
  expect(dialog.element().textContent).not.toContain("80/100");
  // Keyboard disclosure focus scrolls the modal. Audit from a stable top position
  // so the context paragraph is not partially clipped by the scrollport.
  dialog.element().scrollTop = 0;
  await frames(2);
  await auditAccessibility(
    dialog.element(),
    "recommendation-evidence-expanded-browser-fixture",
    context,
  );
  await userEvent.click(page.getByText("Comparison settings", { exact: true }));
  const required = page.getByRole("checkbox", { name: "Multiplayer", exact: true });
  required.element().focus();
  await userEvent.keyboard(" ");
  await expect.element(required).toBeChecked();
  await expect.element(page.getByText("Support unconfirmed", { exact: true })).toBeVisible();
  expect(
    vi.mocked(desktopApi.compareGamePorts).mock.calls.at(-1)?.[0].required_capabilities,
  ).toEqual(["multiplayer"]);
  await userEvent.click(
    page.getByRole("button", { name: "Update notices for Fixture project", exact: true }),
  );
  await expect
    .element(page.getByRole("button", { name: "Update notices for Fixture project", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  expect(desktopApi.changeOrganization).toHaveBeenCalledExactlyOnceWith(
    0,
    {
      kind: "set_followed_project",
      port_id: "sample",
      followed: true,
      observed_identity: "b".repeat(64),
    },
    1,
  );
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
}, 45_000);

it.each(["different edition", "retained offer"] as const)(
  "shows scoped feature results beside each port with the reports closed for a %s",
  async (scenario) => {
    const stale = scenario === "retained offer";
    vi.mocked(desktopApi.compareGamePorts).mockImplementation(async (request) => {
      const report = comparisonFixture();
      const candidate = report.assessment!.candidates[0]!;
      const sample = report.ports[0]!;
      report.required_capabilities = request.required_capabilities ?? [];
      candidate.required_capabilities = { multiplayer: "satisfied", controller: "unsupported" };
      const sibling = { ...sample, port_id: "sibling", name: "Sibling project" };
      if (stale) sibling.freshness = { ...sample.freshness, state: "collection-failed" };
      report.ports.push(sibling);
      report.assessment!.candidates.push({
        ...candidate,
        scope: {
          ...candidate.scope,
          port_id: sibling.port_id,
          edition_id: stale ? candidate.scope.edition_id : "another-edition",
        },
        reasons: stale ? ["operation-unknown"] : ["different-game-or-edition"],
      });
      if (!report.required_capabilities.length) {
        report.assessment!.status = "recommended-starting-point";
        report.assessment!.recommended = candidate.scope;
      } else {
        report.assessment!.status = "insufficient-evidence";
      }
      return report;
    });
    await page.viewport(390, 844);
    await render(<Fixture siblings />);
    await page.getByRole("button", { name: "Compare projects", exact: true }).click();
    const options = page.getByRole("region", { name: "Comparison options", exact: true });
    const result = options.getByRole("status");
    await expect.element(result).toHaveTextContent("Suggested starting point · Fixture project");
    await expect.element(options.getByText(/Comparing Fixture original on Windows/)).toBeVisible();
    await page.getByText("Comparison settings", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Multiplayer", exact: true }).click();
    await page.getByRole("checkbox", { name: "Controller support", exact: true }).click();
    await page.getByText("Comparison settings", { exact: true }).click();
    await expect
      .element(result)
      .toHaveTextContent(
        "We don’t have enough information to suggest a port. You can still explore every project.",
      );
    const first = page.getByRole("region", { name: "Reports and updates for Fixture project" });
    const second = page.getByRole("region", { name: "Reports and updates for Sibling project" });
    await expect
      .element(first.getByText("Supported for these options", { exact: true }))
      .toBeVisible();
    await expect
      .element(first.getByText("Unsupported for these options", { exact: true }))
      .toBeVisible();
    const version = stale ? "Last recorded version 1.0" : "Offered version 1.0";
    await expect.element(second.getByText(version, { exact: true })).toBeVisible();
    expect(second.getByText("Support unconfirmed", { exact: true }).elements()).toHaveLength(2);
    expect(second.getByText("Supported for these options", { exact: true }).query()).toBeNull();
    expect(desktopApi.changeOrganization).not.toHaveBeenCalled();
    await expect
      .element(first.getByText("Synthetic assertion for presentation tests, not real gameplay."))
      .not.toBeVisible();
  },
);

it("does not describe a project declaration as a test result", async () => {
  const report = comparisonFixture();
  const candidate = report.assessment?.candidates[0];
  const observation = candidate?.evidence[0];
  if (!candidate || !observation) throw new Error("Missing comparison fixture");
  observation.evidence.kind = "upstream-declared";
  candidate.dimensions[0]!.strength_permille = 250;
  vi.mocked(desktopApi.compareGamePorts).mockResolvedValue(report);
  await render(<Fixture />);
  await userEvent.click(
    page.getByRole("button", { name: "Compare projects", exact: true }).element(),
  );
  await userEvent.click(
    page.getByText("Why this port? — Fixture project", { exact: true }).element(),
  );
  await expect.element(page.getByText("Information available", { exact: true })).toBeVisible();
  const text = page.getByRole("dialog").element().textContent;
  expect(text).toContain("Reported by the project");
  expect(text).not.toContain("Test results available");
  expect(text).not.toContain("earlier tests");
  expect(desktopApi.changeOrganization).not.toHaveBeenCalled();
});

it("uses the production controller handler to activate controls and dismiss only the comparison", async () => {
  await render(<Fixture />);
  const trigger = page.getByRole("button", { name: "Compare projects", exact: true });
  trigger.element().focus();
  await press(0);
  const dialog = page.getByRole("dialog", { name: "Compare independent projects" });
  await expect.element(dialog).toBeVisible();
  const why = page.getByText("Why this port? — Fixture project", { exact: true });
  why.element().focus();
  await press(0);
  await expect
    .element(page.getByText("Synthetic assertion for presentation tests, not real gameplay."))
    .toBeVisible();
  await press(1);
  await expect.element(dialog).not.toBeInTheDocument();
  expect(back).not.toHaveBeenCalled();
  await expect.element(trigger).toHaveFocus();
});

it("selects a displayed source edition and target platform without changing library preferences", async () => {
  await render(<Fixture />);
  await userEvent.click(page.getByRole("button", { name: "Compare projects", exact: true }));
  await userEvent.click(page.getByText("Comparison settings", { exact: true }));
  const edition = page.getByRole("combobox", { name: /Game edition/ });
  await expect.element(edition).toBeVisible();
  await userEvent.click(edition);
  await userEvent.click(page.getByRole("option", { name: "Fixture original", exact: true }));
  await expect
    .poll(() => vi.mocked(desktopApi.compareGamePorts).mock.calls.at(-1)?.[0].edition_id)
    .toBe("fixture-edition");
  const platform = page.getByRole("combobox", { name: /Target platform/ });
  await userEvent.click(platform);
  await userEvent.click(page.getByRole("option", { name: "Linux", exact: true }));
  await expect
    .poll(() => vi.mocked(desktopApi.compareGamePorts).mock.calls.at(-1)?.[0].platform)
    .toBe("linux-x86-64");
  expect(desktopApi.changeOrganization).not.toHaveBeenCalled();
  expect(vi.mocked(desktopApi.compareGamePorts).mock.calls.at(-1)?.[0].edition_id).toBe(
    "fixture-edition",
  );
});

it("resets an expanded explanation when the library scope changes", async () => {
  const screen = await render(<Fixture />);
  await userEvent.click(page.getByRole("button", { name: "Compare projects", exact: true }));
  const why = page.getByText("Why this port? — Fixture project", { exact: true });
  await userEvent.click(why);
  const explanation = page.getByText(
    "Synthetic assertion for presentation tests, not real gameplay.",
  );
  await expect.element(explanation).toBeVisible();
  await screen.rerender(<Fixture generation={2} />);
  await expect.element(why).toBeVisible();
  await expect.element(explanation).not.toBeVisible();
  await userEvent.click(why);
  await expect.element(explanation).toBeVisible();
});

it("names refresh accurately and keeps different report scope distinct from unknown features", async () => {
  const report = comparisonFixture();
  const candidate = report.assessment!.candidates[0]!;
  candidate.evidence[0]!.disposition = "historical-scope";
  candidate.dimensions[0]!.state = "unknown";
  report.assessment!.status = "insufficient-evidence";
  candidate.recommendation_eligible = false;
  vi.mocked(desktopApi.compareGamePorts).mockResolvedValue(report);
  await render(<Fixture />);
  await userEvent.click(page.getByRole("button", { name: "Compare projects", exact: true }));
  const refresh = page.getByRole("button", { name: "Refresh version information", exact: true });
  const before = vi.mocked(desktopApi.compareGamePorts).mock.calls.length;
  refresh.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => vi.mocked(desktopApi.compareGamePorts).mock.calls.length)
    .toBeGreaterThan(before);
  await expect
    .element(
      page.getByText(
        "Refreshing checks version information. It doesn’t run the game or test your device.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await userEvent.click(page.getByText("Why this port? — Fixture project", { exact: true }));
  await expect
    .element(page.getByText("For a different game, version or setup", { exact: false }))
    .toBeVisible();
  expect(page.getByRole("dialog").element().textContent).toContain("Not enough information");
  expect(page.getByText("Suggested starting point", { exact: true }).query()).toBeNull();
  expect(desktopApi.changeOrganization).not.toHaveBeenCalled();
});

it.each(["failed", "unassessed"] as const)(
  "keeps %s comparisons honest while the project remains available",
  async (state) => {
    if (state === "failed")
      vi.mocked(desktopApi.compareGamePorts).mockRejectedValue(new Error("Unavailable fixture"));
    else {
      const report = comparisonFixture();
      report.assessment = null;
      vi.mocked(desktopApi.compareGamePorts).mockResolvedValue(report);
    }
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Compare projects", exact: true }));
    await expect
      .element(
        page.getByText(
          state === "failed"
            ? "We couldn’t load this comparison. You can still open each project’s details and available actions."
            : "We don’t have a recommendation for these options yet. You can still explore each project.",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(page.getByText("Suggested starting point", { exact: true }).query()).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Refresh version information", exact: true }))
      .toBeVisible();
    expect(desktopApi.changeOrganization).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "en",
    "Update notices for Fixture project",
    "Update notices for Sibling project",
    "Update notices on",
    "Update notices off",
    "Portcove shows a notice when it finds a new download for this port. It does not install anything.",
  ],
  [
    "es",
    "Avisos de actualización de Fixture project",
    "Avisos de actualización de Sibling project",
    "Avisos de actualización activos",
    "Avisos de actualización desactivados",
    "Portcove muestra un aviso cuando encuentra una nueva descarga para esta adaptación. No instala nada.",
  ],
  [
    "ar-XB",
    "إشعارات تحديث Fixture project",
    "إشعارات تحديث Sibling project",
    "إشعارات التحديث مفعّلة",
    "إشعارات التحديث متوقفة",
    "يعرض Portcove إشعارًا عند العثور على تنزيل جديد لهذا المنفذ. لا يثبّت أي شيء.",
  ],
])(
  "keeps sibling update notices independent and explains the effect in %s",
  async (locale, firstLabel, secondLabel, on, off, effect) => {
    await initializeLocalization().changeLanguage(locale);
    await render(<Fixture siblings />);
    await page.getByRole("button", { name: "Compare projects", exact: true }).click();
    const first = page.getByRole("button", { name: firstLabel, exact: true });
    const second = page.getByRole("button", { name: secondLabel, exact: true });
    const firstEvidence = page.getByRole("region", {
      name: "Reports and updates for Fixture project",
      exact: true,
    });
    await expect.element(firstEvidence.getByText(off, { exact: true })).toBeVisible();
    await expect.element(first).toHaveAccessibleDescription(effect);
    await expect.element(second).toHaveAccessibleDescription(effect);
    await first.click();
    await expect.element(firstEvidence.getByText(on, { exact: true })).toBeVisible();
    await expect.element(first).toHaveAttribute("aria-pressed", "true");
    await expect.element(second).toHaveAttribute("aria-pressed", "false");
    await second.click();
    await expect.element(second).toHaveAttribute("aria-pressed", "true");
    await first.click();
    await expect.element(firstEvidence.getByText(off, { exact: true })).toBeVisible();
    await expect.element(first).toHaveAttribute("aria-pressed", "false");
    await expect.element(second).toHaveAttribute("aria-pressed", "true");
    expect(vi.mocked(desktopApi.changeOrganization).mock.calls.map(([, change]) => change)).toEqual(
      [
        expect.objectContaining({
          kind: "set_followed_project",
          port_id: "sample",
          followed: true,
        }),
        expect.objectContaining({
          kind: "set_followed_project",
          port_id: "sibling",
          followed: true,
        }),
        expect.objectContaining({
          kind: "set_followed_project",
          port_id: "sample",
          followed: false,
        }),
      ],
    );
  },
);
