# Documentation launch checklist

The Nodepod documentation site is live at
`https://r1ck404.github.io/Nodepod/`. The repository uses GitHub Pages with a
manual `workflow_dispatch` deployment while website changes remain under
review.

## Current state

- Landing page, Starlight docs, generated API reference, and reduced terminal demo are public.
- Generated API source links are recreated during every docs build and pinned to the build revision.
- The GitHub Sponsors profile (`https://github.com/sponsors/R1ck404`) is approved and public. `.github/FUNDING.yml` and the root package `funding` field point at it.

## Sponsors checklist

- Confirm the monthly tiers are published on the Sponsors dashboard: $5 Supporter, $25 Backer, and $100 Company sponsor. The site and issue template describe them.
- Confirm GitHub's custom one-time amount is enabled.
- Confirm no tier promises an SLA, priority issues, private support, or early repository access.
- Do not add an empty sponsor logo wall.

## Release checklist

1. Run `pnpm run docs:check` under Node.js 22.12 or newer.
2. Run `pnpm run docs:test` and review the Playwright report and screenshots.
3. Review the landing page, docs search, API source links, terminal demo, mobile layout, light/dark modes, and reduced motion.
4. Manually run `.github/workflows/docs-pages.yml` from `main`.
5. Verify the canonical site, docs search, API pages, terminal demo, metadata, and sponsor status.
6. Enable an automatic deployment trigger only after the manual workflow is stable and the desired change paths are agreed.
