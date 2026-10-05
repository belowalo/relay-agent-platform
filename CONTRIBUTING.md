# Contributing to Relay

Use Node.js 22.16 or newer. Install dependencies with `npm ci`, then start the app with `npm run dev`.

Before submitting a change, run `npm run check`, `npm run test:browser`, and `npm run format:check`. Browser tests require `npx playwright install chromium`. Tests use isolated databases; the public embedding model may download on the first run.

Keep credentials in server-side connections or ignored environment files. Do not commit databases, vault keys, generated model caches, test results or account data. Add meaningful execution tests for new node/tool/provider behavior, including workspace access and cancellation where applicable.

Describe the problem, resulting behavior, validation and material limitations in a pull request. See `docs/ARCHITECTURE.md` for extension points and `docs/FEATURE-COVERAGE.md` for current scope.
