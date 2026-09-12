# Wellio application

TanStack Start + React + TypeScript + HeroUI + Tailwind. This is the runnable frontend collaboration baseline, including its current Node/SQLite compatibility services. FastAPI business services are being migrated separately; CopilotKit / Python Agent integration follows later.

## Development

Use Node >=22.13 (verified with 22.15).

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3100/today . Routes: `/today`, `/agent`, `/trends`, `/profile`, `/workout`. Change interface language in Profile. All selected artwork is included in `public/assets`.

`VITE_WELLIO_PREVIEW=1 npm run dev` explicitly enables a visual-only adapter for isolated frontend work. It does not provide AI, recognition, search or persistence. Production always uses HTTP services.

## Verification and production

```sh
npm run typecheck
npm test
npm run build
PORT=3100 HOST=127.0.0.1 npm start
```

Browser checks require a production build and Chromium:

```sh
npx playwright install chromium
npm run test:e2e
```

Playwright starts and stops its own isolated server on port 3101. `PLAYWRIGHT_EXECUTABLE_PATH` may point to an installed Chromium. Tests use controlled responses for candidate and failure states; they do not prove a live model connection.

`npm run test:backend:production` checks real HTTP and SQLite persistence across process restarts after building. The current backend unit suite uses the AI SDK tool runtime with an official test model and injected transports, not paid live model calls.

## Current API and storage

The UI calls `/api/state`, `/api/actions`, `/api/chat` and `/api/attachments`; shared camelCase contracts are in `src/lib/contracts.ts`. Agent events use application NDJSON. Only saved snapshots and explicit operation receipts update business state.

Until FastAPI integration is ready, `src/server` serves the app using Node SQLite. Data defaults to `.data/wellio.sqlite`, with private attachments beside it. Do not commit the runtime directory. See [collaboration notes](../CONTRIBUTING.md) before changing interfaces or replacing the server.

## Optional server configuration

Copy `.env.example` to a private `.env`. AI requires all of `WELLIO_AI_MODEL`, `WELLIO_AI_PROTOCOL` (`responses` or `chat`) and `LOVABLE_API_KEY`. No model or key is provided. Use a model/gateway combination that supports tools, images and structured output.

Explicitly load server configuration:

```sh
node --env-file=.env ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3100
# After building:
PORT=3100 HOST=127.0.0.1 node --env-file=.env .output/server/index.mjs
```

These values are server-only; never prefix credentials with `VITE_`. The default AI gateway is `https://ai.gateway.lovable.dev/v1`; an explicit override must use HTTPS. Missing configuration reports `capabilities.agent=false` and `PROVIDER_NOT_CONFIGURED`. Local records and existing training operations remain available; no fixture AI answers replace unavailable service responses.

Optional managed menu search uses `WELLIO_LOVABLE_FIRECRAWL_ENDPOINT` and `WELLIO_LOVABLE_FIRECRAWL_TOKEN`. The actual connector must be configured and verified separately. Cloud deployment, a live model connection and the pending Python migration are not established by the local test results.

Known UI follow-up: Today currently renders training/food suggestions only when a valid result exists; its unavailable state needs a persistent visible AI suggestion area. This upload preserves the current runnable UI rather than introducing an unreviewed design change.
