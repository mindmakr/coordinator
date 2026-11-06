// Side study: while a run waits on builders or critics, the lead may send a
// low-cost researcher to study one topic relevant to the run. Each study is
// logged on the run, with its sources and the lessons it added, and counts
// against the run's study budget (init --study-budget). What it learned is a
// hint for briefs: it never changes the fence or the bar.
import { oneOf, optText, text } from './args.mjs';
import { webUrl } from './links.mjs';
import { safeId } from './store.mjs';
import { STUDY_AREAS, studyCap } from './self.mjs';

export function addStudy(run, o, nowIso = new Date().toISOString()) {
  const cap = studyCap(run);
  const list = (run.studies ??= []);
  if (list.length >= cap) throw new Error(`study budget spent (${list.length}/${cap}): carry on without it, or set a budget at init (--study-budget)`);
  const sources = (o.source ?? []).map((raw) => {
    const url = typeof raw === 'string' ? webUrl(raw.trim()) : null;
    if (!url || url.length > 500) throw new Error(`--source must be an http(s) URL, got: ${raw}`);
    return url;
  });
  if (!sources.length) throw new Error('give at least one --source: a study records where it learned');
  const lessons = (o.lesson ?? []).map((id) => safeId(id, 'lesson id'));
  const entry = {
    id: `S${list.length + 1}`, area: oneOf(o.area ?? 'other', STUDY_AREAS, '--area'),
    topic: text(o.topic, 'topic', 200), text: text(o.text, 'text', 1000),
    sources, lessons, by: optText(o.by, 80), at: nowIso,
  };
  if (!entry.by) delete entry.by;
  list.push(entry);
  return entry.id;
}
