# The team: your harness's agents

The coordinator does not need a team of its own. It staffs each role from whatever the harness already offers: sub-agent types, project skills, plugins and connected tools. Over time the team gets better as the harness does, and the coordinator learns which members to call.

## Staffing the roles

At intake, look at what this harness lists: agent types, skills and connected tools. Then pick the best fit for each role, and fall back to a general-purpose agent.

| Role | Look for | Notes |
|---|---|---|
| Researcher | web search, docs lookup, design-reference tools (e.g. Mobbin) | Runs at intake, so builders start with answers |
| Builder | the project's own fix or build skill; a language-specific agent | One per unit; has its own worktree |
| Critic | a review skill; a specialist reviewer (security, accessibility, database, language) | Never the same agent instance as the builder. One critic per round. For risk areas (money, stored amounts, security, auth, migrations) add a specialist (`context.md`, rule 3) |
| Visual critic | a browser or screenshot tool; a visual-test skill; Prism's gate when the project has `.prism/` | Required for UI units. With `.prism/`, it runs the gate itself, in a fresh session (`prism.md`) |
| Integrator | a general agent with fresh context | Once all the units have passed |

Write the staffing into the run: `run.mjs note --kind decision --text "critic: security-reviewer + review skill"`.

## Working habits

- **Parallel only when it's independent.** Units that share files go to one builder. Many agents on one file just collide.
- **Briefs carry everything.** An agent sees only its brief: the goal, the bar, the fence, the references, the lessons and its exact reply format (`briefs.md`).
- **Small contexts, short lives.** A builder is closed when it reports and a fix round goes to a new agent; every agent has a token budget (`context.md`).
- **Cheapest member that clears the bar.** Mechanical builder work (docs, copy, translations, renames, fixtures, mirror changes) goes to a cheaper model; critics and the integrator always get the strong one. Follow the table in `routing.md`, record the model at `start` and `verdict` (`--model`), and check `stats` per model in the retro.
- **Reuse, don't duplicate.** If the project has a skill for a step (reviewing a PR, testing screens, writing release notes), the agent runs that skill instead of improvising. Where it has none, the built-in playbook covers the step (`sub-skills.md`).
- **Every member reports in the same shape**, so the lead can compare rounds and the retro can learn from them.

## Learning who to call

In the retro, add a lesson when a staffing choice clearly helped or hurt, for example "Security-reviewer caught the token leak the general critic missed", tagged with the domain. The next intake loads it and staffs the team accordingly.
