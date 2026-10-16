# Chrono Flash

Throwaway English-first daily IQ battery. Soft retry off on LIVE. Soft preview is unlocked — see `SOFT_UNLOCK.md`. HOLD LIVE.

## Loop

Start, clear today's six mixed-skill items, tap **Post time** to open a prefilled X compose.

One official timed run per local day. Give up records `Score —/B · DNF` and does not invent `0:00:00`.

## Run

```bash
npm install
npm test
npm run dev
```

## Pack

Day-1 ships 6 items across 5 families (pattern, verbal, spatial, logic, memory) in `src/battery.ts`. Later days reuse that pack until more days are authored. Day index 1 starts on 2026-09-17.

## Share

Primary CTA is **Post time** → `https://twitter.com/intent/tweet?text=…`.

```
Chrono Flash #N
Score A/B · 0:MM:SS
<deploy-url>
```

DNF:

```
Chrono Flash #N
Score —/B · DNF
<deploy-url>
```

No question text and no answers. Clipboard copy is fallback only if the intent is blocked.
