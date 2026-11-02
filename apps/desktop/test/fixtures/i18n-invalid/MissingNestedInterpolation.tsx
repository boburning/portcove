import { useTranslation } from "react-i18next";

export function MissingNestedInterpolation() {
  const { t } = useTranslation("settings");
  t("language.loadFailed");
  return null;
}
