// Sound effects (SoundMgrFMOD.cpp) on Web Audio.  iOS only lets audio start
// from a user gesture, so unlock() is called from every tap, click and keypress
// (main.js).  It has to be called from inside the event handler: the gesture
// doesn't carry over to a later tick.

import { SOUND_DEFS } from './constants.js';
import { loadPref, savePref, clamp } from './util.js';

const PREF_KEY = 'cheesetoast.sound';
const VOLUME_KEY = 'cheesetoast.volume';   // 0..1, the settings screen's slider

// iPadOS Safari reports itself as a Mac, but a Mac has no touch points.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.platform) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// 0.2 s of silence (MP3, 22 kHz mono, 8 kbps).  On iOS, Web Audio obeys the
// Silent switch / Silent mode but a playing <audio> element doesn't, and while
// one plays the whole page's audio session counts as media playback, so the
// Web Audio output comes through too.  Looping this is the standard workaround.
const SILENCE = 'data:audio/mpeg;base64,SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/83DAAAAAAAAAAAAASW5mbwAAAA8AAAAKAAABvAB3d3d3d3d3d3eHh4eHh4eHh4eHlpaWlpaWlpaWlqWlpaWlpaWlpaW0tLS0tLS0tLS0w8PDw8PDw8PDw9LS0tLS0tLS0tLh4eHh4eHh4eHh8PDw8PDw8PDw8P////////////8AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJAMGAAAAAAAAAbzs8qFPAAAAAAAAAAAAAAAAAP/zEMQAAAADSAAAAABMQU1FMy4xMDBVVVVV//MSxA0AAANIAAAAAFVVVVVVVVVVVVVVVVVV//MQxBsAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDEKAAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMQ1AAADSAAAAABVVVVVVVVVVVVVVVVV//MQxEIAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xDETwAAA0gAAAAAVVVVVVVVVVVVVVVVVf/zEMRcAAADSAAAAABVVVVVVVVVVVVVVVVV//MQxGkAAANIAAAAAFVVVVVVVVVVVVVVVVX/8xLEdgAAA0gAAAAAVVVVVVVVVVVVVVVVVVU=';

// How long after a resume() request play() keeps starting sounds even though
// the context hasn't reported 'running' yet (they queue and play when it does).
const RESUME_GRACE = 1000;

export class SoundMgr {
  constructor() {
    this.enabled = loadPref(PREF_KEY, true);
    this.volume = clamp(+loadPref(VOLUME_KEY, 1) || 0, 0, 1);
    this.buffers = [];
    this.playing = SOUND_DEFS.map(() => []);
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = AC ? new AC() : null;
    if (this.ctx) {
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    this.resumeAt = -Infinity;
    this.silence = IS_IOS ? this.makeSilence() : null;
  }

  makeSilence() {
    const el = document.createElement('audio');
    el.src = SILENCE;
    el.loop = true;
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    el.load();
    return el;
  }

  async load(onProgress) {
    if (!this.ctx) return;
    let done = 0;
    await Promise.all(SOUND_DEFS.map(async ([name], i) => {
      try {
        const res = await fetch(`assets/snd/S_${name}.mp3`);
        const data = await res.arrayBuffer();
        this.buffers[i] = await new Promise((resolve, reject) =>
          this.ctx.decodeAudioData(data, resolve, reject));
      } catch (e) {
        console.warn('sound failed to load:', name, e);
      }
      onProgress && onProgress(++done / SOUND_DEFS.length);
    }));
  }

  // Call from inside a user-gesture event handler.  Safe to call often.
  unlock() {
    if (!this.ctx) return;
    // 'suspended' before the first gesture; Safari also has 'interrupted'
    // (after a call, Siri, the screen locking...) which likewise needs a
    // gesture to come back from.
    if (this.ctx.state !== 'running') this.requestResume();
    if (!this.unlocked) {
      // a silent buffer kicks older iOS versions into life
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, 22050);
      src.connect(this.master);
      src.start(0);
      this.unlocked = true;
    }
    if (this.silence && this.enabled && this.silence.paused) {
      const p = this.silence.play();
      if (p && p.catch) p.catch(() => { /* not a gesture: try again next tap */ });
    }
  }

  requestResume() {
    this.resumeAt = performance.now();
    const p = this.ctx.resume();
    if (p && p.catch) p.catch(() => { /* needs a gesture; unlock() will retry */ });
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
    if (this.silence) this.silence.pause();
  }

  resume() {
    if (this.ctx && this.unlocked) this.requestResume();
    if (this.silence && this.unlocked && this.enabled && this.silence.paused) {
      const p = this.silence.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  // one line for the debug stats overlay
  status() {
    if (!this.ctx) return 'no AudioContext';
    const loaded = this.buffers.filter(Boolean).length;
    return `${this.ctx.state}${this.unlocked ? '' : ' (locked)'}` +
      `${this.enabled ? '' : ' muted'} ${loaded}/${SOUND_DEFS.length} sounds` +
      (this.silence ? (this.silence.paused ? ' bg:off' : ' bg:on') : '');
  }

  setEnabled(on) {
    this.enabled = on;
    savePref(PREF_KEY, on);
    if (!on) {
      this.stopAll();
      if (this.silence) this.silence.pause();
    }
  }

  // overall loudness, 0..1 (remembered)
  setVolume(v) {
    this.volume = clamp(+v || 0, 0, 1);
    savePref(VOLUME_KEY, this.volume);
    if (this.master) this.master.gain.value = this.volume;
  }

  toggle() {
    this.setEnabled(!this.enabled);
    if (this.enabled) this.unlock();
    return this.enabled;
  }

  stopAll() {
    for (const list of this.playing) {
      for (const src of list) {
        try { src.stop(); } catch (e) { /* already stopped */ }
      }
      list.length = 0;
    }
  }

  play(id, volume = 1, pan = 0) {
    if (!this.enabled || !this.ctx) return;
    // resume() is asynchronous: right after unlock() the state is still
    // 'suspended' for a few ms, and sounds started then play once it runs.
    if (this.ctx.state !== 'running' && performance.now() - this.resumeAt > RESUME_GRACE) return;
    const buffer = this.buffers[id];
    if (!buffer) return;
    const list = this.playing[id];
    if (list.length >= SOUND_DEFS[id][1]) {
      // like FMOD's max playbacks: the oldest copy gives way
      const old = list.shift();
      try { old.stop(); } catch (e) { /* already stopped */ }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    let node = src;
    if (volume < 1) {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      node.connect(gain);
      node = gain;
    }
    if (pan && this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = pan;
      node.connect(panner);
      node = panner;
    }
    node.connect(this.master);
    src.onended = () => {
      const i = list.indexOf(src);
      if (i >= 0) list.splice(i, 1);
    };
    list.push(src);
    src.start(0);
  }

  // Quieter with distance and panned toward the source.  ux is the x part
  // of the unit vector from the source to the teapot.
  playFrom(id, dist, ux, game) {
    const volume = 1 - dist / game.univMaxDist;
    const panning = -(ux * dist) / game.univRadX;
    const pan = clamp(panning * 512 / 128, -1, 1);
    this.play(id, Math.max(0, volume), pan);
  }
}
