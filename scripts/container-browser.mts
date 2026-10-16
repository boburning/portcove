import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContainerHost } from "./container-host.mts";

const adapter = createContainerHost("browser");
export const {
  budgets,
  command,
  validateEngine,
  validateDesktop,
  diskFromSettings,
  linuxStorage,
  cacheBytes,
  doctor,
  selectedSource,
  runtimeArguments,
  validateRuntime,
  verifyPublication,
  saveFailure,
  browser,
  cleanup,
} = adapter;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  adapter.main().catch((error) => {
    console.error(
      JSON.stringify({
        error: error.message,
        observations: error.observations,
        observation: error.observation,
      }),
    );
    process.exitCode = error.state?.causal_exit || 1;
  });
