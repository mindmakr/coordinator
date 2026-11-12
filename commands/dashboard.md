---
description: Open the live dashboard of every coordinator run on this PC
argument-hint: "[--port P] | stop"
---

Use the `coordinator` skill's scripts. Start the global dashboard as a background command and show the person the link it prints:

```
node ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/run.mjs dashboard --open $ARGUMENTS
```

It lists every run on this machine, across projects and tools, each linked read-only. If one is already running it prints that link and exits; `dashboard stop` stops it. Details: the dashboard section of `references/hud.md` in the `coordinator` skill.
