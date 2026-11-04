/** Compiled representation of .node-version for tools that run without a checkout.
 * Renovate updates both; dependency-automation.test.mts rejects drift. */
export const controllerNodeVersion = "26.13.0";

/** Official Node 26.13.0 Linux x64 executable is 150319296 bytes.
 * Keep a finite Node-only ceiling; other tools and aggregate limits are separate. */
export const controllerNodeMaximumBytes = 160 * 1024 * 1024;
