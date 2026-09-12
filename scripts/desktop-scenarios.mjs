const nativeResources = ["native-desktop", "keyboard-pointer"];

function scenario(id, description, options = {}) {
  return Object.freeze({
    id,
    description,
    runnable: true,
    prerequisites: ["desktop"],
    dependencies: [],
    host_resources: nativeResources,
    source: "desktop-test.mjs",
    ...options,
  });
}

export const DESKTOP_SCENARIOS = Object.freeze([
  scenario("empty-library", "Native bootstrap uses the isolated empty library."),
  scenario("native-error-recovery", "A rejected native operation leaves the application usable."),
  scenario("keyboard-layout", "Keyboard focus and compact layout remain usable."),
  scenario(
    "native-application-update-preferences",
    "Application update consent saves without starting update work and survives renderer reload.",
  ),
  scenario("appearance-restart", "Appearance preferences survive a real application restart.", {
    cycle_option: "restart-cycles",
  }),
  scenario("accessibility", "The native renderer passes the automated accessibility scan.", {
    source: "desktop-review-controls.mjs",
  }),
  scenario("native-controller-large-list", "Injected controller navigation handles a large list.", {
    source: "desktop-controller-test.mjs",
  }),
  scenario("native-expanded-navigation-copy", "Expanded navigation copy remains usable.", {
    source: "desktop-accessibility-test.mjs",
  }),
  scenario("native-workspace-refresh-recovery", "A failed workspace refresh recovers visibly.", {
    source: "desktop-workspace-refresh-test.mjs",
  }),
  scenario(
    "install-progress-cancellation",
    "Reviewed install progress and cancellation acceptance gap.",
    {
      runnable: false,
      reason: "Requires a reviewed install fixture; native smoke never downloads upstream games.",
      host_resources: nativeResources,
    },
  ),
  scenario("native-preparation-review-and-play", "Reviewed preparation completes before Play.", {
    prerequisites: ["desktop", "owned-fixture"],
    source: "desktop-preparation-test.mjs",
  }),
  scenario("native-missing-readiness-recovery", "Missing rendered readiness recovers safely.", {
    prerequisites: ["desktop", "owned-fixture"],
    dependencies: ["native-preparation-review-and-play"],
    source: "desktop-readiness-test.mjs",
  }),
  scenario("native-retained-contract-repair-state", "Damaged retained state routes to repair.", {
    prerequisites: ["desktop", "owned-fixture"],
    dependencies: ["native-preparation-review-and-play"],
    source: "desktop-preparation-test.mjs",
  }),
  scenario(
    "native-preparation-cancellation",
    "Preparation cancellation retains recovery evidence.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      source: "desktop-preparation-test.mjs",
    },
  ),
  scenario("native-interrupted-preparation-recovery", "Interrupted preparation recovers durably.", {
    prerequisites: ["desktop", "owned-fixture"],
    dependencies: ["native-preparation-cancellation"],
    source: "desktop-preparation-recovery-test.mjs",
  }),
  scenario(
    "native-update-settings-save-without-execution",
    "Saving update settings does not execute an update.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      dependencies: ["native-preparation-review-and-play"],
      source: "desktop-preparation-test.mjs",
    },
  ),
  scenario(
    "native-release-channel-selection-and-restart",
    "Release-channel selection survives renderer restart.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      dependencies: ["native-update-settings-save-without-execution"],
      source: "desktop-preparation-test.mjs",
    },
  ),
  scenario(
    "native-reviewed-backup-restore-and-delete",
    "Backup actions require reviewed consent.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-backup-review-test.mjs",
    },
  ),
  scenario(
    "native-reviewed-installed-game-removal",
    "Installed-game removal preserves owned data.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      dependencies: [
        "native-preparation-review-and-play",
        "native-reviewed-backup-restore-and-delete",
      ],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-removal-review-test.mjs",
    },
  ),
  scenario("native-reviewed-source-reference-removal", "Source removal remains reference-only.", {
    prerequisites: ["desktop", "owned-fixture", "native-dialog"],
    dependencies: ["native-preparation-review-and-play"],
    host_resources: [...nativeResources, "native-dialog"],
    source: "desktop-source-removal-test.mjs",
  }),
  scenario("native-reviewed-existing-install-copy", "Existing-install adoption is reviewed.", {
    prerequisites: ["desktop", "owned-fixture", "native-dialog"],
    dependencies: ["native-preparation-review-and-play"],
    host_resources: [...nativeResources, "native-dialog"],
    source: "desktop-adoption-review-test.mjs",
  }),
  scenario(
    "native-library-move-invalidates-prior-reviews",
    "Library handoff invalidates stale reviews.",
    {
      prerequisites: ["desktop", "owned-fixture"],
      dependencies: ["native-preparation-review-and-play", "native-reviewed-existing-install-copy"],
      source: "desktop-library-handoff-test.mjs",
    },
  ),
  scenario("native-contextual-cli-handoff", "The UI exposes CLI context after library handoff.", {
    prerequisites: ["desktop", "owned-fixture"],
    dependencies: ["native-library-move-invalidates-prior-reviews"],
    source: "desktop-cli-handoff-test.mjs",
  }),
  scenario(
    "native-local-artwork-picker-and-recovery",
    "Local artwork uses the native picker safely.",
    {
      prerequisites: ["desktop", "owned-fixture", "native-dialog"],
      host_resources: [...nativeResources, "native-dialog"],
      source: "desktop-artwork-test.mjs",
    },
  ),
  scenario("native-repeated-library-reload", "Repeated renderer reloads preserve native reads.", {
    cycle_option: "reload-cycles",
    source: "desktop-reload-test.mjs",
  }),
]);

