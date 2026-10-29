import { useRef, useState } from "react";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { auditAccessibility } from "../../../test/accessibility";
import { desktopApi } from "../../api";
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
function Fixture() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const organization = useOrganization(1);
  const comparison = useGameComparison({
    portId: open ? "sample" : undefined,
    generation: 1,
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
          className="max-h-[90vh] overflow-y-auto"
        >
          <DialogTitle>Compare independent projects</DialogTitle>
          <GameComparisonControls comparison={comparison} />
          <GameComparisonEvidence
            comparison={comparison}
            portId="sample"
            organization={organization}
          />
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
    if (change.kind === "set_followed_project")
      organization = {
        ...organization,
        revision: organization.revision + 1,
        followed_port_ids: change.followed ? [change.port_id] : [],
        followed_release_acknowledgments: change.observed_identity
          ? { [change.port_id]: [change.observed_identity] }
          : {},
      };
    return globalThis.structuredClone(organization);
  });
  vi.spyOn(desktopApi, "compareGamePorts").mockImplementation(async (request) => {
    const report = comparisonFixture();
    report.required_capabilities = request.required_capabilities ?? [];
    report.ports[0]!.followed = organization.followed_port_ids.includes("sample");
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
  delete globalThis.document.documentElement.dataset.inputMode;
  vi.restoreAllMocks();
});

it("shows the shared facts, accepts keyboard requirements and keeps following explicitly opt-in", async (context) => {
  await render(<Fixture />);
  const trigger = page.getByRole("button", { name: "Compare projects", exact: true });
  trigger.element().focus();
  await userEvent.keyboard("{Enter}");
  const dialog = page.getByRole("dialog", { name: "Compare independent projects" });
  await expect.element(dialog).toBeVisible();
  await expect
    .element(page.getByText("One candidate assessed. This is not a best-port claim."))
    .toBeVisible();
  expect(desktopApi.changeOrganization).not.toHaveBeenCalled();
  const why = page.getByText("Why this port? — Fixture project", { exact: true });
  why.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByText("Synthetic assertion for presentation tests, not real gameplay."))
    .toBeVisible();
  expect(dialog.element().textContent).not.toContain("80/100");
  await auditAccessibility(
    dialog.element(),
    "recommendation-evidence-expanded-browser-fixture",
    context,
  );
  const required = page.getByRole("checkbox", { name: "Multiplayer", exact: true });
  required.element().focus();
  await userEvent.keyboard(" ");
  await expect.element(required).toBeChecked();
  await expect
    .element(page.getByText("A required capability has not been established for this exact build."))
    .toBeVisible();
  expect(
    vi.mocked(desktopApi.compareGamePorts).mock.calls.at(-1)?.[0].required_capabilities,
  ).toEqual(["multiplayer"]);
  await userEvent.click(page.getByRole("button", { name: "Follow Fixture project", exact: true }));
  await expect
    .element(page.getByRole("button", { name: "Following Fixture project", exact: true }))
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
  const edition = page.getByRole("combobox", { name: /Source edition/ });
  await expect.element(edition).toBeVisible();
  await userEvent.click(edition);
  await userEvent.click(page.getByRole("option", { name: "Fixture original", exact: true }));
  await expect
    .poll(() => vi.mocked(desktopApi.compareGamePorts).mock.calls.at(-1)?.[0].edition_id)
    .toBe("fixture-edition");
  const platform = page.getByRole("combobox", { name: /Target platform/ });
  await userEvent.click(platform);
  await userEvent.click(page.getByRole("option", { name: "Linux x64", exact: true }));
  await expect
    .poll(() => vi.mocked(desktopApi.compareGamePorts).mock.calls.at(-1)?.[0].platform)
    .toBe("linux-x86-64");
  expect(desktopApi.changeOrganization).not.toHaveBeenCalled();
  expect(vi.mocked(desktopApi.compareGamePorts).mock.calls.at(-1)?.[0].edition_id).toBe(
    "fixture-edition",
  );
});
