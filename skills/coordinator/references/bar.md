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

## Rules

- **Write the bar down before building.** If it changes mid-run, record why with `run.mjs note`.
- **Every unit gets its own bar**, the part of the whole bar it owns.
- **If you can't name a bar**, the first unit is "find the bar". Its output is a bar and the reason it fits. A person approves it when the stakes are high.
- **An aspirational bar is fine**, but then the budget is the stop, and the report says how close the work came.
- **Watch for a bar that can be gamed:** tests deleted or skipped, snapshots regenerated, or the measurement changed instead of the result. The critic checks for these every round.
