# Contributing to Flapwire

Thanks for taking a look. Flapwire is a side project with one maintainer, so the loop is small but real — bug reports get read, PRs get reviewed, and the project's direction is open to discussion.

The contributions most likely to land quickly are **new profiles** and **focused bug fixes**. Larger architectural changes are best discussed in an issue first; the masterplan still has a lot of yet-to-arrive features (config files, admin API, UI, bandwidth throttling) and a PR that conflicts with that plan won't merge no matter how good the code is.

## Running the project locally

You need Node 22 or newer.

```sh
npm install
npm run dev          # tsup --watch — rebuilds dist/ on every change
npm test             # vitest
npm run lint         # biome
npm run typecheck    # tsc --noEmit
```

Once `dist/` is built you can run the binary directly:

```sh
node dist/cli.js --target http://localhost:3000 --profile flaky-wifi
```

For HTTPS work, `flapwire trust` writes a local CA to `~/.config/flapwire/`. It's safe to run; `flapwire trust --uninstall` undoes it.

## Adding a new profile

Profiles live in [src/profiles.ts](src/profiles.ts). Each one is a `ProxyProfile` with optional `latency`, `loss`, and `blackout`. The README has a "How the levers work" section that spells out exactly what each lever does given its config values — match that mental model when picking numbers, otherwise the profile won't feel realistic.

Things that help a profile PR land:

- **Real-world reference.** Where did the numbers come from? "Tested on a train between Milano and Roma" beats "feels right".
- **A clear name.** Same convention as the existing four (`fast-3g`, `train-wifi`, etc.) — a setting, not an adjective.
- **A test.** Add an entry in [src/profiles.test.ts](src/profiles.test.ts).
- **A row in the README profile table.**

## Writing a test

Tests use [vitest](https://vitest.dev). The pattern is "one file per source file": `src/foo.ts` → `src/foo.test.ts`. The proxy itself is exercised end-to-end (real HTTP servers on random ports) — that style is in [src/proxy.test.ts](src/proxy.test.ts) and [src/proxy.https.test.ts](src/proxy.https.test.ts). For pure functions, just import and assert.

If you're touching the proxy core, run the full suite locally first — some interactions (blackout reaper, WebSocket upgrade, TLS termination) only show up when everything talks to everything.

## Commits and PRs

- Commit messages are written by hand. The first line is a short summary, the body explains the *why* if it isn't obvious.
- One commit per logical change is preferred. Squash if the PR ends up noisy.
- The CHANGELOG is updated by hand on the maintainer's side at release time. You don't need to touch it in a PR.
- Don't add `Co-Authored-By` trailers from AI assistants.

## What probably won't merge

- Architectural changes that conflict with the masterplan (HTTPS in v0.2, UI in v0.3, CI integration in v0.4) — open an issue first.
- Dependency churn for its own sake (formatter swaps, build-tool swaps, monorepo conversions).
- "Cleanup" PRs that touch lots of files for cosmetic gain.

## Code of conduct

Be decent. If something feels off in an interaction, say so — quietly, in private if you'd rather. The maintainer would much rather hear "this comment came across rougher than I think you meant" than have someone leave.
