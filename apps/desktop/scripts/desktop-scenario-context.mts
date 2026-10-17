import type { WebDriver } from "selenium-webdriver";

/** Ephemeral native-test observations; these fields grant no product authority. */
export interface ScenarioArtifacts {
  browser: WebDriver;
  output: string;
  artifacts: string[];
}

export interface ScenarioContext extends ScenarioArtifacts {
  scenario: (id: string, action: () => unknown) => Promise<void>;
}
