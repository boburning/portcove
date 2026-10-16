import semanticColors from "./scripts/theme-stylelint-plugin.mjs";
export default {
  plugins: [semanticColors],
  extends: ["stylelint-config-recommended"],
  rules: {
    "portcove/semantic-colors": true,
    "declaration-no-important": true,
    "function-disallowed-list": ["linear-gradient", "radial-gradient", "conic-gradient"],
    "at-rule-no-unknown": [true, { ignoreAtRules: ["custom-variant", "slot", "theme", "source"] }],
    "nesting-selector-no-missing-scoping-root": [true, { ignoreAtRules: ["custom-variant"] }],
  },
};
