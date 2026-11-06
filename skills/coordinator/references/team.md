# The team: your harness's agents

The coordinator does not need a team of its own. It staffs each role from whatever the harness already offers: sub-agent types, project skills, plugins and connected tools. Over time the team gets better as the harness does, and the coordinator learns which members to call.

## Staffing the roles

At intake, look at what this harness lists: agent types, skills and connected tools. Then pick the best fit for each role, and fall back to a general-purpose agent.

| Role | Look for | Notes |
|---|---|---|
| Researcher | web search, docs lookup, design-reference tools (e.g. Mobbin) | Runs at intake, so builders start with answers |
| Builder | the project's own fix or build skill; a language-specific agent | One per unit; has its own worktree |
| Critic | a review skill; a specialist reviewer (security, accessibility, database, language) | Never the same agent instance as the builder. For risky areas, use two critics: a general one plus a specialist |
| Visual critic | a browser or screenshot tool; a visual-test skill | Required for UI units |
| Integrator | a general agent with fresh context | Once all the units have passed |

Write the staffing into the run: `run.mjs note --kind decision --text "critic: security-reviewer + review skill"`.

## Working habits

- **Parallel only when it's independent.** Units that share files go to one builder. Many agents on one file just collide.
- **Briefs carry everything.** An agent sees only its brief: the goal, the bar, the fence, the references, the lessons and its exact reply format (`briefs.md`).
- **Cheapest member that clears the bar.** Use a fast model or agent for mechanical units, and a strong one for judgment, critique and integration. Record which choice worked in the retro.
- **Reuse, don't duplicate.** If the project has a skill for a step (reviewing a PR, testing screens, writing release notes), the agent runs that skill instead of improvising. Where it has none, the built-in playbook covers the step (`sub-skills.md`).
- **Every member reports in the same shape**, so the lead can compare rounds and the retro can learn from them.

## Learning who to call

In the retro, add a lesson when a staffing choice clearly helped or hurt, for example "Security-reviewer caught the token leak the general critic missed", tagged with the domain. The next intake loads it and staffs the team accordingly.
