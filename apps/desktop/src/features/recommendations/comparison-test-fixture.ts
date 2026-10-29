import type { GameComparison } from "../../types";

/** Synthetic policy result for adapter/presentation tests; never actual game qualification. */
export function comparisonFixture(
  portId = "sample",
  overrides: Partial<GameComparison> = {},
): GameComparison {
  const scope = {
    game_id: "fixture-game",
    edition_id: "fixture-edition",
    port_id: portId,
    release_id: "stable:1.0",
    artifact_id: `sha256:${"a".repeat(64)}`,
    platform: "windows-x86-64" as const,
    environment_id: "fixture-environment",
    source_profile_id: "no-original-files",
    route_id: "managed:native-portable",
  };
  return {
    format_version: 1,
    policy_version: "balanced-v1",
    game_id: "fixture-game",
    edition_id: "fixture-edition",
    editions: [
      {
        id: "fixture-edition",
        title: "Fixture original",
        system: null,
        evidence_urls: ["https://example.com/fixture"],
      },
    ],
    platform: "windows-x86-64",
    environment_id: "fixture-environment",
    source_profile_ids: ["no-original-files"],
    source_context_is_hypothetical: false,
    required_capabilities: [],
    evaluated_at: 100,
    input_id: "f".repeat(64),
    ports: [
      {
        port_id: portId,
        name: "Fixture project",
        project_url: "https://example.com/fixture",
        edition_ids: ["fixture-edition"],
        declared_platforms: ["windows-x86-64"],
        source_profile_ids: [],
        metadata: "available",
        offered_release: {
          version: "1.0",
          channel: "stable",
          asset_name: "fixture.zip",
          artifact_sha256: "a".repeat(64),
          size: 42,
          published_at: null,
        },
        offered_identity: "b".repeat(64),
        freshness: {
          state: "provider-resolved",
          last_attempt_at: 100,
          last_successful_resolution_at: 100,
          offered_identity_changed_at: 100,
        },
        operation: { kind: "allowed" },
        source_health: null,
        launch_ready: false,
        installed: false,
        followed: false,
        update_notice: null,
        limitations: [],
      },
    ],
    assessment: {
      policy_version: "balanced-v1",
      evidence_snapshot_id: "f".repeat(64),
      evaluated_at: 100,
      status: "assessed-single-candidate",
      recommended: null,
      comparable: [scope],
      retained_regressions: [],
      candidates: [
        {
          scope,
          operation_eligibility: { kind: "allowed" },
          required_capabilities: {},
          dimensions: [
            {
              dimension: "gameplay",
              weight_percent: 30,
              state: "known",
              rating: 4,
              strength_permille: 1000,
              evidence_ids: ["fixture-observation"],
            },
          ],
          evidence: [
            {
              disposition: "current",
              evidence: {
                id: "fixture-observation",
                scope,
                dimension: "gameplay",
                kind: "gameplay-observed",
                claim: { kind: "rating", value: 4 },
                source: "https://example.com/fixture",
                explanation: "Synthetic assertion for presentation tests, not real gameplay.",
                observed_at: 10,
                supersedes: [],
              },
            },
          ],
          ranking_score_basis_points: 8000,
          evidence_coverage_permille: 650,
          recommendation_eligible: true,
          unresolved_regression_ids: [],
          reasons: [],
        },
      ],
    },
    limitations: [],
    ...overrides,
  };
}
