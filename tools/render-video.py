#!/usr/bin/env python3
"""Render a bot game log (bots/logs/*.jsonl.gz) as a full-universe video.

    python3 tools/render-video.py LOG [-o out.mp4] [--every 1] [--max-frames N]

The whole 3840x1920 universe is drawn at half scale (1920x960) over the dusk
clouds, with every sprite from the real sprite sheets.  Each player's teapot is
ringed and leaves a short trail; an inset in the corner follows player 1 at
game scale (bottom left, clear of both whorls), with players' names, and a
strip along the bottom shows time, scores, pots, shields and
what each bot decided.  Frames are piped to ffmpeg (H.264, 20 fps = real time), into
"<name>.mp4.rendering", renamed to <name>.mp4 when complete.

Needs Pillow and ffmpeg.  Multiplayer logs carry several ships ("ships": [...]);
single-player logs have one ("ship").
"""
import argparse, gzip, json, math, os, random, subprocess, sys, signal
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
UW, UH = 3840, 1920                 # universe
W, H = 1920, 1080                   # video
SCALE = 0.5                          # universe -> video
HUD_H = H - int(UH * SCALE)          # 120 px status strip
INSET_W, INSET_H, INSET_SCALE = 560, 330, 1.0
PLAYER_COLORS = [(80, 200, 255), (255, 170, 60), (140, 255, 120), (255, 110, 200)]

try:
    FONT = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 26)
    FONT_S = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 20)
except OSError:
    FONT = FONT_S = ImageFont.load_default()


def load_log(path):
    opener = gzip.open if path.endswith('.gz') else open
    meta, frames = None, []
    with opener(path, 'rt') as f:
        for line in f:
            obj = json.loads(line)
            if 'meta' in obj:
                meta = obj['meta']
            else:
                frames.append(obj)
    return meta, frames


