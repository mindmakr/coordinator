# Credits

Author: Asif Raja, by [mindmakr](https://github.com/mindmakr).

The build, blind-critic and repeat loop at the centre of this skill comes from Matt Shumer's [write-up of the method](https://somethingbig.ai/gauntlet-loop) and his example repository, [mshumer/Claude-of-Duty](https://github.com/mshumer/Claude-of-Duty). Its core ideas are a bar the agent cannot argue its way around, giving the goal rather than the implementation, letting the agent split the work, and never letting the builder grade itself.

These ideas came from [Impeccable](https://github.com/pbakaus/impeccable) by Paul Bakaus:
- one skill made of narrow commands;
- an `init` that asks only what it cannot infer and writes a shared context file;
- a deterministic detector that needs no model.

The lessons store and the planned maps also draw on the wider, shared work on giving agents long-term memory and on running work as a graph of steps with explicit hand-offs. No single project is the source, and this project claims none of those ideas.

This project is an independent adaptation. It adds:
- the intake that asks everything up front, so the run can go unattended;
- stop rules enforced in code;
- durable run state;
- a bar-gaming detector for diffs, built on that deterministic-detector idea;
- learning across runs.
