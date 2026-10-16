import { act as reactAct } from "react";

const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean | undefined;
};
let active = 0;
let previous: boolean | undefined;
let previouslyOwned = false;

// The renderer owns its own act scopes. This scope is only for controlled
// promise/event/timer batches outside renderer operations, using React's public API.
export async function controlledAct<T>(callback: () => T | Promise<T>) {
  if (active++ === 0) {
    previous = environment.IS_REACT_ACT_ENVIRONMENT;
    previouslyOwned = Object.hasOwn(environment, "IS_REACT_ACT_ENVIRONMENT");
  }
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await reactAct(callback);
  } finally {
    if (--active === 0) {
      if (previouslyOwned) environment.IS_REACT_ACT_ENVIRONMENT = previous;
      else delete environment.IS_REACT_ACT_ENVIRONMENT;
    }
  }
}
