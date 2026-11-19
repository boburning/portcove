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
    { url: "https://github.com/sponsors/first", label: "GitHub Sponsors", detail: "first" },
    { url: "https://www.patreon.com/patron", label: "Patreon", detail: "patron" },
    {
      url: "https://opencollective.com/collective",
      label: "Open Collective",
      detail: "collective",
    },
    { url: "https://ko-fi.com/maker", label: "Ko-fi", detail: "maker" },
    { url: "https://liberapay.com/libre", label: "Liberapay", detail: "libre" },
    { url: "https://buymeacoffee.com/coffee", label: "Buy Me a Coffee", detail: "coffee" },
    { url: "https://paypal.me/someone", label: "PayPal", detail: "someone" },
    { url: "https://www.paypal.com/donate?hosted_button_id=X", label: "PayPal" },
    { url: "https://github.com/owner/project#donate", label: "github.com" },
    { url: "https://www.openttd.org/donate.html", label: "openttd.org" },
  ]);
});

it("does not present a deeper path segment as an account name", () => {
  expect(
    fundingLinks([
      "https://www.patreon.com/join/creator",
      "https://ko-fi.com/s/a1b2c3",
      "https://github.com/sponsors/someone/dashboard",
    ]),
  ).toEqual([
    { url: "https://www.patreon.com/join/creator", label: "Patreon" },
    { url: "https://ko-fi.com/s/a1b2c3", label: "Ko-fi" },
    { url: "https://github.com/sponsors/someone/dashboard", label: "GitHub Sponsors" },
  ]);
});

it("tells apart links that would otherwise read the same", () => {
  expect(
    fundingLinks([
      "https://example.org/donate",
      "https://example.org/sponsor?tier=gold",
      "https://www.paypal.com/donate?hosted_button_id=A",
      "https://www.paypal.com/donate?hosted_button_id=B",
    ]),
  ).toEqual([
    { url: "https://example.org/donate", label: "example.org", detail: "donate" },
    {
      url: "https://example.org/sponsor?tier=gold",
      label: "example.org",
      detail: "sponsor?tier=gold",
    },
    {
      url: "https://www.paypal.com/donate?hosted_button_id=A",
      label: "PayPal",
      detail: "donate?hosted_button_id=A",
    },
    {
      url: "https://www.paypal.com/donate?hosted_button_id=B",
      label: "PayPal",
      detail: "donate?hosted_button_id=B",
    },
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
  expect(fundingLinks(null)).toEqual([]);
});
