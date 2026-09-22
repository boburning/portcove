import type { TFunction } from "i18next";

declare const translate: TFunction<"settings">;

translate("language.title");
translate("language.current", { language: "English" });
translate("language.sample", { count: 2 });

// @ts-expect-error The generated catalog must reject unknown keys.
translate("language.missingKey");
