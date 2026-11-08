# Choosing the bar

A bar is something a fresh critic can check without trusting anyone. "Make it great" is not a bar.

## Good bars, strongest first

| Kind | Example | The critic checks it by |
|---|---|---|
| A test that must pass | A test that reproduces the bug, red before the fix | Running it, then the full suite |
| A reference | The behaviour of an existing implementation, a screenshot of a product people admire, a model document | A side-by-side comparison, blind where possible |
| A measurement | p95 latency under 200 ms, a bundle under 300 kB, zero lint errors | Taking the measurement itself |
| An acceptance list | The issue's checklist, the owner's decisions | Checking each item against the running result |
| A reviewer's verdict | A project review skill that returns READY or NEEDS FIXES | Running the review on the real diff |

Combine them. For code, the default is a test, plus the full checks, plus the acceptance list, plus a blind review.

## Behaviours: the bar in checkable sentences

Write each unit's bar as **behaviours**: what a person or a system sees, not how the code does it. One sentence each, either "Given … when … then …" or "It should …":

- Given an HR admin without the permission, when they open /hr/payroll, then they get a 403 and no data.
- It should show totals in SAR with two decimals, in English and Arabic.

Record them with `S/run.mjs add <run> <unit> --behaviour "…"` (repeat the flag) or later with `S/run.mjs behave <run> <unit> --text "…"` (ids B1, B2, …; `--id B2 --text` rewords one, `--id B2 --remove` drops it). After `freeze`, rewording or removing needs `--reason`, which is logged as a bar change, and no behaviour changes while its unit is being judged: a lead cannot drop a failing behaviour to pass a unit quietly. The run's goal gets its own with `behave <run> --goal --text "…"` (G1, G2, …).

- **The critic marks every behaviour** each round: `verdict … --behaviour B1=pass:"what shows it" --behaviour B2=fail:"what is wrong"`. A pass mark needs evidence.
- **A unit cannot pass while any behaviour is failing or unchecked.** `verdict pass` is refused until each is marked pass. Likewise `integrate pass` until every goal behaviour passes.
- **A new build is checked again:** `start` sets every behaviour back to unchecked.
- **Evidence goes on the behaviour it proves:** `S/run.mjs evidence <run> <unit> --behaviour B1 --kind test --text "…"`, or `--kind screenshot --file shot.png`, or `--kind link --url …` (limits in `guardrails.md`).
- Behaviours describe outcomes. "Uses a Map" is not a behaviour; "answers in under 200 ms for 10k orders" is.
- **Closed, never open-ended.** "Catch every X", "any phrasing" or "all such messages" cannot be checked: each round the builder adds cases and the critic finds a new one, so the score falls while the work gets better. State it as a closed list of cases ("these six templates") or as "every entry in this inventory" (a file, a registry, the committed keys). If no closed set exists, it is a review question for a person, not a behaviour (`sub-skills/investigate.md`, Bound the bar).
- **`init`, `add` and `behave` say "check this line"** when the goal, a bar or a behaviour may be open-ended (`lib/openbar.mjs`). The check is narrow on purpose, since most lines with "every" or "all" name a set someone can list: it notes a quantifier (every, any, all, each) a few words before a quoted phrase ("every 'we notified' message") or a wording noun (message, claim, phrasing, wording, mention, variant), "catch every", "never … anywhere" and "any phrasing", and a guarantee with no edge: "no way to …" (or for; also path, route, means) and "nothing … unseen" (unnoticed, unreviewed, unchecked, unrecorded, unverified, slips, escapes, gets past). A goal of "no way for an operator to approve on something they did not see" cost one run 9 rounds: each fixed the reported gap, and the next critic found an adjacent, older one (#65). Write such a goal as the closed list of the person's asks. None of these is noted when the same clause names its list ("listed", "below", "these", "the following", "in the issue", an inventory, registry, manifest or a file). On the lines of 17 real runs the forms before #65 noted 2 of 158, u1213 among them. It only notes: rewrite the line, or keep it with `--accept-open`, which is recorded as a bar note.
- **Guard tests get their own unit.** A guard or invariant test (a lint rule, a "no message claims X" test) goes in a unit of its own, apart from the product fix it protects, so a guard that keeps failing cannot stop a fix that passed. When a no-progress stop finds one behaviour failing in each of the last rounds while the rest pass, its reason names that behaviour: narrow it or move it out.

## Severity: what fails a round

Every finding the critic reports carries a severity:

| Severity | Means | Round |
|---|---|---|
| high | a wrong result, data loss, a security hole, a behaviour failing | fails |
| medium | a real defect against the bar, with a workaround | fails |
| low | small and safe to fix in passing | a fold-in on a pass |
| nit | wording or style | a fold-in on a pass |

- `verdict fail` needs `--severity high|medium` for the gap, the worst of its findings. Record each FINDINGS line with `--finding "medium: …"` (repeatable, on the general and the specialist verdicts); a pass that lists a high or medium finding is refused. A fail on a low or a nit is refused: pass, and record them with `--fold "…"` (repeatable; `nit: …` or plain for a low). A fold that says high or medium, reads as serious (critical, data loss, a leak) or touches a pinned area (money, auth, security, personal data: the stems `references/routing.md` pins) is refused: that needs a round. A confirmed security finding is at least high (`sub-skills/review.md`).
- **A gap older than the change does not fail a round.** A finding that was already there on the base and is none of the unit's behaviours goes under OUT-OF-FENCE, whatever its severity, and the lead files it as a follow-up (`note --kind follow-up`). Only a regression this change causes, or a requested behaviour that fails, fails a round. A high one found this way still reaches the person in the report. Rounds failed on such gaps kept one run going until its time ran out before the finish-line question came (#65).
- **Fold-ins get a targeted check, not a new critic round.** After a pass with folds, `next` says `fold-in`. The fold must build on the head the critic reviewed (the critic's `verdict --head`, else that round's detect head, else the builder's `built --head`; only when none was recorded, `foldin --reviewed <sha>`), stay small (10 files and 200 lines since the reviewed head by default; `init --fold-max-files/--fold-max-lines`) and pass `detect.mjs --run <run> --unit <unit> --base <reviewed> --head <fold>` (the fence and gaming check, allowed in this state). The lead, or a light check, confirms only the folds and the tests they touch, then `S/run.mjs foldin <run> <unit> --head <sha> --evidence "…"`, which records the diff size. Anything bigger, off the reviewed history or outside the fence is a new round. Then `next` says `done` with `step: merge`.
- **The finish line.** When every other unit has passed or stopped, and the last open unit failed from round 2 on (or at a score of 8 or more) with medium findings at most, from the general critic and every specialist, `next` says `ask-person` with a ready question (ship with follow-ups, one more round, stop) instead of another build (`commands/run.md`, Loop). Any open high, or a finding with no severity, means a normal round, and so does a round some required specialist has not marked yet. A specialist whose mark arrives after the general fail closed the round still records it on that round (`verdict … --specialist <name>`, once, before the next `start`), and `next` weighs it.

## Rules

- **Write the bar down before building.** If it changes mid-run, record why with `run.mjs note`.
- **Every unit gets its own bar**, the part of the whole bar it owns.
- **If you can't name a bar**, the first unit is "find the bar". Its output is a bar and the reason it fits. A person approves it when the stakes are high.
- **An aspirational bar is fine**, but then the budget is the stop, and the report says how close the work came.
- **Watch for a bar that can be gamed:** tests deleted or skipped, snapshots regenerated, or the measurement changed instead of the result. The critic checks for these every round.
