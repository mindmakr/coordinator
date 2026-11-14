# Craft: no slop

Anything a person reads or uses is held to a craft bar as well as the task's bar. Critics check it every round. A fail here is a FAIL, just like a failing test.

## The slop the critic rejects

| Where | Slop | What good looks like |
|---|---|---|
| Writing, copy, docs | Filler openers ("In today's fast-paced world"), hedges, "seamless/robust/leverage/delve", lists of three for rhythm, restating the question, closing summaries that add nothing | Says the specific thing first. Concrete nouns and numbers. Every sentence earns its place |
| Titles and headings | Generic ("Overview", "Dashboard", "Settings page"), clever but unclear, title case pasted everywhere | Names what the person gets or does there, in their words |
| Navigation and labels | Menus mirroring the code's structure, vague verbs ("Manage", "Process"), more than one name for one thing | Follows the person's task order. One name per thing, everywhere. Labels are verbs for actions and nouns for places |
| Prompts and agent briefs | Long role-play preambles, piled-up "IMPORTANT"s, rules that contradict each other, no output contract | Goal, bar, fence, inputs and an exact reply format. Shortest wording that leaves nothing to guess |
| UI | Default-template look: purple-to-blue gradients, cards nested in cards, everything centred, emoji as icons, grey text on colour, one font weight | A real reference followed with intent: hierarchy, spacing rhythm, contrast that passes WCAG AA, real content in the mock |

## Replies to the person

The person may be juggling several pieces of work, and reads replies between other things.

- Lead with the outcome in one sentence.
- As short as the content allows. No recap of earlier messages, no closing summary.
- When more than one piece of work is active, open with a context line naming the run or issue and the unit, such as `cw-efficiency · reviews unit`. Leave it out otherwise.
- Questions go through the question tool, never as prose, and each stands on its own in plain English: the situation, why it matters, each option as a consequence, no run jargon (`commands/run.md` step 1.7).

## UI and UX start from references, never from a blank page

1. **References first.** If the project has a `.prism/` folder, its tokens and anchors are the bar for the look, and a build may not change them (`prism.md`). If the person gave references (Mobbin flows, screenshots, Figma, a site they admire, a design system), they are the bar. Use them before anything else. If a Mobbin or design tool is connected to the harness, search it for the same flow (for example "onboarding", "settings", "checkout") in products the person respects.
2. **Otherwise research.** Search the web for 3–5 strong, current examples of the same flow, in apps or sites known for doing it well. Save the links or screenshots, and say in one line each what to take from it.
3. **Write the reference into the unit's bar:** "Matches the hierarchy and density of <ref A>; navigation follows <ref B>; our design tokens."
4. **The critic compares side by side**, blind where it can: our screen and the reference at the same size, in each text direction and at phone width.

The research is the lead's job at intake (`commands/run.md`), so builders start with the references in their brief and nobody stops mid-run to look for them.

## Checking it

- The critic reads every changed user-facing string out loud. Would a careful human writer have written it?
- Navigation: it walks the main task from entry to finish using only the labels. Any guess counts as a gap.
- One-name-per-thing: grep the changed copy for synonyms of the same concept.
- If the project has its own style guide, or a skill for writing or design, it outranks this file; this file fills the gaps.
