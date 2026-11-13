/** Test-only shapes for the DOM functions Selenium serializes into its remote browser. */
declare module "selenium-webdriver/lib/atoms/get-attribute.js" {
  const getAttribute: (element: Element, name: string) => string | null;
  export default getAttribute;
}

declare module "selenium-webdriver/lib/atoms/is-displayed.js" {
  const isDisplayed: (element: Element, ignoreOpacity?: boolean) => boolean;
  export default isDisplayed;
}
