import { describe, expect, it } from "vite-plus/test";
import type { GithubAuthStatus, UpdateCheckForecast } from "../../types";
import { signInOfferFor } from "./use-update-center";

const forecast = (counted: number, relief: number): UpdateCheckForecast => ({
  games: 10,
  counted_requests: counted,
  sign_in_relief_requests: relief,
});
const auth = (authenticated: boolean, remaining: number | null): GithubAuthStatus => ({
  source: "anonymous",
  authenticated,
  login: null,
  device_login_available: true,
  rate_limit: remaining === null ? null : { limit: 60, remaining, resets_at: 1 },
});

describe("sign-in offer before a bulk update check", () => {
  it("offers sign-in only when the forecast outruns the remaining anonymous allowance", () => {
    expect(signInOfferFor(forecast(30, 30), auth(false, 12))).toEqual({
      countedRequests: 30,
      remainingRequests: 12,
    });
    expect(signInOfferFor(forecast(10, 10), auth(false, 12))).toBeUndefined();
    expect(signInOfferFor(forecast(12, 12), auth(false, 12))).toBeUndefined();
  });

  it("never offers when sign-in cannot help, is already done, or the allowance is unknown", () => {
    expect(signInOfferFor(forecast(30, 0), auth(false, 12))).toBeUndefined();
    expect(signInOfferFor(forecast(30, 30), auth(true, 12))).toBeUndefined();
    expect(signInOfferFor(forecast(30, 30), auth(false, null))).toBeUndefined();
  });
});
