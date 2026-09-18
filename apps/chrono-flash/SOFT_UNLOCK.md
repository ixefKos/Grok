# Soft unlock · pre-LIVE lock

Soft (`*.vercel.app`, `localhost`, `127.0.0.1`, `import.meta.env.DEV`, or `VITE_SOFT_UNLOCK=1`) has **day-lock OFF**. `bootSession` returns Home with Start. Reload after a run does not stick the score card.

`dayLockEnabled()` defaults **ON** for any other host (a future public LIVE domain).

## Before ANY LIVE ask / LIVE domain

1. Re-enable one-run/day · soft retry OFF (`dayLockEnabled() === true` on LIVE).
2. Verify: play → result → reload stays on score · Start gone · DNF ≠ `0:00:00` · **Post time** still works.
3. Do not merge LIVE with day-lock OFF.
