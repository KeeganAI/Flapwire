---
name: Bug report
about: Something Flapwire does that it shouldn't, or doesn't do that it should
labels: bug
---

**What happened**

A short description. Include the command you ran and what you expected vs. what you saw.

**To reproduce**

```sh
# the command(s) you ran
```

If the bug needs a specific upstream (e.g. a Next.js dev server, an HTTPS site), say so — and a minimal repo or container is gold if you have one.

**Environment**

- Flapwire version: `npx flapwire --version` (or the npm version installed)
- Node: `node --version`
- OS: macOS / Linux distro / Windows
- Browser or client (if relevant): Chrome 132, curl 8.7, etc.

**Output**

Paste anything Flapwire printed to stdout/stderr. The per-request log lines (`GET /foo → 200 (412ms)`) are usually the most useful.
