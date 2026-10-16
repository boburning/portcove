import semanticColors from "./scripts/theme-stylelint-plugin.mjs";
export default {
  plugins: [semanticColors],
  extends: ["stylelint-config-recommended"],
  rules: {
    "portcove/semantic-colors": true,
    "function-disallowed-list": ["linear-gradient", "radial-gradient", "conic-gradient"],
    "at-rule-no-unknown": [true, { ignoreAtRules: ["custom-variant", "slot", "theme"] }],
    "nesting-selector-no-missing-scoping-root": [true, { ignoreAtRules: ["custom-variant"] }],
    // The monolithic stylesheet deliberately orders component overrides after
    // their shared primitives; this existing cascade is not a formatting rule.
    "no-descending-specificity": null,
  },
};
