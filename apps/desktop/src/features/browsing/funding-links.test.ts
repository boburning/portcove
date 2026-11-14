import { expect, it } from "vite-plus/test";
import { fundingLinks } from "./funding-links";

it("labels known platforms with their account and other sites by host", () => {
  expect(
    fundingLinks([
      "https://github.com/sponsors/first",
      "https://www.patreon.com/patron",
      "https://opencollective.com/collective",
      "https://ko-fi.com/maker",
      "https://liberapay.com/libre",
      "https://buymeacoffee.com/coffee",
      "https://paypal.me/someone",
      "https://www.paypal.com/donate?hosted_button_id=X",
      "https://github.com/owner/project#donate",
      "https://www.openttd.org/donate.html",
      "https://ko-fi.com/maker",
    ]),
  ).toEqual([
    { url: "https://github.com/sponsors/first", label: "GitHub Sponsors", account: "first" },
    { url: "https://www.patreon.com/patron", label: "Patreon", account: "patron" },
    {
      url: "https://opencollective.com/collective",
      label: "Open Collective",
      account: "collective",
    },
    { url: "https://ko-fi.com/maker", label: "Ko-fi", account: "maker" },
    { url: "https://liberapay.com/libre", label: "Liberapay", account: "libre" },
    { url: "https://buymeacoffee.com/coffee", label: "Buy Me a Coffee", account: "coffee" },
    { url: "https://paypal.me/someone", label: "PayPal", account: "someone" },
    {
      url: "https://www.paypal.com/donate?hosted_button_id=X",
      label: "PayPal",
      account: undefined,
    },
    { url: "https://github.com/owner/project#donate", label: "github.com" },
    { url: "https://www.openttd.org/donate.html", label: "openttd.org" },
  ]);
});

it("drops anything that is not a credential-free HTTPS URL", () => {
  expect(
    fundingLinks([
      "http://ko-fi.com/maker",
      "https://user:secret@example.com/",
      "javascript:alert(1)",
      "not a url",
    ]),
  ).toEqual([]);
  expect(fundingLinks(undefined)).toEqual([]);
});
