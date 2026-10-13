// Boot, the frame loop, and the HTML bits around the canvas: buttons,
// touch controls, overlays and full screen.

import { GS, ST } from './constants.js';
import { loadTextures } from './assets.js';
import { FontMgr } from './font.js';
import { SoundMgr } from './sound.js';
import { Input } from './input.js';
import { Game } from './game.js';
import { randomI } from './util.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const debug = new URLSearchParams(location.search).has('debug');

const startEl = $('start');
const startMsg = $('start-msg');
const startBar = $('start-bar');
const pausedEl = $('paused');
const touchEl = $('touch');
const engraveForm = $('engrave');
const engraveInput = $('engrave-name');

let game = null;
let started = false;
let mp = null;   // online multiplayer (js/mp.js), when enabled
let chat = null; // multiplayer chat (js/chat.js)
let settings = null; // the gear's settings screen (js/settings.js)
const mpBar = $('mp-bar');
const mpStatus = $('mp-status');

function showMpMode(mode) {
  for (const m of ['single', 'coop', 'duel', 'melee']) $('mp-' + m).classList.toggle('on', mode === m);
}

// ------------------------------------------------------------ loading

async function boot() {
  const snd = new SoundMgr();
  document.body.classList.toggle('muted', !snd.enabled);

  let texP = 0, sndP = 0;
  const progress = () => { startBar.style.width = Math.round((texP * 0.6 + sndP * 0.4) * 100) + '%'; };

  const [textures, fontData] = await Promise.all([
    loadTextures((p) => { texP = p; progress(); }),
    fetch('assets/fonts.json').then((r) => r.json()),
    snd.load((p) => { sndP = p; progress(); }),
  ]);

  const font = new FontMgr(fontData, {
    comic: textures[8].image,
    goudy: textures[9].image,
  });
  const input = new Input();
  game = new Game({ canvas, textures, font, snd, input, debug });
  // ?stats turns the overlay on without a keyboard (for the iPad)
  game.wantsStats = new URLSearchParams(location.search).has('stats');
  game.touchMode = isTouchDevice();
  game.ui = { stateChanged, engraveRetry: beginEngrave };

  wireInput(input, snd);
  wireHud(snd);
  wireEngrave();
  window.addEventListener('resize', () => game.resize());
  // iPad: the canvas box can change without a window resize (keyboard, Safari's
  // bars), so watch the box itself and the visual viewport too
  if (window.ResizeObserver) new ResizeObserver(() => game.resize()).observe(canvas);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => game.resize());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (mp && mp.stepAway) mp.stepAway('hidden');   // shared universe: hand off hosting first
      game.pause();
      snd.suspend();
    } else {
      snd.resume();
    }
  });

  // A phone or tablet turned upright pauses the game; the CSS shows the
  // "turn your device sideways" cover for the same media query.
  const portrait = window.matchMedia('(orientation: portrait) and (pointer: coarse)');
  const onOrientation = () => { if (portrait.matches) game.pause(); };
  if (portrait.addEventListener) portrait.addEventListener('change', onOrientation);
  else if (portrait.addListener) portrait.addListener(onOrientation);

  // Online multiplayer (test site): js/mp.js.  ?solo turns it off.
  const params = new URLSearchParams(location.search);
  if (!params.has('solo')) {
    const m = await import('./mp.js');
    mp = m.installMultiplayer(game, {
      setStatus: (text) => { mpStatus.textContent = text; mpStatus.classList.toggle('hidden', !text || game.state !== GS.Play); },
      modeChanged: showMpMode,
      askName: () => names.askName(game).then((n) => { showName(); return n; }),
    });
    showMpMode(mp.mode);
    const names = await import('./names.js');
    const showName = () => { $('mp-name').textContent = (game.nameBuf || '').trim() || 'your name'; };
    showName();
    $('mp-name').addEventListener('click', (e) => { e.stopPropagation(); if (game.state === GS.Attract) mp.askName(); });
    const { installChat } = await import('./chat.js');
    chat = installChat(game, mp, { form: $('chat'), input: $('chat-input') });
    mp.chat = chat;
    if (debug) window.__mp = mp;   // (?debug: tests reach the session and transport)
    window.__chatLog = () => chat.log.map((m) => (m.who ? m.who + ': ' : '') + m.text);   // bot checks
    mp.chatEvents = [];   // for bot recordings (agent.js)
    mp.onChat = (id, name, text) => { chat.add(id, name, text); mp.chatEvents.push([id, text]); };
    mp.onSessionEnd = () => chat.reset();
    game.drawExtras = (v) => { chat.draw(v); mp.checkRoster(); };
    $('mp-single').addEventListener('click', (e) => { e.stopPropagation(); mp.setMode('single'); });
    $('mp-coop').addEventListener('click', (e) => { e.stopPropagation(); mp.setMode('coop'); });
    $('mp-duel').addEventListener('click', (e) => { e.stopPropagation(); mp.setMode('duel'); });
    $('mp-melee').addEventListener('click', (e) => { e.stopPropagation(); mp.setMode('melee'); });
    for (const id of ['mp-single', 'mp-coop', 'mp-duel', 'mp-melee', 'mp-name', 'mp-games', 'mp-settings'])
      $(id).addEventListener('pointerdown', (e) => e.stopPropagation());
    $('mp-settings').addEventListener('click', (e) => { e.stopPropagation(); settings.show(); });
    mp.showName = showName;
    // Join from the games list (games/: ?join=<host id>&mode=...): that game,
    // as soon as the player has tapped in (audio needs the gesture)
    const joinId = params.get('join');
    if (joinId) {
      mp.setMode(params.get('mode') || mp.mode);
      mp.joinHost = joinId;
      history.replaceState(null, '', location.pathname);   // (a reload shouldn't join again)
      pendingJoin = true;
      backToGames = true;
    }
    // New game from the games page (?new=1&mode=&max=&bots=): host one with those settings
    if (params.has('new')) {
      mp.setMode(params.get('mode') || mp.mode);
      if (params.get('max')) mp.setMaxPlayers(+params.get('max'));
      mp.newGame = { noBots: params.get('bots') === '0' };
      history.replaceState(null, '', location.pathname);
      pendingJoin = true;
      backToGames = true;
    }
    // no pausing a shared universe
    const pause = game.pause.bind(game);
    const resume = game.resume.bind(game);
    const sharing = () => !!mp.session && (game.players.length > 1 || !!game.remote);
    game.pause = () => {
      // alone: a real pause, and out of the matchmaker's queue while it lasts
      if (!sharing()) { pause(); if (game.state === GS.Pause) mp.setPaused(true); return; }
      // A shared universe can't stop for one player: pausing opens the
      // settings, which parks your teapot (out of play, pot kept) until you're
      // back.  A host keeps hosting: handing off on P churned the universe
      // between players (in the 2026-10-08 games, P right after starting was
      // common: attract mode says "Hit P to Play").  Switching tabs or apps
      // still hands off (visibilitychange, pagehide: stepAway).
      // (2026-10-08, user's design: the overlay and silence of a pause, with
      // our teapot frozen in place while the others play on)
      if (game.state !== GS.Play || mp.sharedPause) return;
      mp.sharedPause = true;
      mp.setAway(true);
      game.snd.stopAll(); game.realSnd.suspend();
      showPaused();
      mp.diag && mp.diag('pause-shared');
    };
    game.resume = () => {
      if (mp.sharedPause) { endSharedPause(); return; }
      resume(); if (game.state === GS.Play) mp.setPaused(false);
    };
    const endSharedPause = () => {
      mp.sharedPause = false;
      mp.setAway(false);
      game.realSnd.resume();
      showPaused();
    };
    mp.endSharedPause = endSharedPause;
    // alone again while paused (the others left): an ordinary pause
    setInterval(() => {
      if (mp.sharedPause && game.state === GS.Play && !sharing()) { endSharedPause(); pause(); }
    }, 500);
    // host or guest stepping away: hosts hand off, guests stop steering
    mp.stepAway = (why) => {
      const s = mp.session;
      if (!s || !sharing()) return;
      if (s.role === 'host') s.stepDown(why);
      else if (why !== 'pause') { game.input.releaseAll && game.input.releaseAll(); s.sendInput(); }   // switching away: stop steering
      // (a guest pressing pause keeps its controls; it only gets the "can't pause" note)
      mp.diag && mp.diag('step-away ' + why);
    };
    window.addEventListener('pagehide', () => mp.stepAway('pagehide'));
    setInterval(async () => {
      if (game.state !== GS.Attract || !mp) return;
      const st = await new (await import('./rtc.js')).Matchmaker().status();
      $('mp-waiting').textContent = st ? `waiting: ${st.coop} co-op, ${st.duel} duel, ${st.melee || 0} melee` : '';
    }, 5000);
  }

  const { installSettings } = await import('./settings.js');
  settings = installSettings(game, {
    mp, chat, toggleSound, toggleFullscreen, fullscreenSupported, fullscreenElement,
    askName: mp ? () => mp.askName() : null, showName: mp ? () => mp.showName && mp.showName() : null,
  });

  // Bot interface for the multiplayer test site (?agent): see js/agent.js
  if (params.has('agent')) {
    import('./agent.js').then((m) => m.installAgent(game, input, {
      hideStart: () => { started = true; startEl.classList.add('hidden'); },
      mp,
    }));
  }

  startEl.classList.add('ready');
  startMsg.textContent = '';
  // Loaded: the title flies in, then the attract mode begins on its own (a tap
  // or key skips the wait).  Nothing needs a gesture yet: the attract mode is
  // silent, and the key or tap that starts a game unlocks the audio.  Coming
  // from the games list (?join, ?new), straight in.
  startEl.addEventListener('pointerdown', start);
  if (pendingJoin && !params.has('agent')) start();
  else setTimeout(start, 2200);

  const startTitle = startEl.querySelector('h1');
  let last = performance.now();
  const loop = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    if (game.state === GS.Intro) {
      const r = startTitle.getBoundingClientRect();
      const k = canvas.width / canvas.clientWidth;
      game.introTitleRect = { x: r.left * k, y: r.top * k, w: r.width * k, h: r.height * k };
    }
    game.frame(dt);
    if (game.state === GS.Engrave) placeEngraveField();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function isTouchDevice() {
  return navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches;
}

