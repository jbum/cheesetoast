// A hand-written baseline: aim at the closest thing worth shooting, fire when
// lined up, shield when something is about to hit, drift toward targets when
// nothing is in range.  Used to check the pipeline and as a yardstick for Jev.
export function makeHeuristic({ every = 4 } = {}) {
  return {
    name: 'heuristic',
    async decide(st) {
      const plan = [];
      const me = st.me;
      if (!me || !me.alive) {
        for (let i = 0; i < every; i++) plan.push({});
        return { plan, label: 'waiting' };
      }
      const shootable = st.entities.filter((e) => e.kind === 'asteroid' || e.kind === 'enemy' || e.kind === 'rival');
      const danger = st.entities.find((e) => e.kind !== 'powerup' && e.ticks_to_impact !== null &&
        e.ticks_to_impact < 10 && e.gap < 80);
      const target = shootable.find((e) => e.in_fire_range) || shootable[0];
      const shield = !!danger && me.shield_power > 0 && !me.invulnerable;
      let turn = target ? target.turn_steps : 0;
      const thrust = target && !target.in_fire_range && Math.abs(turn) <= 1 && me.speed < 5;
      for (let i = 0; i < every; i++) {
        const c = { fire: !!target && target.in_fire_range && Math.abs(turn) <= 1, shield, thrust: thrust && i === 0 };
        if (turn > 0) { c.right = true; turn--; } else if (turn < 0) { c.left = true; turn++; }
        plan.push(c);
      }
      const label = (shield ? 'shield ' : '') + (target ? `aim ${target.type} ${target.bearing}°` : 'idle');
      return { plan, label };
    },
  };
}
