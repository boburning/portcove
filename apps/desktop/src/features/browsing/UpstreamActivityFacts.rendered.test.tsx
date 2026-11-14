import i18next from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, it } from "vite-plus/test";
import type { PortDefinition, PortStatus, UpstreamActivity } from "../../types";
import { UpstreamActivityFacts, upstreamActivityState } from "./UpstreamActivityFacts";

const DAY = 24 * 60 * 60;
// 2026-11-13T12:00:00Z
const OBSERVED = 1_794_571_200;
const REPOSITORY = "Owner/project";
const port = {
  release: { provider: "github", repository: REPOSITORY },
} as unknown as PortDefinition;

function status(activity: Omit<UpstreamActivity, "repository"> | undefined) {
  return {
    last_update_check: {
      checked_at: OBSERVED,
      check: { upstream_activity: activity && { repository: REPOSITORY, ...activity } },
    },
  } as unknown as PortStatus;
}

// Dates use the player's local time zone and the active interface language.
const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(i18next.language);
const month = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(i18next.language, {
    year: "numeric",
    month: "long",
  });

beforeAll(async () => {
  const { initializeLocalization } = await import("../../localization");
  initializeLocalization(["en-US"]);
});

it("keeps an absent or dateless observation unknown", () => {
  expect(upstreamActivityState(undefined)).toBeUndefined();
  expect(
    upstreamActivityState({ repository: REPOSITORY, observed_at: OBSERVED, archived: false }),
  ).toBeUndefined();
  expect(renderToStaticMarkup(<UpstreamActivityFacts port={port} />)).toBe("");
  expect(
    renderToStaticMarkup(<UpstreamActivityFacts port={port} status={status(undefined)} />),
  ).toBe("");
  expect(
    renderToStaticMarkup(
      <UpstreamActivityFacts
        port={port}
        status={status({ observed_at: OBSERVED, archived: false })}
      />,
    ),
  ).toBe("");
});

it("hides an observation of another repository or provider", () => {
  const archived = status({ observed_at: OBSERVED, archived: true });
  for (const release of [
    { provider: "github", repository: "Successor/project" },
    { provider: "gitlab", repository: REPOSITORY },
  ]) {
    const other = { release } as unknown as PortDefinition;
    expect(renderToStaticMarkup(<UpstreamActivityFacts port={other} status={archived} />)).toBe("");
  }
  const unbound = {
    last_update_check: { check: { upstream_activity: { observed_at: OBSERVED, archived: true } } },
  } as unknown as PortStatus;
  expect(renderToStaticMarkup(<UpstreamActivityFacts port={port} status={unbound} />)).toBe("");
});

it("matches the repository regardless of letter case, as GitHub does", () => {
  const recased = {
    release: { provider: "github", repository: REPOSITORY.toUpperCase() },
  } as unknown as PortDefinition;
  expect(
    renderToStaticMarkup(
      <UpstreamActivityFacts
        port={recased}
        status={status({ observed_at: OBSERVED, archived: true })}
      />,
    ),
  ).toContain("Upstream activity on GitHub");
});

it("explains an archived upstream and names who reported it when", () => {
  const markup = renderToStaticMarkup(
    <UpstreamActivityFacts
      port={port}
      status={status({ observed_at: OBSERVED, archived: true, last_change_at: OBSERVED - DAY })}
    />,
  );
  expect(markup).toContain("Upstream activity on GitHub");
  expect(markup).toContain(
    `GitHub reported on ${day(OBSERVED)} that the project&#x27;s authors archived it`,
  );
  expect(markup).toContain("New versions are unlikely.");
});

it("measures two quiet years at the observation, not the current clock", () => {
  const quiet = {
    repository: REPOSITORY,
    observed_at: OBSERVED,
    archived: false,
    last_change_at: OBSERVED - 730 * DAY,
  };
  expect(upstreamActivityState(quiet)).toBe("quiet");
  expect(upstreamActivityState({ ...quiet, last_change_at: OBSERVED - 729 * DAY })).toBe("recent");
  expect(
    renderToStaticMarkup(<UpstreamActivityFacts port={port} status={status(quiet)} />),
  ).toContain(
    `GitHub reported on ${day(OBSERVED)} that the project had not changed since ${month(quiet.last_change_at)}. New versions are unlikely unless work resumes.`,
  );
});

it("shows the latest change month for an active upstream", () => {
  const changed = OBSERVED - 40 * DAY;
  expect(
    renderToStaticMarkup(
      <UpstreamActivityFacts
        port={port}
        status={status({ observed_at: OBSERVED, archived: false, last_change_at: changed })}
      />,
    ),
  ).toContain(`that the project last changed in ${month(changed)}.`);
});
