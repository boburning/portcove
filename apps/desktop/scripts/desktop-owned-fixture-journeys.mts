import type { DesktopSelection } from "../../../scripts/desktop-scenarios.mts";
type KnownGap = DesktopSelection["known_gaps"][number];
interface JourneySlots {
  browser?: unknown;
  invoke?: unknown;
  scenario?: unknown;
  library?: unknown;
  output?: unknown;
  artifacts?: unknown;
  inputs?: unknown;
  installFixture?: unknown;
  restartApplication?: unknown;
  cli?: unknown;
  tool?: unknown;
  interruptApplication?: unknown;
  closeApplication?: unknown;
  captureLivePreparation?: unknown;
  ownedGameProcess?: unknown;
  chooseOwnedLibrary?: unknown;
  chooseGameFileFolder?: unknown;
}
type Shared<Context extends JourneySlots> = {
  [Key in "browser" | "invoke" | "scenario" | "library" | "output" | "artifacts"]: Context[Key];
};
type Selected<Context extends JourneySlots, Keys extends keyof JourneySlots> = {
  [Key in Keys]: Context[Key];
};
type JourneyPlan = {
  fixtureFamilies: readonly (
    | { kind: "known-gaps"; gaps: readonly KnownGap[]; family?: undefined }
    | { kind?: undefined; family: string }
  )[];
};
interface JourneyRuntime<Context extends JourneySlots, Confirmation> {
  context: () => Context;
  recordKnownGap: (gap: KnownGap) => void;
  confirmNative: () => Confirmation;
}
export interface OwnedFixtureJourneys<Context extends JourneySlots, Confirmation> {
  install: (
    context: Shared<Context> &
      Selected<Context, "inputs" | "restartApplication"> & {
        fixture: Context["installFixture"];
        ownedGameProcess?: Context["ownedGameProcess"];
        confirmNative?: Confirmation;
      },
  ) => Promise<unknown>;
  selectedSetup: (
    context: Shared<Context> & Selected<Context, "cli"> & { fixture: Context["installFixture"] },
  ) => Promise<unknown>;
  selectedSetupCompletion: (
    context: Shared<Context> &
      Selected<Context, "cli" | "restartApplication" | "chooseGameFileFolder"> & {
        fixture: Context["installFixture"];
      },
  ) => Promise<unknown>;
  preparation: (
    context: Shared<Context> &
      Selected<
        Context,
        | "cli"
        | "tool"
        | "restartApplication"
        | "interruptApplication"
        | "closeApplication"
        | "captureLivePreparation"
        | "chooseOwnedLibrary"
      > & { confirmNative: Confirmation },
  ) => Promise<unknown>;
}
/** Consumes plan-owned order; the harness retains attempt and native authority. */
export async function runOwnedFixtureJourneys<Context extends JourneySlots, Confirmation>(
  { plan, runtime }: { plan: JourneyPlan; runtime: JourneyRuntime<Context, Confirmation> },
  journeys: OwnedFixtureJourneys<Context, Confirmation>,
) {
  for (const entry of plan.fixtureFamilies) {
    if (entry.kind === "known-gaps") {
      for (const gap of entry.gaps) runtime.recordKnownGap(gap);
      continue;
    }
    const context = runtime.context(); // Obtain the browser current at invocation.
    const shared: Shared<Context> = {
      browser: context.browser,
      invoke: context.invoke,
      scenario: context.scenario,
      library: context.library,
      output: context.output,
      artifacts: context.artifacts,
    };
    switch (entry.family) {
      case "install":
        await journeys.install({
          ...shared,
          inputs: context.inputs,
          fixture: context.installFixture,
          restartApplication: context.restartApplication,
          ...(context.ownedGameProcess
            ? { ownedGameProcess: context.ownedGameProcess, confirmNative: runtime.confirmNative() }
            : {}),
        });
        break;
      case "selected-setup":
        await journeys.selectedSetup({
          ...shared,
          cli: context.cli,
          fixture: context.installFixture,
        });
        break;
      case "selected-setup-completion":
        await journeys.selectedSetupCompletion({
          ...shared,
          cli: context.cli,
          fixture: context.installFixture,
          restartApplication: context.restartApplication,
          chooseGameFileFolder: context.chooseGameFileFolder,
        });
        break;
      case "preparation":
        await journeys.preparation({
          ...shared,
          cli: context.cli,
          tool: context.tool,
          confirmNative: runtime.confirmNative(),
          restartApplication: context.restartApplication,
          interruptApplication: context.interruptApplication,
          closeApplication: context.closeApplication,
          captureLivePreparation: context.captureLivePreparation,
          chooseOwnedLibrary: context.chooseOwnedLibrary,
        });
        break;
      default:
        throw new Error("Unknown owned fixture family: " + entry.family);
    }
  }
}
