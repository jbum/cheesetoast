// A bot that wants to lose: flies at the nearest asteroid and never shields.
// Used by bots/scenarios.mjs to make a player run out of pots on cue.
export function makeKamikaze({ every = 4 } = {}) {
  return {
    name: 'kamikaze',
    async decide(st) {
      const plan = [];
      const target = st.me && st.me.alive && st.entities.find((e) => e.kind === 'asteroid' || e.kind === 'enemy' || e.kind === 'teeth');
      let turn = target ? target.turn_steps : 0;
      for (let i = 0; i < every; i++) {
        const c = { thrust: !!target && Math.abs(turn) <= 1 };
        if (turn > 0) { c.right = true; turn--; } else if (turn < 0) { c.left = true; turn++; }
        plan.push(c);
      }
      return { plan, label: target ? `ram ${target.type}` : 'looking for trouble' };
    },
  };
}