let pendingJoin = false;   // ?join= from the games list: start that game once we're in
// ...and when that game is over (after the spin-out and any engraving), back to
// the games list rather than attract mode
let backToGames = false, playedSinceJoin = false;

function start(e) {
  if (started) return;
  if (e) { e.preventDefault(); game.snd.unlock(); }
  started = true;
  startEl.classList.add('hidden');
  game.startup();
  if (pendingJoin) {
    pendingJoin = false;
    const go = setInterval(() => {
      if (game.state === GS.Attract && game.canStartFromAttract()) { clearInterval(go); game.beginGame(); }
    }, 100);
  }
}

// ------------------------------------------------------------ state-driven UI

// The pause overlay: an ordinary pause, a shared-universe pause (mp.sharedPause:
// the teapot frozen, the game going on), or "End this game?" from the X button
let confirmEnd = false;
function showPaused() {
  const shared = !!(mp && mp.sharedPause);
  const show = (game.state === GS.Pause || shared || confirmEnd) && !(settings && settings.open);
  pausedEl.classList.toggle('hidden', !show);
  $('paused-title').textContent = confirmEnd ? 'End this game?' : 'Paused';
  $('btn-resume').textContent = confirmEnd ? 'Keep playing' : 'Resume';
  $('btn-quit').classList.toggle('pill-dim', !confirmEnd);
  const note = shared && !confirmEnd ? "The game goes on for the others: your teapot is frozen in place" + (game.duel ? ', and rivals can still shoot it.' : '.') : '';
  $('paused-note').textContent = note;
  $('paused-note').classList.toggle('hidden', !note);
}
// X: pause (or freeze), and ask
function askEnd() {
  if (game.state !== GS.Play && game.state !== GS.Pause) return;
  confirmEnd = true;
  if (game.state === GS.Play) game.pause();
  showPaused();
}

