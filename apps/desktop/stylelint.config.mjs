export default {
  extends: ["stylelint-config-recommended"],
  rules: {
    // The monolithic stylesheet deliberately orders component overrides after
    // their shared primitives; this existing cascade is not a formatting rule.
    "no-descending-specificity": null,
  },
};
