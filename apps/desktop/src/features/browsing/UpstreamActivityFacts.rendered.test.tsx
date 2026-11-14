import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, it } from "vite-plus/test";
import type { PortStatus, UpstreamActivity } from "../../types";
import { UpstreamActivityFacts, upstreamActivityState } from "./UpstreamActivityFacts";

const DAY = 24 * 60 * 60;
// 2026-11-13T00:00:00Z
const OBSERVED = 1_794_528_000;

function status(activity: UpstreamActivity | undefined) {
  return {
    last_update_check: { checked_at: OBSERVED, check: { upstream_activity: activity } },
  } as unknown as PortStatus;
}

beforeAll(async () => {
  const { initializeLocalization } = await import("../../localization");
  initializeLocalization(["en-US"]);
});

it("keeps an absent or dateless observation unknown", () => {
  expect(upstreamActivityState(undefined)).toBeUndefined();
  expect(upstreamActivityState({ observed_at: OBSERVED, archived: false })).toBeUndefined();
  expect(renderToStaticMarkup(<UpstreamActivityFacts status={status(undefined)} />)).toBe("");
  expect(renderToStaticMarkup(<UpstreamActivityFacts />)).toBe("");
  expect(
    renderToStaticMarkup(
      <UpstreamActivityFacts status={status({ observed_at: OBSERVED, archived: false })} />,
    ),
  ).toBe("");
});

it("explains an archived upstream before its activity date", () => {
  const markup = renderToStaticMarkup(
    <UpstreamActivityFacts
      status={status({ observed_at: OBSERVED, archived: true, last_change_at: OBSERVED - DAY })}
    />,
  );
  expect(markup).toContain("Upstream activity");
  expect(markup).toContain("archived it and no longer accept changes");
  expect(markup).toContain("new versions are unlikely");
  expect(markup).toContain("update check on November 13, 2026");
});

it("measures two quiet years at the observation, not the current clock", () => {
  const quiet = { observed_at: OBSERVED, archived: false, last_change_at: OBSERVED - 730 * DAY };
  expect(upstreamActivityState(quiet)).toBe("quiet");
  expect(upstreamActivityState({ ...quiet, last_change_at: OBSERVED - 729 * DAY })).toBe("recent");
  expect(renderToStaticMarkup(<UpstreamActivityFacts status={status(quiet)} />)).toContain(
    "No upstream changes since November 2024. New versions are unlikely unless work resumes.",
  );
});

it("shows the latest change month for an active upstream", () => {
  expect(
    renderToStaticMarkup(
      <UpstreamActivityFacts
        status={status({
          observed_at: OBSERVED,
          archived: false,
          last_change_at: OBSERVED - 40 * DAY,
        })}
      />,
    ),
  ).toContain("Last upstream change: October 2026.");
});
