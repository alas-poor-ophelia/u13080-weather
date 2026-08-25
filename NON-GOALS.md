# Non-goals

What U+13080 Weather deliberately does **not** do. 

- Physical/GCM simulation, moisture transport, heightmap-driven climate.
- Self-driven multi-year climate variability (ENSO-like oscillations, random cold decades). Authored history is in: the era timeline lets you script ice ages, thaws and warm centuries as steps on the calendar, and the generator follows the script. It will not invent long-term arcs of its own.
- Continuous (non-banded) lunar/tidal scaling. v2 candidate; bands suffice for alpha.
- Accumulated ground state (snow depth, mud, days-since-rain). Consumers derive it from a range query. A deterministic rolling-window field is a possible v2 addition.
- Multiple simultaneously *active* calendars. `getReport` accepts any caller-built `TimeContext`, so consumers may use any calendar; only the convenience `now()` is single-adapter.

> **Q**: Will any of this ever change?
> **A**: During the alpha, maybe a bit. Some of these remain hard truths though, for instance this will not suddenly cease being a stochastic predictor engine and become a real simulator. After the alpha, very unlikely.
