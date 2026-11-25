const hero = document.querySelector('#hero');
const replay = document.querySelector('#replay');
const motion = document.querySelector('#motion');
const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
const scene = document.querySelector('.scene');
scene.addEventListener('animationend', event => {
  if (event.target === scene) scene.classList.add('settled');
});
let paused = false;
let replayFrame;
let refreshGalleryMotion = () => {};

function setPaused(value) {
  paused = value;
  hero.classList.toggle('motion-paused', value);
  document.body.classList.toggle('motion-paused', value);
  motion.setAttribute('aria-pressed', String(value));
  motion.setAttribute('aria-label', value ? '继续背景动效' : '暂停背景动效');
  motion.querySelector('.motion-text').textContent = value ? '继续动效' : '暂停动效';
  motion.querySelector('.pause-symbol').textContent = value ? '▷' : 'Ⅱ';
  refreshGalleryMotion();
}

function replayIntro() {
  cancelAnimationFrame(replayFrame);
  setPaused(false);
  window.scrollTo({ top: 0, behavior: 'instant' });
  scene.classList.remove('settled');
  document.body.classList.add('replaying');
  void hero.offsetWidth;
  replayFrame = requestAnimationFrame(() => document.body.classList.remove('replaying'));
}

replay.addEventListener('click', replayIntro);
motion.addEventListener('click', () => setPaused(!paused));
function syncMotionPreference() {
  hero.classList.toggle('reduced', preference.matches);
  document.body.classList.toggle('reduced', preference.matches);
  motion.disabled = preference.matches;
  replay.disabled = preference.matches;
  motion.title = preference.matches ? '已遵循系统的减少动态效果设置' : '';
  replay.title = preference.matches ? '已遵循系统的减少动态效果设置' : '重新播放手机与插件的开场动画';
  refreshGalleryMotion();
}
preference.addEventListener('change', syncMotionPreference);
syncMotionPreference();

const dialog = document.querySelector('#info-dialog');

// Three identical groups allow dragging either way through a continuous ribbon.
// Only the original group is exposed to assistive technology.
const gallery = document.querySelector('.feature-gallery');
const track = gallery.querySelector('.gallery-track');
const group = track.querySelector('.gallery-group');
for (const position of ['before', 'after']) {
  const copy = group.cloneNode(true);
  copy.setAttribute('aria-hidden', 'true');
  if (position === 'before') track.prepend(copy);
  else track.append(copy);
}

let cycleWidth = 0;
let galleryPosition = 0;
let galleryFrame = 0;
let lastGalleryTime = 0;
let galleryHovered = false;
let galleryFocused = false;
let galleryVisible = false;
let pointerActive = false;
let mouseDrag = null;
let resumeAfterInteraction = 0;
let resumeTimer;
let normalizationFrame;
let focusedCard = null;
let galleryStep = null;
let stepFrame = 0;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

function focusCard(card) {
  if (focusedCard === card) return;
  focusedCard = card;
  gallery.classList.toggle('has-active-card', Boolean(card));
  const cards = [...track.querySelectorAll('.feature-card')];
  const selected = cards.indexOf(card);
  cards.forEach((item, index) => {
    item.classList.toggle('is-active', item === card);
    item.style.setProperty('--nudge', card ? (index < selected ? '-16px' : index > selected ? '16px' : '0px') : '0px');
  });
}

function normalizeGallery() {
  if (!cycleWidth || pointerActive || galleryStep) return;
  const current = gallery.scrollLeft;
  if (current < cycleWidth || current >= cycleWidth * 2) {
    const wrapped = cycleWidth + ((current - cycleWidth) % cycleWidth + cycleWidth) % cycleWidth;
    gallery.scrollLeft = wrapped;
    galleryPosition = wrapped;
  }
}

function measureGallery() {
  cancelGalleryStep();
  const previousWidth = cycleWidth;
  const relativePosition = previousWidth ? ((gallery.scrollLeft % previousWidth) / previousWidth) : 0;
  cycleWidth = group.getBoundingClientRect().width;
  galleryPosition = cycleWidth * (1 + relativePosition);
  gallery.scrollLeft = galleryPosition;
}

function canMoveGallery() {
  return galleryVisible && !document.hidden && !preference.matches && !paused &&
    !galleryHovered && !galleryFocused && !pointerActive && !galleryStep && !dialog.open &&
    performance.now() >= resumeAfterInteraction;
}

function animateGallery(time) {
  galleryFrame = 0;
  if (!canMoveGallery()) { lastGalleryTime = 0; return; }
  if (lastGalleryTime) {
    galleryPosition += Math.min(time - lastGalleryTime, 50) * .025;
    if (galleryPosition >= cycleWidth * 2) galleryPosition -= cycleWidth;
    gallery.scrollLeft = galleryPosition;
  }
  lastGalleryTime = time;
  galleryFrame = requestAnimationFrame(animateGallery);
}

refreshGalleryMotion = () => {
  if (canMoveGallery() && !galleryFrame) {
    galleryPosition = gallery.scrollLeft;
    lastGalleryTime = 0;
    galleryFrame = requestAnimationFrame(animateGallery);
  } else if (!canMoveGallery()) {
    cancelAnimationFrame(galleryFrame);
    galleryFrame = 0;
    lastGalleryTime = 0;
  }
};

function holdAfterInteraction() {
  resumeAfterInteraction = performance.now() + 1400;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(refreshGalleryMotion, 1450);
  refreshGalleryMotion();
}

