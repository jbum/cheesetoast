// The snapshot on the wire (net.js), as bytes instead of JSON: 22 bytes a
// sprite instead of about 55, so a busy four-player universe (100 sprites)
// is 2.5 KB a tick instead of 6, two or three UDP packets instead of five or
// more (a snapshot is lost if any of its packets is), and no JSON.parse of
// it on the guest.  Players, the heir and so on stay a small JSON part.
//
//   header   u8 magic, i32 tick (negative early in a game), u8 level,
//            u8 flags (1 = no bots), u16 n, n bytes of UTF-8 JSON
//            { h, players }, u16 sprite count
//   sprite   u32 uid, u8 type, i16 x*10, i16 y*10, i16 vx*100, i16 vy*100,
//            u8 frame, u16 rotation (degrees, 0-359), u8 alpha (0-100),
//            u8 bits (1 visible, 2 shielded), u16 rad*16,
//            u8 owner (1 + its index in players, 0 none), u8 rotIdx
//
// decodeSnapshot gives back the JSON snapshot's shape (sprites as the arrays
// packSprite makes), so the rest of net.js doesn't care which came.

const MAGIC = 0xc7;
const SPRITE_BYTES = 22;
const enc = new TextEncoder(), dec = new TextDecoder();
const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

// sprites: packSprite arrays [uid, type, x, y, vx, vy, frame, rot, alpha, vis, rad, ownerId, rotIdx, shielded]
export function encodeSnapshot({ tick, level, nb, h, players }, sprites) {
  const head = enc.encode(JSON.stringify({ h, players }));
  const slot = new Map(players.map((p, i) => [p[0], i + 1]));
  const buf = new ArrayBuffer(1 + 4 + 1 + 1 + 2 + head.length + 2 + sprites.length * SPRITE_BYTES);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o, MAGIC); o += 1;
  dv.setInt32(o, tick | 0, true); o += 4;
  dv.setUint8(o, Math.min(255, level)); o += 1;
  dv.setUint8(o, nb ? 1 : 0); o += 1;
  dv.setUint16(o, head.length, true); o += 2;
  new Uint8Array(buf, o, head.length).set(head); o += head.length;
  dv.setUint16(o, sprites.length, true); o += 2;
  for (const a of sprites) {
    dv.setUint32(o, a[0] >>> 0, true);
    dv.setUint8(o + 4, a[1]);
    dv.setInt16(o + 5, i16(a[2] * 10), true);
    dv.setInt16(o + 7, i16(a[3] * 10), true);
    dv.setInt16(o + 9, i16(a[4] * 100), true);
    dv.setInt16(o + 11, i16(a[5] * 100), true);
    dv.setUint8(o + 13, a[6] & 255);
    dv.setUint16(o + 14, ((Math.round(a[7]) % 360) + 360) % 360, true);
    dv.setUint8(o + 16, Math.max(0, Math.min(255, a[8])));
    dv.setUint8(o + 17, (a[9] ? 1 : 0) | (a[13] ? 2 : 0));
    dv.setUint16(o + 18, Math.max(0, Math.min(65535, Math.round(a[10] * 16))), true);
    dv.setUint8(o + 20, slot.get(a[11]) || 0);
    dv.setUint8(o + 21, a[12] & 255);
    o += SPRITE_BYTES;
  }
  return buf;
}

export function isSnapshotBytes(buf) {
  return buf instanceof ArrayBuffer && buf.byteLength > 11 && new DataView(buf).getUint8(0) === MAGIC;
}

export function decodeSnapshot(buf) {
  const dv = new DataView(buf);
  let o = 1;
  const tick = dv.getInt32(o, true); o += 4;
  const level = dv.getUint8(o); o += 1;
  const nb = dv.getUint8(o) & 1; o += 1;
  const hl = dv.getUint16(o, true); o += 2;
  const { h, players } = JSON.parse(dec.decode(new Uint8Array(buf, o, hl))); o += hl;
  const n = dv.getUint16(o, true); o += 2;
  const sprites = new Array(n);
  for (let i = 0; i < n; i++, o += SPRITE_BYTES) {
    const owner = dv.getUint8(o + 20);
    const bits = dv.getUint8(o + 17);
    sprites[i] = [dv.getUint32(o, true), dv.getUint8(o + 4),
      dv.getInt16(o + 5, true) / 10, dv.getInt16(o + 7, true) / 10,
      dv.getInt16(o + 9, true) / 100, dv.getInt16(o + 11, true) / 100,
      dv.getUint8(o + 13), dv.getUint16(o + 14, true), dv.getUint8(o + 16),
      bits & 1, dv.getUint16(o + 18, true) / 16, owner ? players[owner - 1][0] : 0,
      dv.getUint8(o + 21), bits & 2 ? 1 : 0];
  }
  return { k: 'snap', tick, level, nb, h, players, sprites };
}
