# How Layercraft learns, and how it passes that on

## 1. Tracing improvements are in the code
Everything learnt from hard pictures (FTFF, Daruma) lives in `src/trace.ts` and `src/fitcurve.ts`.
Every user gets it the next time the site is published.

## 2. Built-in lessons
- When someone taps a shape and says how it sits, the app stores a lesson in that browser only:
  nine numbers describing the shape (size, hole, lighter, dark, thin, size ratio, colour difference,
  neighbours) and the choice (higher / same sheet / lower). There are no pictures or picture fingerprints.
- Every copy of the app starts from `src/learned-defaults.json`. Local lessons then refine it on that device.
- Advanced → Fix a layer → Save my lessons downloads `layercraft-lessons.json` (numbers only).
- To fold lessons into the next release:

```
npm run bake-lessons -- layercraft-lessons.json
```

  The bake keeps a lesson set only if it's well formed, isn't contradicted by what other pictures taught,
  and keeps every test picture passing. Otherwise nothing changes. Accepted lessons are kept in
  `scripts/lessons/accepted.json`, so every bake rebuilds from the hand-written rules.

## 3. Test pictures
```
npm run test:trace
```
- FTFF photo with the AI layer map:
  - 8 sheets in the right order;
  - letter cut versus the photo's own edge: mean ≤ 0.40 px, worst 5% ≤ 1.05 px, both directions.
    It currently measures 0.33 / 0.79 px.
- FTFF and Daruma flat redraws: every sheet must still match the accepted result (≥ 99% shared area).
- After an intended improvement, check the pictures, then accept them as the new baselines:

```
npm run test:trace -- --update
```

  Tighten `LIMITS` in `tests/suite.ts` when the tracer gets better, so it can never slide back.

## 4. Community sharing, fully automatic (design, not built yet)
There's no human review. A machine decides from numbers only, and the test pictures are the referee.

1. **Opt-in sharing.** One switch: "Share my lessons with the community" (off by default). It publishes
   the lesson numbers as a Nostr app-data event (kind 30078, `d` = `layercraft/lessons/v1`).
   - The event is signed by a throwaway key made on that device, never the user's own identity, so one
     device is one contributor. It is replaceable, so a device only ever counts once.
   - It carries a small proof-of-work stamp (NIP-13), which makes flooding expensive.
   - It goes to the Torii node relay and a couple of public relays.
2. **Automatic baking.** A scheduled job on your VPS collects the events and drops malformed or
   out-of-range ones. It applies the bake rules above, plus agreement:
   - a kind of lesson is adopted only when at least 5 separate contributors agree, with no strong disagreement;
   - each contributor's weight is capped, so no single device can steer the model.
3. **Same referee.** The job runs `npm run test:trace`. A model that makes any test picture worse is thrown away.
4. **Signed community model.** A passing model is published as one replaceable event signed by the
   Layercraft publisher key (`d` = `layercraft/model/v1`, with lesson count and test scores).
   - The app, if "Use community lessons" is on, fetches it, checks the signature and the publisher key
     built into the app, and uses it as its starting point.
   - Otherwise it falls back to the built-in file. Each release also bakes the latest model into the
     built-in file.
5. **Privacy.**
   - No pictures, no picture fingerprints and no user identity are shared.
   - Fetching reveals an IP address to the relay only when the switch is on.
   - Any user can turn both switches off, and "Forget what it learnt" still wipes local lessons.

Before building this, confirm which Nostr key acts as the Layercraft publisher, and where the bake job runs.
