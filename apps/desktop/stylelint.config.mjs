export default {
  extends: ["stylelint-config-recommended"],
  rules: {
    "at-rule-no-unknown": [true, { ignoreAtRules: ["custom-variant", "slot", "theme"] }],
    "nesting-selector-no-missing-scoping-root": [true, { ignoreAtRules: ["custom-variant"] }],
    // The monolithic stylesheet deliberately orders component overrides after
    // their shared primitives; this existing cascade is not a formatting rule.
    "no-descending-specificity": null,
  },
};
