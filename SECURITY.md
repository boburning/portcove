# Security policy

Please report vulnerabilities privately to the repository maintainers rather than opening a public issue. Include the affected version, operating system, reproduction steps, expected impact, and any proof-of-concept files needed to reproduce the issue safely.

Portcove treats upstream release metadata, archive paths, filenames, and adopted directories as untrusted. Important security invariants include:

- no install without a SHA-256 digest obtained independently from the payload;
- no archived upstream repository at catalog or resolution time;
- no archive path traversal, symbolic links, or hard links;
- no execution during download or extraction;
- no deletion of user-data directories during version removal;
- no modification of the original directory during adoption;
- no bundled or uploaded copyrighted game source data;
- no release-signing private keys in the repository.
- no GitHub tokens in command arguments, SQLite, caches, logs, structured output, release downloads, or launched-game environments;
- bearer authorization is limited to the configured GitHub API origin, including across redirects;
- device authorization requires a public client ID and stores a token only after GitHub validates it.

Every production child process is created through the core-owned typed child-process policy. It starts from a reviewed operating-system/session allowlist, removes GitHub credentials plus credential-shaped token, secret, password, API-key, cloud-key, SSH-agent, and askpass variables, and then adds only the operation's checked Portcove/upstream variables. Native executables may receive literal caller arguments. Windows batch launchers receive only fixed, metacharacter-checked catalog arguments and reject caller-supplied arguments before process creation.

Install and adoption payloads are built and verified privately before same-volume publication. Removal quarantines only paths already registered inside the managed versions tree before deleting metadata. Startup recovery advances only durable, unambiguous operation states; untracked final directories are reported for review and are never automatically deleted.
