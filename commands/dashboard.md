---
description: Open the live dashboard of every coordinator run on this PC
argument-hint: "[--port P] | stop"
---

Use the `coordinator` skill's scripts. Run this as a normal command (it starts the dashboard detached, prints its link and exits; the dashboard keeps serving after this window closes) and show the person the link it prints:

```
node ${CLAUDE_PLUGIN_ROOT}/skills/coordinator/scripts/run.mjs dashboard --open $ARGUMENTS
```

It lists every run on this machine, across projects and tools, each linked read-only, and starts with **Needs you**: every open question of every run, with an answer form. If one is already running it prints that link and exits; `dashboard stop` stops it. Details: the dashboard section of `references/hud.md` in the `coordinator` skill.
