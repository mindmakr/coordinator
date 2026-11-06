# /coordinator status [run]

Answer "how are we getting on?" from the state, not from memory, and pick a run back up after a break.

1. Run `S/run.mjs list`. With no run named, take the most recent open one.
2. Run `S/run.mjs show <run>`. It prints the text HUD: the situation, what needs the person, a rough time left, the budget used, and each unit's status, round, score trend, last gap and next action (`references/hud.md`). If the person wants the page, start `S/run.mjs serve <run>` and give them its URL, or give them `hud.html`.
3. For each unit in `building`, check its real state (the branch head, the PR, the output file), not just the agent's last message.
4. Reply in four lines or fewer, after a context line when several pieces of work are active (`references/craft.md`):
   - what is done;
   - what is running, and who is running it;
   - what is stopped, and why;
   - whether anything needs the person. Usually nothing does: say so.
5. **Resume:** if the lead lost context, carry on with `S/run.mjs next <run>` exactly as in `run.md` step 3. The intake answers are already in the run's notes, so don't ask them again.
