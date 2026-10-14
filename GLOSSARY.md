# Portcove

This glossary defines the delivery-evidence terms used by Portcove's development tooling.

## Delivery evidence

**Retained input**: A preserved copy of declared input bytes, identified at a recorded observation time. Its existence does not establish that execution consumed those bytes.
_Avoid_: Execution proof

**Build-input fingerprint**: A comparison identity for the effective inputs observed for a product build. Its completeness is a separate property.
_Avoid_: Source-head identity

**Product-artifact identity**: The identity of the actual product bytes and required resources being observed or executed.
_Avoid_: Build-input fingerprint

**Harness identity**: The identity of the declared scenario implementation and helper inputs.
_Avoid_: Product identity

**Execution/qualification binding**: The relationship between observed execution and its product, harness, runtime, fixtures, initial state, requirements and acceptance criteria.
_Avoid_: Acceptance authority

**Runtime capability observation**: An observation of an exposed runtime capability under stated conditions. API absence, access restriction, exposed devices and injected or physical behavior are distinct observations.
_Avoid_: Hardware qualification

**Settled visual capture**: A scenario-bound image of an intended visible target after its semantic readiness condition, accompanied by application-state and viewport observations.
_Avoid_: Screenshot existence

**Acceptance packet**: A bounded collection of bindings, requirements and evidence with preflight and completed stages. It records observations and review without granting acceptance or merge authority.
_Avoid_: Approval token
