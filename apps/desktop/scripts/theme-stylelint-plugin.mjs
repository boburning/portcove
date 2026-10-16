import stylelint from "stylelint";
const ruleName = "portcove/semantic-colors";
export default stylelint.createPlugin(ruleName, () => (root, result) => {
  root.walkDecls((declaration) => {
    const selector = declaration.parent.type === "rule" ? declaration.parent.selector : "";
    const file = root.source?.input.file?.replaceAll("\\", "/") ?? "";
    if (
      file.endsWith("/styles/tokens.css") &&
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
});
