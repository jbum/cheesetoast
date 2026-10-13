// The settings screen (the gear on the top line in attract mode, and on the
// HUD while playing).  Your own settings, remembered on this device: sound,
// volume, full screen, name, name tags, reduce motion, the touch buttons'
// side and size, how many players you like in a game, chat and who you've
// muted.  In a multiplayer game also the universe's own: whether bots may
// join, which any person in it can change (mp.js).  Alone, opening it pauses
// the game; in a shared universe the others play on, so your teapot is frozen
// in place until you're back (mp.setAway).

import { GS, SND } from './constants.js';
import { loadPref, savePref, clamp } from './util.js';

const PREFS = {
  tags: 'cheesetoast.nameTags', motion: 'cheesetoast.reduceMotion', lefty: 'cheesetoast.leftHanded',
  btn: 'cheesetoast.buttonSize', chat: 'cheesetoast.chat', mutes: 'cheesetoast.mutes',
};

export function installSettings(game, { mp, chat, toggleSound, toggleFullscreen, fullscreenSupported, fullscreenElement, askName, showName }) {
  const $ = (id) => document.getElementById(id);
  const el = $('settings');
  const settings = { open: false };
  let paused = false;    // we paused the game to come here
  let refresh = null;

  // ---- remembered personal settings, applied now
  const prefs = {
    tags: loadPref(PREFS.tags, true) !== false,
    motion: !!loadPref(PREFS.motion, window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    lefty: !!loadPref(PREFS.lefty, false),
    btn: clamp(+loadPref(PREFS.btn, 1) || 1, 0.8, 1.3),
    chat: loadPref(PREFS.chat, true) !== false,
    mutes: Array.isArray(loadPref(PREFS.mutes, [])) ? loadPref(PREFS.mutes, []) : [],
  };
  const apply = () => {
    game.reduceMotion = prefs.motion;
    document.body.classList.toggle('lefty', prefs.lefty);
    document.documentElement.style.setProperty('--btn-scale', prefs.btn);
    if (chat) {
      chat.tags = prefs.tags;
      chat.enabled = prefs.chat;
      chat.muted = new Set(prefs.mutes.map((n) => String(n).toLowerCase()));
    }
  };
  const set = (k, v) => { prefs[k] = v; savePref(PREFS[k], v); apply(); sync(); };
  apply();

  const inPlay = () => game.state === GS.Play || game.state === GS.Pause;

  function mutesList() {
    // the players in this game, each with a mute switch; and anyone muted before
    const here = mp && mp.session && inPlay() && mp.otherPlayers ? mp.otherPlayers() : [];
    const names = new Map();
    for (const p of here) names.set(String(p.name).toLowerCase(), { name: p.name, bot: p.bot, here: true });
    for (const n of prefs.mutes) if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), { name: n, here: false });
    const box = $('set-mutes');
    const key = JSON.stringify([...names.values()]) + prefs.mutes.join('|') + prefs.chat;
    if (box.dataset.key === key) return;   // (rebuilt only when it changes: keeps focus while open)
    box.dataset.key = key;
    box.innerHTML = '';
    if (!prefs.chat || !names.size) return;
    for (const [low, p] of names) {
      const row = document.createElement('label');
      row.className = 'set-row mute-row';
      const span = document.createElement('span');
      span.textContent = `Mute ${p.name}` + (p.here ? '' : ' (not here)');
      const sw = document.createElement('input');
      sw.type = 'checkbox'; sw.className = 'switch';
      sw.checked = prefs.mutes.some((n) => n.toLowerCase() === low);
      sw.addEventListener('change', () => set('mutes', sw.checked
        ? [...prefs.mutes.filter((n) => n.toLowerCase() !== low), p.name]
        : prefs.mutes.filter((n) => n.toLowerCase() !== low)));
      row.append(span, sw);
      box.append(row);
    }
  }

  function sync() {
    $('set-sound').checked = game.snd.enabled;
    $('set-volume').value = Math.round(game.snd.volume * 100);
    $('set-volume').disabled = !game.snd.enabled;
    $('set-fs-row').classList.toggle('hidden', !fullscreenSupported());
    $('set-fs').checked = !!fullscreenElement();
    // your name: changed between games (the host already knows you by it)
    $('set-name-row').classList.toggle('hidden', !mp || !askName || inPlay());
    $('set-name').textContent = (game.nameBuf || '').trim() || 'your name';
    $('set-tags').checked = prefs.tags;
    $('set-motion').checked = prefs.motion;
    // touch buttons: on touch devices
    $('set-touch').classList.toggle('hidden', !game.touchMode);
    $('set-lefty').checked = prefs.lefty;
    $('set-btn').value = Math.round(prefs.btn * 100);
    // playing with others
    $('set-mp').classList.toggle('hidden', !mp);
    if (mp) {
      for (const b of $('set-max').querySelectorAll('button')) {
        const on = +b.dataset.n === mp.maxPlayers;
        b.classList.toggle('on', on); b.setAttribute('aria-checked', on);
      }
      $('set-chat').checked = prefs.chat;
      $('set-chat-row').classList.toggle('hidden', !!game.touchMode);   // (chat is typed: desktop only)
      mutesList();
    }
    // the controls: keys, or the touch buttons
    $('set-keys').classList.toggle('hidden', !!game.touchMode);
    $('set-touch-help').classList.toggle('hidden', !game.touchMode);
    // this universe's settings: only while in a multiplayer game, for people
    const multi = !!(mp && mp.session && inPlay() && !game.local.bot);
    $('set-game').classList.toggle('hidden', !multi);
    if (multi) {
      const noBots = mp.noBots();
      $('set-bots').checked = !noBots;
      $('set-bots-note').textContent = noBots
        ? 'No bots will be sent here, and any that were here have left.'
        : 'When you wait alone, a bot (🤖) may come to play with you.';
    }
    const shared = !!(mp && mp.sharing && mp.sharing());
    $('set-away-note').textContent = settings.open && shared && game.state === GS.Play
      ? "The game goes on for the others: your teapot is frozen in place until you're back" + (game.duel ? ' (rivals can still shoot it).' : '.') : '';
    $('set-close').textContent = inPlay() ? 'Back to the game' : 'Done';
    $('set-quit').classList.toggle('hidden', !inPlay());
  }

  settings.show = () => {
    if (settings.open) return;
    settings.open = true;
    game.input.releaseAll();
    if (game.state === GS.Play) {
      if (mp && mp.sharing && mp.sharing()) mp.setAway(true);
      else { game.pause(); paused = game.state === GS.Pause; }
    }
    sync();
    el.classList.remove('hidden');
    game.ui && game.ui.stateChanged(game.state);
    refresh = setInterval(sync, 500);   // a partner may change the game's settings meanwhile
    setTimeout(() => $('set-close').focus(), 0);
  };

  settings.hide = () => {
    if (!settings.open) return;
    settings.open = false;
    clearInterval(refresh);
    el.classList.add('hidden');
    if (mp && mp.setAway) mp.setAway(false);
    if (paused && game.state === GS.Pause) game.resume();
    paused = false;
    game.ui && game.ui.stateChanged(game.state);
  };

  $('set-sound').addEventListener('change', () => { if ($('set-sound').checked !== game.snd.enabled) toggleSound(); sync(); });
  $('set-volume').addEventListener('input', () => game.snd.setVolume($('set-volume').value / 100));
  // a sample at the new loudness
  $('set-volume').addEventListener('change', () => game.realSnd.play(SND.Bell, 1));
  $('set-fs').addEventListener('change', () => { toggleFullscreen(); setTimeout(sync, 300); });
  $('set-name').addEventListener('click', () => { if (askName) askName().then(() => { showName && showName(); sync(); }); });
  $('set-tags').addEventListener('change', () => set('tags', $('set-tags').checked));
  $('set-motion').addEventListener('change', () => set('motion', $('set-motion').checked));
  $('set-lefty').addEventListener('change', () => set('lefty', $('set-lefty').checked));
  $('set-btn').addEventListener('input', () => set('btn', $('set-btn').value / 100));
  $('set-max').addEventListener('click', (e) => { const n = e.target.dataset && +e.target.dataset.n; if (n && mp) { mp.setMaxPlayers(n); sync(); } });
  $('set-chat').addEventListener('change', () => {
    set('chat', $('set-chat').checked);
    if (!prefs.chat && chat) chat.reset();   // (what others said so far goes too)
  });
  $('set-bots').addEventListener('change', () => { if (mp) mp.setNoBots(!$('set-bots').checked); setTimeout(sync, 150); });
  $('set-close').addEventListener('click', () => settings.hide());
  $('set-quit').addEventListener('click', () => { settings.hide(); game.quitGame(); });
  el.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === el) settings.hide(); });
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();   // (keys here don't steer the teapot)
    // Esc closes; so does P when it was P that opened it (a "pause" in a shared universe)
    if (e.key === 'Escape' || (e.code === 'KeyP' && game.state === GS.Play)) { e.preventDefault(); settings.hide(); }
  });
  return settings;
}