function stateChanged(state) {
  const playing = state === GS.Play;
  if (state !== GS.Play && state !== GS.Pause) confirmEnd = false;
  // a shared pause ends with the game (out of pots, quit, the session over)
  if (mp && mp.sharedPause && state !== GS.Play) { mp.sharedPause = false; game.local.wantAway = false; game.realSnd.resume(); }
  if (backToGames) {
    if (playing) playedSinceJoin = true;
    else if (state === GS.Attract && playedSinceJoin) { backToGames = false; location.href = 'games/'; }
  }
  if (mp) {
    mpBar.classList.toggle('hidden', state !== GS.Attract);
    mpStatus.classList.toggle('hidden', !playing || !mp.status);
    // a solo host whose game ends (no partner) leaves the queue
    if (state === GS.GameOver) mp.gameOver();
  }
  const touchControls = playing && game.touchMode;
  touchEl.classList.toggle('hidden', !touchControls);
  document.body.classList.toggle('touch-controls', touchControls);
  $('btn-pause').classList.toggle('hidden', !playing);
  $('btn-end').classList.toggle('hidden', !(playing || state === GS.Pause));
  // the HUD's gear while playing (in attract mode it's on the top line; with ?solo there's no top line)
  $('btn-settings').classList.toggle('hidden', !(playing || state === GS.Pause || (!mp && state === GS.Attract)));
  showPaused();
  if (state === GS.Engrave) beginEngrave();
  else engraveForm.classList.add('hidden');
  if (!playing) game.input.releaseAll();
}

