# Contribution conventions

Portcove uses one lightweight format for branch names, authored commits and
pull requests. The format makes intent and evidence easy to scan without
turning writing style into a merge gate. `.github/pr-conventions.json` is the
machine-readable contract; `just pr-check <number-or-url>` reports advisory
findings against a live pull request.

## Titles and authored commits

Use `type(scope): imperative summary` for pull request titles and commit
subjects. The scope is optional and names the narrowest useful area in
lowercase kebab-case.

Allowed types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`,
`ci`, `chore` and `revert`. Use `!` before the colon for an intentional breaking
change and explain the compatibility effect under **Review and risk**.

Keep the subject at 72 characters or fewer when practical and omit a trailing
period. Proper nouns may retain their normal capitalization. Examples:

```text
feat(desktop): show reviewed library transfer details
fix(core): retain source contracts after catalog updates
docs(repo): clarify release evidence
refactor!: replace the legacy public transport contract
```

Write each authored commit around one coherent change. Temporary fixup commits
may exist while a pull request is a draft, but update them to the standard
before marking it ready. Git-generated `Merge ...` and `Revert "..."` subjects
are exempt. Automated dependency pull requests retain their generated branch,
body and commit formats, while their pull request titles still follow the title
contract.

## Branches

Use a descriptive lowercase kebab-case name under one of these prefixes:

```text
feature/  fix/  docs/  test/  refactor/  performance/
build/    ci/   chore/ release/
```

For example, use `chore/pr-conventions`, not an author- or agent-specific
prefix. `dependabot/` is reserved for the dependency service.

## Pull request description

Keep the five template sections in order:

1. **Linked issue** — use `Closes`, `Fixes` or `Resolves` only when the pull
   request completes the issue; otherwise use `Refs` or `Related to`.
2. **Outcome and scope** — lead with the user or maintainer outcome, then name
   important implementation boundaries and non-goals.
3. **Verification** — list exact commands and observed results. Distinguish
   automated, packaged, physical-platform and human evidence. Use
   `Not run — <reason>` or `Not applicable — <reason>` instead of silence.
4. **Review and risk** — record the distinct final-diff review against the
   exact head commit, repairs and re-review result, important invariants, and
   documentation impact.
5. **Readiness and follow-ups** — state the live Roadmap status, merge authority,
   remaining blockers or linked follow-up issues, or `None`.

Draft pull requests may say that verification or review is pending. Before a
pull request becomes ready, update its single description with final evidence
rather than appending a second narrative. Summarize evidence in GitHub-visible
text even when detailed artifacts are retained locally. Do not claim a command,
platform, gameplay observation, review or protected action that did not occur.

The checker is intentionally advisory. A warning asks the author to improve the
metadata or explain an exception; it is not an acceptance, review, security or
merge authority and is not a required status check.
