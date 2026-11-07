// The homepage's only script: the practice's name, the hero scan's step, the loop's active step, copy buttons.
// Scrolling effects are CSS scroll-driven animations; IntersectionObserver is the fallback.
(() => {
  if (typeof TERM === 'string') document.querySelectorAll('[data-term]').forEach((el) => { el.textContent = TERM; });

  const io = 'IntersectionObserver' in window;
  // The hero's scan stage: the probe crossing the middle of the screen names the step,
  // which picks the caption (and, without scroll timelines, the scan and pan positions).
  const stage = document.querySelector('.scan');
  if (stage && io) {
    const mark = new IntersectionObserver((entries) => {
      entries.filter((e) => e.isIntersecting).forEach((e) => { stage.dataset.step = e.target.dataset.step; });
    }, { rootMargin: '-50% 0px -50% 0px' });
    stage.querySelectorAll('.probe').forEach((p) => mark.observe(p));
  }

  const ring = document.querySelector('.ring');
  const steps = [...document.querySelectorAll('.steps li')];
  if (steps.length && io) {
    const pick = (li) => {
      steps.forEach((s) => s.classList.toggle('on', s === li));
      if (ring) ring.dataset.step = li.dataset.step;
    };
    pick(steps[0]);
    const watch = new IntersectionObserver((entries) => {
      entries.filter((e) => e.isIntersecting).forEach((e) => pick(e.target));
    }, { rootMargin: '-45% 0px -50% 0px' });
    steps.forEach((s) => watch.observe(s));
  } else steps.forEach((s) => s.classList.add('on'));

  document.querySelectorAll('button.copy').forEach((b) => {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; }
      catch { b.textContent = 'Select and copy'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1800);
    });
  });
})();
