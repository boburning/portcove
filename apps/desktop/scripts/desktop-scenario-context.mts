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

/** Named IPC calls used by native scenarios; remote replies require runtime narrowing. */
export type ScenarioInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