function setTouchMode(on) {
  if (game.touchMode === on) return;
  game.touchMode = on;
  stateChanged(game.state);
}

// ------------------------------------------------------------ input

function wireInput(input, snd) {
  input.attachStick($('tc-stick'));
  input.attachTouchControls($('tc-right'));
  input.onKeyboardUsed = () => setTouchMode(false);

  input.onCommand = (code, e) => {
    if (!started) {
      if (!e.metaKey && !e.altKey) start();
      return;
    }
    snd.unlock();
    if (settings && settings.open) {   // (keys don't reach the game behind the settings)
      if (code === 'Escape' || (code === 'KeyP' && game.state === GS.Play)) settings.hide();   // (P: back from a shared "pause")
      return;
    }
    switch (game.state) {
      case GS.Attract:
        if ((code === 'KeyP' || code === 'Enter' || code === 'Space') && game.canStartFromAttract()) {
          e.preventDefault();
          game.beginGame();
        } else if (code === 'KeyN') {
          game.nextAttractMode();
        } else if (mp && code === 'KeyS') {
          mp.setMode('single');
        } else if (mp && code === 'KeyC') {
          mp.setMode('coop');
        } else if (mp && code === 'KeyD') {
          mp.setMode('duel');
        } else if (mp && code === 'KeyE') {
          mp.setMode('melee');
        }
        break;
      case GS.Play:
        if (mp && mp.connecting) { mp.bailJoin(); break; }   // still connecting to a host: play solo instead
        if (confirmEnd || (mp && mp.sharedPause)) {   // the pause overlay is up (the game going on)
          if (code === 'KeyQ' || (confirmEnd && code === 'Enter')) { confirmEnd = false; game.quitGame(); }
          else if (code === 'KeyP' || code === 'Escape' || code === 'Space') { confirmEnd = false; game.resume(); showPaused(); }
          break;
        }
        if (chat && (code === 'Enter' || code === 'KeyT') && chat.available()) { e.preventDefault(); chat.openField(); break; }
        if (code === 'KeyP' || code === 'Escape') game.pause();
        else if (code === 'KeyQ') game.quitGame();
        else if (debug && code === 'KeyJ') game.newAsteroid(ST.BigJim);
        else if (debug && code === 'KeyI') game.newAsteroid(ST.AIAster);
        else if (debug && code === 'KeyR')
          game.newEnemy([ST.Scone, ST.Toaster, ST.Mixer, ST.Croissant, ST.Saucer, ST.Cube][randomI(6)]);
        break;
      case GS.Pause:
        if (code === 'KeyQ' || (confirmEnd && code === 'Enter')) { confirmEnd = false; game.quitGame(); }
        else if (code === 'KeyP' || code === 'Escape' || code === 'Space') { confirmEnd = false; game.resume(); showPaused(); }
        break;
    }
    switch (code) {
      case 'KeyM': toggleSound(); break;
      case 'KeyF': toggleFullscreen(); break;
      case 'Equal': case 'NumpadAdd': game.zoom(1 / 1.05); break;
      case 'Minus': case 'NumpadSubtract': game.zoom(1.05); break;
      case 'BracketLeft': game.cameraRoll += 6; break;
      case 'BracketRight': game.cameraRoll -= 6; break;
      case 'Backquote': game.wantsStats = !game.wantsStats; break;
    }
  };

  // Every gesture type gets a chance to unlock audio: iOS Safari doesn't
  // always count pointerdown/touchstart as one, but touchend and click are,
  // and the touch controls don't route through the canvas handler below.
  for (const type of ['touchend', 'pointerup', 'click', 'keydown'])
    document.addEventListener(type, () => { if (started) snd.unlock(); }, true);

  // Taps and clicks on the playfield
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') setTouchMode(true);
    snd.unlock();
    if (game.state === GS.Attract && game.canStartFromAttract())
      game.beginGame();
    else if (game.state === GS.Play && mp && mp.connecting) mp.bailJoin();
  });
  // keep iOS from treating quick double taps or pinches as zooms
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());
}

