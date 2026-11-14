# /coordinator status [run]

Answer "how are we getting on?" from the state, not from memory, and pick a run back up after a break.

1. **First, the status.** With no run named, run `S/run.mjs status-line` and put its output first in the reply, as is: one line per run, active runs first (status word, units done and the percentage, the round in progress, the ETA, and "Needs you: …" when anything does), then the recently concluded ones with their closing lines. With a run named, run `S/run.mjs status-line <run>` and lead with that line.
2. Run `S/run.mjs show <run>` (with no run named, for the most recent active one). It prints the text HUD: the situation, what needs the person, a rough time left, the budget used, and each unit's status, round, score trend, last gap and next action (`references/hud.md`). If the person wants the page, start `S/run.mjs serve <run>` and give them its URL, or give them `hud.html`.
3. For each unit in `building`, check its real state (the branch head, the PR, the output file), not just the agent's last message.
4. After the status line(s), reply in four lines or fewer (`references/craft.md`):
   - what is done;
   - what is running, and who is running it;
   - what is stopped, and why;
   - whether anything needs the person. Usually nothing does: say so.
5. **Resume:** if the lead lost context, or this is a new window, first find out who leads the run: `S/run.mjs lead <run>`. It prints the lead, since when and when it was last active, in minutes and this PC's time. Never work out an age from a timestamp in the log.
   - **No lead, or the lead is gone:** it claims the run for this window; taking over a gone lead is logged as "took over from <id>: <why>". Do not ask; say so in one line. A lead is gone when its Claude Code window has ended and the run has seen no lead step and no unit beat for 10 minutes, or, whatever the tool, none for the run's stale minutes (45 by default) (`references/durability.md`, One lead).
   - **Another window still leads it:** leave the run to that window. Never start a second lead, a builder or a critic for it. Answer the person from `status-line` and `show` only. Take it over only after the person says yes: `S/run.mjs lead <run> --takeover --reason "<their words>"` (`references/guardrails.md`, Without asking).
   - **This window leads it** (now or after a takeover): follow the Resume steps in `references/durability.md`, run `S/run.mjs waiting` as at intake (items older than a day, at most once a day: `run.md`, Intake), then carry on with `S/run.mjs next <run>` exactly as in `run.md` step 3. The intake answers are already in the run's notes, so don't ask them again.
