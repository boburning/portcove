import { useTranslation } from "react-i18next";

export function ProvidedNestedInterpolation() {
  const { t } = useTranslation("settings");
  t("language.loadFailed", { language: "English" });
  return null;
}
