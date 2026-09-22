// This stable augmentation points i18next at the CLI-generated resource interface.
import type Resources from "./resources.generated";

declare module "i18next" {
  interface CustomTypeOptions {
    enableSelector: false;
    defaultNS: "settings";
    resources: Resources;
  }
}
