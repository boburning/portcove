import { isRecord } from "./runtime-values.mts";

export const controllerTagPatterns = [
  "refs/tags/portcove-production-controller-*",
  "refs/tags/portcove-upstream-rehearsal-*",
  "refs/tags/portcove-controller-canary-*",
] as const;

export const releaseOwner = {
  actor_type: "User",
  actor_id: 43177418,
  bypass_mode: "always",
} as const;

export function matchesControllerTagPattern(pattern: string, ref: string) {
  // GitHub uses fnmatch with FNM_PATHNAME. The only supported patterns are
  // these literal prefixes with a single trailing star in the same component.
  const prefix = pattern.slice(0, -1);
  return (
    controllerTagPatterns.some((allowed) => allowed === pattern) &&
    ref.startsWith(prefix) &&
    !ref.slice(prefix.length).includes("/")
  );
}

export function activeRefRuleset(rule: unknown, target: "branch" | "tag", ref: string) {
  if (
    !isRecord(rule) ||
    rule.target !== target ||
    rule.enforcement !== "active" ||
    !isRecord(rule.conditions) ||
    Object.keys(rule.conditions).length !== 1 ||
    !isRecord(rule.conditions.ref_name) ||
    Object.keys(rule.conditions.ref_name).length !== 2 ||
    !Array.isArray(rule.conditions.ref_name.include) ||
    !Array.isArray(rule.conditions.ref_name.exclude) ||
    rule.conditions.ref_name.exclude.length !== 0 ||
    !Array.isArray(rule.rules) ||
    !Array.isArray(rule.bypass_actors)
  ) {
    return undefined;
  }
  const includes: unknown[] = rule.conditions.ref_name.include;
  const exact = target === "tag" ? /^refs\/tags\/[^*?[\\]+$/u : /^refs\/heads\/[^*?[\\]+$/u;
  if (
    !includes.every(
      (include) =>
        typeof include === "string" &&
        (exact.test(include) ||
          (target === "tag" && controllerTagPatterns.some((pattern) => pattern === include))),
    ) ||
    !includes.some(
      (include) =>
        typeof include === "string" &&
        (include === ref || (target === "tag" && matchesControllerTagPattern(include, ref))),
    )
  ) {
    return undefined;
  }
  return {
    id: rule.id,
    rules: rule.rules as unknown[],
    actors: rule.bypass_actors as unknown[],
    includes: includes as string[],
  };
}

export function hasOnlyRules(rules: readonly unknown[], types: readonly string[]) {
  return (
    rules.length === types.length &&
    types.every((type) =>
      rules.some((rule) => isRecord(rule) && rule.type === type && Object.keys(rule).length === 1),
    )
  );
}

export function hasOnlyActor(
  actors: readonly unknown[],
  expected: { actor_type: string; actor_id: number; bypass_mode: string },
) {
  const actor = actors[0];
  return (
    actors.length === 1 &&
    isRecord(actor) &&
    actor.actor_type === expected.actor_type &&
    actor.actor_id === expected.actor_id &&
    actor.bypass_mode === expected.bypass_mode
  );
}

export function hasControllerTagProtection(rulesets: readonly unknown[], ref: string) {
  const applicable = rulesets.flatMap((rule) => {
    const active = activeRefRuleset(rule, "tag", ref);
    return active ? [active] : [];
  });
  // The old all-three restriction is valid only for exact refs. Applying
  // creation with no bypass to a namespace prevents provisioning successors.
  const legacy = applicable.some(
    ({ actors, includes, rules }) =>
      actors.length === 0 &&
      includes.every((include) => !include.endsWith("*")) &&
      hasOnlyRules(rules, ["creation", "update", "deletion"]),
  );
  if (legacy) return true;

  return (
    applicable.some(
      ({ actors, rules }) => actors.length === 0 && hasOnlyRules(rules, ["update", "deletion"]),
    ) &&
    applicable.some(
      ({ actors, rules }) =>
        hasOnlyActor(actors, releaseOwner) && hasOnlyRules(rules, ["creation"]),
    )
  );
}
