import stylelint from "stylelint";
import type { RuleBase } from "stylelint";
const ruleName = "portcove/semantic-colors";
const rule: RuleBase<boolean, unknown> = () => (root, result) => {
  const file = root.source?.input.file?.replaceAll("\\", "/") ?? "";
  const isTokenFile = file.endsWith("/styles/tokens.css");
  root.walkDecls((declaration) => {
    const selector =
      declaration.parent?.type === "rule" && "selector" in declaration.parent
        ? declaration.parent.selector
        : "";
    if (
      isTokenFile &&
      (selector === ":root" || /^:root\[data-theme=["']light["']\]$/u.test(selector))
    )
      return;
    if (
      /#[\da-f]{3,8}\b|rgba?\s*\(|hsla?\s*\(/iu.test(declaration.value) ||
      /var\(\s*--n64-/iu.test(declaration.value)
    )
      stylelint.utils.report({
        ruleName,
        node: declaration,
        result,
        message: "Component colors must reference semantic aliases",
      });
  });
};
export default stylelint.createPlugin(
  ruleName,
  Object.assign(rule, {
    ruleName,
    messages: { rejected: "Component colors must reference semantic aliases" },
  }),
);
