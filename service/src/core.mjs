// The one place the service reaches into the skill. Event schema, log parsing,
// replay, rules, the plain-language view and the page renderers are the skill's
// own (MIT, Node built-ins only), so a run looks and validates the same in the
// terminal, on the local dashboard and here. Nothing is copied: the container
// image carries skills/coordinator/scripts/lib at the same relative path.
export { parseLog, replay, canonical, sha256 } from '../../skills/coordinator/scripts/lib/events.mjs';
export { validateEvent, validRun, KINDS, V } from '../../skills/coordinator/scripts/lib/eventschema.mjs';
export { decide } from '../../skills/coordinator/scripts/lib/rules.mjs';
export { view as runView } from '../../skills/coordinator/scripts/lib/view.mjs';
export { hud } from '../../skills/coordinator/scripts/lib/hud.mjs';
export { unitPage } from '../../skills/coordinator/scripts/lib/unitpage.mjs';
export { selfModel } from '../../skills/coordinator/scripts/lib/self.mjs';
export { selfPage } from '../../skills/coordinator/scripts/lib/selfpage.mjs';
export { page, chip, stamp, blk, esc } from '../../skills/coordinator/scripts/lib/parts.mjs';
export { maskSecrets } from '../../skills/coordinator/scripts/lib/secrets.mjs';
export { mapPage as projectMapPage } from '../../skills/coordinator/scripts/lib/map/page.mjs';
export { fromText as mapFromText } from '../../skills/coordinator/scripts/lib/map/log.mjs';
export { mapsPage } from '../../skills/coordinator/scripts/lib/mapspage.mjs';
export { unitRefs } from '../../skills/coordinator/scripts/lib/maps.mjs';
export { isTracker, marker, trackerBody, unitState } from '../../skills/coordinator/scripts/lib/tracker.mjs';
export { questions } from '../../skills/coordinator/scripts/lib/questions.mjs';
export { REPO } from '../../skills/coordinator/scripts/lib/links.mjs';
export { isSafeId } from '../../skills/coordinator/scripts/lib/store.mjs';
// c12 writes: the same event a `run.mjs answer` or `note --kind person` appends.
export { diff, snapshotText } from '../../skills/coordinator/scripts/lib/events.mjs';
export { answer as answerQuestion, find as findQuestion, fromForm, personNote } from '../../skills/coordinator/scripts/lib/questions.mjs';
export { render as workbench } from '../../skills/coordinator/scripts/lib/workbench.mjs';
// The local demo (src/demo): a lead's pit stop to a folder, and its pull, run on copies.
export { push as pushRun, pull as pullRun } from '../../skills/coordinator/scripts/lib/statesync.mjs';
export { mapAttach, mapRestore } from '../../skills/coordinator/scripts/lib/map/index.mjs';
