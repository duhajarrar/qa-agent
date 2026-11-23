---
title: QA Agent
emoji: ✅
colorFrom: purple
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: AI QA engineer that tests your website and writes the report
---

# QA Agent

**Find the bugs before your users do.** Pick the AI you already use, paste your API key, add your website link, and get a full HTML test report with test cases, results, bug reports, screenshots and videos.

The agent works like a senior QA engineer (see [`prompts/qa-testing-agent-prompt.md`](prompts/qa-testing-agent-prompt.md)):

1. **Learn your product:** explores the website, reads your documents, defines the business goals and the types of users (personas).
2. **Plan the tests:** writes the main end-to-end journey (you confirm it), then the test plan and test cases in this order: happy paths → edge cases → negative → look & accessibility.
3. **Test:** runs every test in a real Chromium browser. You watch it live. Happy paths run first; if one fails, it asks you whether to continue (E2E gate). Failed tests are retried once to catch flaky behavior.
4. **Report:** writes one Markdown file per bug (severity, priority, business impact, steps, screenshot, video, console errors and failed requests), a `test-plan.md`, and a self-contained `report.html` styled with your product's colors.

It stops only at four "Your turn" moments: quick questions, the main journey, the test cases, and the E2E gate. Every one has a **Use your best guess** button, and it continues on its own after 20 minutes without an answer.

## Bring your own key

Supported providers: **Claude (Anthropic), OpenAI, Gemini (Google), DeepSeek, OpenRouter, Groq**. The site never pays for AI: each user pastes their own API key.

- The key is checked by listing the models it can use. Model IDs are never hard-coded; the site picks a sensible default from the live list.
- The key lives only in server memory for the run and is deleted when the run ends. It is never logged or written to disk.
- Passwords for test logins are never sent to the AI. The model types `{{secret:Role}}` and the browser fills in the real value. Passwords are masked in the report and bug files.
- Free keys (Gemini, Groq, OpenRouter `:free` models) have daily limits, so the site suggests a **Quick** test for them.

## Run locally

Requires Node 20+.

```bash
npm install
npx playwright install chromium      # once
npm run build
npm start                            # http://localhost:7860
```

For development with hot reload, run `npm run dev:server` and `npm run dev:web` in two terminals and open http://localhost:5173.

`npm run dev:server` sets `ALLOW_PRIVATE_URLS=true` so you can test sites on `localhost`.

## Deploy free on Hugging Face Spaces

1. Create a new Space at https://huggingface.co/new-space, choose **Docker** → **Blank**.
2. Push this repository to the Space (or connect it to your GitHub repo). The front matter at the top of this README configures it (`sdk: docker`, `app_port: 7860`).
3. Wait for the build. Your site is live at `https://<user>-<space>.hf.space`.

Notes for the free CPU tier: the Space sleeps after a period without visitors and wakes on the next visit; files are temporary, so users should download their report (the zip) when the test finishes. Two tests can run at the same time by default (`MAX_CONCURRENT_RUNS`); extra tests wait in line.

Any other Docker host works too (Render, Railway, Fly.io, a VPS): build the `Dockerfile` and expose port 7860.

## Configuration

See [`.env.example`](.env.example). Everything is optional.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `7860` | HTTP port |
| `MAX_CONCURRENT_RUNS` | `2` | Tests running at once (each one runs its own browser, roughly a few hundred MB of RAM) |
| `CHECKPOINT_TIMEOUT_MIN` | `180` | The agent always waits for your answer; after this many minutes with no answer the run is stopped (never continued) |
| `RUN_TTL_HOURS` | `6` | When reports and evidence are deleted |
| `ALLOW_PRIVATE_URLS` | off | Dev only: allow `localhost` and private IPs |
| `ENABLE_MOCK_PROVIDER` | off | Dev only: scripted "Mock" AI used by the automated test |

## Safety

- Only public `http(s)` addresses can be tested: the product URL (and any redirect while checking it) must resolve to a public IP, and the browser refuses `localhost` and private IP addresses.
- The browser stays inside the product's domain (plus common login and payment providers). Navigations elsewhere are blocked and noted.
- The agent is told never to make real payments, delete real data or message real people, and to stop before final payment on production.
- Each run has an unguessable ID; reports are only reachable through it. The report is served with a sandboxing Content-Security-Policy.
- Simple per-IP rate limits protect the free server.

## Testing

```bash
npm run typecheck
npm run e2e
```

`npm run e2e` starts a small demo shop with a planted bug (`fixtures/demo-shop`: the discount code does not lower the total) and runs the whole pipeline with a scripted mock model: real browser, live frames, all four checkpoints, retry of the failing test, bug file, video, report, zip download and security checks.

## Project structure

```
server/
  index.ts           HTTP API, live updates (Server-Sent Events), file downloads
  runs.ts            run state, checkpoints ("Your turn"), queue, cleanup
  providers.ts       AI providers, key check and model list
  browser.ts         Playwright: browser tools for the AI, live view, video, evidence
  security.ts        URL checks and secret masking
  agent/pipeline.ts  the phases: learn → plan → test → report
  agent/prompts.ts   instructions built from the master prompt
  report/            report.html, bug files, test-plan.md
web/                 React website (start wizard, live run view, checkpoints)
prompts/             the master QA prompt
fixtures/demo-shop/  demo site used by the automated test
```

## Limitations and next steps

- **Web research:** the agent learns from the website and your documents. Searching the wider internet (reviews, competitors) needs a search API key and is not included yet.
- **Private sites:** a hosted server cannot reach sites behind a VPN or on your own computer.
- **Model quality:** stronger models give much better results. Free and small models make more mistakes in long browser sessions.
- **Phase 9 (automation):** generating a Playwright regression suite from the passing tests is planned for the next version.