class Sheets:
    """Sprite cells from the texture atlases, scaled and rotated on demand (cached)."""

    def __init__(self, textures):
        self.tex = []
        for file, cell in textures:
            p = os.path.join(ROOT, 'assets', 'img', file)
            img = Image.open(p).convert('RGBA') if cell and os.path.exists(p) else None
            self.tex.append((img, cell))
        self.cache = {}

    def get(self, tex, idx, size, rot, alpha):
        size = max(2, int(round(size)))
        rot = int(round(rot / 5.0)) * 5 % 360
        alpha = int(round(alpha / 10.0)) * 10
        key = (tex, idx, size, rot, alpha)
        im = self.cache.get(key)
        if im is not None:
            return im
        img, cell = self.tex[tex] if tex < len(self.tex) else (None, 0)
        if img is None:
            return None
        cols = img.width // cell
        x, y = (idx % cols) * cell, (idx // cols) * cell
        im = img.crop((x, y, x + cell, y + cell)).resize((size, size), Image.LANCZOS)
        if rot:
            im = im.rotate(rot, resample=Image.BICUBIC, expand=True)
        if alpha < 100:
            a = im.getchannel('A').point(lambda v: v * alpha // 100)
            im.putalpha(a)
        if len(self.cache) > 20000:
            self.cache.clear()
        self.cache[key] = im
        return im


def make_background():
    bg = Image.new('RGB', (int(UW * SCALE), int(UH * SCALE)), (0, 0, 0))
    clouds = Image.open(os.path.join(ROOT, 'assets', 'img', 'clouds_dusk.png')).convert('RGB')
    clouds = clouds.resize(bg.size, Image.BICUBIC)
    bg = Image.blend(bg, clouds, 0.38)
    d = ImageDraw.Draw(bg)
    rnd = random.Random(7)
    for _ in range(1400):
        x, y = rnd.randrange(bg.width), rnd.randrange(bg.height)
        v = rnd.randrange(90, 255)
        d.point((x, y), fill=(v, v, min(255, v + 20)))
    return bg


def to_screen(x, y, cx, cy, scale, w, h):
    """World (y up) to image pixels; (cx, cy) is the world point at the image center."""
    dx = (x - cx + UW / 2) % UW - UW / 2
    dy = (y - cy + UH / 2) % UH - UH / 2
    return w / 2 + dx * scale, h / 2 - dy * scale


def draw_sprites(img, frame, sheets, cx, cy, scale, enlarge=1.0):
    w, h = img.size
    uw, uh = UW * scale, UH * scale   # the universe's size in pixels (the torus repeats)
    for t, x, y, tex, idx, rad, rot, alpha in frame['s']:
        sx0, sy0 = to_screen(x, y, cx, cy, scale, w, h)
        size = 2 * rad * scale * enlarge
        cell = None
        # near an edge, also draw the copy that wraps in from the other side
        for ox in (0, -uw, uw):
            for oy in (0, -uh, uh):
                sx, sy = sx0 + ox, sy0 + oy
                if sx < -size or sy < -size or sx > w + size or sy > h + size:
                    continue
                cell = cell or sheets.get(tex, idx, size, rot, alpha)
                if cell is None:
                    break
                img.paste(cell, (int(sx - cell.width / 2), int(sy - cell.height / 2)), cell)


def ships_of(frame):
    if 'ships' in frame:
        return frame['ships']
    s = frame.get('ship')
    return [{'id': 1, 'pos': s, 'score': frame.get('score'), 'pots': frame.get('pots'),
             'shield': frame.get('shield'), 'a': frame.get('a', ''), 'name': 'bot'}] if s else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('log')
    ap.add_argument('-o', '--out')
    ap.add_argument('--every', type=int, default=1, help='use every Nth tick (2 = twice as fast)')
    ap.add_argument('--max-frames', type=int, default=0)
    ap.add_argument('--title', default='')
    args = ap.parse_args()

    meta, frames = load_log(args.log)
    if not frames:
        sys.exit('no frames in ' + args.log)
    frames = frames[::args.every]
    if args.max_frames:
        frames = frames[:args.max_frames]
    out = args.out or os.path.splitext(os.path.splitext(args.log)[0])[0] + '.mp4'
    title = args.title or (meta or {}).get('title') or os.path.basename(args.log).split('.')[0]
    sheets = Sheets(meta['textures'])
    bg = make_background()
    big_bg = bg.resize((int(UW * INSET_SCALE), int(UH * INSET_SCALE)), Image.BILINEAR)
    trails = {}
    chats = {}
    inset_at = None

    # Write to "<name>.mp4.rendering" and rename when done (like a browser
    # download), so a video still being rendered is never mistaken for a
    # finished one; a failed or interrupted render deletes its partial file.
    part = out + '.rendering'
    def stop(signum, frame):   # kill / Ctrl-C: clean up like any other failure
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    ff = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                           '-s', f'{W}x{H}', '-r', '20', '-i', '-',   # every Nth tick at 20 fps = N x speed
                           '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p',
                           '-movflags', '+faststart', '-f', 'mp4', part], stdin=subprocess.PIPE)
    try:
        for n, fr in enumerate(frames):
            canvas = Image.new('RGB', (W, H), (12, 12, 18))
            uni = bg.copy()
            # universe view: centered on the universe's center (0, 0)
            draw_sprites(uni, fr, sheets, 0, 0, SCALE, enlarge=1.25)
            d = ImageDraw.Draw(uni)
            ships = ships_of(fr)
            for cid, text in fr.get('chat', []):
                chats[cid] = [text, 90]          # show for ~4.5 s
            for cid in list(chats):
                chats[cid][1] -= 1
                if chats[cid][1] <= 0:
                    del chats[cid]
            for i, sh in enumerate(ships):
                pos = sh.get('pos')
                if not pos or not pos[3]:   # waiting to respawn: nothing to draw
                    continue
                color = PLAYER_COLORS[i % len(PLAYER_COLORS)]
                sx, sy = to_screen(pos[0], pos[1], 0, 0, SCALE, uni.width, uni.height)
                tr = trails.setdefault(sh.get('id', i), [])
                tr.append((sx, sy))
                del tr[:-40]
                for (ax, ay), (bx, by) in zip(tr, tr[1:]):
                    if abs(ax - bx) < 100 and abs(ay - by) < 100:   # skip torus wraps
                        d.line([(ax, ay), (bx, by)], fill=color, width=2)
                r = 22
                d.ellipse([sx - r, sy - r, sx + r, sy + r], outline=color, width=3 if pos[3] else 1)
                if sh.get('name'):
                    d.text((sx + r + 4, sy - r), sh['name'], fill=color, font=FONT_S)
                said = chats.get(sh.get('id'))
                if said:
                    tw = d.textlength(said[0], font=FONT_S)
                    bx, by = max(4, min(uni.width - tw - 24, sx - tw / 2 - 10)), max(4, sy - r - 48)
                    d.rounded_rectangle([bx, by, bx + tw + 20, by + 32], radius=10, fill=(30, 20, 40), outline=color, width=2)
                    d.polygon([(sx - 6, by + 32), (sx + 6, by + 32), (sx, sy - r)], fill=(30, 20, 40), outline=color)
                    d.text((bx + 10, by + 5), said[0], fill=(240, 250, 255), font=FONT_S)
            canvas.paste(uni, (0, 0))

            # inset: player 1 at game scale
            if ships and ships[0].get('pos') and ships[0]['pos'][3]:
                inset_at = ships[0]['pos']        # follow player 1; hold still while they respawn
            if inset_at:
                p = inset_at
                inset = Image.new('RGB', (INSET_W, INSET_H), (0, 0, 0))
                # crop the background around the ship (with wrap) from the scaled background
                bgx, bgy = (p[0] + UW / 2) * INSET_SCALE, (UH / 2 - p[1]) * INSET_SCALE
                for ox in (-UW * INSET_SCALE, 0, UW * INSET_SCALE):
                    for oy in (-UH * INSET_SCALE, 0, UH * INSET_SCALE):
                        inset.paste(big_bg, (int(INSET_W / 2 - bgx + ox), int(INSET_H / 2 - bgy + oy)))
                draw_sprites(inset, fr, sheets, p[0], p[1], INSET_SCALE)
                di = ImageDraw.Draw(inset)
                # every player near player 1: a ring in their color and their name
                for k, sh in enumerate(ships):
                    q = sh.get('pos')
                    if not q or not q[3]:
                        continue
                    ix, iy = to_screen(q[0], q[1], p[0], p[1], INSET_SCALE, INSET_W, INSET_H)
                    if -40 < ix < INSET_W + 40 and -40 < iy < INSET_H + 40:
                        color = PLAYER_COLORS[k % len(PLAYER_COLORS)]
                        di.ellipse([ix - 30, iy - 30, ix + 30, iy + 30], outline=color, width=2 if q[3] else 1)
                        if sh.get('name'):
                            tw = di.textlength(sh['name'], font=FONT_S)
                            di.text((ix - tw / 2, iy + 34), sh['name'], fill=color, font=FONT_S)
                di.rectangle([0, 0, INSET_W - 1, INSET_H - 1], outline=PLAYER_COLORS[0], width=2)
                # bottom left: the whorls are top left and bottom right
                canvas.paste(inset, (12, int(UH * SCALE) - INSET_H - 12))

            # status strip
            d = ImageDraw.Draw(canvas)
            y0 = int(UH * SCALE)
            t = fr.get('t', 0) / 20
            tfont = FONT if d.textlength(title, font=FONT) <= 600 else FONT_S
            d.text((16, y0 + 10), title, fill=(255, 210, 235), font=tfont)
            d.text((16, y0 + 46), f'{int(t // 60)}:{t % 60:04.1f}   level {fr.get("level", 0)}', fill=(200, 230, 240), font=FONT)
            for i, sh in enumerate(ships[:4]):
                x0 = 660 + i * 330
                color = PLAYER_COLORS[i % len(PLAYER_COLORS)]
                d.text((x0, y0 + 10), f'{sh.get("name") or "player " + str(i + 1)}: {sh.get("score", 0)}  pots {sh.get("pots", 0)}', fill=color, font=FONT)
                sp = max(0, min(100, sh.get('shield') or 0))
                col = (60, 230, 90) if sp >= 70 else (255, 210, 50) if sp >= 40 else (255, 50, 40)
                d.rectangle([x0, y0 + 50, x0 + 200, y0 + 60], outline=(120, 140, 150))
                d.rectangle([x0, y0 + 50, x0 + 2 * sp, y0 + 60], fill=col)
                a = (sh.get('a') or '')[:40]
                d.text((x0, y0 + 70), a, fill=(170, 190, 200), font=FONT_S)
            ff.stdin.write(canvas.tobytes())
            if n % 400 == 0:
                print(f'  frame {n}/{len(frames)}', file=sys.stderr)
        ff.stdin.close()
        ff.wait()
    except BaseException:
        ff.kill()
        ff.wait()
        if os.path.exists(part):
            os.remove(part)
        raise
    if ff.returncode != 0:
        if os.path.exists(part):
            os.remove(part)
        sys.exit(f'ffmpeg failed ({ff.returncode}); nothing written')
    os.replace(part, out)
    print(out)


if __name__ == '__main__':
    main()
