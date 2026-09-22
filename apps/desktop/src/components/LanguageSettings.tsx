import { Trans } from "react-i18next";
import { localeOptions, useLocalization } from "../localization";
import { ChoiceSelect } from "./ChoiceSelect";

export function LanguageSettings() {
  const localization = useLocalization();
  const { choice, locale, saving, saved, error } = localization;
  const options = localeOptions.map((option) => ({
    value: option.value,
    label:
      option.value === "system"
        ? localization.t("language.system")
        : option.value === "en"
          ? localization.t("language.english")
          : localization.t("language.engineering"),
  }));
  const selectedLabel =
    options.find((option) => option.value === choice)?.label ?? localization.t("language.system");

  return (
    <article className="settings-card language-card" data-focus-group>
      <p className="eyebrow">{localization.t("language.eyebrow")}</p>
      <h2>{localization.t("language.title")}</h2>
      <p>{localization.t("language.description")}</p>
      <ChoiceSelect
        label={localization.t("language.pickerLabel")}
        value={choice}
        options={options}
        disabled={saving}
        onChange={(nextChoice) => void localization.select(nextChoice)}
      />
      <p>{localization.t("language.current", { language: selectedLabel })}</p>
      <p>{localization.t("language.sample", { count: locale === "ar-XB" ? 3 : 2 })}</p>
      <p>
        <Trans ns="settings" i18nKey="language.richProof" components={{ strong: <strong /> }} />
      </p>
      <p role="status" aria-live="polite">
        {saving
          ? localization.t("language.saving")
          : error
            ? localization.t("language.saveFailed")
            : saved
              ? localization.t("language.saved")
              : ""}
      </p>
    </article>
  );
}
