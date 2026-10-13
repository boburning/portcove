// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SetupReviewSelectionProvider } from "../features/game-file-discovery/setup-review-selection";
import { portDefinition, portStatus } from "../test-fixtures";
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
  await act(async () => element.querySelectorAll<HTMLInputElement>("input")[0].click());
  await act(async () => element.querySelectorAll<HTMLInputElement>("input")[1].click());
  await act(async () => button("Review Port 0 setup").click());
  expect(open).toHaveBeenCalledWith("p0", "game-file-libraries-setup");
  await act(async () => render(false));
  await act(async () => render(true));
  expect(element.textContent).toContain("2 of 16 ports selected");
  await act(async () => render(true, false));
  expect(button("Review Port 0 setup").disabled).toBe(true);
  await act(async () => render(true, true, []));
  expect(button("Review Port 1 setup").disabled).toBe(true);
  expect(element.textContent).toContain("2 of 16 ports selected");
  await act(async () => render(true));
  await act(async () => button("Remove Port 0 from selection").click());
  expect(element.textContent).toContain("1 of 16 ports selected");
  expect(button("Review Port 1 setup").disabled).toBe(false);
});

it("bounds selection without hiding eligible ports, and replaces it with the library workspace", async () => {
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
  for (let i = 0; i < 16; i++)
    await act(async () => element.querySelectorAll<HTMLInputElement>("input")[i].click());
  expect(element.querySelectorAll("input")).toHaveLength(18);
  expect(element.querySelectorAll<HTMLInputElement>("input")[16].disabled).toBe(true);
  await act(async () => button("Remove Port 0 from selection").click());
  expect(element.querySelectorAll<HTMLInputElement>("input")[16].disabled).toBe(false);
  await act(async () => render("new"));
  expect(element.textContent).not.toContain("ports selected");
});
