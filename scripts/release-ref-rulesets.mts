import { isRecord } from "./runtime-values.mts";

export const controllerTagPatterns = [
  "refs/tags/portcove-production-controller-*",
  "refs/tags/portcove-upstream-rehearsal-*",
  "refs/tags/portcove-controller-canary-*",
] as const;

/** Coordinator namespaces whose preparation receipts are allocation authority.
 * Receipt names are slash-separated (`<namespace>-prepared/v<version>` and
 * `<namespace>-prepared-source/<source commit>`), so each pattern's trailing
 * star covers exactly one path component under GitHub's fnmatch matching. */
export const receiptTagNamespaces = ["portcove-production"] as const;

export function receiptTagPatterns(namespace: string) {
  if (!receiptTagNamespaces.some((known) => known === namespace))
    throw new Error("receipt tag protection is defined only for ratified coordinator namespaces");
  return [`refs/tags/${namespace}-prepared/*`, `refs/tags/${namespace}-prepared-source/*`] as const;
}

export const receiptTagPatternList: readonly string[] =
  receiptTagNamespaces.flatMap(receiptTagPatterns);

/** The existing release state writer App. Coordinator checkpoints create
 * receipts in the same atomic ref transaction that advances
 * `refs/heads/portcove-production-coordinator-state`, which only this App may
 * update, so no other actor can create a receipt through a valid checkpoint. */
export const releaseReceiptWriter = {
  actor_type: "Integration",
  actor_id: 5632044,
  bypass_mode: "always",
} as const;

/** GitHub fnmatch with FNM_PATHNAME for the supported literal-prefix patterns:
 * the trailing star matches one non-empty component that contains no `/`. */
export function matchesReceiptTagPattern(pattern: string, ref: string) {
  const prefix = pattern.slice(0, -1);
  const rest = ref.slice(prefix.length);
  return (
    receiptTagPatternList.includes(pattern) &&
    ref.startsWith(prefix) &&
    rest.length > 0 &&
    !rest.includes("/")
  );
}

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
          (target === "tag" &&
            (controllerTagPatterns.some((pattern) => pattern === include) ||
              receiptTagPatternList.includes(include)))),
    ) ||
    !includes.some(
      (include) =>
        typeof include === "string" &&
        (include === ref ||
          (target === "tag" &&
            (matchesControllerTagPattern(include, ref) || matchesReceiptTagPattern(include, ref)))),
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

/** Receipt tags of one namespace are immutable for everyone (update and
 * deletion denied, no bypass actor) and only the release state writer App may
 * create one. Both receipt patterns must be covered; any weaker or missing
 * policy fails closed. Additional active restrictions only narrow access. */
export function hasReceiptTagProtection(rulesets: readonly unknown[], namespace: string) {
  const [versions, sources] = receiptTagPatterns(namespace);
  // A real-shaped name under each prefix selects the applicable policies; each
  // must name the namespace pattern itself, so a policy for one exact receipt
  // cannot stand in for the whole namespace.
  const examples = [
    [versions, `${versions.slice(0, -1)}v0.1.0-alpha.3`],
    [sources, `${sources.slice(0, -1)}${"0".repeat(40)}`],
  ] as const;
  return examples.every(([pattern, ref]) => {
    const applicable = rulesets.flatMap((rule) => {
      const active = activeRefRuleset(rule, "tag", ref);
      return active && active.includes.includes(pattern) ? [active] : [];
    });
    return (
      applicable.some(
        ({ actors, rules }) => actors.length === 0 && hasOnlyRules(rules, ["update", "deletion"]),
      ) &&
      applicable.some(
        ({ actors, rules }) =>
          hasOnlyActor(actors, releaseReceiptWriter) && hasOnlyRules(rules, ["creation"]),
      )
    );
  });
}
