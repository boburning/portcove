import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { GameFileObservationSummary } from "./GameFileObservationSummary";
import type { GameFileObservationPresentation } from "./use-game-file-observation";
const observation: GameFileObservationPresentation = {
  lastAccepted: {
    observedAt: 1700000000,
    expiresAt: 1700000300,
    deadline: 12345,
    routes: [
      {
        port_id: "selected",
        route: "external_registration",
        platform: "linux-x86-64",
        channel: "beta",
      },
    ],
  },
  usable: false,
  expired: true,
  outcome: "accepted",
};
it("shows recorded catalog time/scope outside current matching evidence, excluding other ports", () => {
  const html = renderToStaticMarkup(
    <GameFileObservationSummary observation={observation} catalog portId="selected" />,
  );
  expect(html).toContain("Catalog check history");
  expect(html).toContain("Previous check");
  expect(html).toContain('dateTime="2023-11-14T22:13:20.000Z"');
  expect(html).toContain(new Date(1700000000000).toLocaleString());
  expect(html).toContain("Complete catalog (1 port)");
  expect(html).toContain("Existing installation setup");
  expect(html).toContain("Linux");
  expect(html).toContain("Preview");
  expect(html).toContain("Filters → Check game-file filters");
  expect(html).not.toContain("Complete set");
  expect(
    renderToStaticMarkup(
      <GameFileObservationSummary observation={observation} catalog portId="other" />,
    ),
  ).toBe("");
});
it.each(["checking", "failed", "cancelled"] as const)(
  "explains a first %s outcome without inventing history",
  (outcome) => {
    const html = renderToStaticMarkup(
      <GameFileObservationSummary
        observation={{ ...observation, lastAccepted: undefined, expired: false, outcome }}
      />,
    );
    expect(html).toContain(
      outcome === "checking"
        ? "Checking selected route"
        : outcome === "failed"
          ? "latest check failed"
          : "latest check was canceled",
    );
    expect(html).not.toContain("<time");
    expect(html).not.toContain("Previous check");
  },
);
it.each(["checking", "failed", "cancelled"] as const)(
  "pairs unexpired history with the latest %s outcome",
  (outcome) => {
    const html = renderToStaticMarkup(
      <GameFileObservationSummary
        observation={{ ...observation, expired: false, outcome }}
        catalog
      />,
    );
    expect(html).toContain("Previous check");
    expect(html).not.toContain("Last checked");
    expect(html).toContain("informational only");
  },
);
