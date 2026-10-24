import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";

const environments = new AsyncLocalStorage<Readonly<NodeJS.ProcessEnv>>();

/** Fixed trusted GH/Git read calls receive the captured job token, which may
 * have provider write permissions. Read-only describes code confinement, not
 * permission attenuation. Dedicated journal/App/signing secrets, OIDC bearer,
 * host config and runtime injection are stripped. Candidate/Core children must
 * instead use the credential-free payload signing environment. */
export async function withReadOnlyReleaseChildren<T>(directory: string, work: () => Promise<T>) {
  if (!path.isAbsolute(directory)) throw new Error("private read-only CLI home required");
  const token = process.env.GH_TOKEN;
  if (!token || token.length > 16384 || /[\r\n\0]/u.test(token))
    throw new Error("explicit fixed-job reader transport token required");
  const home = await mkdtemp(path.join(directory, "readonly-cli-"));
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  Object.assign(environment, {
    GH_TOKEN: token,
    GH_HOST: "github.com",
    GH_CONFIG_DIR: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  return environments.run(Object.freeze(environment), work);
}

/** Undefined retains existing callers' behavior. Explicit transports such as
 * the dedicated journal runner still set their own independent child env. */
export function readOnlyReleaseChildEnvironment(): NodeJS.ProcessEnv | undefined {
  const selected = environments.getStore();
  return selected === undefined ? undefined : { ...selected };
}
