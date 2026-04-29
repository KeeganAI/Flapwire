---
name: New profile
about: Propose a built-in profile (or send a PR adding one)
labels: profile
---

**Profile name**

Settings, not adjectives — `tokyo-metro`, `coffee-shop`, `airport-wifi`. Avoid `slow` / `fast` (we already have those).

**Lever values**

- `latency`: base ± jitter (ms). Note that jitter is the standard deviation of a normal distribution, not a uniform half-range.
- `loss.connectionDropRate`: 0–1.
- `blackout` (optional): `everySeconds`, `durationSeconds`.

**Where the numbers come from**

Real measurements beat guesses. If you watched a webpagetest run, an actual SpeedTest, or a tcpdump on a tunnel between Milano and Roma — link or paste it. Anecdotal is fine ("commute on the M3, 9am") if labelled as such.

**Why this profile is worth shipping built-in**

What does it expose that the existing four (`fast-3g`, `slow-3g`, `flaky-wifi`, `train-wifi`) don't?
