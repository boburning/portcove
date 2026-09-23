import { useEffect, useId, useRef } from "react";
import { localeOptions, useLocalization } from "../localization";
import { ChoiceSelect } from "./ChoiceSelect";

export function LanguageSettings() {
  const localization = useLocalization();
  const { choice, locale, saving, saved, error } = localization;
  const triggerId = useId();
  const restoreFocusAfterSave = useRef(false);
  useEffect(() => {
    if (saving || !restoreFocusAfterSave.current) return;
    restoreFocusAfterSave.current = false;
    if (document.activeElement === document.body) document.getElementById(triggerId)?.focus();
  }, [saving, triggerId]);
  const options = [
    ...localeOptions.map((option) => ({
      value: option.value,
      label: localization.t(option.value === "system" ? "language.system" : "language.english"),
    })),
    ...(choice === "ar-XB"
      ? [{ value: "ar-XB" as const, label: localization.t("language.engineering") }]
      : []),
  ];
  const resolvedLanguage = localization.t(
    locale === "ar-XB" ? "language.engineering" : "language.english",
  );

  return (
    <article className="settings-card language-card" data-focus-group>
      <p className="eyebrow">{localization.t("language.eyebrow")}</p>
      <h2>{localization.t("language.title")}</h2>
      <p>{localization.t("language.description")}</p>
      <ChoiceSelect
        triggerId={triggerId}
        label={localization.t("language.pickerLabel")}
        value={choice}
        options={options}
        disabled={saving}
        onChange={(nextChoice) => {
          restoreFocusAfterSave.current = true;
          void localization.select(nextChoice);
        }}
      />
      <p>{localization.t("language.current", { language: resolvedLanguage })}</p>
      {locale === "ar-XB" && (
        <div role="note">
          <strong>{localization.t("language.previewTitle")}</strong>
          <p>{localization.t("language.previewDescription")}</p>
        </div>
      )}
      <p role="status" aria-live="polite">
        {saving
          ? localization.t("language.saving")
          : error === "load"
            ? localization.t("language.loadFailed", { language: resolvedLanguage })
            : error === "save"
              ? localization.t("language.saveFailed")
              : error === "apply"
                ? localization.t("language.applyFailed")
                : saved
                  ? localization.t("language.saved")
                  : ""}
      </p>
    </article>
  );
}
