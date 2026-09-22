import { useTranslation } from "react-i18next";

export function InvalidLocalization() {
  const { t } = useTranslation("settings");
  t("language.notInTheCatalog");
  t("language.current", "Portcove is using {{language}}.", { wrong: "English" });
  return null;
}
