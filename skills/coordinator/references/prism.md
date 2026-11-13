# Prism: the visual contract and its gate

Prism is a companion tool, being designed, that keeps the look of screens, game scenes and generated images consistent from one session to the next. It writes the look down in a `.prism/` folder, and its gate checks a build against it. The coordinator does not need Prism. When a project has a `.prism/` folder, the coordinator applies the three rules below. Any tool that writes the same files works the same way.

Code: `scripts/lib/prismreport.mjs` (reads the gate report), `scripts/lib/gaming.mjs` (the `visual-contract` check), `scripts/lib/doctor.mjs` (the `prism` line).

## The folder

| File | What it holds | Changed by |
|---|---|---|
| `brief.json` | What is being made (an app, a game, an image set), its domain, the screen sizes | The look-dev unit only |
| `dials.json` | The calibration numbers for the look | The look-dev unit only |
| `tokens.json` | The contract: named colours, type, spacing and radii; for a game, camera, lighting and colour grade | The look-dev unit only |
| `anchors/` | One reference image for each key screen, scene or character | The look-dev unit only |
| `assets.json` | Where each image or model came from, and its licence | Any build that adds an asset |
| `gate-report.json` | The gate's result for one commit | Never committed: add it to `.gitignore` |

The coordinator reads only `tokens.json` (its hash) and `gate-report.json`. The other names matter to `detect.mjs`.

## The three rules

1. **Lock the look before building.** When visual work starts and the project has no `.prism/tokens.json`, ask at intake, in the one batch, whether to lock the look first in a look-dev unit (`commands/run.md`, step 1.4). That unit proposes the contract, in variants on their own branches when there is a real choice, each with snapshots for the person. The person picks one, and the choice is recorded as a decision. Its detect run is allowed to change the contract, with `--allow visual-contract`, recorded with `note --kind decision`. The other visual units go `--after` it.
2. **A build never changes the contract.** `detect.mjs` flags any change to `brief.json`, `dials.json`, `tokens.json` or `anchors/`, in any folder's `.prism/`, as `visual-contract`: a FAIL, like a deleted test. A build that needs a new token or anchor stops and reports it as a question. The lead asks the person, or adds a look-dev unit.
3. **The critic runs the gate, not the builder.** A builder may run the gate as a check of its own work and attach the report while building. That report is kept and never counts. For each visual unit, add the specialist `prism` (`add --specialist prism`, or `add-specialist <run> <unit> prism --reason …`). The visual critic, in a fresh session, checks out the build's commit, runs the gate there, attaches the report, and records `verdict <run> <unit> pass|fail --specialist prism …`.

## Attaching the report

```
S/run.mjs evidence <run> <unit> --kind prism --file <worktree>/.prism/gate-report.json
```

The report is refused, with the reason, unless:

- it reads, and does not contradict itself (a PASS that lists a failed check or a fixable violation);
- it sits beside the `tokens.json` it was checked against, and the sha256 of that file matches the report's;
- while the unit is being judged, it names the commit being judged. That commit comes from `built --head <sha>`, or from this round's `detect.mjs --unit` run, so record it first.

While the unit is being judged, the latest report attached in the round decides:

- a FAIL report refuses every pass on that build, from the unit's critic and from any specialist;
- the `prism` specialist passes only on a PASS report.

The unit page shows each report: PASS or FAIL, the commit, the checks passed and the violations.

## The report the coordinator reads

```json
{
  "schema": 1,
  "status": "FAIL",
  "head": "9f2c4e1a7b3d5f6e8a0b1c2d3e4f5a6b7c8d9e0f",
  "tokensSha256": "3b1f…64 hex characters…",
  "round": 1,
  "tool": { "name": "prism", "version": "0.1.0" },
  "checks": [
    { "target": "settings", "state": "empty", "viewport": "390x844", "status": "FAIL" }
  ],
  "violations": [
    { "rule": "raw-colour", "target": "settings", "state": "empty", "viewport": "390x844", "detail": "#3a3a3a on .card is not a token", "fixable": true }
  ]
}
```

| Field | Rule |
|---|---|
| `schema` | `1` |
| `status` | `PASS` or `FAIL` |
| `head` | The full commit id the gate checked: 40 or 64 lowercase hex characters |
| `tokensSha256` | The sha256 of the bytes of the `tokens.json` the gate checked against |
| `round` | Optional: which attempt this was |
| `checks` | Optional: one entry per target, state and screen size, each with a `status` of `PASS` or `FAIL` |
| `violations` | Optional: each with a `rule`, where it applies, a `detail`, and `fixable` (true unless it says false) |

- **Consistency:** a PASS may list only violations marked `"fixable": false`, and no failed check. A FAIL must name at least one failed check or violation.
- **Unknown fields** are ignored, so a newer report still reads.
- **Masking and caps:** text is masked for secrets, and at most 20 violations are kept on the item; the file itself is stored whole.

## Doctor

`doctor` has a `prism` line:

- **skip** when the project has no `.prism/`;
- **warn** when a `.prism/` has no readable `tokens.json`, or when git tracks a `gate-report.json`;
- **ok** otherwise.

## Without Prism

A project with no `.prism/` folder sees no change. The visual critic follows `sub-skills/visual.md` as before, and nothing here is read.
