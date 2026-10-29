export const settingsCategories = [
  { id: "appearance", label: "Appearance" },
  { id: "library-storage", label: "Library and storage" },
  { id: "game-files", label: "Game files" },
  { id: "updates", label: "Updates" },
  { id: "integrations", label: "Integrations" },
  { id: "controls", label: "Keyboard and controller" },
  { id: "advanced", label: "Advanced" },
  { id: "about", label: "About" },
] as const;

export type SettingsCategory = (typeof settingsCategories)[number]["id"];
