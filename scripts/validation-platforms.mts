import type { ValidationPlan, ValidationPlatform } from "./validation-plan.mts";

const platformRunners = Object.freeze({
  "linux-x86_64": "ubuntu-22.04",
  "macos-aarch64": "macos-15",
  "macos-x86_64": "macos-15-intel",
  "windows-x86_64": "windows-latest",
});

export function fastPlatformMatrix(plan: Pick<ValidationPlan, "platforms">) {
  if (!plan || !Array.isArray(plan.platforms)) throw new Error("validation platforms are missing");
  const platforms: readonly ValidationPlatform[] = plan.platforms;
  return platforms
    .filter((platform) => platform !== "primary-host")
    .map((platform) => {
      const runner = platformRunners[platform];
      if (!runner) throw new Error(`validation platform has no runner: ${platform}`);
      return { platform, runner };
    });
}

export function qualificationMatrices(plan: Pick<ValidationPlan, "platforms">) {
  const platforms = fastPlatformMatrix(plan);
  return {
    native: platforms
      .filter(({ platform }) => platform === "linux-x86_64" || platform === "macos-aarch64")
      .map((entry) => ({ ...entry, partition: "hash:1/1" })),
    docs: platforms,
  };
}
