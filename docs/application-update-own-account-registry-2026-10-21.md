# Target-account registry observation preparation

The fixed Windows account adapter launches
`scripts/native-qualification-account-registry.ps1` through its existing held
token, JobObject and captured-stream boundary. The reader accepts only the
invocation digest. It observes its own loaded hive, SID and profile and reads
the fixed HKCU Uninstall and EdgeUpdate Clients fields. Registry enumeration,
values, output and lifetime reader launches are bounded. The broker requires
the original root PID/creation identity, successful exit, empty root group and
completed captured streams before consuming the projection. Raw failures remain
in the original capture.

Installer, WebView and ordinary public-update observations retain actual HKCU
provenance with the selected account SID. They continue reading machine-wide
HKLM registration separately. Historical retained HKEY_USERS reports keep their
original interpretation; the new reader does not relabel them. Scheduler
preflight reports `hku_loaded: null`: it does not test another user's live hive.
Actual loaded-profile evidence is required from the trusted target process.

Capability configuration adds the reader to its exact `source_sha256` inventory.
There are no new credential targets, boundary fields, account privileges, ACL
grants, Task actions or runtime acceptance authorities. The existing original
parent deadline and 64-root bound remain in force. Controlled fixtures and
PowerShell parsing do not establish successful target-account execution.
The historical broker HKU AccessDenied remains a failed observation, and fresh
account/profile/GUI/registry/teardown capability remains an initial-setup test.
