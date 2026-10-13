#!/usr/bin/env python3
"""Rebuild assets/ from the 2003-04 Windows source (CT_III).

Run from the repo root:  python3 tools/prepare_assets.py path/to/CT_III

- Sprite sheets are copied as-is.
- The grayscale bitmap-font atlases (GL_ALPHA textures in the original)
  become white RGBA PNGs so the browser can tint them.
- The radar lens (luminance+alpha) is pre-tinted with the radar color.
- Glyph metrics are pulled out of the *_font.cpp tables into fonts.json.
- OGG sound effects become MP3 (Safari on iOS can't decode Ogg Vorbis).
"""
import json, os, re, shutil, subprocess, sys
from PIL import Image

if len(sys.argv) < 2:
    sys.exit('usage: python3 tools/prepare_assets.py path/to/CT_III')
SRC = os.path.expanduser(sys.argv[1])
TEX = os.path.join(SRC, 'Textures')
IMG_OUT = 'assets/img'
SND_OUT = 'assets/snd'

SHEETS = ['CTSprites32.png', 'CTSprites48.png', 'CTSprites64.png',
          'Teapots64.png', 'BatBoy64.png', 'ScoreNumbers.png', 'clouds_dusk.png']

SOUNDS = ['S_Startup', 'S_ShipDebut', 'S_Thrust', 'S_Shield', 'S_BadGuyDebut',
          'S_Firing', 'S_EnemyFires', 'S_DudBullet', 'S_ShipExplodes', 'S_Explosion',
          'S_JimOuch', 'S_BreakRings', 'S_YummyConsume', 'S_LevelCompletion',
          'S_ExtraShip', 'S_HighScore1', 'S_Bell', 'S_Clunk', 'S_NO', 'S_POP',
          'S_YES', 'S_Cymbal', 'S_ChineseGong', 'S_EnemyFire2', 'S_ToasterPop',
          'S_MixerTaunt']


def white_alpha(src, dst):
    im = Image.open(src).convert('L')
    out = Image.new('RGBA', im.size, (255, 255, 255, 0))
    out.putalpha(im)
    out.save(dst, optimize=True)


def tinted_lens(src, dst):
    im = Image.open(src).convert('LA')
    lum, alpha = im.split()
    r = lum.point(lambda v: v * 128 // 255)
    b = lum
    Image.merge('RGBA', (r, r, b, alpha)).save(dst, optimize=True)


def glyphs(cpp):
    text = open(cpp, encoding='latin-1').read()
    rows = re.findall(r'\{(\d+),(\d+),(\d+),(\d+),(\d+),(-?\d+),(-?\d+),(-?\d+)\}', text)
    hdr = re.search(r"=\s*\{\s*(?://[^\n]*\n)?\s*(\d+),'(.)',(\d+),(\d+),(\d+),", text)
    count, first, sample, defpts, space = hdr.groups()
    return {
        'first': ord(first), 'sampleSize': int(sample), 'defPoints': int(defpts),
        'spaceAX': int(space),
        # charno, x, y, width, height, hoffset, voffset, hadvance
        'glyphs': [[int(v) for v in r] for r in rows][:int(count)],
    }


def main():
    os.makedirs(IMG_OUT, exist_ok=True)
    os.makedirs(SND_OUT, exist_ok=True)
    for name in SHEETS:
        shutil.copy(os.path.join(TEX, name), os.path.join(IMG_OUT, name))
    white_alpha(os.path.join(TEX, 'Comic52.png'), os.path.join(IMG_OUT, 'Comic52.png'))
    white_alpha(os.path.join(TEX, 'GoudySto65.png'), os.path.join(IMG_OUT, 'GoudySto65.png'))
    tinted_lens(os.path.join(TEX, 'LensSmall.png'), os.path.join(IMG_OUT, 'Lens.png'))

    fonts = {
        'comic': dict(glyphs(os.path.join(SRC, 'Comic52_font.cpp')), image='Comic52.png'),
        'goudy': dict(glyphs(os.path.join(SRC, 'GoudySto65_font.cpp')), image='GoudySto65.png'),
    }
    with open('assets/fonts.json', 'w') as f:
        json.dump(fonts, f, separators=(',', ':'))

    for name in SOUNDS:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i',
                        os.path.join(SRC, 'sounds', name + '.ogg'),
                        '-codec:a', 'libmp3lame', '-q:a', '4',
                        os.path.join(SND_OUT, name + '.mp3')], check=True)


if __name__ == '__main__':
    main()
