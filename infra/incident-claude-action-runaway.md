# Bug report: `claude-code-action` has no built-in self-trigger guard → runaway billing

**Repo:** `anthropics/claude-code-action`
**Action version:** `anthropics/claude-code-action@v1`

## Summary

The commonly-documented trigger pattern — run the action on `issue_comment` /
`pull_request_review` events when the body contains a mention string like
`@claude` — has no built-in protection against **self-triggering or
bot-triggering**. The action posts its result as a comment. If that comment (or
a comment from another bot such as CodeRabbit/Copilot) contains the trigger
string, the workflow fires again, starting another **full agentic session**.
Each iteration is billed.

With the Anthropic Console **auto-reload / auto-renew** balance feature enabled,
this turned a \$20 top-up into roughly **1500 SEK (~\$140) in 6 hours** before it
was noticed — the loop repeatedly drained and auto-refilled the balance.

## Reproduction

A minimal, near-verbatim copy of the pattern shown in the action's own README:

```yaml
# .github/workflows/claude.yml
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

jobs:
  claude:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@claude'))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Trigger loop:
1. Any comment containing `@claude` starts a session.
2. The action (or another reviewing bot) posts a comment that contains the
   string `@claude` (e.g. quoting the request, or addressing the user).
3. `issue_comment: [created]` fires again → the `if` matches → a new full
   agentic session runs → billed.
4. Repeat indefinitely.

## Expected behaviour

The action should make this footgun hard to hit:

1. **Ignore events authored by itself and by bots by default** — i.e. skip when
   `github.event.comment.user.type == 'Bot'`, when the author is the GitHub App
   identity the action posts as, or `github-actions[bot]`. Today the only
   guard is whatever `if:` the user writes by hand.
2. **Document the loop risk prominently** in the README next to the trigger
   example, with a recommended author/bot exclusion in the `if:` condition.
3. **Optional built-in recursion/rate guard** — e.g. refuse to run if the same
   thread already triggered N sessions in the last M minutes.

## Impact

- Real, fast monetary loss. Agentic sessions are far more expensive per
  invocation than a single completion, and the loop has no natural stop.
- Severely amplified by Console auto-reload: the loop cannot be stopped by
  "running out of balance" because the balance auto-refills.
- The blast radius is whoever's `ANTHROPIC_API_KEY`/Console balance backs the
  workflow.

## Suggested mitigations for users (please add to docs)

- Restrict the `if:` to a trusted human author and exclude bots, e.g.
  `github.event.comment.user.login == '<owner>' && github.event.comment.user.type != 'Bot'`.
- Disable Console auto-reload, or set a hard monthly spend cap.
- Treat `@claude`-on-comment workflows as privileged automation, not a
  convenience to enable broadly.

## What we did

Removed the workflow entirely as the immediate fix. Filing this so the loop
risk is addressed in the action/docs so others don't hit it.
