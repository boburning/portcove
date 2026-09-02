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