gallery.addEventListener('pointerenter', event => {
  if (event.pointerType === 'mouse') { galleryHovered = true; refreshGalleryMotion(); }
});
gallery.addEventListener('pointerleave', event => {
  if (event.pointerType === 'mouse') { galleryHovered = false; focusCard(null); refreshGalleryMotion(); }
});
gallery.addEventListener('focusin', () => { galleryFocused = true; refreshGalleryMotion(); });
gallery.addEventListener('focusout', () => { galleryFocused = false; refreshGalleryMotion(); });
gallery.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  cancelGalleryStep();
  pointerActive = true;
  if (event.pointerType === 'mouse') {
    event.preventDefault();
    gallery.setPointerCapture(event.pointerId);
    mouseDrag = { x: event.clientX, scroll: gallery.scrollLeft, dragging: false };
  }
  refreshGalleryMotion();
});
gallery.addEventListener('pointermove', event => {
  if (mouseDrag) {
    const delta = event.clientX - mouseDrag.x;
    // A click keeps the existing hover state. Only an intentional drag changes it.
    if (!mouseDrag.dragging) {
      if (Math.abs(delta) < 6) return;
      mouseDrag.dragging = true;
      focusCard(null);
      gallery.classList.add('is-dragging');
    }
    gallery.scrollLeft = mouseDrag.scroll - delta;
    // Rebase a long drag at each seam so it never hits the finite strip edge.
    if (gallery.scrollLeft < cycleWidth || gallery.scrollLeft >= cycleWidth * 2) {
      const shift = gallery.scrollLeft < cycleWidth ? cycleWidth : -cycleWidth;
      gallery.scrollLeft += shift;
      mouseDrag.scroll += shift;
    }
  } else if (!galleryStep && event.pointerType === 'mouse' && finePointer.matches) {
    focusCard(event.target.closest('.feature-card'));
  }
});
function endGalleryPointer(event) {
  const wasDragging = mouseDrag?.dragging;
  pointerActive = false;
  mouseDrag = null;
  gallery.classList.remove('is-dragging');
  normalizeGallery();
  holdAfterInteraction();
  if (wasDragging && event?.pointerType === 'mouse' && finePointer.matches) {
    focusCard(document.elementFromPoint(event.clientX, event.clientY)?.closest('.feature-card') || null);
  }
}
gallery.addEventListener('pointerup', endGalleryPointer);
gallery.addEventListener('pointercancel', endGalleryPointer);
gallery.addEventListener('lostpointercapture', () => { if (pointerActive) endGalleryPointer(); });
gallery.addEventListener('wheel', event => {
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
    event.preventDefault();
    cancelGalleryStep();
    focusCard(null);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? gallery.clientWidth : 1;
    gallery.scrollLeft += (event.deltaX || event.deltaY) * unit;
    normalizeGallery();
    holdAfterInteraction();
  }
}, { passive: false });
gallery.addEventListener('scroll', () => {
  cancelAnimationFrame(normalizationFrame);
  normalizationFrame = requestAnimationFrame(normalizeGallery);
}, { passive: true });
function cancelGalleryStep() {
  cancelAnimationFrame(stepFrame);
  stepFrame = 0;
  galleryStep = null;
}
function stepGallery(direction) {
  focusCard(null);
  const gap = parseFloat(getComputedStyle(group).columnGap) || 0;
  const target = (galleryStep?.target ?? gallery.scrollLeft) + direction * (group.firstElementChild.offsetWidth + gap);
  cancelGalleryStep();
  if (preference.matches) {
    gallery.scrollLeft = target;
    normalizeGallery();
    holdAfterInteraction();
    return;
  }
  galleryStep = { start: gallery.scrollLeft, target, time: performance.now() };
  holdAfterInteraction();
  const tick = time => {
    if (!galleryStep) return;
    const progress = Math.min(1, (time - galleryStep.time) / 380);
    const eased = 1 - Math.pow(1 - progress, 4);
    const next = galleryStep.start + (galleryStep.target - galleryStep.start) * eased;
    // Wrap start and destination together, keeping the interpolation continuous.
    const wrapped = cycleWidth + ((next - cycleWidth) % cycleWidth + cycleWidth) % cycleWidth;
    const shift = wrapped - next;
    galleryStep.start += shift;
    galleryStep.target += shift;
    gallery.scrollLeft = wrapped;
    if (progress < 1) stepFrame = requestAnimationFrame(tick);
    else {
      cancelGalleryStep();
      galleryPosition = gallery.scrollLeft;
      holdAfterInteraction();
    }
  };
  stepFrame = requestAnimationFrame(tick);
}
document.querySelectorAll('[data-gallery-step]').forEach(button => button.addEventListener('click', () => stepGallery(Number(button.dataset.galleryStep))));
gallery.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const direction = event.key === 'ArrowLeft' ? -1 : 1;
  stepGallery(direction);
});

new ResizeObserver(measureGallery).observe(group);
new IntersectionObserver(entries => {
  galleryVisible = entries[0].isIntersecting;
  refreshGalleryMotion();
}, { threshold: .05 }).observe(gallery);
new MutationObserver(refreshGalleryMotion).observe(dialog, { attributes: true, attributeFilter: ['open'] });
document.addEventListener('visibilitychange', refreshGalleryMotion);
preference.addEventListener('change', () => { cancelGalleryStep(); refreshGalleryMotion(); });
new IntersectionObserver(entries => {
  hero.classList.toggle('scene-resting', !entries[0].isIntersecting);
}).observe(hero);
measureGallery();
refreshGalleryMotion();
