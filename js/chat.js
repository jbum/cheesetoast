// Multiplayer chat (desktop): Enter (or T) opens a one-line field, Enter sends,
// Esc cancels.  Messages appear as speech balloons over the speaker's teapot
// (at the screen edge, pointing their way, when they're off screen) plus a
// faint log of the last few lines.  Only while you have a partner.  Each
// message is checked (PG-13) by the score server's Jev check before sending;
// if that can't be reached, a short local word list stands in.  Also draws
// the other players' names under their teapots.

export const BLOCK = /\b(f+u+c+k|sh[i1]+t|b[i1]tch|c+u+n+t|n[i1]gg|fag|slut|whore|dick|cock|pussy|rape|kys)/i;
const CSS_FONT = '"Comic Neue", "Chalkboard SE", "Chalkboard", "Comic Sans MS", sans-serif';

export function installChat(game, mp, { form, input }) {
  // personal settings (js/settings.js): chat on/off, players muted by name, name tags
  const chat = { balloons: new Map(), log: [], lastLogTime: 0, open: false, enabled: true, tags: true, muted: new Set() };
  const mutedName = (name) => chat.muted.has(String(name || '').trim().toLowerCase());
  chat.isMuted = mutedName;

  const partnered = () => !!mp.session && (game.players.length > 1 || !!game.remote);
  chat.available = () => partnered() && !game.touchMode && chat.enabled;

  chat.openField = () => {
    if (!chat.available()) return false;
    game.input.releaseAll();
    form.classList.remove('hidden');
    input.value = '';
    input.focus();
    chat.open = true;
    return true;
  };
  chat.closeField = () => {
    form.classList.add('hidden');
    input.blur();
    chat.open = false;
  };

  async function allowed(text) {
    try {
      const res = await fetch('api/chat-check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), cache: 'no-store',
      });
      const r = await res.json();
      if (r.checked) return r.ok;
      return !BLOCK.test(text);
    } catch (e) {
      return !BLOCK.test(text);
    }
  }

  chat.say = async (text) => {
    text = String(text || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 100);
    if (!text || !mp.session) return false;
    if (chat.sending) return false;
    chat.sending = true;
    try {
      if (!(await allowed(text))) {
        chat.add(mp.session.id, '', '(not sent: keep it PG-13)', true);
        return false;
      }
      if (mp.session) mp.session.sendChat(text);
      return true;
    } finally {
      chat.sending = false;
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    chat.closeField();
    chat.say(text);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); chat.closeField(); }
  });
  input.addEventListener('blur', () => { if (chat.open) chat.closeField(); });
  form.addEventListener('pointerdown', (e) => e.stopPropagation());

  // a message arrived (or we sent one)
  chat.add = (id, name, text, privateNote = false) => {
    // chat off, or a muted player: not shown (our own lines and notes always are)
    const mine = privateNote || id === (mp.session && mp.session.id);
    if (!mine && (!chat.enabled || mutedName(name))) return;
    const now = performance.now();
    const life = 3500 + 60 * text.length;
    chat.balloons.set(id, { text, born: now, life, privateNote });
    chat.log.push({ who: privateNote ? '' : (id === (mp.session && mp.session.id) ? 'you' : name || 'someone'), text, at: now });
    if (chat.log.length > 5) chat.log.shift();
    chat.lastLogTime = now;
  };

  chat.reset = () => { chat.balloons.clear(); chat.log = []; chat.closeField(); };

  // ---- drawing (called at the end of Game.renderGame)

  function screenPos(v, x, y) {
    const d = { x: x - v.offX, y: y - v.offY };
    game.bindToUniverseTorus(d);
    const { a, b, c, d: dd, e, f } = v.m;
    return [a * d.x - c * d.y + e, b * d.x - dd * d.y + f];
  }

  function wrap(ctx, text, maxW) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  }

  function balloon(ctx, k, tx, ty, text, alpha, own) {
    const W = game.cw, H = game.ch;
    const fs = 15 * k, pad = 8 * k, maxW = 240 * k;
    ctx.font = `700 ${fs}px ${CSS_FONT}`;
    const lines = wrap(ctx, text, maxW);
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const bh = lines.length * fs * 1.25 + pad * 2;
    const margin = 10 * k;
    // above the teapot, kept on screen
    let bx = tx - bw / 2, by = ty - 34 * k - bh;
    bx = Math.max(margin, Math.min(W - margin - bw, bx));
    by = Math.max(margin, Math.min(H - margin - bh - 60 * k, by));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = own ? 'rgba(10, 40, 60, 0.85)' : 'rgba(40, 15, 45, 0.85)';
    ctx.strokeStyle = own ? 'rgba(127, 233, 238, 0.9)' : 'rgba(255, 170, 220, 0.9)';
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 10 * k); else ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.stroke();
    // tail toward the teapot (clamped to the balloon's bottom edge)
    const cx = Math.max(bx + 14 * k, Math.min(bx + bw - 14 * k, tx));
    const tipX = Math.max(margin, Math.min(W - margin, tx)), tipY = Math.max(margin, Math.min(H - margin, ty - 18 * k));
    ctx.beginPath();
    ctx.moveTo(cx - 7 * k, by + bh - 1);
    ctx.lineTo(tipX, Math.max(by + bh + 4 * k, tipY));
    ctx.lineTo(cx + 7 * k, by + bh - 1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f2fbff';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + i * fs * 1.25));
    ctx.restore();
  }

  chat.draw = (v) => {
    if (!mp.session) return;
    const ctx = game.ctx;
    const k = game.cw / game.cssW;   // device pixels per CSS pixel
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const now = performance.now();

    // name tags under the other players' teapots
    if (partnered() && chat.tags) {
      ctx.font = `700 ${12 * k}px ${CSS_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      // only players with a teapot flying (not waiting to respawn)
      const others = game.remote ? (mp.session.others || []).filter((o) => o[7]).map((o) => ({ id: o[0], name: o[1], paused: !!o[15] }))
        : game.players.filter((p) => p !== game.local && p.ship && p.ship.active && p.ship.type === 1).map((p) => ({ id: p.id, name: p.name, paused: !!p.away }));
      for (const o of others) {
        const pos = mp.session.positionOf(o.id, v.lerp);
        if (!pos) continue;
        const [sx, sy] = screenPos(v, pos.x, pos.y);
        if (sx < -50 || sy < -50 || sx > game.cw + 50 || sy > game.ch + 50) continue;
        ctx.fillStyle = 'rgba(255, 190, 230, 0.75)';
        ctx.fillText((o.name || 'player') + (o.paused ? ' (paused)' : ''), sx, sy + 22 * k);
      }
      ctx.textAlign = 'start';
    }

    // balloons
    for (const [id, bl] of chat.balloons) {
      const age = now - bl.born;
      if (age > bl.life) { chat.balloons.delete(id); continue; }
      const alpha = Math.min(1, (bl.life - age) / 500);
      const pos = mp.session.positionOf(id, v.lerp) || { x: v.offX, y: v.offY };
      const [sx, sy] = screenPos(v, pos.x, pos.y);
      balloon(ctx, k, sx, sy, bl.text, alpha, id === mp.session.id);
    }

    // faint log, top left, fades out a while after the last message
    const since = now - chat.lastLogTime;
    if (chat.log.length && since < 12000 && !game.touchMode) {   // touch: the radar lives top left
      const a = Math.min(0.7, (12000 - since) / 2000);
      ctx.font = `700 ${13 * k}px ${CSS_FONT}`;
      ctx.textBaseline = 'top';
      chat.log.forEach((m, i) => {
        ctx.fillStyle = `rgba(200, 235, 245, ${a})`;
        ctx.fillText((m.who ? m.who + ': ' : '') + m.text, 12 * k, (12 + i * 17) * k);
      });
    }
  };

  return chat;
}
