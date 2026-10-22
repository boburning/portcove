import { SettingsRow } from "./ui/patterns";
import { useId, useState } from "react";
import { useSelectReturnFocus } from "./use-select-return-focus";
import { localeOptions, useLocalization } from "../localization";
import { ChoiceSelect } from "./ChoiceSelect";

export function LanguageSettings() {
  const localization = useLocalization();
  const { choice, locale, saving, saved, error } = localization;
  const triggerId = useId();
  const [popupClosed, setPopupClosed] = useState(true);
  const requestReturnFocus = useSelectReturnFocus(triggerId, saving, popupClosed);
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
    <SettingsRow className="language-card" data-focus-group>
      <h2>{localization.t("language.title")}</h2>
      <p>{localization.t("language.description")}</p>
      <ChoiceSelect
        triggerId={triggerId}
        label={localization.t("language.pickerLabel")}
        value={choice}
        options={options}
        disabled={saving}
        onOpenChange={() => setPopupClosed(false)}
        onOpenChangeComplete={(open) => setPopupClosed(!open)}
        onChange={(nextChoice) => {
          requestReturnFocus();
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
    </SettingsRow>
  );
}
