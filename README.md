# AI Update Newsletter Watch

Claude Code, Codex, Gemini, DeepSeek, Qwen and related AI coding/model updates are checked on a schedule.

## What it does

- Checks GitHub releases, npm packages, and official changelog pages.
- Stores the last seen state in `.state/state.json`.
- Creates a GitHub issue when updates are found. People watching the repository can receive those issues by email for free.
- Sends new updates to Slack and/or Discord when webhook secrets are configured.
- Runs every 10 minutes with GitHub Actions.

Public repositories can use standard GitHub-hosted runners without consuming the private-repository Actions quota.

## Free-first setup

The default setup uses only free GitHub features:

- GitHub Actions as the scheduler.
- `.state/state.json` in the repository as the database.
- GitHub Issues as the notification archive.
- GitHub Watch notifications as the free email-like delivery channel.

This avoids paying for a database or email provider while the project is small.

## Setup

1. Create a public GitHub repository.
2. Push this project.
3. In GitHub, open `Settings -> Secrets and variables -> Actions`.
4. Optional: add one or both secrets:
   - `SLACK_WEBHOOK_URL`
   - `DISCORD_WEBHOOK_URL`
5. Open the `Actions` tab and enable workflows if GitHub asks.
6. Run `Watch AI Updates` manually once with `workflow_dispatch`.
7. Watch the repository and enable issue notifications if you want GitHub to send email notifications.

## Free email options later

If GitHub issue notifications are not enough, these are the lowest-cost next steps:

- Buttondown: simple newsletter, free for the first 100 subscribers.
- MailerLite: free plan for up to 500 subscribers and 12,000 monthly emails.
- Resend: developer API, free tier for 3,000 transactional emails per month with a 100/day limit.
- Brevo: free plan with 300 email sends per day.

Keep Slack/Discord/GitHub Issues for instant alerts, and use an email provider only for daily or weekly digests.

## Local check

```bash
npm run check:sources
```

The first run initializes state and does not notify. Later runs notify only when a watched source changes.

## Edit sources

Update `sources.json`.

Supported source types:

- `github_releases`
- `github_tags`
- `npm`
- `webpage`

## Notes

- Webpage monitoring detects page content changes by hash. It is useful but can be noisy if a site changes layout often.
- LLM summarization is intentionally not enabled by default, so the watcher does not spend API credits unless you add that later.
