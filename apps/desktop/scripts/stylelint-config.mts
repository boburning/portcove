import type { Config } from "stylelint";
import semanticColors from "./theme-stylelint-plugin.mts";
export default {
  plugins: [semanticColors],
  extends: ["stylelint-config-recommended"],
  rules: {
    "portcove/semantic-colors": true,
    "declaration-no-important": true,
    "function-disallowed-list": ["linear-gradient", "radial-gradient", "conic-gradient"],
    "at-rule-no-unknown": [
      true,
      { ignoreAtRules: ["custom-variant", "slot", "theme", "source", "reference", "tailwind"] },
    ],
    "nesting-selector-no-missing-scoping-root": [true, { ignoreAtRules: ["custom-variant"] }],
  },
} satisfies Config;
