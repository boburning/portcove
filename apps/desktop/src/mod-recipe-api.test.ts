import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "./api";
import type { RecipeImportReview } from "./transport-types.generated";

afterEach(() => vi.unstubAllGlobals());

it("returns the native recipe plan unchanged through inspect, acquisition, discard and apply", async () => {
  // These valid JSON numbers change when parsed and serialized by JavaScript.
  const serialized =
    '{"recipe":{"settings":[{"value":2048.0},{"value":9007199254740993},{"value":-0.0}]},"plan_sha256":"original"}';
  const acquired = serialized.replace('"original"', '"acquired"');
  const envelope = (serialized_plan: string) => {
    const plan: unknown = JSON.parse(serialized_plan);
    return JSON.parse(
      JSON.stringify({
        plan,
        serialized_plan,
        setting_values: ["2048.0", "9007199254740993", "-0.0"],
      }),
    ) as RecipeImportReview;
  };
  const invoke = vi.fn((command: string, _args: unknown) =>
    Promise.resolve(
      command === "inspect_mod_recipe"
        ? envelope(serialized)
        : command === "acquire_mod_recipe_package"
          ? envelope(acquired)
          : undefined,
    ),
  );
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => invoke(command, args) },
  });
  const review = await desktopApi.inspectModRecipe("zelda64-recomp", "/recipe.json", 7);
  expect(JSON.stringify(review.plan)).not.toBe(serialized);
  expect(review.setting_values).toEqual(["2048.0", "9007199254740993", "-0.0"]);
  // A view projection is never sent back as mutation authority.
  review.plan.plan_sha256 = "edited display";
  const next = await desktopApi.acquireModRecipePackage(
    "zelda64-recomp",
    "profile",
    "mod.nrm",
    review,
    7,
  );
  expect(invoke).toHaveBeenLastCalledWith("acquire_mod_recipe_package", {
    portId: "zelda64-recomp",
    profileId: "profile",
    nativeId: "mod.nrm",
    serializedPlan: serialized,
    generation: 7,
  });
  await desktopApi.discardModRecipeReview("zelda64-recomp", next, 7);
  expect(invoke).toHaveBeenLastCalledWith("discard_mod_recipe_review", {
    portId: "zelda64-recomp",
    serializedPlan: acquired,
    generation: 7,
  });
  await desktopApi.applyModRecipe("zelda64-recomp", "Shared", next, 7, true);
  expect(invoke).toHaveBeenLastCalledWith("apply_mod_recipe", {
    portId: "zelda64-recomp",
    displayName: "Shared",
    serializedPlan: acquired,
    generation: 7,
    allowCode: true,
  });
});