// ------------------------------------------------------------ HUD buttons

function wireHud(snd) {
  const tap = (id, fn) => $(id).addEventListener('click', (e) => {
    e.stopPropagation();
    snd.unlock();
    fn();
    e.currentTarget.blur();
  });
  tap('btn-sound', toggleSound);
  tap('btn-settings', () => settings && settings.show());
  tap('btn-pause', () => game.pause());
  tap('btn-resume', () => { confirmEnd = false; game.resume(); showPaused(); });
  tap('btn-quit', () => { confirmEnd = false; game.quitGame(); });
  tap('btn-end', askEnd);
  for (const id of ['btn-sound', 'btn-settings', 'btn-end', 'btn-pause', 'btn-fullscreen', 'btn-resume', 'btn-quit'])
    $(id).addEventListener('pointerdown', (e) => e.stopPropagation());

  // Full screen: the Fullscreen API where there is one (desktop, iPad, Android).
  // Safari on iPhone has none, so there the button explains Add to Home Screen,
  // which runs the game without browser bars (manifest + apple-mobile-web-app tags).
  const fsBtn = $('btn-fullscreen');
  const fsHelp = $('fs-help');
  const standalone = navigator.standalone ||
    window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  const isIOS = /iP(hone|ad|od)/.test(navigator.platform) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (fullscreenSupported()) {
    tap('btn-fullscreen', toggleFullscreen);
  } else if (isIOS && !standalone) {
    tap('btn-fullscreen', () => { if (!mp || !mp.sharing()) game.pause(); fsHelp.classList.remove('hidden'); });
    tap('btn-fs-help-close', () => fsHelp.classList.add('hidden'));
    $('btn-fs-help-close').addEventListener('pointerdown', (e) => e.stopPropagation());
    fsHelp.addEventListener('pointerdown', (e) => e.stopPropagation());
  } else {
    fsBtn.classList.add('hidden');
  }
  const onFsChange = () => {
    document.body.classList.toggle('fullscreen', !!fullscreenElement());
    setTimeout(() => game.resize(), 100);
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  stateChanged(game.state);
}

function toggleSound() {
  const on = game.snd.toggle();
  document.body.classList.toggle('muted', !on);
}

function fullscreenSupported() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

function toggleFullscreen() {
  if (fullscreenElement()) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      const p = req.call(el);
      // Android can hold landscape while full screen (iOS has no orientation lock)
      const lock = () => {
        const o = screen.orientation;
        if (o && o.lock) o.lock('landscape').catch(() => {});
      };
      if (p && p.then) p.then(lock, () => {});
      else lock();
    }
  }
}

// ------------------------------------------------------------ high score name entry

function wireEngrave() {
  engraveInput.addEventListener('input', () => {
    if (game.engraveMsg && !game.engraveBusy) game.engraveMsg = '';
    game.setEngraveName(engraveInput.value);
    if (engraveInput.value !== game.nameBuf) engraveInput.value = game.nameBuf;
    updateEngraveButton();
  });
  engraveInput.addEventListener('focus', () => { game.engraveFocused = true; });
  engraveInput.addEventListener('blur', () => {
    game.engraveFocused = false;
    setTimeout(() => { window.scrollTo(0, 0); game.resize(); }, 50);   // iOS: undo keyboard scrolling
  });
  engraveInput.addEventListener('keydown', (e) => e.stopPropagation());
  engraveForm.addEventListener('submit', (e) => {
    e.preventDefault();
    engraveInput.blur();
    game.finishEngrave();
  });
  engraveForm.addEventListener('pointerdown', (e) => e.stopPropagation());
}

// "Engrave" stays dim until there's a name, which shows the order: type, then engrave
function updateEngraveButton() {
  $('engrave-done').disabled = !game.nameBuf.trim();
}

function beginEngrave() {
  engraveInput.value = game.nameBuf;
  updateEngraveButton();
  engraveForm.classList.remove('hidden');
  placeEngraveField();
  if (!game.touchMode) engraveInput.focus();
}

function placeEngraveField() {
  const r = game.engraveNameRect();
  Object.assign(engraveForm.style, {
    left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
  });
}

boot().catch((err) => {
  console.error(err);
  startMsg.textContent = 'Sorry, the game failed to load.';
});
