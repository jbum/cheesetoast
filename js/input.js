// Keyboard and touch input.  Both feed the same key flags (KF_*).

import { KF } from './constants.js';

const KEY_FLAGS = {
  Space: KF.Fire,
  ShiftLeft: KF.Thrust, ShiftRight: KF.Thrust, AltLeft: KF.Thrust, AltRight: KF.Thrust,
  KeyX: KF.Thrust, KeyZ: KF.Thrust,
  ControlLeft: KF.Shield, ControlRight: KF.Shield, ArrowUp: KF.Shield,
  KeyA: KF.Shield, KeyS: KF.Shield,
  ArrowDown: KF.Brake,
  ArrowLeft: KF.Left,
  ArrowRight: KF.Right,
};

export class Input {
  constructor() {
    this.keyFlags = 0;      // from the keyboard
    this.touchFlags = 0;    // from the on-screen buttons
    this.held = new Set();
    this.pointers = new Map();   // pointerId -> button element
    this.onCommand = null;  // (code, event) for non-flag keys
    this.onKeyboardUsed = null;

    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keyUp(e));
    window.addEventListener('blur', () => this.releaseAll());
  }

  get flags() {
    return this.keyFlags | this.touchFlags | (this.botFlags || 0);
  }

  // The steering circle's direction: degrees clockwise from straight up on
  // the screen, or null.  game.js turns it into a heading the teapot turns to
  // at the keyboard's rate.  A quick flick keeps its direction a little after
  // the thumb lifts, long enough to finish a half turn (8 ticks).
  get stickAngle() {
    const s = this.stick;
    if (!s) return null;
    if (s.steering) return s.angle;
    if (s.angle !== null && performance.now() < s.holdUntil) return s.angle;
    return null;
  }

  keyDown(e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    const flag = KEY_FLAGS[e.code];
    if (flag !== undefined) {
      e.preventDefault();
      this.held.add(e.code);
      this.recomputeKeys();
      this.onKeyboardUsed && this.onKeyboardUsed();
    }
    if (e.metaKey || (e.ctrlKey && !e.code.startsWith("Control"))) return;
    if (!e.repeat && this.onCommand) this.onCommand(e.code, e);
  }

  keyUp(e) {
    if (KEY_FLAGS[e.code] !== undefined) {
      this.held.delete(e.code);
      this.recomputeKeys();
    }
  }

  recomputeKeys() {
    let f = 0;
    for (const code of this.held) f |= KEY_FLAGS[code];
    this.keyFlags = f;
  }

  releaseAll() {
    this.held.clear();
    this.pointers.clear();
    this.keyFlags = 0;
    this.touchFlags = 0;
    if (this.stick) this.stickRelease(false);
    this.refreshButtons();
  }

  // ---- the steering circle (the left cluster on touch screens)
  // Touching the outer half steers: the thumb's direction from the center is
  // where the teapot should face, and dragging steers like a thumbstick.  The
  // inner half doesn't steer; a double-tap there brakes for as long as the
  // second tap is held.
  attachStick(el) {
    const s = this.stick = { el, id: null, steering: false, braking: false, angle: null, holdUntil: 0,
      downAt: 0, downInner: false, moved: 0, lastTap: 0, aim: null };
    const at = (e) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      return { dx, dy, k: Math.hypot(dx, dy) / (r.width / 2) };
    };
    const steer = (p) => {
      s.steering = true;
      s.angle = (Math.atan2(p.dx, -p.dy) * 180 / Math.PI + 360) % 360;
    };
    const show = (p) => {
      const knob = el.querySelector('.tc-stick-knob');
      const k = p ? Math.min(1, p.k) / (p.k || 1) : 0;   // (the knob stays inside the rim)
      if (knob) knob.style.transform = p ? `translate(${p.dx * k}px, ${p.dy * k}px)` : '';
      el.classList.toggle('steering', s.steering);
      el.classList.toggle('braking', s.braking);
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      const p = at(e), now = performance.now();
      s.id = e.pointerId; s.downAt = now; s.moved = 0; s.downInner = p.k < 0.5;
      this.pointers.set(e.pointerId, { stick: true, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' });
      if (s.downInner) {
        // the second of two quick taps in the middle: brake (no steering)
        s.braking = now - s.lastTap < 350;
        s.steering = false;
      } else steer(p);
      this.recomputeTouch(); show(p);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== s.id) return;
      const p = at(e);
      const held = this.pointers.get(e.pointerId);
      if (held) { held.x = e.clientX; held.y = e.clientY; }
      s.moved = Math.max(s.moved, p.k);
      // steering once out of the middle (and until back well inside it, so the
      // ring's edge doesn't flicker); a brake held while dragging out becomes steering
      if (p.k >= 0.5 || (s.steering && p.k >= 0.3)) { s.braking = false; steer(p); }
      else if (s.steering) s.steering = false;
      this.recomputeTouch(); show(p);
    });
    const up = (e) => { if (e.pointerId === s.id) this.stickRelease(true); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  stickRelease(tap) {
    const s = this.stick;
    if (s.id !== null) this.pointers.delete(s.id);
    const now = performance.now();
    // a quick tap in the middle counts toward a double-tap
    s.lastTap = tap && s.downInner && !s.braking && now - s.downAt < 300 && s.moved < 0.5 ? now : 0;
    if (s.steering) s.holdUntil = now + 450;   // (finish turning to where it pointed)
    s.id = null; s.steering = false; s.braking = false;
    this.recomputeTouch();
    const knob = s.el.querySelector('.tc-stick-knob');
    if (knob) knob.style.transform = '';
    s.el.classList.remove('steering', 'braking');
  }

  // the heading the teapot is turning to (game.js), shown as a notch on the rim
  showStickAim(deg) {
    const s = this.stick;
    if (!s) return;
    if (deg === s.aim) return;
    s.aim = deg;
    const aim = s.el.querySelector('.tc-stick-aim');
    s.el.classList.toggle('aiming', deg !== null);
    if (aim && deg !== null) aim.style.transform = `rotate(${deg}deg)`;
  }

  // Touch buttons: each element has data-flag="Left" etc.  A finger can
  // slide from one button to another, and several fingers work at once.
  attachTouchControls(container) {
    this.buttons = (this.buttons || []).concat([...container.querySelectorAll('[data-flag]')]);
    const update = (e) => {
      e.preventDefault();
      const btn = this.buttonAt(e.clientX, e.clientY);
      if (btn) this.pointers.set(e.pointerId, { btn, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' });
      else this.pointers.delete(e.pointerId);
      this.recomputeTouch();
    };
    if (!this.watchingTouches) {
      // iOS sometimes never sends pointerup/pointercancel for a finger that a
      // system gesture takes over (the bottom edge and corners, right where the
      // left buttons are), leaving a button held.  Touch events still list the
      // fingers really on the glass, so drop any held touch with no finger.
      this.watchingTouches = true;
      const check = (e) => this.reconcileTouches(e.touches);
      for (const type of ['touchstart', 'touchend', 'touchcancel'])
        document.addEventListener(type, check, { capture: true, passive: true });
    }
    const release = (e) => {
      this.pointers.delete(e.pointerId);
      this.recomputeTouch();
    };
    container.addEventListener('pointerdown', (e) => {
      try { container.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      update(e);
    });
    container.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId) || e.buttons) update(e);
    });
    container.addEventListener('pointerup', release);
    container.addEventListener('pointercancel', release);
    container.addEventListener('lostpointercapture', release);
    container.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  buttonAt(x, y) {
    // generous hit areas: the nearest button within 1.3x its radius
    let best = null, bestD = Infinity;
    for (const btn of this.buttons) {
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = Math.hypot(x - cx, y - cy) / (r.width / 2);
      if (d < 1.3 && d < bestD) { best = btn; bestD = d; }
    }
    return best;
  }

  // touches: the TouchList of fingers currently down.  Keeps, for each finger,
  // the held pointer nearest to it; held touch pointers left over are stale.
  reconcileTouches(touches) {
    const held = [...this.pointers].filter(([, p]) => p.touch);
    if (held.length <= touches.length) return;
    const keep = new Set();
    for (const t of touches) {
      let best = null, bestD = Infinity;
      for (const [id, p] of held) {
        if (keep.has(id)) continue;
        const d = Math.hypot(t.clientX - p.x, t.clientY - p.y);
        if (d < bestD) { best = id; bestD = d; }
      }
      if (best !== null) keep.add(best);
    }
    for (const [id] of held) if (!keep.has(id)) this.pointers.delete(id);
    if (this.stick && this.stick.id !== null && !this.pointers.has(this.stick.id)) this.stickRelease(false);
    this.recomputeTouch();
  }

  recomputeTouch() {
    let f = 0;
    for (const { btn } of this.pointers.values()) if (btn) f |= KF[btn.dataset.flag];
    if (this.stick && this.stick.braking) f |= KF.Brake;
    this.touchFlags = f;
    this.refreshButtons();
  }

  refreshButtons() {
    if (!this.buttons) return;
    const active = new Set([...this.pointers.values()].map((p) => p.btn).filter(Boolean));
    for (const btn of this.buttons) btn.classList.toggle('down', active.has(btn));
  }
}
