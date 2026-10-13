// Constants from CTGame.h

export const TICK = 0.05;              // game logic runs at 20 ticks per second

export const kFixedVisWidth = 800;
export const kFixedVisHeight = 600;

export const kMaxRotIdxAngles = 32;    // number of vectors in vector table
export const MaxShipSpeed = 32;

// Browser port: the two whorls in clouds_dusk.png pull the teapot in (an idea
// from CT_III's Todo.txt: "Add slight gravity pull towards the two vortices").
// World units: the 512x256 cloud image covers the 3840x1920 universe at 7.5x,
// image (px, py) -> world (7.5 px - 1920, 960 - 7.5 py).  rx/ry are the oval
// you can see; the pull is 0 at its edge and kWhorlPull at the center
// (0.6 at first; doubled after play testing).
export const WHORLS = [
  { x: -1020, y: 457.5, rx: 225, ry: 150 },    // upper left (image 120, 67)
  { x: 1098.75, y: -427.5, rx: 375, ry: 240 },  // lower right (image 402.5, 185)
];
// The pull reaches past the visible spiral by this factor (1.4 after play testing)
export const kWhorlReach = 1.4;
export const kWhorlPull = 1.2;   // units/tick^2 at a whorl's center (thrust is 1)
export const BulletSpeed = 8.0;
export const Debounce = 8;
export const UziDebounce = 1;
export const ShieldIncrease = 4;
export const MaxShieldPower = 100;

export const GS = { Attract: 0, Play: 1, GameOver: 2, Pause: 3, Engrave: 4, Intro: 5 };

export const SM = { Triple: 1, Uzi: 2, AutoShield: 4, CreamBullet: 8 };

export const KF = { Fire: 0x01, Left: 0x02, Right: 0x04, Thrust: 0x08, Shield: 0x10, Brake: 0x20 };
export const SF = { Fire: 0x01, Left: 0x02, Right: 0x04, Thrust: 0x08, Shield: 0x10, Brake: 0x20 };

// Browser port: the instructions come first (CT_III: top scores, instructions,
// beastiary, motto), so a first-time visitor sees the controls right away
export const AT = { Instructions: 0, Beastiary: 1, Motto: 2, TopScores: 3, Count: 4 };

// Bullet flags
export const BF_ShipCollideFlag = 0x01;
export const BF_GoodBulletFlag = 0x02;
export const BF_BadBulletFlag = 0x04;

// Radar colors
export const kAsterColor = 0xff66cc;
export const kBadColor = 0xdd0000;
export const kYummyColor = 0x33ff99;
export const kTeaColor = 0x0099ff;
export const kInvisible = 0;

export const ST = {};
[
  'TeapotNew', 'Teapot', 'Shield',
  'BigJim', 'LittleJim', 'LittleJim2', 'Eugene',
  'Aster', 'Aster1', 'Aster2',
  'Wheel', 'WheelR', 'WheelG', 'WheelB',
  'Teacup', 'SmallCup', 'SmallCup2',
  'SconeRock', 'SconePebble',
  'Colander', 'Teeth',
  'Saucer', 'CoffeePot', 'Cube', 'Croissant', 'Scone',
  'Toaster', 'EMuffin', 'Nook', 'Cranny',
  'Mixer', 'Beater',
  'Bullet', 'Photon', 'CreamBullet',
  'Yummies', 'Creamer',
  'Explosion', 'RingExplosion', 'Quake', 'Morsel',
  'DemoTeapot', 'ScoreTile',
  // added in the browser port: the AI asterisk and its two halves
  'AIAster', 'AIOpenAI', 'AIClaude',
].forEach((name, i) => { ST[name] = i; });

export const Y = { Mult2: 0, Mult3: 1, Mult5: 2, Triple: 3, Uzi: 4, Shield: 5, Creamer: 6, Count: 7 };

export const kNormalYummyChance = 400;
export const kNormalToasterChance = 1040;
export const kMaxBadGuyChance = 650;
export const kMinBadGuyChance = 133;

export const kYummyLifeSpan = 200;
export const kCreamerLifeSpan = 150;
export const kToasterLifeSpan = 650;
export const kCroissantLifeSpan = 400;
export const kCubeLifeSpan = 780;
export const kQuakeLifeSpan = 200;
export const kPhotonLifeSpan = 35;
export const kBulletLifeSpan = 35;
export const kMedSparkLifeSpan = 40;
export const kSmallSparkLifeSpan = 25;
export const kLargeSparkLifeSpan = 65;

export const kAsterPoints = 100;
export const kSaucerPoints = 500;
export const kCroissantPoints = 600;
export const kSconePoints = 600;
export const kCoffeePotPoints = 600;
export const kCubePoints = 750;
export const kMuffinPoints = 750;
export const kBeaterPoints = 750;
export const kMixerPoints = 750;
export const kLevelBonusScore = 1000;
export const kFreeShipPoints = 50000;
export const kColanderPoints = 600;

export const kBadGuyLevelDecrement = 50;
export const kMinAsteroidsPerLevel = 9;
export const kExtraAsteroidsPerLevel = 1;
export const kMaxAsteroids = 30;
export const kNewLevelIncrement = 10000;

export const kMaxSprites = 1000;
export const kMaxScoreTiles = 6;

// Textures: [file, tile size]
export const TXT = {
  CTSprites32: 0, CTSprites48: 1, CTSprites64: 2, Teapots: 3, Batboy: 4,
  ScoreNumbers: 5, Radar: 6, Clouds: 7, Comic52: 8, GoudySto65: 9, AILogos: 10,
};
export const TEXTURE_DEFS = [
  ['CTSprites32.png', 32],
  ['CTSprites48.png', 48],
  ['CTSprites64.png', 64],
  ['Teapots64.png', 64],
  ['BatBoy64.png', 64],
  ['ScoreNumbers.png', 60],
  ['Lens.png', 0],
  ['clouds_dusk.png', 0],
  ['Comic52.png', 0],
  ['GoudySto65.png', 0],
  ['AILogos64.png?v=2', 64],   // made by tools/ai-logo-sprites.html (?v= busts the 1-day image cache)
];

// Sound effects (SoundMgr.h): [file, maxPlaybacks]
export const SND = {};
export const SOUND_DEFS = [
  ['Startup', 1], ['ShipDebut', 1], ['Thrust', 2], ['Shield', 2],
  ['BadGuyDebut', 6], ['Firing', 2], ['EnemyFires', 6], ['DudBullet', 6],
  ['ShipExplodes', 1], ['Explosion', 4], ['JimOuch', 4], ['BreakRings', 4],
  ['YummyConsume', 2], ['LevelCompletion', 1], ['ExtraShip', 1], ['HighScore1', 1],
  ['Bell', 2], ['Clunk', 2], ['NO', 2], ['POP', 2],
  ['YES', 2], ['Cymbal', 2], ['ChineseGong', 1], ['EnemyFire2', 6],
  ['ToasterPop', 2], ['MixerTaunt', 2],
];
SOUND_DEFS.forEach(([name], i) => { SND[name] = i; });
