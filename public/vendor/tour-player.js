function R(n) {
  return n.length === 0 || /[\u0000-\u0020%?#\\]/.test(n) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(n) || n.startsWith("//") || n.startsWith("/") || /^[a-zA-Z]:\//.test(n) ? !1 : !n.split("/").some((t) => t === "..");
}
const X = 1.15, Y = 4e3;
function J(n) {
  return n.advance ?? "click";
}
function N(n) {
  return n.zoom ?? X;
}
function K(n) {
  return n.hotspot.shape ?? "rect";
}
function V(n) {
  return n.tooltip.placement ?? "bottom";
}
function Q(n) {
  const t = J(n);
  return t === "click" ? Y : t.auto;
}
function tt(n, t) {
  if (!n.chapters) return null;
  for (const e of n.chapters)
    if (e.steps.includes(t)) return e.id;
  return null;
}
function G(n) {
  const t = [];
  let e = "", i = 0;
  const s = () => {
    e && (t.push({ kind: "text", value: e }), e = "");
  };
  for (; i < n.length; ) {
    if (n.startsWith("**", i)) {
      const r = n.indexOf("**", i + 2);
      if (r > i + 2) {
        s(), t.push({ kind: "bold", value: n.slice(i + 2, r) }), i = r + 2;
        continue;
      }
    } else if (n[i] === "`") {
      const r = n.indexOf("`", i + 1);
      if (r > i + 1) {
        s(), t.push({ kind: "code", value: n.slice(i + 1, r) }), i = r + 1;
        continue;
      }
    }
    e += n[i], i += 1;
  }
  return s(), t;
}
function $(n) {
  const t = document.createDocumentFragment();
  for (const e of G(n))
    if (e.kind === "text")
      t.appendChild(document.createTextNode(e.value));
    else {
      const i = document.createElement(e.kind === "bold" ? "strong" : "code");
      i.textContent = e.value, t.appendChild(i);
    }
  return t;
}
function U(n) {
  return G(n).map((t) => t.value).join("");
}
const et = (n, t) => {
  const e = setTimeout(t, n);
  return () => clearTimeout(e);
};
function P(n, t, e) {
  return Math.min(e, Math.max(t, n));
}
class it {
  tour;
  mode;
  emit;
  render;
  schedule;
  autoplay;
  index;
  started = !1;
  completed = !1;
  playing = !1;
  emittedComplete = !1;
  cancelTimer = null;
  choicesOpen = !1;
  /** Step indices whose gate was submitted or skipped this run. */
  clearedGates = /* @__PURE__ */ new Set();
  now;
  enteredAt;
  constructor(t) {
    this.tour = t.tour, this.mode = t.mode, this.emit = t.emit, this.render = t.render, this.schedule = t.schedule ?? et, this.autoplay = t.autoplay ?? !1, this.now = t.now ?? Date.now, this.enteredAt = this.now(), this.index = P(t.startStep ?? 0, 0, this.tour.steps.length - 1);
  }
  /** Time on the current step so far — the component's pagehide `tour-abandon` payload. */
  dwellSoFar() {
    return Math.max(0, this.now() - this.enteredAt);
  }
  /** Mid-tour CTA on the current step was clicked. */
  stepCtaClick() {
    const t = this.tour.steps[this.index]?.cta;
    t && this.emit("tour-cta-click", { tourId: this.tour.id, href: t.href, stepIndex: this.index });
  }
  snapshot() {
    return {
      index: this.index,
      total: this.tour.steps.length,
      started: this.started,
      completed: this.completed,
      playing: this.playing,
      choicesOpen: this.choicesOpen,
      gateOpen: this.gateOpen()
    };
  }
  gateOpen() {
    return this.completed ? !1 : !!this.tour.steps[this.index]?.gate && !this.clearedGates.has(this.index);
  }
  init() {
    this.render(this.snapshot(), "init"), this.mode === "watch" && this.autoplay && this.play();
  }
  /** Viewer clicked the hotspot — advances in both modes. */
  activateHotspot() {
    this.gateOpen() || (this.markStarted(), this.advance());
  }
  next() {
    this.gateOpen() || (this.markStarted(), this.advance());
  }
  prev() {
    if (this.markStarted(), this.choicesOpen) {
      this.choicesOpen = !1, this.render(this.snapshot(), "step");
      return;
    }
    if (this.completed) {
      this.completed = !1, this.render(this.snapshot(), "step");
      return;
    }
    this.index !== 0 && this.setIndex(this.index - 1);
  }
  /** Pick a branch option from the open choice menu. */
  choose(t) {
    if (!this.choicesOpen) return;
    this.choicesOpen = !1, this.markStarted();
    const e = P(t, 0, this.tour.steps.length - 1);
    if (e === this.index) {
      this.render(this.snapshot(), "step");
      return;
    }
    this.setIndex(e);
  }
  /**
   * Submit the current step's lead gate. Emits `tour-lead` with the field
   * values — the player itself never transmits them anywhere.
   */
  submitGate(t) {
    this.gateOpen() && (this.clearedGates.add(this.index), this.markStarted(), this.emit("tour-lead", {
      tourId: this.tour.id,
      stepIndex: this.index,
      fields: t
    }), this.render(this.snapshot(), "gate"));
  }
  /** Skip a skippable gate — clears it for this run without emitting a lead. */
  skipGate() {
    const t = this.tour.steps[this.index];
    !this.gateOpen() || !t?.gate?.skippable || (this.clearedGates.add(this.index), this.markStarted(), this.render(this.snapshot(), "gate"));
  }
  goTo(t) {
    const e = P(t, 0, this.tour.steps.length - 1);
    if (!(this.gateOpen() || this.choicesOpen)) {
      if (this.markStarted(), this.completed && (this.completed = !1), e === this.index) {
        this.render(this.snapshot(), "step");
        return;
      }
      this.setIndex(e);
    }
  }
  /**
   * First engagement via the preview teaser. Marks the run started and re-renders
   * the current step's layer — its own path, separate from goTo, so it never
   * disturbs an open gate/branch (which can't coexist with the teaser anyway,
   * but keeping the paths distinct is what stops the goTo boundary bug).
   */
  engage() {
    this.markStarted();
    const t = this.choicesOpen ? "choices" : this.gateOpen() ? "gate" : "step";
    this.render(this.snapshot(), t);
  }
  jumpToChapter(t) {
    const i = this.tour.chapters?.find((s) => s.id === t)?.steps[0];
    i !== void 0 && this.goTo(i);
  }
  play() {
    this.mode !== "watch" || this.completed || this.playing || this.gateOpen() || (this.playing = !0, this.markStarted(), this.scheduleAdvance(), this.render(this.snapshot(), "play"));
  }
  pause() {
    this.playing && (this.playing = !1, this.clearTimer(), this.render(this.snapshot(), "pause"));
  }
  togglePlay() {
    this.playing ? this.pause() : this.play();
  }
  replay() {
    this.clearTimer(), this.enteredAt = this.now(), this.completed = !1, this.emittedComplete = !1, this.playing = !1, this.choicesOpen = !1, this.clearedGates.clear(), this.index = 0, this.started = !0, this.emit("tour-start", { tourId: this.tour.id }), this.render(this.snapshot(), "replay"), this.mode === "watch" && this.play();
  }
  ctaClick() {
    this.tour.cta && this.emit("tour-cta-click", { tourId: this.tour.id, href: this.tour.cta.href });
  }
  handleKey(t) {
    switch (t) {
      case "ArrowRight":
        return this.next(), !0;
      case "ArrowLeft":
        return this.prev(), !0;
      case "Home":
        return this.goTo(0), !0;
      case "End":
        return this.goTo(this.tour.steps.length - 1), !0;
      case " ":
        return this.mode !== "watch" || (this.markStarted(), this.completed) ? !1 : (this.togglePlay(), !0);
      default:
        return !1;
    }
  }
  dispose() {
    this.clearTimer();
  }
  markStarted() {
    this.started || (this.started = !0, this.enteredAt = this.now(), this.emit("tour-start", { tourId: this.tour.id }));
  }
  advance() {
    if (this.completed) return;
    if (this.tour.steps[this.index]?.choices && !this.choicesOpen) {
      this.choicesOpen = !0, this.playing && (this.playing = !1, this.clearTimer()), this.render(this.snapshot(), "choices");
      return;
    }
    if (!this.choicesOpen) {
      if (this.index >= this.tour.steps.length - 1) {
        this.complete();
        return;
      }
      this.setIndex(this.index + 1);
    }
  }
  setIndex(t) {
    const e = this.dwellSoFar();
    this.enteredAt = this.now(), this.index = t, this.choicesOpen = !1, this.emit("tour-step-change", {
      tourId: this.tour.id,
      stepIndex: t,
      chapterId: tt(this.tour, t),
      dwellMs: e
    }), this.playing && this.gateOpen() ? (this.playing = !1, this.clearTimer()) : this.playing && this.scheduleAdvance(), this.render(this.snapshot(), "step");
  }
  complete() {
    this.completed = !0, this.playing = !1, this.clearTimer(), this.emittedComplete || (this.emittedComplete = !0, this.emit("tour-complete", { tourId: this.tour.id })), this.render(this.snapshot(), "complete");
  }
  scheduleAdvance() {
    this.clearTimer();
    const t = this.tour.steps[this.index];
    t && (this.cancelTimer = this.schedule(Q(t), () => {
      this.cancelTimer = null, this.advance();
    }));
  }
  clearTimer() {
    this.cancelTimer && (this.cancelTimer(), this.cancelTimer = null);
  }
}
const W = (
  /* css */
  `
:host {
  display: block;
  --_accent: var(--tour-accent, var(--_manifest-accent, #2563eb));
  --_surface: var(--tour-surface, #ffffff);
  --_ink: var(--tour-ink, #16202b);
  --_radius: var(--tour-radius, 12px);
  --_hairline: color-mix(in srgb, var(--_ink) 12%, transparent);
  --_ink-soft: color-mix(in srgb, var(--_ink) 55%, transparent);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--_ink);
}
:host([hidden]) { display: none; }

*, *::before, *::after { box-sizing: border-box; }

button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}
:is(button, a):focus-visible {
  outline: 2px solid var(--_accent);
  outline-offset: 2px;
  border-radius: 6px;
}

.viewport {
  container-type: inline-size;
  border: 1px solid var(--_hairline);
  border-radius: var(--_radius);
  background: var(--_surface);
  overflow: hidden;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--_ink) 6%, transparent);
}

/* ---------- stage ---------- */

.stage {
  position: relative;
  aspect-ratio: var(--_frame-w, 16) / var(--_frame-h, 10);
  overflow: hidden;
  background: color-mix(in srgb, var(--_ink) 4%, var(--_surface));
  outline: none;
  /* Let vertical page scroll pass through, but own horizontal swipes. */
  touch-action: pan-y;
}

.camera {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  transition: transform 700ms cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

.frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 320ms ease;
}
.frame.show { opacity: 1; }

/* ---------- hotspot ---------- */

.hotspot {
  position: absolute;
  border-radius: 8px;
  --_ring: color-mix(in srgb, var(--_accent) 85%, white);
}
.hotspot[data-shape="circle"] { border-radius: 50%; }
.hotspot::before {
  /* Expanded hit area: >=44px effective tap target without growing the visual. */
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: max(100%, 44px);
  height: max(100%, 44px);
  transform: translate(-50%, -50%);
}
.hotspot::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 2px solid var(--_ring);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--_accent) 45%, transparent);
  animation: tour-pulse 2.2s cubic-bezier(0.4, 0, 0.4, 1) infinite;
}
.hotspot.hidden { display: none; }
.hotspot.nudge::after {
  /* Faster one-shot pulse: the hint when the viewer clicks elsewhere. */
  animation: tour-pulse 650ms cubic-bezier(0.4, 0, 0.4, 1) 2;
}

@keyframes tour-pulse {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--_accent) 45%, transparent); }
  60%  { box-shadow: 0 0 0 14px color-mix(in srgb, var(--_accent) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--_accent) 0%, transparent); }
}

/* ---------- tooltip ---------- */

.tooltip {
  position: absolute;
  z-index: 3;
  max-width: min(320px, 78%);
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--_surface);
  border: 1px solid var(--_hairline);
  box-shadow:
    0 12px 32px color-mix(in srgb, var(--_ink) 18%, transparent),
    0 2px 6px color-mix(in srgb, var(--_ink) 10%, transparent);
  font-size: 14px;
  line-height: 1.45;
  opacity: 0;
  translate: 0 4px;
  transition: opacity 240ms ease, translate 240ms ease;
  pointer-events: none;
}
.tooltip.show { opacity: 1; translate: 0 0; }
.tooltip strong { font-weight: 650; color: var(--_accent); }
.tooltip code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  padding: 1px 5px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--_ink) 7%, var(--_surface));
  border: 1px solid var(--_hairline);
}
.tooltip::before {
  content: "";
  position: absolute;
  width: 10px;
  height: 10px;
  background: inherit;
  border: inherit;
  rotate: 45deg;
}
.tooltip[data-placement="bottom"]::before { top: -6px; left: calc(50% - 5px); border-right: 0; border-bottom: 0; }
.tooltip[data-placement="top"]::before    { bottom: -6px; left: calc(50% - 5px); border-left: 0; border-top: 0; }
.tooltip[data-placement="right"]::before  { left: -6px; top: calc(50% - 5px); border-top: 0; border-right: 0; }
.tooltip[data-placement="left"]::before   { right: -6px; top: calc(50% - 5px); border-bottom: 0; border-left: 0; }

/* Narrow viewports: tooltip becomes a bottom sheet (spec §5 mobile). */
@container (max-width: 480px) {
  .tooltip, .tooltip.show {
    left: 8px !important;
    right: 8px !important;
    top: auto !important;
    bottom: 8px !important;
    max-width: none;
  }
  .tooltip::before { display: none; }
}

/* ---------- HUD ---------- */

.hud {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--_hairline);
  background: var(--_surface);
}
.hud .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: var(--_ink-soft);
}
.hud .btn:hover { background: color-mix(in srgb, var(--_ink) 7%, transparent); color: var(--_ink); }
.hud .btn:disabled { opacity: 0.35; cursor: default; background: none; }
.hud .btn svg { width: 18px; height: 18px; display: block; }
.hud .btn[hidden] { display: none; }
.hud .btn[aria-pressed="true"] { color: var(--_accent); background: color-mix(in srgb, var(--_accent) 12%, transparent); }

/* ---------- narration captions (v3 Phase 5) ---------- */

.caption {
  position: absolute;
  left: 50%;
  bottom: 5%;
  transform: translateX(-50%);
  max-width: min(90%, 640px);
  padding: 8px 16px;
  border-radius: 10px;
  background: color-mix(in srgb, #000 72%, transparent);
  color: #fff;
  font-size: 15px;
  line-height: 1.45;
  text-align: center;
  text-wrap: balance;
  z-index: 7;
  pointer-events: none;
}
.caption[hidden] { display: none; }

.counter {
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  color: var(--_ink-soft);
  white-space: nowrap;
}

.progress {
  flex: 1;
  height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--_ink) 10%, transparent);
  overflow: hidden;
}
.progress .fill {
  height: 100%;
  width: 0;
  border-radius: inherit;
  background: var(--_accent);
  transition: width 320ms ease;
}

/* ---------- chapters ---------- */

.chapters-wrap { position: relative; }
.chapters-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 5;
  min-width: 200px;
  padding: 6px;
  border-radius: 10px;
  background: var(--_surface);
  border: 1px solid var(--_hairline);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--_ink) 18%, transparent);
}
.chapters-pop[hidden] { display: none; }
.chapters-pop .chapter {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 13.5px;
}
.chapters-pop .chapter:hover { background: color-mix(in srgb, var(--_ink) 7%, transparent); }
.chapters-pop .chapter[aria-current="true"] {
  color: var(--_accent);
  font-weight: 600;
}

/* ---------- completion ---------- */

.complete {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--_surface) 62%, transparent);
  backdrop-filter: blur(10px);
  opacity: 0;
  /* visibility gates the backdrop-filter too — it renders even at opacity 0 */
  visibility: hidden;
  pointer-events: none;
  transition: opacity 320ms ease, visibility 0s linear 320ms;
}
.complete.show {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition: opacity 320ms ease;
}
.complete .card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 28px 36px;
  border-radius: var(--_radius);
  background: var(--_surface);
  border: 1px solid var(--_hairline);
  box-shadow: 0 24px 48px color-mix(in srgb, var(--_ink) 22%, transparent);
  text-align: center;
  max-width: 82%;
}
.complete .check {
  width: 36px;
  height: 36px;
  color: var(--_accent);
  margin-bottom: 2px;
}
.complete h2 { margin: 0; font-size: 17px; font-weight: 650; }
.complete p { margin: 0 0 10px; font-size: 13.5px; color: var(--_ink-soft); }
.complete .cta {
  display: inline-block;
  padding: 9px 18px;
  border-radius: 8px;
  background: var(--_accent);
  color: var(--_surface);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}
.complete .replay {
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--_ink-soft);
}
.complete .replay:hover { color: var(--_ink); background: color-mix(in srgb, var(--_ink) 7%, transparent); }

/* ---------- loading / error ---------- */

.notice {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  padding: 24px;
  font-size: 13.5px;
  color: var(--_ink-soft);
  text-align: center;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ---------- reduced motion (spec: crossfade only, no pan/zoom) ---------- */

@media (prefers-reduced-motion: reduce) {
  .camera { transition: none; }
  .tooltip { transition: opacity 240ms ease; translate: 0 0; }
  .hotspot::after { animation: none; }
  .progress .fill { transition: none; }
}

/* ─── v2 overlays: branch menu + lead gate ─────────────────────────── */
.branch, .gate {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--_surface) 62%, transparent);
  backdrop-filter: blur(10px);
}
.branch[hidden], .gate[hidden] { display: none; }
.branch .card, .gate .card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(420px, calc(100% - 48px));
  padding: 24px;
  border-radius: calc(var(--_radius) + 4px);
  background: var(--_surface);
  color: var(--_ink);
  box-shadow: 0 10px 40px -12px rgba(10, 20, 30, 0.35);
  text-align: left;
}
.branch h2, .gate h2 {
  margin: 0 0 4px;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.gate .card p {
  margin: -2px 0 4px;
  font-size: 13px;
  opacity: 0.72;
}
.choice {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--_ink) 14%, transparent);
  border-radius: var(--_radius);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease;
}
.choice:hover {
  border-color: var(--_accent);
  background: color-mix(in srgb, var(--_accent) 7%, transparent);
}
.choice-label { font-size: 14px; font-weight: 600; }
.choice-desc { font-size: 12.5px; opacity: 0.68; }
.gate-form { display: flex; flex-direction: column; gap: 10px; }
.gate-field { display: flex; flex-direction: column; gap: 4px; }
.gate-label { font-size: 12px; font-weight: 600; opacity: 0.8; }
.gate-form input {
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--_ink) 18%, transparent);
  border-radius: calc(var(--_radius) - 4px);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
}
.gate-form input:focus-visible {
  outline: 2px solid var(--_accent);
  outline-offset: 1px;
  border-color: var(--_accent);
}
.gate-submit {
  margin-top: 4px;
  padding: 10px 14px;
  border: 0;
  border-radius: 999px;
  background: var(--_accent);
  color: #fff;
  font: inherit;
  font-size: 14px;
  font-weight: 650;
  cursor: pointer;
}
.gate-submit:hover { filter: brightness(1.06); }
.gate-skip {
  align-self: center;
  padding: 4px 8px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  opacity: 0.62;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.gate-skip:hover { opacity: 0.9; }

/* ─── v3 phase 1: teaser, callouts, tooltip CTA ────────────────────── */
.teaser {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  background: linear-gradient(color-mix(in srgb, var(--_ink) 4%, transparent), color-mix(in srgb, var(--_ink) 26%, transparent));
}
.teaser-btn {
  padding: 13px 26px;
  border: 0;
  border-radius: 999px;
  background: var(--_accent);
  color: #fff;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 10px 32px -8px color-mix(in srgb, var(--_accent) 70%, transparent);
  animation: teaser-pulse 2.2s ease-in-out infinite;
}
@keyframes teaser-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}
.teasing .frame.show {
  animation: teaser-kenburns 16s ease-in-out infinite alternate;
}
@keyframes teaser-kenburns {
  from { transform: scale(1); }
  to { transform: scale(1.07) translate(-1.2%, -0.8%); }
}
.teasing .tooltip, .teasing .hotspot { visibility: hidden; }
@media (prefers-reduced-motion: reduce) {
  .teasing .frame.show { animation: none; }
  .teaser-btn { animation: none; }
}
.callouts { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.callout {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: 240px;
}
.callout-dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--_accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--_accent) 30%, transparent);
}
.callout-text {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--_ink);
  background: color-mix(in srgb, var(--_surface) 94%, transparent);
  border: 1px solid color-mix(in srgb, var(--_ink) 12%, transparent);
  border-radius: calc(var(--_radius) - 3px);
  padding: 5px 9px;
  box-shadow: 0 3px 14px -4px rgba(10, 20, 30, 0.25);
}
.narrow .callout { display: none; }
.tooltip-cta {
  display: inline-block;
  margin-top: 8px;
  padding: 7px 14px;
  border-radius: 999px;
  background: var(--_accent);
  color: #fff;
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}
.tooltip-cta:hover { filter: brightness(1.06); }
/* The tooltip is pointer-events:none (informational layer) — its CTA must
   opt back in, or clicks fall through to the frame beneath. */
.tooltip-cta { pointer-events: auto; }
/* Crossfade frames never take pointer events (the hidden opacity-0 frame
   otherwise intercepts clicks meant for layers above). */
.frame { pointer-events: none; }
`
), b = {
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>',
  chapters: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a4 4 0 0 1 0 7"/><path d="M18.5 6a7.5 7.5 0 0 1 0 12"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/></svg>'
}, w = 12, st = 720, rt = 480;
function nt(n) {
  if (typeof n != "object" || n === null) return !1;
  const t = n, e = t.frame;
  return t.schema === 1 && typeof t.id == "string" && Array.isArray(t.steps) && t.steps.length > 0 && typeof e?.w == "number" && typeof e?.h == "number" && e.w > 0 && e.h > 0 && Z(t.cta) && t.steps.every(ot);
}
function ot(n) {
  if (typeof n != "object" || n === null) return !1;
  const t = n;
  if (typeof t.img != "string" || !R(t.img) || t.audio !== void 0 && (typeof t.audio != "string" || !R(t.audio)) || !Z(t.cta)) return !1;
  const e = t.hotspot;
  if (typeof e != "object" || e === null) return !1;
  const i = e;
  for (const r of ["x", "y", "w", "h"])
    if (typeof i[r] != "number" || !Number.isFinite(i[r])) return !1;
  const s = t.tooltip;
  return typeof s?.text == "string" && s.text.length > 0;
}
function Z(n) {
  if (n === void 0) return !0;
  if (typeof n != "object" || n === null) return !1;
  const t = n;
  return typeof t.label == "string" && t.label.length > 0 && typeof t.href == "string" && t.href.length > 0;
}
class at extends HTMLElement {
  static get observedAttributes() {
    return ["src"];
  }
  root;
  tour = null;
  tourUrl = null;
  state = null;
  loadedSrc = null;
  lazyObserver = null;
  narrowObserver = null;
  settleTimer = null;
  nudgeTimer = null;
  renderToken = 0;
  reducedMotion = !1;
  // Populated by buildDom(); definite-assigned since buildDom runs before use.
  els;
  activeFrame = 0;
  /** Personalization tokens from the host's `tokens` attribute ({{key}} → value). */
  tokens = {};
  /** Step index the gate form was last built for — preserves typed values across renders. */
  gateBuiltFor = -1;
  /** Embed preview teaser is covering the player (dismissed on first engagement). */
  teasing = !1;
  onPageHide = null;
  /** Touch-swipe origin on the frame (null when no gesture is in flight). */
  swipeStart = null;
  /** A swipe just navigated — swallow the click it would otherwise fire. */
  suppressTap = !1;
  /** Bumped per load(); a stale async fetch checks it before applying its tour. */
  loadToken = 0;
  /** tour-abandon fires at most once per run (guards bfcache re-hide). */
  emittedAbandon = !1;
  /** Narration is muted by default (v3 Phase 5); the toggle opts the viewer in. */
  narrationOn = !1;
  audioEl = null;
  /** Step index the current clip belongs to — guards against restarting on re-render. */
  audioStep = -1;
  /**
   * Tears down the previous load()'s event listeners. `keydown` (on the host)
   * and the outside-click handler (on the shadow root) attach to nodes that
   * survive a reload, so without this each `src` change would stack another
   * handler — a second copy advances the tour twice per ArrowRight.
   */
  listeners = null;
  constructor() {
    if (super(), this.root = this.attachShadow({ mode: "open" }), "adoptedStyleSheets" in this.root && typeof CSSStyleSheet < "u") {
      const t = new CSSStyleSheet();
      t.replaceSync(W), this.root.adoptedStyleSheets = [t];
    } else {
      const t = document.createElement("style");
      t.textContent = W, this.root.appendChild(t);
    }
  }
  connectedCallback() {
    this.reducedMotion = typeof matchMedia == "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, this.hasAttribute("tabindex") || this.setAttribute("tabindex", "0"), this.showNotice("Loading tour…"), typeof IntersectionObserver == "function" ? (this.lazyObserver = new IntersectionObserver(
      (t) => {
        t.some((e) => e.isIntersecting) && (this.lazyObserver?.disconnect(), this.lazyObserver = null, this.load());
      },
      { rootMargin: "256px" }
    ), this.lazyObserver.observe(this)) : this.load();
  }
  disconnectedCallback() {
    this.onPageHide && window.removeEventListener("pagehide", this.onPageHide), this.listeners?.abort(), this.stopAudio(), this.state?.dispose(), this.lazyObserver?.disconnect(), this.narrowObserver?.disconnect(), this.settleTimer && clearTimeout(this.settleTimer), this.nudgeTimer && clearTimeout(this.nudgeTimer);
  }
  attributeChangedCallback(t, e, i) {
    t === "src" && this.loadedSrc !== null && i && i !== e && this.load();
  }
  get mode() {
    return this.getAttribute("mode") === "watch" ? "watch" : "guided";
  }
  async load() {
    const t = this.getAttribute("src");
    if (!t) {
      this.showNotice("tour-player: missing src attribute");
      return;
    }
    this.loadedSrc = t, this.state?.dispose(), this.state = null, this.stopAudio(), this.narrationOn = !1, this.emittedAbandon = !1;
    const e = ++this.loadToken;
    let i;
    try {
      this.tourUrl = new URL(t, document.baseURI);
      const r = await fetch(this.tourUrl.href);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const o = await r.json();
      if (!nt(o)) throw new Error("not a valid tour manifest (schema 1)");
      i = o;
    } catch (r) {
      if (e !== this.loadToken) return;
      this.showNotice("Couldn't load this tour."), console.error(`tour-player: failed to load ${t}:`, r);
      return;
    }
    if (e !== this.loadToken) return;
    this.tour = i, this.tokens = this.parseTokens(), i.theme?.accent && this.style.setProperty("--_manifest-accent", i.theme.accent), this.hasAttribute("aria-label") || this.setAttribute("aria-label", i.title), this.buildDom(i);
    const s = Number.parseInt(this.getAttribute("start-step") ?? "", 10);
    this.state = new it({
      tour: i,
      mode: this.mode,
      startStep: Number.isNaN(s) ? 0 : s,
      // The teaser owns the first engagement; autoplay starts on dismissal.
      autoplay: this.hasAttribute("autoplay") && !this.hasAttribute("preview"),
      emit: (r, o) => this.dispatchEvent(new CustomEvent(r, { detail: o, bubbles: !0, composed: !0 })),
      render: (r, o) => {
        this.renderState(r, o);
      }
    }), this.state.init(), this.hasAttribute("preview") && this.showTeaser(), this.onPageHide && window.removeEventListener("pagehide", this.onPageHide), this.onPageHide = () => {
      const r = this.state?.snapshot();
      this.emittedAbandon || !r?.started || r.completed || !this.tour || (this.emittedAbandon = !0, this.dispatchEvent(
        new CustomEvent("tour-abandon", {
          detail: {
            tourId: this.tour.id,
            stepIndex: r.index,
            dwellMs: this.state?.dwellSoFar() ?? 0
          },
          bubbles: !0,
          composed: !0
        })
      ));
    }, window.addEventListener("pagehide", this.onPageHide);
  }
  showTeaser() {
    const t = p("div", "teaser"), e = document.createElement("button");
    e.type = "button", e.className = "teaser-btn", e.textContent = this.getAttribute("preview-label") ?? "Take the tour", t.appendChild(e), this.els.stage.appendChild(t), this.els.viewport.classList.add("teasing"), this.teasing = !0, t.addEventListener("click", (i) => {
      i.stopPropagation(), this.dismissTeaser();
    });
  }
  dismissTeaser() {
    this.teasing && (this.teasing = !1, this.els.viewport.classList.remove("teasing"), this.els.stage.querySelector(".teaser")?.remove(), this.mode === "watch" && this.hasAttribute("autoplay") ? this.state?.play() : this.state?.engage());
  }
  parseTokens() {
    const t = this.getAttribute("tokens");
    if (!t) return {};
    try {
      const e = JSON.parse(t);
      if (typeof e != "object" || e === null || Array.isArray(e)) return {};
      const i = {};
      for (const [s, r] of Object.entries(e))
        (typeof r == "string" || typeof r == "number") && (i[s] = String(r));
      return i;
    } catch {
      return console.error("tour-player: tokens attribute is not valid JSON"), {};
    }
  }
  /**
   * {{key}} personalization. Substituted values always land in text nodes
   * (the markdown renderer never uses innerHTML), so host-supplied values
   * can't smuggle markup. Unknown tokens stay literal.
   */
  sub(t) {
    return t.replace(
      /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
      (e, i) => Object.prototype.hasOwnProperty.call(this.tokens, i) ? this.tokens[i] : e
    );
  }
  showNotice(t) {
    this.clearRoot();
    const e = document.createElement("div");
    e.className = "viewport";
    const i = document.createElement("div");
    i.className = "notice", i.textContent = t, e.appendChild(i), this.root.appendChild(e);
  }
  clearRoot() {
    for (const t of [...this.root.children])
      t.tagName !== "STYLE" && t.remove();
  }
  // ---------- DOM construction ----------
  buildDom(t) {
    this.clearRoot();
    const e = p("div", "viewport"), i = p("div", "stage");
    i.style.setProperty("--_frame-w", String(t.frame.w)), i.style.setProperty("--_frame-h", String(t.frame.h));
    const s = p("div", "camera"), r = document.createElement("img"), o = document.createElement("img");
    for (const y of [r, o])
      y.className = "frame", y.alt = "", y.draggable = !1, y.decoding = "async";
    const a = document.createElement("button");
    a.className = "hotspot hidden", a.type = "button", s.append(r, o, a);
    const d = p("div", "tooltip");
    d.setAttribute("aria-live", "polite");
    const l = p("div", "complete"), u = p("div", "card"), h = p("div", "check");
    h.innerHTML = b.check;
    const c = document.createElement("h2");
    c.textContent = "Tour complete";
    const f = document.createElement("p");
    f.textContent = t.title;
    const m = document.createElement("a");
    m.className = "cta";
    const v = document.createElement("button");
    v.className = "replay", v.type = "button", v.textContent = "Replay tour", u.append(h, c, f), t.cta && (m.textContent = t.cta.label, m.href = D(t.cta.href), u.appendChild(m)), u.appendChild(v), l.appendChild(u);
    const _ = p("div", "callouts"), k = p("div", "branch");
    k.hidden = !0;
    const x = p("div", "gate");
    x.hidden = !0;
    const g = p("div", "caption");
    g.hidden = !0, g.setAttribute("aria-hidden", "true"), i.append(s, _, d, k, x, g, l);
    const C = p("div", "hud"), H = T(b.prev, "Previous step"), I = T(b.next, "Next step"), O = T(b.play, "Play");
    O.hidden = this.mode !== "watch";
    const B = p("span", "counter"), F = p("div", "progress"), j = p("div", "fill");
    F.appendChild(j);
    const L = p("div", "chapters-wrap"), S = T(b.chapters, "Chapters");
    S.setAttribute("aria-haspopup", "true"), S.setAttribute("aria-expanded", "false");
    const z = p("div", "chapters-pop");
    z.hidden = !0, L.append(S, z), (!t.chapters || t.chapters.length === 0) && (L.hidden = !0);
    const E = T(b.mute, "Play narration");
    E.setAttribute("aria-pressed", "false");
    const q = t.steps.some((y) => typeof y.audio == "string");
    E.hidden = !q, C.append(H, O, I, B, F, L, E);
    const M = p("div", "sr-only");
    M.setAttribute("aria-live", "polite"), e.append(i, C, M), this.root.appendChild(e), this.els = {
      viewport: e,
      stage: i,
      camera: s,
      frames: [r, o],
      hotspot: a,
      tooltip: d,
      counter: B,
      fill: j,
      prev: H,
      next: I,
      playPause: O,
      chaptersBtn: S,
      chaptersPop: z,
      complete: l,
      replay: v,
      cta: m,
      live: M,
      branch: k,
      gate: x,
      callouts: _,
      narrateBtn: E,
      caption: g
    }, this.activeFrame = 0, this.gateBuiltFor = -1, this.audioStep = -1, this.narrowObserver?.disconnect(), typeof ResizeObserver == "function" && (this.narrowObserver = new ResizeObserver(() => {
      const y = i.clientWidth < rt;
      e.classList.toggle("narrow", y);
    }), this.narrowObserver.observe(i)), this.wireEvents(t);
  }
  wireEvents(t) {
    const { hotspot: e, stage: i, prev: s, next: r, playPause: o, chaptersBtn: a, chaptersPop: d, replay: l, cta: u } = this.els;
    this.listeners?.abort(), this.listeners = new AbortController();
    const h = { signal: this.listeners.signal };
    e.addEventListener(
      "click",
      (c) => {
        c.stopPropagation(), !this.consumeSwipe() && this.state?.activateHotspot();
      },
      h
    ), i.addEventListener(
      "click",
      () => {
        this.consumeSwipe() || this.nudgeHotspot();
      },
      h
    ), this.wireSwipe(i, h), s.addEventListener("click", () => this.state?.prev(), h), r.addEventListener("click", () => this.state?.next(), h), o.addEventListener("click", () => this.state?.togglePlay(), h), this.els.narrateBtn.addEventListener(
      "click",
      (c) => {
        c.stopPropagation(), this.toggleNarration();
      },
      h
    ), l.addEventListener("click", () => this.state?.replay(), h), u.addEventListener("click", () => this.state?.ctaClick(), h), a.addEventListener(
      "click",
      (c) => {
        c.stopPropagation(), this.toggleChapters(d.hidden, t);
      },
      h
    ), this.root.addEventListener(
      "click",
      (c) => {
        !d.hidden && !c.composedPath().includes(this.els.chaptersBtn) && this.toggleChapters(!1, t);
      },
      h
    ), this.addEventListener(
      "keydown",
      (c) => {
        if (!this.state) return;
        if (this.teasing && this.dismissTeaser(), c.key === "Escape" && !d.hidden) {
          this.toggleChapters(!1, t);
          return;
        }
        const f = c.composedPath()[0];
        f instanceof HTMLElement && (f.tagName === "BUTTON" || f.tagName === "A") && (c.key === " " || c.key === "Enter") || this.state.handleKey(c.key) && c.preventDefault();
      },
      h
    );
  }
  /**
   * Touch-swipe navigation (mobile): a horizontal drag across the frame moves a
   * step — left = next, right = prev. Touch/pen only, so desktop clicks are
   * never misread. No pointer capture (it would steal focus from gate inputs);
   * a gesture that ends off the frame is simply ignored.
   */
  wireSwipe(t, e) {
    t.addEventListener(
      "pointerdown",
      (s) => {
        this.suppressTap = !1, s.pointerType !== "mouse" && (this.swipeStart = { x: s.clientX, y: s.clientY, id: s.pointerId });
      },
      e
    ), t.addEventListener(
      "pointerup",
      (s) => {
        const r = this.swipeStart;
        if (!r || s.pointerId !== r.id) return;
        this.swipeStart = null;
        const o = s.clientX - r.x, a = s.clientY - r.y;
        Math.abs(o) < 45 || Math.abs(o) < Math.abs(a) * 1.5 || this.swipeAllowed() && (this.suppressTap = !0, o < 0 ? this.state?.next() : this.state?.prev());
      },
      e
    ), t.addEventListener("pointercancel", () => this.swipeStart = null, e);
  }
  swipeAllowed() {
    const t = this.state?.snapshot();
    return !!(t && !this.teasing && !t.completed && !t.choicesOpen && !t.gateOpen);
  }
  /** True once right after a swipe, so the trailing synthetic click is swallowed. */
  consumeSwipe() {
    return this.suppressTap ? (this.suppressTap = !1, !0) : !1;
  }
  toggleChapters(t, e) {
    const { chaptersBtn: i, chaptersPop: s } = this.els;
    if (s.hidden = !t, i.setAttribute("aria-expanded", String(t)), !t || !e.chapters) return;
    const r = this.state?.snapshot().index ?? 0;
    s.replaceChildren();
    for (const o of e.chapters) {
      const a = document.createElement("button");
      a.type = "button", a.className = "chapter", a.textContent = o.title, o.steps.includes(r) && a.setAttribute("aria-current", "true"), a.addEventListener("click", () => {
        this.toggleChapters(!1, e), this.state?.jumpToChapter(o.id);
      }), s.appendChild(a);
    }
  }
  // ---------- rendering ----------
  async renderState(t, e) {
    const i = this.tour;
    if (!i) return;
    const s = i.steps[t.index];
    if (!s) return;
    const r = ++this.renderToken;
    if (this.renderHud(t), this.els.complete.classList.toggle("show", t.completed), t.completed) {
      this.els.live.textContent = "Tour complete", this.els.tooltip.classList.remove("show"), this.els.hotspot.classList.add("hidden"), this.stopAudio(), this.audioStep = -1, this.els.caption.hidden = !0, this.syncOverlays(t, s), this.els.replay.focus();
      return;
    }
    if (e === "play" || e === "pause") return;
    if (e === "choices" || e === "gate") {
      this.syncOverlays(t, s), t.choicesOpen || t.gateOpen ? (this.els.tooltip.classList.remove("show"), this.els.hotspot.classList.add("hidden"), this.stopAudio(), this.els.caption.hidden = !0, this.audioStep = -1) : (this.els.hotspot.classList.remove("hidden"), this.showTooltip(s, 1), this.syncNarration(s, t.index));
      return;
    }
    if (this.syncOverlays(t, s), this.els.tooltip.classList.remove("show"), this.els.hotspot.classList.add("hidden"), this.els.callouts.replaceChildren(), this.stopAudio(), this.els.caption.hidden = !0, !await this.swapFrame(s, r) || r !== this.renderToken) return;
    const a = e === "step" && !this.reducedMotion;
    this.applyCamera(s, a ? N(s) : 1), this.positionHotspot(s);
    const d = this.reducedMotion || e !== "step" ? 60 : st;
    this.settleTimer && clearTimeout(this.settleTimer), this.settleTimer = setTimeout(() => {
      if (r !== this.renderToken) return;
      const l = this.state?.snapshot();
      if (l?.gateOpen || l?.choicesOpen) {
        this.preloadNeighbors(t.index);
        return;
      }
      this.els.hotspot.classList.remove("hidden"), this.showTooltip(s, a ? N(s) : 1), this.renderCallouts(s, a ? N(s) : 1), this.syncNarration(s, t.index), this.preloadNeighbors(t.index);
    }, d);
  }
  /**
   * Non-blocking annotations (v3). Anchors go through the same camera math as
   * the tooltip: a frame point p maps to p·s + hotspotCenter·(1 − s).
   */
  renderCallouts(t, e) {
    const i = this.els.callouts;
    if (i.replaceChildren(), !t.callouts || t.callouts.length === 0) return;
    const s = this.els.stage.clientWidth, r = this.els.stage.clientHeight, o = (t.hotspot.x + t.hotspot.w / 2) * s, a = (t.hotspot.y + t.hotspot.h / 2) * r;
    for (const d of t.callouts) {
      const l = d.x * s * e + o * (1 - e), u = d.y * r * e + a * (1 - e), h = p("div", "callout"), c = p("span", "callout-dot"), f = p("span", "callout-text");
      f.replaceChildren($(this.sub(d.text))), h.append(c, f), h.style.left = `${A(l, 8, Math.max(8, s - 8))}px`, h.style.top = `${A(u, 8, Math.max(8, r - 8))}px`, i.appendChild(h);
    }
  }
  // ---------- v2 overlays: branch menu + lead gate ----------
  syncOverlays(t, e) {
    const i = t.choicesOpen && !t.completed, s = t.gateOpen && !t.completed;
    this.els.stage.classList.toggle("overlaid", i || s), i && e.choices && this.buildBranch(e), this.els.branch.hidden = !i, s && e.gate && this.buildGate(e, t.index), this.els.gate.hidden = !s, s || (this.gateBuiltFor = this.gateBuiltFor === t.index ? -1 : this.gateBuiltFor), i ? (this.els.live.textContent = this.sub(e.choicesPrompt ?? "What do you want to see next?"), this.els.branch.querySelector("button")?.focus()) : s && e.gate && (this.els.live.textContent = this.sub(e.gate.title), this.els.gate.querySelector("input")?.focus());
  }
  buildBranch(t) {
    const { branch: e } = this.els;
    e.replaceChildren();
    const i = p("div", "card"), s = document.createElement("h2");
    s.textContent = this.sub(t.choicesPrompt ?? "What do you want to see next?"), i.appendChild(s);
    for (const r of t.choices ?? []) {
      const o = document.createElement("button");
      o.type = "button", o.className = "choice";
      const a = p("span", "choice-label");
      if (a.textContent = this.sub(r.label), o.appendChild(a), r.description) {
        const d = p("span", "choice-desc");
        d.textContent = this.sub(r.description), o.appendChild(d);
      }
      o.addEventListener("click", (d) => {
        d.stopPropagation(), this.state?.choose(r.target);
      }), i.appendChild(o);
    }
    e.appendChild(i);
  }
  buildGate(t, e) {
    if (this.gateBuiltFor === e) return;
    this.gateBuiltFor = e;
    const i = t.gate;
    if (!i) return;
    const s = this.els.gate;
    s.replaceChildren();
    const r = p("div", "card"), o = document.createElement("h2");
    if (o.textContent = this.sub(i.title), r.appendChild(o), i.subtitle) {
      const l = document.createElement("p");
      l.textContent = this.sub(i.subtitle), r.appendChild(l);
    }
    const a = document.createElement("form");
    a.className = "gate-form";
    for (const l of i.fields) {
      const u = document.createElement("label");
      u.className = "gate-field";
      const h = p("span", "gate-label");
      h.textContent = this.sub(l.label);
      const c = document.createElement("input");
      c.name = l.key, c.type = l.type ?? "text", c.required = l.required ?? !1, c.autocomplete = l.type === "email" ? "email" : "on", u.append(h, c), a.appendChild(u);
    }
    const d = document.createElement("button");
    if (d.type = "submit", d.className = "gate-submit", d.textContent = this.sub(i.submitLabel ?? "Continue"), a.appendChild(d), a.addEventListener("submit", (l) => {
      if (l.preventDefault(), l.stopPropagation(), !a.reportValidity()) return;
      const u = {};
      for (const h of i.fields) {
        const c = a.elements.namedItem(h.key);
        u[h.key] = c instanceof HTMLInputElement ? c.value.trim() : "";
      }
      this.state?.submitGate(u);
    }), r.appendChild(a), i.skippable) {
      const l = document.createElement("button");
      l.type = "button", l.className = "gate-skip", l.textContent = "Skip for now", l.addEventListener("click", (u) => {
        u.stopPropagation(), this.state?.skipGate();
      }), r.appendChild(l);
    }
    s.appendChild(r);
  }
  renderHud(t) {
    const { counter: e, fill: i, prev: s, next: r, playPause: o } = this.els;
    e.textContent = `${Math.min(t.index + 1, t.total)} / ${t.total}`, i.style.width = `${(t.index + 1) / t.total * 100}%`, s.disabled = t.index === 0 && !t.completed, r.disabled = t.completed, o.innerHTML = t.playing ? b.pause : b.play, o.setAttribute("aria-label", t.playing ? "Pause" : "Play");
  }
  resolveImg(t) {
    return this.resolveAsset(t.img);
  }
  /**
   * Resolve a relative asset path against the manifest URL and confine it to the
   * manifest's origin. isLikelyStep already rejects unsafe paths, so this is
   * defense in depth: never issue a cross-origin fetch for a frame/clip even if
   * some future guard gap let one through — return "" (no request) instead.
   */
  resolveAsset(t) {
    const e = this.tourUrl ?? new URL(document.baseURI);
    let i;
    try {
      i = new URL(t, e);
    } catch {
      return "";
    }
    return i.origin === e.origin ? i.href : "";
  }
  /**
   * Crossfades to the step's frame. Returns false when a newer render started
   * while the image was decoding — the class swap must never run for a stale
   * render, or rapid navigation leaves the wrong frame visible.
   */
  async swapFrame(t, e) {
    const i = this.resolveImg(t), s = this.els.frames[this.activeFrame];
    if (s.src === i && s.classList.contains("show")) return !0;
    const r = this.activeFrame ^ 1, o = this.els.frames[r];
    o.src = i;
    try {
      await o.decode();
    } catch {
    }
    return e !== this.renderToken ? !1 : (o.classList.add("show"), s.classList.remove("show"), this.activeFrame = r, !0);
  }
  applyCamera(t, e) {
    const i = t.hotspot.x + t.hotspot.w / 2, s = t.hotspot.y + t.hotspot.h / 2;
    this.els.camera.style.transform = `translate(${i * (1 - e) * 100}%, ${s * (1 - e) * 100}%) scale(${e})`;
  }
  positionHotspot(t) {
    const { hotspot: e } = this.els;
    e.style.left = `${t.hotspot.x * 100}%`, e.style.top = `${t.hotspot.y * 100}%`, e.style.width = `${t.hotspot.w * 100}%`, e.style.height = `${t.hotspot.h * 100}%`, e.dataset.shape = K(t), e.setAttribute("aria-label", `Next: ${U(this.sub(t.tooltip.text))}`);
  }
  showTooltip(t, e) {
    const { tooltip: i, stage: s, viewport: r } = this.els;
    if (i.replaceChildren($(this.sub(t.tooltip.text))), t.cta) {
      const g = document.createElement("a");
      g.className = "tooltip-cta", g.href = D(t.cta.href), g.textContent = this.sub(t.cta.label), g.addEventListener("click", (C) => {
        if (this.consumeSwipe()) {
          C.preventDefault(), C.stopPropagation();
          return;
        }
        C.stopPropagation(), this.state?.stepCtaClick();
      }), i.appendChild(g);
    }
    if (r.classList.contains("narrow")) {
      i.style.left = "", i.style.top = "", i.dataset.placement = "sheet", i.classList.add("show");
      return;
    }
    const o = s.clientWidth, a = s.clientHeight, d = (t.hotspot.x + t.hotspot.w / 2) * o, l = (t.hotspot.y + t.hotspot.h / 2) * a, u = t.hotspot.w * o * e / 2, h = t.hotspot.h * a * e / 2;
    i.style.left = "-9999px", i.style.top = "0px";
    const c = i.offsetWidth, f = i.offsetHeight;
    let m = V(t);
    const v = {
      bottom: l + h + w + f <= a,
      top: l - h - w - f >= 0,
      right: d + u + w + c <= o,
      left: d - u - w - c >= 0
    }, _ = {
      bottom: "top",
      top: "bottom",
      left: "right",
      right: "left"
    };
    !v[m] && v[_[m]] && (m = _[m]);
    let k, x;
    m === "bottom" || m === "top" ? (k = A(d - c / 2, 8, Math.max(8, o - c - 8)), x = m === "bottom" ? l + h + w : l - h - w - f) : (k = m === "right" ? d + u + w : d - u - w - c, x = A(l - f / 2, 8, Math.max(8, a - f - 8))), x = A(x, 8, Math.max(8, a - f - 8)), i.dataset.placement = m, i.style.left = `${k}px`, i.style.top = `${x}px`, i.classList.add("show");
  }
  nudgeHotspot() {
    const { hotspot: t } = this.els;
    t.classList.contains("hidden") || (t.classList.remove("nudge"), t.offsetWidth, t.classList.add("nudge"), this.nudgeTimer && clearTimeout(this.nudgeTimer), this.nudgeTimer = setTimeout(() => t.classList.remove("nudge"), 1400));
  }
  // ---------- narration (v3 Phase 5) ----------
  toggleNarration() {
    this.narrationOn = !this.narrationOn;
    const { narrateBtn: t } = this.els;
    if (t.innerHTML = this.narrationOn ? b.sound : b.mute, t.setAttribute("aria-pressed", String(this.narrationOn)), t.setAttribute("aria-label", this.narrationOn ? "Mute narration" : "Play narration"), !this.narrationOn) {
      this.stopAudio(), this.els.caption.hidden = !0;
      return;
    }
    const e = this.state?.snapshot(), i = e ? this.tour?.steps[e.index] : void 0;
    i && e && !e.completed && !e.choicesOpen && !e.gateOpen && (this.audioStep = -1, this.syncNarration(i, e.index));
  }
  /** Caption + audio for a step, gated by the muted-by-default toggle. */
  syncNarration(t, e) {
    const { caption: i } = this.els;
    if (!this.narrationOn) {
      i.hidden = !0;
      return;
    }
    i.textContent = U(this.sub(t.tooltip.text)), i.hidden = !1, this.audioStep !== e && (this.audioStep = e, this.stopAudio(), typeof t.audio == "string" && this.playAudio(this.resolveAudio(t.audio)));
  }
  playAudio(t) {
    if (this.stopAudio(), typeof Audio != "function") return;
    const e = new Audio(t);
    this.audioEl = e, e.play().catch(() => {
    });
  }
  stopAudio() {
    this.audioEl && (this.audioEl.pause(), this.audioEl.src = "", this.audioEl = null);
  }
  resolveAudio(t) {
    return this.resolveAsset(t);
  }
  preloadNeighbors(t) {
    const e = this.tour;
    if (e)
      for (const i of [t + 1, t - 1]) {
        const s = e.steps[i];
        if (!s) continue;
        const r = new Image();
        r.src = this.resolveImg(s);
      }
  }
}
function p(n, t) {
  const e = document.createElement(n);
  return e.className = t, e;
}
function T(n, t) {
  const e = document.createElement("button");
  return e.type = "button", e.className = "btn", e.setAttribute("aria-label", t), e.innerHTML = n, e;
}
function A(n, t, e) {
  return Math.min(e, Math.max(t, n));
}
const lt = /* @__PURE__ */ new Set(["http", "https", "mailto", "tel"]);
function D(n) {
  if (typeof n != "string") return "#";
  const t = n.replace(/[\u0000-\u0020]/g, ""), e = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(t);
  return e && !lt.has(e[1].toLowerCase()) ? "#" : n;
}
typeof customElements < "u" && !customElements.get("tour-player") && customElements.define("tour-player", at);
export {
  at as TourPlayer,
  it as TourState
};