const smoke = [
  "empty-library",
  "native-error-recovery",
  "keyboard-layout",
  "native-application-update-preferences",
  "appearance-restart",
  "accessibility",
  "native-controller-large-list",
  "native-expanded-navigation-copy",
  "native-workspace-refresh-recovery",
  "install-progress-cancellation",
];
const ownedLifecycle = [
  "native-preparation-review-and-play",
  "native-missing-readiness-recovery",
  "native-retained-contract-repair-state",
  "native-preparation-cancellation",
  "native-interrupted-preparation-recovery",
  "native-update-settings-save-without-execution",
  "native-release-channel-selection-and-restart",
  "native-reviewed-backup-restore-and-delete",
  "native-reviewed-installed-game-removal",
  "native-reviewed-source-reference-removal",
  "native-reviewed-existing-install-copy",
  "native-library-move-invalidates-prior-reviews",
  "native-contextual-cli-handoff",
];

export const DESKTOP_PROFILES = Object.freeze({
  smoke: Object.freeze(smoke),
  presentation: Object.freeze([
    "empty-library",
    "keyboard-layout",
    "native-application-update-preferences",
    "accessibility",
    "native-controller-large-list",
    "native-expanded-navigation-copy",
  ]),
  restart: Object.freeze(["appearance-restart", "native-workspace-refresh-recovery"]),
  artwork: Object.freeze(["native-local-artwork-picker-and-recovery"]),
  "owned-lifecycle": Object.freeze(ownedLifecycle),
  full: Object.freeze([...smoke, ...ownedLifecycle, "native-local-artwork-picker-and-recovery"]),
});

export const desktopScenarioById = new Map(DESKTOP_SCENARIOS.map((item) => [item.id, item]));

function ordered(ids) {
  const selected = new Set(ids);
  return DESKTOP_SCENARIOS.filter((item) => selected.has(item.id)).map((item) => item.id);
}

function dependencyClosure(ids) {
  const closure = new Set();
  const visit = (id, chain = []) => {
    if (chain.includes(id))
      throw new Error(`Desktop scenario dependency cycle: ${[...chain, id].join(" -> ")}`);
    const item = desktopScenarioById.get(id);
    if (!item) throw new Error(`Unknown desktop scenario dependency: ${id}`);
    for (const dependency of item.dependencies) {
      closure.add(dependency);
      visit(dependency, [...chain, id]);
    }
  };
  for (const id of ids) visit(id);
  return closure;
}

export function resolveDesktopSelection({
  profile,
  scenarios = [],
  reloadCycles = 0,
  defaultProfile = "smoke",
} = {}) {
  if (profile && scenarios.length) throw new Error("--profile and --scenario cannot be combined");
  const selectedProfile = profile ?? (scenarios.length ? null : defaultProfile);
  if (selectedProfile && !DESKTOP_PROFILES[selectedProfile])
    throw new Error(`Unknown desktop profile: ${selectedProfile}`);
  const requested = selectedProfile ? [...DESKTOP_PROFILES[selectedProfile]] : [...scenarios];
  if (!requested.length) throw new Error("Desktop verification selected no scenarios");
  if (selectedProfile && reloadCycles > 0) requested.push("native-repeated-library-reload");
  if (!selectedProfile && reloadCycles > 0 && !requested.includes("native-repeated-library-reload"))
    throw new Error(
      "--reload-cycles with exact selection requires --scenario native-repeated-library-reload",
    );
  if (requested.includes("native-repeated-library-reload") && reloadCycles < 1)
    throw new Error("native-repeated-library-reload requires --reload-cycles 1..25");
  const unknown = requested.filter((id) => !desktopScenarioById.has(id));
  if (unknown.length)
    throw new Error(`Unknown desktop scenario: ${[...new Set(unknown)].join(", ")}`);
  const uniqueRequested = ordered(requested);
  const nonRunnable = uniqueRequested.filter((id) => !desktopScenarioById.get(id).runnable);
  if (!selectedProfile && nonRunnable.length)
    throw new Error(`${nonRunnable.join(", ")} is an acceptance gap, not a runnable scenario`);
  const selected = uniqueRequested.filter((id) => desktopScenarioById.get(id).runnable);
  const dependencies = dependencyClosure(selected);
  const selectedSet = new Set(selected);
  const setup = ordered([...dependencies].filter((id) => !selectedSet.has(id)));
  const executed = new Set([...selected, ...setup]);
  const excluded = DESKTOP_SCENARIOS.filter(
    (item) => !executed.has(item.id) && !nonRunnable.includes(item.id),
  ).map((item) => item.id);
  const prerequisites = [
    ...new Set([...selected, ...setup].flatMap((id) => desktopScenarioById.get(id).prerequisites)),
  ];
  const hostResources = [
    ...new Set([...selected, ...setup].flatMap((id) => desktopScenarioById.get(id).host_resources)),
  ];
  return {
    profile: selectedProfile,
    requested_scenarios: uniqueRequested,
    selected_scenarios: selected,
    setup_scenarios: setup,
    excluded_scenarios: excluded,
    known_gaps: nonRunnable.map((id) => ({
      scenario: id,
      reason: desktopScenarioById.get(id).reason,
    })),
    prerequisites,
    host_resources: hostResources,
  };
}

export function catalogReport() {
  return DESKTOP_SCENARIOS.map((item) => ({
    ...item,
    profiles: Object.entries(DESKTOP_PROFILES)
      .filter(([, ids]) => ids.includes(item.id))
      .map(([name]) => name),
  }));
}

export function desktopHarnessDeadlineMs(selection) {
  const executed = selection.selected_scenarios.length + selection.setup_scenarios.length;
  return executed > 8 ? 10 * 60_000 : 3 * 60_000;
}
