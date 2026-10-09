/** Consumes plan-owned order; the harness retains attempt and native authority. */
export async function runOwnedFixtureJourneys({ plan, runtime }, journeys) {
  for (const entry of plan.fixtureFamilies) {
    if (entry.kind === "known-gaps") {
      for (const gap of entry.gaps) runtime.recordKnownGap(gap);
      continue;
    }
    const context = runtime.context(); // Obtain the browser current at invocation.
    const shared = {
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
        });
        break;
      default:
        throw new Error("Unknown owned fixture family: " + entry.family);
    }
  }
}
