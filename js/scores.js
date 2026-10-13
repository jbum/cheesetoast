// Shared Hall of Cheese: talks to the score server (server/scores_server.py)
// behind the same origin.  Any failure (offline, or the local dev server,
// which has no /api) returns null, and the game falls back to scores saved
// on this device.

const API = 'api/scores';

async function call(method, body, query = '') {
  try {
    const res = await fetch(API + query, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const type = res.headers.get('Content-Type') || '';
    if (!type.includes('application/json')) return null;   // no score server here
    const data = await res.json();
    return { status: res.status, data };
  } catch (e) {
    return null;
  }
}

// The top scores for a game mode (single, coop, duel, melee) as [{score, level, name}], or null if the server can't be reached
export async function fetchScores(mode = 'single') {
  const r = await call('GET', null, '?mode=' + encodeURIComponent(mode));
  return r && r.status === 200 && Array.isArray(r.data.scores) ? r.data.scores : null;
}

// Returns null when the server can't be reached, else one of
//   { ok: true, rank, status, scores }     (rank is null while pending review)
//   { ok: false, error: 'name' | 'score' | 'busy' | ..., message }
export async function submitScore(entry) {
  const r = await call('POST', entry);
  if (!r) return null;
  if (r.status === 200 && r.data.ok) return r.data;
  return { ok: false, error: r.data.error || 'error', message: r.data.message || 'Something went wrong.' };
}
