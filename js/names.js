// The player-name dialog (multiplayer): asked before the first game when no
// name has been saved, and from the mode bar's name button.  Names are checked
// for PG-13 by the score server (Jev); if it can't be reached, chat's short
// word list stands in.  Names are made unique within a universe by the host
// (net.js uniqueName).

import { BLOCK } from './chat.js';
import { loadPref, savePref } from './util.js';

export const NAME_KEY = 'cheesetoast.name';
const MAX_LEN = 20;

export const savedName = () => String(loadPref(NAME_KEY, '') || '').trim();

async function check(name) {
  try {
    const res = await fetch('api/name-check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }), cache: 'no-store',
    });
    const r = await res.json();
    if (r.checked || !r.ok) return r;
  } catch (e) { /* no score server here */ }
  return BLOCK.test(name) ? { ok: false, message: "That name isn't allowed. Try another?" } : { ok: true, name };
}

// Resolves to the chosen name, or null if cancelled
export function askName(game, { title = 'What should we call you?' } = {}) {
  const dlg = document.getElementById('name-dlg');
  const input = document.getElementById('name-input');
  const msg = document.getElementById('name-msg');
  const ok = document.getElementById('name-ok');
  document.getElementById('name-title').textContent = title;
  game.input && game.input.releaseAll && game.input.releaseAll();
  input.value = savedName() || game.nameBuf || '';
  input.maxLength = MAX_LEN;
  msg.textContent = '';
  dlg.classList.remove('hidden');
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return new Promise((resolve) => {
    const done = (name) => {
      dlg.classList.add('hidden');
      dlg.onsubmit = null;
      document.getElementById('name-cancel').onclick = null;
      input.onkeydown = null;
      input.blur();
      // iOS can leave the page scrolled after its keyboard closes
      setTimeout(() => { window.scrollTo(0, 0); game.resize && game.resize(); }, 50);
      resolve(name);
    };
    dlg.onsubmit = async (e) => {
      e.preventDefault();
      const name = input.value.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
      if (!name) { msg.textContent = 'Please type a name.'; return; }
      ok.disabled = true;
      msg.textContent = 'Checking...';
      const r = await check(name);
      ok.disabled = false;
      if (!r.ok) { msg.textContent = r.message || "That name isn't allowed."; input.select(); return; }
      savePref(NAME_KEY, name);
      game.nameBuf = name;
      done(name);
    };
    document.getElementById('name-cancel').onclick = () => done(null);
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  });
}
