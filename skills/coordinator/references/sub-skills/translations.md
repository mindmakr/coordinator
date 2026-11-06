# translations: every locale, every key, a real translation

**When:** a builder adds or edits user-facing strings (with `fix.md`); a critic checks a unit that changed strings; or a run adds a language.

**Inputs:** the locale folders, base locale, file format, and anything marked copy-under-approval in `COORDINATOR.md`; the changed keys from the diff.

**In the loop:** the builder brief adds it when the unit changes strings; the critic brief adds its check. The integrator runs the parity check once across the whole run.

## Parity rules

For every locale the project lists:

- **every key** in the base exists in each locale, and no locale has keys the base lacks;
- **the same placeholders** and plural or select branches as the base;
- **a real translation:** a value identical to the base is untranslated, unless it is a brand name, a code, a unit or a number;
- **no empty values**, and every file parses.

Use the project's own parity check if it has one. Otherwise compare the key sets and placeholders with a short script and paste its counts.

## Builder steps

1. Add every new key to every locale in the same change, with the base's placeholders.
2. In each file you edit, move visible text that is not behind a key into keys.
3. For many keys, give each locale's missing keys to one translator agent per locale (never one agent per file), then check parity again.
4. Delete keys no code uses, or add them to the base if code does.
5. Check right-to-left locales on the running screens (`visual.md`).

## Copy under approval

When the project routes wording through its own approval (a copy store, a maker-checker step, a content team), new or changed copy is marked as awaiting approval in that process, and any claim it makes is flagged for the approver. The wording itself is the approver's call: a critic does not fail the unit on it, and nobody writes strict tests on wording nuance. Parity and placeholders still apply.
## Critic check

Run the parity check on the head. Missing, extra, empty, unparsable or placeholder-mismatched keys are a FAIL. Values identical to the base are a FAIL only for keys this unit added.

## Output

Builder: one row per locale with its parity counts, in the report. Critic: the reply from `briefs.md`, with the parity output in EVIDENCE.
