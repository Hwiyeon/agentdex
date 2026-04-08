(() => {
  'use strict';

  const WORLD_WIDTH = 480;
  const WORLD_HEIGHT = 320;
  const SPRITE_SIZE = 16;
  const DRAW_SIZE = 32;
  const SUBAGENT_DRAW_SIZE = 19;
  const ENTITY_EDGE_PAD = 8;
  const OVERLAY_EDGE_PAD = 2;
  const POKEDEX_MIN = 1;
  const POKEDEX_MAX = 251;
  const POKEDEX_TOTAL = POKEDEX_MAX - POKEDEX_MIN + 1;
  const RING_SLOTS = 6;
  const RING_BASE_RADIUS = 30;
  const RING_STEP = 22;
  const SUBAGENT_RING_SLOTS = 12;
  const SUBAGENT_RING_BASE_RADIUS = 29;
  const SUBAGENT_RING_STEP = 4;
  const DEFAULT_PROMO_CONTEXT_MAX = 100000;
  const PROMO_SCENE_STORAGE_KEY = 'poke-agents-promo-scene-v1';
  const PROMO_POKEDEX_STORAGE_KEY = 'poke-agents-promo-pokedex-v1';
  const PROMO_BOX_STORAGE_KEY = 'poke-agents-promo-box-v1';
  const PROMO_EXPORT_SCALE = 2;
  const PROMO_STATUSES = ['Idle', 'Thinking', 'Tool-Running', 'Outputting', 'Waiting', 'Sleeping'];

  // Pokeball spawn/despawn animation constants
  const SPAWN_DURATION_MS = 900;   // total spawn animation
  const DESPAWN_DURATION_MS = 700; // total despawn animation
  const BALL_SHAKE_MS = 300;       // ball wiggle phase
  const BALL_OPEN_MS = 300;        // ball opens + flash
  const APPEAR_MS = 300;           // monster fades in

  // ── Area mask system ──
  // The area_mask.png encodes each region as a unique solid color.
  // We load it onto a hidden canvas and use getImageData() to look up
  // which area any (x,y) pixel belongs to.

  // Color-to-area mapping — must match tools/generate_area_mask.js AREA_COLORS
  const AREA_DEFS = [
    { color: 'FF0000', id: 'mountain',      label: 'Mountain',      index: 0 },
    { color: 'FF8000', id: 'cave',           label: 'Cave',          index: 1 },
    { color: '008000', id: 'forest',         label: 'Forest',        index: 2 },
    { color: 'FFFF00', id: 'ruin',           label: 'Ruins',         index: 3 },
    { color: '800080', id: 'rough_terrain',  label: 'Hard Terrain',  index: 4 },
    { color: '00FF00', id: 'grassland',      label: 'Grassland',     index: 5 },
    { color: 'FF00FF', id: 'urban',          label: 'Urban',         index: 6 },
    { color: '00FFFF', id: 'waters_edge',    label: "Water's Edge",  index: 7 },
    { color: '0000FF', id: 'sea',            label: 'Sea',           index: 8 },
  ];

  // Build fast color→index lookup (key = "R,G,B")
  const COLOR_TO_INDEX = {};
  for (var d = 0; d < AREA_DEFS.length; d++) {
    var cv = parseInt(AREA_DEFS[d].color, 16);
    var cr = (cv >> 16) & 0xFF, cg = (cv >> 8) & 0xFF, cb = cv & 0xFF;
    COLOR_TO_INDEX[cr + ',' + cg + ',' + cb] = AREA_DEFS[d].index;
  }

  // Mutable AREAS array — starts with hardcoded fallback, replaced once mask loads
  var AREAS = [
    { x: 15,  y: 8,   w: 190, h: 82,  id: 'mountain',      label: 'Mountain' },
    { x: 115, y: 88,  w: 170, h: 82,  id: 'cave',           label: 'Cave' },
    { x: 305, y: 195, w: 150, h: 55,  id: 'forest',         label: 'Forest' },
    { x: 275, y: 8,   w: 140, h: 82,  id: 'ruin',           label: 'Ruins' },
    { x: 10,  y: 92,  w: 100, h: 78,  id: 'rough_terrain',  label: 'Hard Terrain' },
    { x: 300, y: 94,  w: 160, h: 96,  id: 'grassland',      label: 'Grassland' },
    { x: 120, y: 175, w: 180, h: 60,  id: 'urban',          label: 'Urban' },
    { x: 55,  y: 240, w: 380, h: 28,  id: 'waters_edge',    label: "Water's Edge" },
    { x: 0,   y: 270, w: 480, h: 50,  id: 'sea',            label: 'Sea' },
  ];

  // Mask pixel data (Uint8ClampedArray) and valid-coordinate lists per area
  var areaMaskData = null;    // raw RGBA pixels, length = WORLD_WIDTH * WORLD_HEIGHT * 4
  var areaMaskReady = false;
  var areaValidCoords = [];   // index → [{x,y}, ...] list of walkable pixels for that area

  // Load area mask onto hidden canvas
  (function loadAreaMask() {
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = WORLD_WIDTH;
      c.height = WORLD_HEIGHT;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      areaMaskData = ctx.getImageData(0, 0, WORLD_WIDTH, WORLD_HEIGHT).data;

      // Compute bounding boxes and valid-coordinate lists from mask
      var minX = [], maxX = [], minY = [], maxY = [];
      var coords = [];
      for (var i = 0; i < AREA_DEFS.length; i++) {
        minX[i] = WORLD_WIDTH; maxX[i] = 0;
        minY[i] = WORLD_HEIGHT; maxY[i] = 0;
        coords[i] = [];
      }

      // Sample every 2nd pixel for valid-coords (saves memory, still dense enough)
      for (var y = 0; y < WORLD_HEIGHT; y++) {
        for (var x = 0; x < WORLD_WIDTH; x++) {
          var off = (y * WORLD_WIDTH + x) * 4;
          var r = areaMaskData[off], g = areaMaskData[off + 1], b = areaMaskData[off + 2];
          var idx = COLOR_TO_INDEX[r + ',' + g + ',' + b];
          if (idx === undefined) continue;
          if (x < minX[idx]) minX[idx] = x;
          if (x > maxX[idx]) maxX[idx] = x;
          if (y < minY[idx]) minY[idx] = y;
          if (y > maxY[idx]) maxY[idx] = y;
          if ((x % 2 === 0) && (y % 2 === 0)) {
            coords[idx].push({ x: x, y: y });
          }
        }
      }

      // Update AREAS with mask-derived bounding boxes
      for (var i = 0; i < AREA_DEFS.length; i++) {
        if (coords[i].length > 0) {
          AREAS[i] = {
            x: minX[i], y: minY[i],
            w: maxX[i] - minX[i], h: maxY[i] - minY[i],
            id: AREA_DEFS[i].id, label: AREA_DEFS[i].label
          };
        }
      }

      areaValidCoords = coords;
      areaMaskReady = true;

      // Re-place any entities that were created before the mask loaded
      // (they may be stuck at fallback bounding-box positions)
      relocateEntitiesToMask();
      savePositionCache();
    };
    img.src = '/data/area_mask.png';
  })();

  // Re-position all existing entities using mask data (called once after mask loads)
  function relocateEntitiesToMask() {
    if (!areaMaskReady) return;
    // Clear all positions so overlapsExisting works fresh
    var entries = [];
    for (var [id, entity] of appState.entityById) {
      entries.push({ id: id, entity: entity });
    }
    // Temporarily remove all, then re-place one by one to avoid self-overlap
    for (var i = 0; i < entries.length; i++) {
      appState.entityById.delete(entries[i].id);
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i].entity;
      var cached = positionCache[entries[i].id];
      // Use cached position if it's inside the correct area
      if (cached && typeof cached.x === 'number' && isInsideArea(cached.x + DRAW_SIZE / 2, cached.y + DRAW_SIZE / 2, e.roomIndex)) {
        e.x = cached.x; e.y = cached.y;
        e.baseX = cached.x; e.baseY = cached.y;
      } else {
        var slot = pickSlotInArea(e.roomIndex, hashCode(entries[i].id));
        e.x = slot.x; e.y = slot.y;
        e.baseX = slot.x; e.baseY = slot.y;
      }
      appState.entityById.set(entries[i].id, e);
    }
  }

  // Look up area index for a world-space pixel
  function getAreaAtPixel(x, y) {
    if (!areaMaskReady) return -1;
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= WORLD_WIDTH || y < 0 || y >= WORLD_HEIGHT) return -1;
    var off = (y * WORLD_WIDTH + x) * 4;
    var r = areaMaskData[off], g = areaMaskData[off + 1], b = areaMaskData[off + 2];
    var idx = COLOR_TO_INDEX[r + ',' + g + ',' + b];
    return idx !== undefined ? idx : -1;
  }

  // Pick a random valid coordinate inside the given area
  function pickCoordsInArea(areaIndex, seed) {
    if (!areaMaskReady || !areaValidCoords[areaIndex] || areaValidCoords[areaIndex].length === 0) {
      // Fallback to bounding-box center
      var area = AREAS[areaIndex];
      return { x: area.x + area.w / 2, y: area.y + area.h / 2 };
    }
    var list = areaValidCoords[areaIndex];
    var pick = seed % list.length;
    return list[pick];
  }

  // Check if a coordinate is inside the given area (mask-based)
  function isInsideArea(x, y, areaIndex) {
    return getAreaAtPixel(x, y) === areaIndex;
  }

  // Map habitat strings from pokemon_data.json to area indices
  const HABITAT_TO_AREA = {
    'mountain': 0, 'cave': 1, 'forest': 2, 'rare': 3,
    'rough-terrain': 4, 'grassland': 5, 'urban': 6,
    'waters-edge': 7, 'sea': 8
  };

  const EVOLUTION_PATHS = {
    1: [1], 2: [1, 2], 3: [1, 2, 3], 4: [4], 5: [4, 5], 6: [4, 5, 6],
    7: [7], 8: [7, 8], 9: [7, 8, 9], 10: [10], 11: [10, 11], 12: [10, 11, 12],
    13: [13], 14: [13, 14], 15: [13, 14, 15], 16: [16], 17: [16, 17], 18: [16, 17, 18],
    19: [19], 20: [19, 20], 21: [21], 22: [21, 22], 23: [23], 24: [23, 24],
    25: [25], 26: [25, 26], 27: [27], 28: [27, 28], 29: [29], 30: [29, 30], 31: [29, 30, 31],
    32: [32], 33: [32, 33], 34: [32, 33, 34], 35: [35], 36: [35, 36], 37: [37], 38: [37, 38],
    39: [39], 40: [39, 40], 41: [41], 42: [41, 42], 43: [43], 44: [43, 44], 45: [43, 44, 45],
    46: [46], 47: [46, 47], 48: [48], 49: [48, 49], 50: [50], 51: [50, 51],
    52: [52], 53: [52, 53], 54: [54], 55: [54, 55], 56: [56], 57: [56, 57],
    58: [58], 59: [58, 59], 60: [60], 61: [60, 61], 62: [60, 61, 62], 63: [63], 64: [63, 64], 65: [63, 64, 65],
    66: [66], 67: [66, 67], 68: [66, 67, 68], 69: [69], 70: [69, 70], 71: [69, 70, 71],
    72: [72], 73: [72, 73], 74: [74], 75: [74, 75], 76: [74, 75, 76], 77: [77], 78: [77, 78],
    79: [79], 80: [79, 80], 81: [81], 82: [81, 82], 83: [83], 84: [84], 85: [84, 85],
    86: [86], 87: [86, 87], 88: [88], 89: [88, 89], 90: [90], 91: [90, 91], 92: [92], 93: [92, 93], 94: [92, 93, 94],
    95: [95], 96: [96], 97: [96, 97], 98: [98], 99: [98, 99], 100: [100], 101: [100, 101],
    102: [102], 103: [102, 103], 104: [104], 105: [104, 105], 106: [106], 107: [107], 108: [108],
    109: [109], 110: [109, 110], 111: [111], 112: [111, 112], 113: [113], 114: [114], 115: [115],
    116: [116], 117: [116, 117], 118: [118], 119: [118, 119], 120: [120], 121: [120, 121],
    122: [122], 123: [123], 124: [124], 125: [125], 126: [126], 127: [127], 128: [128],
    129: [129], 130: [129, 130], 131: [131], 132: [132], 133: [133], 134: [133, 134], 135: [133, 135], 136: [133, 136],
    137: [137], 138: [138], 139: [138, 139], 140: [140], 141: [140, 141], 142: [142], 143: [143],
    144: [144], 145: [145], 146: [146], 147: [147], 148: [147, 148], 149: [147, 148, 149],
    150: [150], 151: [151],
    152: [152], 153: [152, 153], 154: [152, 153, 154], 155: [155], 156: [155, 156], 157: [155, 156, 157],
    158: [158], 159: [158, 159], 160: [158, 159, 160], 161: [161], 162: [161, 162], 163: [163], 164: [163, 164],
    165: [165], 166: [165, 166], 167: [167], 168: [167, 168], 169: [41, 42, 169], 170: [170], 171: [170, 171],
    172: [172], 173: [173], 174: [174], 175: [175], 176: [175, 176], 177: [177], 178: [177, 178],
    179: [179], 180: [179, 180], 181: [179, 180, 181], 182: [43, 44, 182], 183: [183], 184: [183, 184],
    185: [95, 185], 186: [60, 61, 186], 187: [187], 188: [187, 188], 189: [187, 188, 189], 190: [190],
    191: [191], 192: [191, 192], 193: [193], 194: [194], 195: [194, 195], 196: [133, 196], 197: [133, 197],
    198: [198], 199: [79, 199], 200: [200], 201: [201], 202: [202], 203: [203], 204: [204], 205: [204, 205],
    206: [206], 207: [207], 208: [95, 208], 209: [209], 210: [209, 210], 211: [211], 212: [123, 212],
    213: [213], 214: [214], 215: [215], 216: [216], 217: [216, 217], 218: [218], 219: [218, 219],
    220: [220], 221: [220, 221], 222: [222], 223: [223], 224: [223, 224], 225: [225], 226: [226], 227: [227],
    228: [228], 229: [228, 229], 230: [116, 117, 230], 231: [231], 232: [231, 232], 233: [137, 233], 234: [234],
    235: [235], 236: [236], 237: [236, 237], 238: [238], 239: [239], 240: [240], 241: [241], 242: [113, 242],
    243: [243], 244: [244], 245: [245], 246: [246], 247: [246, 247], 248: [246, 247, 248], 249: [249], 250: [250], 251: [251]
  };

  const colorSeeds = [
    ['#5b8f5a', '#3f6e3d', '#cde8b5'],
    ['#7899d1', '#4d6f9f', '#dae8ff'],
    ['#d97f5a', '#a45536', '#ffd9bf'],
    ['#9b80c6', '#6d5798', '#eedcff'],
    ['#d0b44f', '#987e2c', '#fff1b8'],
    ['#5ca59a', '#35756d', '#d2fff7']
  ];

  const canvas = document.getElementById('office-canvas');
  const overlayEl = document.getElementById('agent-overlay');
  const activeCountEl = document.getElementById('active-count');
  const lastUpdateEl = document.getElementById('last-update');
  const tokenTotalEl = document.getElementById('token-total');
  const projectFilterEl = document.getElementById('project-filter');
  const sessionFilterEl = document.getElementById('session-filter');
  const agentListEl = document.getElementById('agent-list');
  const boxListEl = document.getElementById('box-list');
  const boxCountEl = document.getElementById('box-count');
  const boxHistoryToggleEl = document.getElementById('box-history-toggle');
  const boxHistoryModalEl = document.getElementById('box-history-modal');
  const boxHistoryBackdropEl = document.getElementById('box-history-backdrop');
  const boxHistoryCloseEl = document.getElementById('box-history-close');
  const boxHistorySummaryEl = document.getElementById('box-history-summary');
  const boxHistoryGridEl = document.getElementById('box-history-grid');
  const subhistoryModalEl = document.getElementById('subhistory-modal');
  const subhistoryBackdropEl = document.getElementById('subhistory-backdrop');
  const subhistoryCloseEl = document.getElementById('subhistory-close');
  const subhistoryTitleEl = document.getElementById('subhistory-title');
  const subhistorySummaryEl = document.getElementById('subhistory-summary');
  const subhistoryGridEl = document.getElementById('subhistory-grid');
  const pokedexToggleEl = document.getElementById('pokedex-toggle');
  const hardResetBtnEl = document.getElementById('hard-reset-btn');
  const promoStudioToggleEl = document.getElementById('promo-studio-toggle');
  const promoStudioPanelEl = document.getElementById('promo-studio-panel');
  const promoStudioSummaryEl = document.getElementById('promo-studio-summary');
  const promoStudioCloseEl = document.getElementById('promo-studio-close');
  const promoStudioEnabledEl = document.getElementById('promo-studio-enabled');
  const promoAddRootEl = document.getElementById('promo-add-root');
  const promoResetEl = document.getElementById('promo-reset');
  const promoExportEl = document.getElementById('promo-export');
  const promoStudioListEl = document.getElementById('promo-studio-list');
  const pokedexProgressEl = document.getElementById('pokedex-progress');
  const pokedexModalEl = document.getElementById('pokedex-modal');
  const pokedexBackdropEl = document.getElementById('pokedex-backdrop');
  const pokedexCloseEl = document.getElementById('pokedex-close');
  const pokedexSummaryEl = document.getElementById('pokedex-summary');
  const pokedexGridEl = document.getElementById('pokedex-grid');
  const pokedexLangEnEl = document.getElementById('pokedex-lang-en');
  const pokedexLangKoEl = document.getElementById('pokedex-lang-ko');

  const uiState = {
    projectFilter: 'all',
    sessionFilter: 'all',
    pokedexOpen: false,
    boxHistoryOpen: false,
    subhistoryOpen: false,
    subhistoryParentId: null,
    pokedexLanguage: 'en',
    collapsedSubtrees: {},
    promoStudioOpen: false,
    promoStudioEnabled: false
  };

  function isSubtreeCollapsed(agentId, depth, childCount, collapsedIds) {
    if (!childCount) return false;
    if (Object.prototype.hasOwnProperty.call(collapsedIds, agentId)) {
      return !!collapsedIds[agentId];
    }
    return depth === 0;
  }

  const appState = {
    snapshot: {
      agents: [],
      activeAgentCount: 0,
      config: { enablePokeapiSprites: true },
      pokedex: { seenPokemonIds: [], firstDiscoveryByPokemon: {}, discoveredCount: 0, totalCount: POKEDEX_TOTAL }
    },
    liveSnapshot: null,
    entityById: new Map(),
    subhistoryEntryByKey: new Map(),
    roomAssignments: new Map(),
    projects: [],
    sessions: []
  };

  var exportImageCache = new Map();
  var promoStudioState = loadPromoStudioState();
  var promoPokedexState = loadPromoPokedexState();
  var promoBoxState = loadPromoBoxState();
  uiState.promoStudioEnabled = !!promoStudioState.enabled;

  function promoClampInt(value, min, max, fallback) {
    var num = parseInt(value, 10);
    if (!Number.isFinite(num)) num = fallback;
    if (!Number.isFinite(num)) num = min;
    return Math.max(min, Math.min(max, num));
  }

  function createPromoId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function createPromoSubagent(parentPokemonId) {
    return {
      id: createPromoId('promo-sub'),
      label: 'Sub Agent',
      pokemonId: promoClampInt(parentPokemonId, POKEDEX_MIN, POKEDEX_MAX, 133),
      level: 8,
      exp: 3600,
      hp: 86,
      status: 'Tool-Running'
    };
  }

  function createPromoRoot() {
    var root = {
      id: createPromoId('promo-root'),
      label: 'Main Agent',
      pokemonId: 25,
      level: 18,
      exp: 6200,
      hp: 100,
      status: 'Thinking',
      subagents: []
    };
    root.subagents.push(createPromoSubagent(root.pokemonId));
    return root;
  }

  function createDefaultPromoStudioState() {
    return {
      enabled: false,
      roots: [createPromoRoot()]
    };
  }

  function normalizePromoUnit(raw, isRoot) {
    var fallback = isRoot ? createPromoRoot() : createPromoSubagent();
    var level = promoClampInt(raw && raw.level, 1, 100, fallback.level);
    var needed = level >= 100 ? 0 : expToNextLevel(level);
    return {
      id: (raw && raw.id) || fallback.id,
      label: raw && typeof raw.label === 'string' ? raw.label.slice(0, 40) : fallback.label,
      pokemonId: promoClampInt(raw && raw.pokemonId, POKEDEX_MIN, POKEDEX_MAX, fallback.pokemonId),
      level: level,
      exp: promoClampInt(raw && raw.exp, 0, level >= 100 ? 0 : needed, fallback.exp),
      hp: promoClampInt(raw && raw.hp, 0, 100, fallback.hp),
      status: PROMO_STATUSES.indexOf(raw && raw.status) >= 0 ? raw.status : fallback.status,
      subagents: isRoot && raw && Array.isArray(raw.subagents)
        ? raw.subagents.map(function (sub) { return normalizePromoUnit(sub, false); })
        : (isRoot ? [] : undefined)
    };
  }

  function normalizePromoStudioState(raw) {
    var normalized = raw && typeof raw === 'object' ? raw : {};
    var hasRoots = Array.isArray(normalized.roots);
    var roots = hasRoots
      ? normalized.roots.map(function (root) { return normalizePromoUnit(root, true); })
      : [];
    if (!hasRoots) {
      roots = createDefaultPromoStudioState().roots;
    }
    return {
      enabled: !!normalized.enabled,
      roots: roots
    };
  }

  function loadPromoStudioState() {
    try {
      var raw = localStorage.getItem(PROMO_SCENE_STORAGE_KEY);
      if (!raw) return createDefaultPromoStudioState();
      return normalizePromoStudioState(JSON.parse(raw));
    } catch (_) {
      return createDefaultPromoStudioState();
    }
  }

  function savePromoStudioState() {
    try {
      localStorage.setItem(PROMO_SCENE_STORAGE_KEY, JSON.stringify({
        enabled: uiState.promoStudioEnabled,
        roots: promoStudioState.roots
      }));
    } catch (_) {
      // Ignore storage errors.
    }
  }

  function normalizePromoPokedexState(raw) {
    var normalized = raw && typeof raw === 'object' ? raw : {};
    var seenLookup = {};
    var seenPokemonIds = [];
    var rawSeenIds = Array.isArray(normalized.seenPokemonIds) ? normalized.seenPokemonIds : [];
    for (var i = 0; i < rawSeenIds.length; i++) {
      var pokemonId = Number(rawSeenIds[i]);
      if (!Number.isInteger(pokemonId) || pokemonId < POKEDEX_MIN || pokemonId > POKEDEX_MAX || seenLookup[pokemonId]) {
        continue;
      }
      seenLookup[pokemonId] = true;
      seenPokemonIds.push(pokemonId);
    }
    seenPokemonIds.sort(function (a, b) { return a - b; });

    var firstDiscoveryByPokemon = {};
    var rawDiscovery = normalized.firstDiscoveryByPokemon && typeof normalized.firstDiscoveryByPokemon === 'object'
      ? normalized.firstDiscoveryByPokemon
      : {};
    for (var key in rawDiscovery) {
      if (!Object.prototype.hasOwnProperty.call(rawDiscovery, key)) continue;
      var discoveryId = Number(key);
      if (!seenLookup[discoveryId]) continue;
      firstDiscoveryByPokemon[discoveryId] = { ...rawDiscovery[key] };
    }

    return {
      seenPokemonIds: seenPokemonIds,
      firstDiscoveryByPokemon: firstDiscoveryByPokemon,
      discoveredCount: seenPokemonIds.length,
      totalCount: POKEDEX_TOTAL
    };
  }

  function loadPromoPokedexState() {
    try {
      var raw = localStorage.getItem(PROMO_POKEDEX_STORAGE_KEY);
      if (!raw) {
        return normalizePromoPokedexState(null);
      }
      return normalizePromoPokedexState(JSON.parse(raw));
    } catch (_) {
      return normalizePromoPokedexState(null);
    }
  }

  function savePromoPokedexState() {
    try {
      localStorage.setItem(PROMO_POKEDEX_STORAGE_KEY, JSON.stringify({
        seenPokemonIds: promoPokedexState.seenPokemonIds || [],
        firstDiscoveryByPokemon: promoPokedexState.firstDiscoveryByPokemon || {}
      }));
    } catch (_) {
      // Ignore storage errors.
    }
  }

  function normalizePromoBoxSession(raw) {
    var boxedAt = Number(raw && raw.boxedAt);
    if (!Number.isFinite(boxedAt) || boxedAt <= 0) boxedAt = Date.now();
    return {
      id: (raw && raw.id) || createPromoId('promo-box'),
      boxedAt: boxedAt,
      root: normalizePromoUnit(raw && raw.root, true)
    };
  }

  function normalizePromoBoxState(raw) {
    var normalized = raw && typeof raw === 'object' ? raw : {};
    var rawSessions = Array.isArray(normalized.sessions) ? normalized.sessions : [];
    var sessions = rawSessions.map(function (session) {
      return normalizePromoBoxSession(session);
    });
    sessions.sort(function (a, b) {
      return (a.boxedAt || 0) - (b.boxedAt || 0);
    });
    return { sessions: sessions };
  }

  function loadPromoBoxState() {
    try {
      var raw = localStorage.getItem(PROMO_BOX_STORAGE_KEY);
      if (!raw) {
        return normalizePromoBoxState(null);
      }
      return normalizePromoBoxState(JSON.parse(raw));
    } catch (_) {
      return normalizePromoBoxState(null);
    }
  }

  function savePromoBoxState() {
    try {
      localStorage.setItem(PROMO_BOX_STORAGE_KEY, JSON.stringify({
        sessions: promoBoxState.sessions || []
      }));
    } catch (_) {
      // Ignore storage errors.
    }
  }

  function resetPromoBoxState() {
    promoBoxState = normalizePromoBoxState(null);
    try {
      localStorage.removeItem(PROMO_BOX_STORAGE_KEY);
    } catch (_) {
      savePromoBoxState();
    }
  }

  function resetPromoPokedexState() {
    promoPokedexState = normalizePromoPokedexState(null);
    try {
      localStorage.removeItem(PROMO_POKEDEX_STORAGE_KEY);
    } catch (_) {
      savePromoPokedexState();
    }
  }

  // ── Position persistence via localStorage ──
  const POSITION_CACHE_KEY_PREFIX = 'poke-agents-positions:';

  function getPositionCacheScope(config) {
    var modeScope = config && config.isMockMode ? 'mock' : 'watch';
    return config && config.promoStudioActive ? modeScope + ':promo' : modeScope;
  }

  function getPositionCacheKey(scope) {
    return POSITION_CACHE_KEY_PREFIX + scope;
  }

  function loadPositionCache(scope) {
    if (!scope) return {};
    try {
      var raw = localStorage.getItem(getPositionCacheKey(scope));
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  function savePositionCache() {
    if (!positionCacheScope) return;
    try {
      var cache = {};
      for (var [id, entity] of appState.entityById) {
        cache[id] = { x: entity.baseX, y: entity.baseY, roomIndex: entity.roomIndex, parentId: entity.parentId };
      }
      localStorage.setItem(getPositionCacheKey(positionCacheScope), JSON.stringify(cache));
    } catch (_) { /* quota exceeded etc */ }
  }

  function applyPositionCacheScope(config) {
    var nextScope = getPositionCacheScope(config);
    if (positionCacheScope === nextScope) return;
    positionCacheScope = nextScope;
    positionCache = loadPositionCache(positionCacheScope);
    appState.entityById.clear();
    appState.roomAssignments.clear();
    appState.prevAgentMap = new Map();
    agentPokemonCache = {};
    subagentPokemonCache = {};
    animations.clear();
  }

  var positionCacheScope = null;
  var positionCache = {};

  const worldCanvas = document.createElement('canvas');
  const worldCtx = worldCanvas.getContext('2d');
  worldCtx.imageSmoothingEnabled = false;

  const screenCtx = canvas.getContext('2d');
  screenCtx.imageSmoothingEnabled = false;

  function hashCode(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h >>> 0);
  }

  // ── Weighted Pokemon spawn by rarity tier ──
  // Tier weights: Common spawns ~40x more often than Legendary
  var TIER_WEIGHTS = { 1: 40, 2: 25, 3: 15, 4: 5, 5: 1 };
  var pokemonPool = [];       // weighted array of pokemon IDs
  var pokemonPoolReady = false;
  var agentPokemonCache = {}; // agentId → pokemon_id (stable assignment)
  var subagentPokemonCache = {}; // subagent agentId → rendered pokemon_id
  var pokemonHabitat = {};    // pokemon_id → habitat string (e.g. 'cave', 'forest')
  var pokemonNames = {};      // pokemon_id → display name
  var pokemonKoNames = {};    // pokemon_id → Korean display name
  var pokemonRarityLabels = {}; // pokemon_id → rarity label
  var pokemonRarityTiers = {};  // pokemon_id → rarity tier number

  // Per-area weighted pools: areaIndex → [pokemon_id, ...]
  var areaPoolMap = {};

  (function loadPokemonData() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/data/pokemon_data.json');
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      try {
        var data = JSON.parse(xhr.responseText);
        var pool = [];
        var areaPools = {};
        for (var i = 0; i < data.pokemon.length; i++) {
          var p = data.pokemon[i];
          if (p.pokemon_id < POKEDEX_MIN || p.pokemon_id > POKEDEX_MAX) continue;
          var w = TIER_WEIGHTS[p.final_tier] || 1;
          for (var j = 0; j < w; j++) {
            pool.push(p.pokemon_id);
          }
          // Store habitat lookup
          if (p.habitat) {
            pokemonHabitat[p.pokemon_id] = p.habitat;
          }
          if (p.name) {
            pokemonNames[p.pokemon_id] = formatPokemonName(p.name);
          }
          if (p.tier_label) {
            pokemonRarityLabels[p.pokemon_id] = p.tier_label;
          }
          if (Number.isInteger(p.final_tier)) {
            pokemonRarityTiers[p.pokemon_id] = p.final_tier;
          }
          // Build per-area pools
          var areaIdx = HABITAT_TO_AREA[p.habitat];
          if (areaIdx !== undefined) {
            if (!areaPools[areaIdx]) areaPools[areaIdx] = [];
            for (var j = 0; j < w; j++) {
              areaPools[areaIdx].push(p.pokemon_id);
            }
          }
        }
        pokemonPool = pool;
        areaPoolMap = areaPools;
        pokemonPoolReady = true;
        renderPokedex();
        renderPromoStudio();
      } catch (e) {
        // Fallback: uniform 1-251
      }
    };
    xhr.send();
  })();

  (function loadPokemonKoNames() {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/data/pokemon_names_ko.json');
    xhr.onload = function () {
      if (xhr.status !== 200) return;
      try {
        var data = JSON.parse(xhr.responseText);
        for (var id in data) {
          if (!Object.prototype.hasOwnProperty.call(data, id)) continue;
          pokemonKoNames[Number(id)] = data[id];
        }
        renderPokedex();
        renderPromoStudio();
      } catch (_) {
        // Keep English fallback if the mapping file is unavailable or malformed.
      }
    };
    xhr.send();
  })();

  function getPokemonId(agentId) {
    var forced = forcedPokemonIdForAgent(agentId);
    if (forced) return forced;
    if (agentPokemonCache[agentId]) return agentPokemonCache[agentId];
    if (pokemonPoolReady && pokemonPool.length > 0) {
      // Use hash to pick deterministically from weighted pool
      var idx = hashCode(agentId) % pokemonPool.length;
      var id = pokemonPool[idx];
      agentPokemonCache[agentId] = id;
      return id;
    }
    // Data not loaded yet — return temp value without caching so it gets
    // re-evaluated once the pool is ready on the next render cycle.
    return (hashCode(agentId) % POKEDEX_TOTAL) + POKEDEX_MIN;
  }

  function pickHistoricalAgent(candidates, beforeTs) {
    if (!candidates || candidates.length === 0) return null;

    var cutoff = typeof beforeTs === 'number' ? beforeTs : Infinity;
    var best = null;
    var bestCreatedAt = -Infinity;

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!candidate) continue;
      var createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : -Infinity;
      if (createdAt > cutoff) continue;
      if (!best || createdAt >= bestCreatedAt) {
        best = candidate;
        bestCreatedAt = createdAt;
      }
    }

    if (best) return best;

    for (var j = 0; j < candidates.length; j++) {
      var fallback = candidates[j];
      if (!fallback) continue;
      var fallbackCreatedAt = typeof fallback.createdAt === 'number' ? fallback.createdAt : -Infinity;
      if (!best || fallbackCreatedAt >= bestCreatedAt) {
        best = fallback;
        bestCreatedAt = fallbackCreatedAt;
      }
    }

    return best;
  }

  function findHistoricalAgentById(agentId, beforeTs) {
    if (!agentId) return null;
    var candidates = [];
    if (appState.agentById && appState.agentById.has(agentId)) {
      candidates.push(appState.agentById.get(agentId));
    }
    if (appState.prevAgentMap && appState.prevAgentMap.has(agentId)) {
      candidates.push(appState.prevAgentMap.get(agentId));
    }
    var boxed = (appState.snapshot && appState.snapshot.boxedAgents) || [];
    for (var i = boxed.length - 1; i >= 0; i--) {
      if (boxed[i] && boxed[i].agentId === agentId) {
        candidates.push(boxed[i]);
      }
    }

    var history = (appState.snapshot && appState.snapshot.subagentHistory) || [];
    for (var j = history.length - 1; j >= 0; j--) {
      if (history[j] && history[j].agentId === agentId) {
        candidates.push(history[j]);
      }
    }

    return pickHistoricalAgent(candidates, beforeTs);
  }

  function getAgentById(agentId, beforeTs) {
    return findHistoricalAgentById(agentId, beforeTs);
  }

  function forcedPokemonIdForAgent(agentId, beforeTs) {
    var agent = findHistoricalAgentById(agentId, beforeTs);
    if (!agent) return null;
    var pokemonId = Number(agent.forcedPokemonId);
    if (!Number.isInteger(pokemonId) || pokemonId < POKEDEX_MIN || pokemonId > POKEDEX_MAX) {
      return null;
    }
    return pokemonId;
  }

  function getEvolutionPath(pokemonId) {
    return EVOLUTION_PATHS[pokemonId] || [pokemonId];
  }

  function getRenderPokemonId(agent) {
    if (!agent) return POKEDEX_MIN;
    if (agent.forcedPokemonId) {
      return agent.forcedPokemonId;
    }
    if (!agent.parentId) {
      return getPokemonId(agent.agentId);
    }
    if (subagentPokemonCache[agent.agentId]) {
      return subagentPokemonCache[agent.agentId];
    }

    var parentAgent = getAgentById(agent.parentId, agent.createdAt);
    var parentPokemonId = parentAgent ? getRenderPokemonId(parentAgent) : getPokemonId(agent.parentId);
    var candidates = getEvolutionPath(parentPokemonId);
    var selected = candidates[hashCode(agent.agentId) % candidates.length];
    if (parentAgent) {
      subagentPokemonCache[agent.agentId] = selected;
    }
    return selected;
  }

  // Get the area index that a pokemon's habitat maps to
  function getPokemonAreaIndex(pokemonId) {
    var habitat = pokemonHabitat[pokemonId];
    if (!habitat) return -1;
    var idx = HABITAT_TO_AREA[habitat];
    return idx !== undefined ? idx : -1;
  }

  function formatPokemonName(name) {
    if (!name) return 'Unknown';
    return String(name)
      .split('-')
      .map(function (part) {
        if (!part) return '';
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' ');
  }

  function getPokemonName(pokemonId) {
    return pokemonNames[pokemonId] || ('Pokemon ' + pokemonId);
  }

  function pokemonDisplayName(pokemonId) {
    if (uiState.pokedexLanguage === 'ko') {
      return pokemonKoNames[pokemonId] || getPokemonName(pokemonId);
    }
    return getPokemonName(pokemonId);
  }

  function syncPokedexLanguageTabs() {
    var isKo = uiState.pokedexLanguage === 'ko';
    pokedexLangEnEl.classList.toggle('active', !isKo);
    pokedexLangKoEl.classList.toggle('active', isKo);
    pokedexLangEnEl.setAttribute('aria-selected', String(!isKo));
    pokedexLangKoEl.setAttribute('aria-selected', String(isKo));
  }

  function pokedexDiscoveryInfo(pokemonId) {
    var pokedex = appState.snapshot.pokedex || {};
    var discoveryMap = pokedex.firstDiscoveryByPokemon || {};
    return discoveryMap[pokemonId] || null;
  }

  function getPokemonRarity(pokemonId) {
    var label = pokemonRarityLabels[pokemonId];
    var tier = pokemonRarityTiers[pokemonId];
    if (!label && !tier) return null;
    return {
      label: label || 'Unknown',
      tier: tier || 0
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function clampToRoomBounds(x, y, roomIndex, drawSize) {
    var room = AREAS[roomIndex];
    var size = typeof drawSize === 'number' ? drawSize : DRAW_SIZE;
    return {
      x: clamp(x, room.x + ENTITY_EDGE_PAD, room.x + room.w - size - ENTITY_EDGE_PAD),
      y: clamp(y, room.y + ENTITY_EDGE_PAD, room.y + room.h - size - ENTITY_EDGE_PAD)
    };
  }

  function toShortId(value) {
    if (!value) return 'unknown';
    return value.length <= 14 ? value : value.slice(0, 6) + '...' + value.slice(-5);
  }

  function shortProjectName(projectId) {
    if (!projectId) return 'unknown';
    var segments = projectId.replace(/^-+/, '').split('-').filter(Boolean);
    var skip = { home:1, users:1, user:1, projects:1, repos:1, src:1, code:1, work:1, workspace:1, documents:1, desktop:1 };
    var last = -1;
    for (var i = 0; i < segments.length; i++) {
      if (skip[segments[i].toLowerCase()]) last = i;
    }
    var meaningful = segments.slice(last + 1);
    return meaningful.length > 0 ? meaningful.join('-') : segments[segments.length - 1] || projectId;
  }

  // Strip legacy "project: query" prefix from displayName for agents persisted before the split.
  // The prefix is a single token with no spaces followed by ": ".
  function stripProjectPrefix(displayName) {
    if (!displayName) return displayName;
    var colonIdx = displayName.indexOf(': ');
    if (colonIdx > 0 && colonIdx < 40) {
      var prefix = displayName.slice(0, colonIdx);
      if (prefix.indexOf(' ') === -1) {
        return displayName.slice(colonIdx + 2);
      }
    }
    return displayName;
  }

  function commandText(value) {
    if (!value) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function summarizeCommand(value, maxLen) {
    var text = commandText(value);
    var limit = typeof maxLen === 'number' ? maxLen : 48;
    if (!text) return '';
    if (text.length <= limit) return text;
    return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '...';
  }

  function agentLabel(agent) {
    if (agent.displayName) {
      var label = stripProjectPrefix(agent.displayName);
      if (agent.subagentType) label = '[' + agent.subagentType + '] ' + label;
      return label;
    }
    if (agent.subagentType) return agent.subagentType;
    return toShortId(agent.agentId);
  }

  function setCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const nativeW = Math.max(Math.round(rect.width * dpr), 320);
    const nativeH = Math.max(Math.round(rect.height * dpr), 240);
    canvas.width = nativeW;
    canvas.height = nativeH;
    worldCanvas.width = nativeW;
    worldCanvas.height = nativeH;
    screenCtx.setTransform(1, 0, 0, 1, 0, 0);
    screenCtx.imageSmoothingEnabled = false;
  }

  function getTransform() {
    const scale = Math.min(worldCanvas.width / WORLD_WIDTH, worldCanvas.height / WORLD_HEIGHT);
    const offsetX = Math.floor((worldCanvas.width - WORLD_WIDTH * scale) / 2);
    const offsetY = Math.floor((worldCanvas.height - WORLD_HEIGHT * scale) / 2);
    return { scale, offsetX, offsetY };
  }

  function desiredAreaIndexForAgent(agent) {
    if (!agent) return -1;
    if (agent.parentId) {
      const parentEntity = appState.entityById.get(agent.parentId);
      if (parentEntity !== undefined) return parentEntity.roomIndex;
      const assigned = appState.roomAssignments.get(agent.parentId);
      if (assigned !== undefined) return assigned;
      var parentAgent = getAgentById(agent.parentId, agent.createdAt);
      if (parentAgent) return desiredAreaIndexForAgent(parentAgent);
      return -1;
    }
    var pokemonId = getRenderPokemonId(agent);
    return getPokemonAreaIndex(pokemonId);
  }

  function getAreaIndex(agent) {
    // Child agents follow their parent's area
    if (agent.parentId) {
      const parentEntity = appState.entityById.get(agent.parentId);
      if (parentEntity !== undefined) return parentEntity.roomIndex;
      const assigned = appState.roomAssignments.get(agent.parentId);
      if (assigned !== undefined) return assigned;
    }
    const existing = appState.roomAssignments.get(agent.agentId);
    if (existing !== undefined) {
      if (!agent.parentId && agent.isPromoCustom) {
        var desiredPromoArea = desiredAreaIndexForAgent(agent);
        if (desiredPromoArea >= 0 && desiredPromoArea !== existing) {
          appState.roomAssignments.set(agent.agentId, desiredPromoArea);
          return desiredPromoArea;
        }
      }
      return existing;
    }

    // Determine area from the agent's assigned pokemon's habitat
    var habitatArea = desiredAreaIndexForAgent(agent);
    if (habitatArea >= 0) {
      appState.roomAssignments.set(agent.agentId, habitatArea);
      return habitatArea;
    }

    // Fallback: assign to a land area round-robin
    const landAreas = 7;
    const occupied = new Set(appState.roomAssignments.values());
    for (let i = 0; i < landAreas; i++) {
      if (!occupied.has(i)) {
        appState.roomAssignments.set(agent.agentId, i);
        return i;
      }
    }
    const idx = appState.roomAssignments.size % landAreas;
    appState.roomAssignments.set(agent.agentId, idx);
    return idx;
  }

  class LocalSpriteProvider {
    constructor() {
      this.cache = new Map();
    }

    getSprite(agent, frame, status) {
      const palette = colorSeeds[hashCode(agent.agentId) % colorSeeds.length];
      const key = palette.join('|') + ':' + status + ':' + frame;
      if (this.cache.has(key)) return this.cache.get(key);

      const sprite = document.createElement('canvas');
      sprite.width = SPRITE_SIZE;
      sprite.height = SPRITE_SIZE;
      const ctx = sprite.getContext('2d');
      ctx.imageSmoothingEnabled = false;

      const body = palette[0];
      const outline = palette[1];
      const light = palette[2];
      const bob = (status === 'Idle' || status === 'Sleeping') ? (frame % 2 === 0 ? 0 : 1) : 0;

      function px(x, y, color) {
        ctx.fillStyle = color;
        ctx.fillRect(x, y + bob, 1, 1);
      }

      for (let y = 5; y <= 11; y += 1) {
        for (let x = 4; x <= 11; x += 1) px(x, y, body);
      }
      for (let y = 4; y <= 12; y += 1) { px(3, y, outline); px(12, y, outline); }
      for (let x = 3; x <= 12; x += 1) { px(x, 4, outline); px(x, 12, outline); }
      px(5, 4, body); px(10, 4, body); px(4, 3, outline); px(11, 3, outline);
      px(6, 7, '#111'); px(9, 7, '#111'); px(7, 9, light); px(8, 9, light);

      if (status === 'Outputting') {
        px(7, 10, '#111'); px(8, 10, '#111');
        if (frame % 2 === 0) px(9, 10, '#111');
      }
      if (status === 'Tool-Running') {
        const offset = frame % 3;
        px(12, 8 + (offset === 0 ? -1 : offset === 2 ? 1 : 0), '#e9e2d0');
        px(13, 8, '#111');
      }
      if (status === 'Waiting') px(7, 10, '#111');
      if (status === 'Thinking') px(7, 6, light);

      this.cache.set(key, sprite);
      return sprite;
    }
  }

  class PokeApiSpriteProvider {
    constructor(localProvider) {
      this.localProvider = localProvider;
      this.urls = new Map();
      this.failedIds = new Set();
      this.sleepScaleCache = new Map();
      this.sleepScalePending = new Set();
    }

    getSpriteUrl(agent, sleeping) {
      const id = getPokemonId(agent.agentId);
      if (this.failedIds.has(id)) return null;
      var spec = pokemonSpriteSpec(sleeping);
      var folder = spec.folder;
      var cacheKey = folder + ':' + id;
      if (this.urls.has(cacheKey)) return this.urls.get(cacheKey);
      var url = '/sprites/' + folder + '/' + id + '.' + spec.ext;
      this.urls.set(cacheKey, url);
      // Preload to detect failures
      var img = new Image();
      img.onerror = () => { this.failedIds.add(id); this.urls.delete(cacheKey); };
      img.src = url;
      return url;
    }

    getSprite(agent, frame, status) {
      return this.localProvider.getSprite(agent, frame, status);
    }

    getSleepScale(agent) {
      var id = getRenderPokemonId(agent);
      if (this.sleepScaleCache.has(id)) {
        return this.sleepScaleCache.get(id);
      }
      this.primeSleepScale(id);
      return FALLBACK_SLEEP_SPRITE_SCALE;
    }

    primeSleepScale(id) {
      if (!id || this.sleepScalePending.has(id)) return;

      this.sleepScalePending.add(id);

      var staticImg = new Image();
      var animatedImg = new Image();
      var staticMax = 96;
      var animatedMax = 96;
      var remaining = 2;
      var self = this;

      function finish() {
        remaining -= 1;
        if (remaining > 0) return;
        self.sleepScalePending.delete(id);
        var rawScale = staticMax / Math.max(1, animatedMax);
        var finalScale = clamp(rawScale, MIN_SLEEP_SPRITE_SCALE, MAX_SLEEP_SPRITE_SCALE);
        self.sleepScaleCache.set(id, finalScale);
      }

      staticImg.onload = function () {
        staticMax = Math.max(staticImg.naturalWidth || 0, staticImg.naturalHeight || 0, 1);
        finish();
      };
      staticImg.onerror = finish;

      animatedImg.onload = function () {
        animatedMax = Math.max(animatedImg.naturalWidth || 0, animatedImg.naturalHeight || 0, 1);
        finish();
      };
      animatedImg.onerror = finish;

      staticImg.src = '/sprites/static/' + id + '.png';
      animatedImg.src = '/sprites/animated/' + id + '.gif';
    }
  }

  const localProvider = new LocalSpriteProvider();
  const pokeProvider = new PokeApiSpriteProvider(localProvider);
  const FALLBACK_SLEEP_SPRITE_SCALE = 1.9;
  const MIN_SLEEP_SPRITE_SCALE = 0.6;
  const MAX_SLEEP_SPRITE_SCALE = 2.8;

  function spriteProvider() {
    return appState.snapshot.config && appState.snapshot.config.enablePokeapiSprites ? pokeProvider : localProvider;
  }

  // --- Pokeball sprite (16x16 pixel art, drawn once) ---
  const pokeballSprite = (function () {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    function px(x, y, color) { g.fillStyle = color; g.fillRect(x, y, 1, 1); }
    var O = '#222', R = '#e03030', W = '#f8f8f8', L = '#c02020', G = '#aaa';
    // Top half (red)
    for (var x = 4; x <= 11; x++) px(x, 1, O);
    for (var x = 3; x <= 12; x++) px(x, 2, O);
    px(3, 2, O); px(12, 2, O);
    for (var x = 4; x <= 11; x++) px(x, 2, R);
    px(2, 3, O); for (var x = 3; x <= 12; x++) px(x, 3, R); px(13, 3, O);
    px(1, 4, O); for (var x = 2; x <= 13; x++) px(x, 4, R); px(14, 4, O);
    px(1, 5, O); for (var x = 2; x <= 13; x++) px(x, 5, R); px(14, 5, O);
    px(1, 6, O); for (var x = 2; x <= 13; x++) px(x, 6, R); px(14, 6, O);
    // Highlight
    px(4, 3, L); px(5, 3, '#f06060'); px(4, 4, '#f06060'); px(5, 4, '#f88'); px(5, 5, '#f06060');
    // Center band
    px(1, 7, O); for (var x = 2; x <= 13; x++) px(x, 7, G); px(14, 7, O);
    px(1, 8, O); for (var x = 2; x <= 13; x++) px(x, 8, G); px(14, 8, O);
    // Button
    px(6, 7, O); px(9, 7, O); px(6, 8, O); px(9, 8, O);
    px(7, 7, W); px(8, 7, W); px(7, 8, W); px(8, 8, W);
    px(7, 6, O); px(8, 6, O); px(7, 9, O); px(8, 9, O);
    // Bottom half (white)
    px(1, 9, O); for (var x = 2; x <= 13; x++) px(x, 9, W); px(14, 9, O);
    px(1, 10, O); for (var x = 2; x <= 13; x++) px(x, 10, W); px(14, 10, O);
    px(1, 11, O); for (var x = 2; x <= 13; x++) px(x, 11, W); px(14, 11, O);
    px(2, 12, O); for (var x = 3; x <= 12; x++) px(x, 12, W); px(13, 12, O);
    px(3, 13, O); for (var x = 4; x <= 11; x++) px(x, 13, W); px(12, 13, O);
    for (var x = 4; x <= 11; x++) px(x, 14, O);
    return c;
  })();

  // Open pokeball sprite (top half lifted)
  const pokeballOpenSprite = (function () {
    var c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    function px(x, y, color) { g.fillStyle = color; g.fillRect(x, y, 1, 1); }
    var O = '#222', R = '#e03030', W = '#f8f8f8', G = '#aaa';
    // Top half shifted up 3px and slightly apart
    for (var x = 4; x <= 11; x++) px(x, 0, O);
    px(3, 1, O); for (var x = 4; x <= 11; x++) px(x, 1, R); px(12, 1, O);
    px(2, 2, O); for (var x = 3; x <= 12; x++) px(x, 2, R); px(13, 2, O);
    px(2, 3, O); for (var x = 3; x <= 12; x++) px(x, 3, R); px(13, 3, O);
    // Center band + button (stays in place)
    px(1, 7, O); for (var x = 2; x <= 13; x++) px(x, 7, G); px(14, 7, O);
    px(1, 8, O); for (var x = 2; x <= 13; x++) px(x, 8, G); px(14, 8, O);
    px(6, 7, O); px(9, 7, O); px(6, 8, O); px(9, 8, O);
    px(7, 7, '#ff0'); px(8, 7, '#ff0'); px(7, 8, '#ff0'); px(8, 8, '#ff0');
    px(7, 6, O); px(8, 6, O); px(7, 9, O); px(8, 9, O);
    // Bottom half (white)
    px(1, 9, O); for (var x = 2; x <= 13; x++) px(x, 9, W); px(14, 9, O);
    px(1, 10, O); for (var x = 2; x <= 13; x++) px(x, 10, W); px(14, 10, O);
    px(1, 11, O); for (var x = 2; x <= 13; x++) px(x, 11, W); px(14, 11, O);
    px(2, 12, O); for (var x = 3; x <= 12; x++) px(x, 12, W); px(13, 12, O);
    px(3, 13, O); for (var x = 4; x <= 11; x++) px(x, 13, W); px(12, 13, O);
    for (var x = 4; x <= 11; x++) px(x, 14, O);
    return c;
  })();

  // --- Spawn/despawn animation state ---
  // key: agentId, value: { type: 'spawn'|'despawn', startTime, x, y, entity?, agent? }
  const animations = new Map();

  function startSpawnAnimation(agentId, entity) {
    animations.set(agentId, {
      type: 'spawn',
      startTime: performance.now(),
      x: entity.baseX,
      y: entity.baseY
    });
  }

  function startDespawnAnimation(agentId, entity, agent) {
    animations.set(agentId, {
      type: 'despawn',
      startTime: performance.now(),
      x: entity.x,
      y: entity.y,
      agent: agent  // keep ref for final sprite render
    });
  }

  function getEntityDepth(entityId) {
    var depth = 0;
    var cur = appState.entityById.get(entityId);
    while (cur && cur.parentId) {
      depth++;
      cur = appState.entityById.get(cur.parentId);
      if (depth > 10) break;
    }
    return depth;
  }

  // Minimum distance between entity centers to avoid overlap
  var MIN_ENTITY_DIST = DRAW_SIZE + 4;

  // Check if a candidate position overlaps any existing entity
  function overlapsExisting(cx, cy) {
    for (const e of appState.entityById.values()) {
      var existingSize = e.drawSize || DRAW_SIZE;
      var ex = e.baseX + existingSize / 2;
      var ey = e.baseY + existingSize / 2;
      var minDist = (DRAW_SIZE + existingSize) * 0.5 + 2;
      var dx = cx - ex, dy = cy - ey;
      if (dx * dx + dy * dy < minDist * minDist) return true;
    }
    return false;
  }

  // Pick a non-overlapping random position inside the area
  function pickSlotInArea(roomIndex, seed) {
    if (areaMaskReady && areaValidCoords[roomIndex] && areaValidCoords[roomIndex].length > 0) {
      var list = areaValidCoords[roomIndex];
      // Use two different hash components to spread starting positions
      var startIdx = seed % list.length;

      // Try up to 50 candidates with a large prime stride for good spread
      for (var attempt = 0; attempt < 50; attempt++) {
        var idx = (startIdx + attempt * 7919) % list.length;
        var coord = list[idx];
        var cx = coord.x, cy = coord.y;
        var candidate = clampToRoomBounds(cx - DRAW_SIZE / 2, cy - DRAW_SIZE / 2, roomIndex);
        if (candidate.x !== cx - DRAW_SIZE / 2 || candidate.y !== cy - DRAW_SIZE / 2) {
          continue;
        }
        if (!overlapsExisting(cx, cy)) {
          return candidate;
        }
      }
      // All candidates overlapped — use the seed pick anyway
      var coord = list[startIdx];
      return clampToRoomBounds(coord.x - DRAW_SIZE / 2, coord.y - DRAW_SIZE / 2, roomIndex);
    }
    // Fallback when mask not loaded: scatter within the bounding box using seed
    var room = AREAS[roomIndex];
    var margin = DRAW_SIZE + ENTITY_EDGE_PAD;
    var usableW = Math.max(1, room.w - margin * 2);
    var usableH = Math.max(1, room.h - margin * 2);
    // Pseudo-random scatter based on seed
    var px = room.x + margin + (seed % usableW);
    var py = room.y + margin + ((seed * 7919) % usableH);
    // Try a few offsets to avoid overlap
    for (var attempt = 0; attempt < 15; attempt++) {
      var tx = room.x + margin + ((seed + attempt * 3571) % usableW);
      var ty = room.y + margin + (((seed + attempt * 7919) * 2654435761) >>> 0) % usableH;
      if (!overlapsExisting(tx + DRAW_SIZE / 2, ty + DRAW_SIZE / 2)) {
        return { x: tx, y: ty };
      }
    }
    return { x: px, y: py };
  }

  // Clamp a position to stay inside the area (mask-aware)
  function clampToArea(x, y, roomIndex, drawSize) {
    var size = typeof drawSize === 'number' ? drawSize : DRAW_SIZE;
    var clamped = clampToRoomBounds(x, y, roomIndex, size);
    var cx = clamped.x;
    var cy = clamped.y;
    // If mask is available, verify the center of the sprite is inside the area
    if (areaMaskReady && !isInsideArea(cx + size / 2, cy + size / 2, roomIndex)) {
      // Find nearest valid coord in this area
      var best = pickSlotInArea(roomIndex, hashCode(cx + ',' + cy));
      cx = best.x; cy = best.y;
    }
    return { x: cx, y: cy };
  }

  function overlapsExistingAt(x, y, drawSize, ignoreId) {
    var size = typeof drawSize === 'number' ? drawSize : DRAW_SIZE;
    var cx = x + size / 2;
    var cy = y + size / 2;
    for (const e of appState.entityById.values()) {
      if (ignoreId && e.id === ignoreId) continue;
      var existingSize = e.drawSize || DRAW_SIZE;
      var ex = e.baseX + existingSize / 2;
      var ey = e.baseY + existingSize / 2;
      var minDist = (existingSize + size) * 0.5 + 2;
      var dx = cx - ex;
      var dy = cy - ey;
      if (dx * dx + dy * dy < minDist * minDist) return true;
    }
    return false;
  }

  function pickNearbySubagentSlot(parentEntity, roomIndex, seed, drawSize, agentId) {
    var parentX = typeof parentEntity.x === 'number' ? parentEntity.x : parentEntity.baseX;
    var parentY = typeof parentEntity.y === 'number' ? parentEntity.y : parentEntity.baseY;
    var parentCX = parentX + DRAW_SIZE / 2;
    var parentCY = parentY + DRAW_SIZE / 2;
    var bounds = getSubagentRadiusBounds(drawSize);
    var minRadius = bounds.min;
    var maxRadius = bounds.max;
    var slotCount = SUBAGENT_RING_SLOTS;
    var ringStep = Math.max(SUBAGENT_RING_STEP, drawSize * 0.45);
    var angleOffset = (seed % 360) * (Math.PI / 180);
    var best = null;
    var bestScore = Infinity;

    for (var ring = 0; ring < 3; ring++) {
      var radius = Math.min(maxRadius, Math.max(minRadius + 1, SUBAGENT_RING_BASE_RADIUS + ring * ringStep));
      for (var slotIndex = 0; slotIndex < slotCount; slotIndex++) {
        var angle = angleOffset + (Math.PI * 2 * slotIndex / slotCount);
        var x = parentCX + Math.cos(angle) * radius - drawSize / 2;
        var y = parentCY + Math.sin(angle) * radius - drawSize / 2;
        var clamped = clampToArea(x, y, roomIndex, drawSize);
        var dx = (clamped.x + drawSize / 2) - parentCX;
        var dy = (clamped.y + drawSize / 2) - parentCY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minRadius) continue;
        if (dist > maxRadius) continue;
        var score = Math.abs(dist - radius);
        if (score < bestScore) {
          best = clamped;
          bestScore = score;
        }
        if (!overlapsExistingAt(clamped.x, clamped.y, drawSize, agentId)) {
          return clamped;
        }
      }
    }

    if (best) {
      return best;
    }

    for (var attempt = 0; attempt < 24; attempt++) {
      var angle = angleOffset + (Math.PI * 2 * attempt / 24);
      var radius = Math.min(maxRadius, minRadius + 1 + attempt * 0.5);
      var x = parentCX + Math.cos(angle) * radius - drawSize / 2;
      var y = parentCY + Math.sin(angle) * radius - drawSize / 2;
      var clamped = clampToArea(x, y, roomIndex, drawSize);
      var dx = (clamped.x + drawSize / 2) - parentCX;
      var dy = (clamped.y + drawSize / 2) - parentCY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minRadius || dist > maxRadius) continue;
      if (!overlapsExistingAt(clamped.x, clamped.y, drawSize, agentId)) {
        return clamped;
      }
    }

    return clampToArea(parentCX + maxRadius - drawSize / 2, parentCY - drawSize / 2, roomIndex, drawSize);
  }

  function getParentAnchor(parentId, roomIndex) {
    if (!parentId) return null;
    var liveParent = appState.entityById.get(parentId);
    if (liveParent) {
      return {
        x: liveParent.baseX,
        y: liveParent.baseY,
        roomIndex: liveParent.roomIndex
      };
    }

    var cached = positionCache[parentId];
    if (cached && typeof cached.x === 'number' && typeof cached.y === 'number') {
      return {
        x: cached.x,
        y: cached.y,
        roomIndex: typeof cached.roomIndex === 'number' ? cached.roomIndex : roomIndex
      };
    }

    return null;
  }

  function subagentDistanceFromParent(x, y, drawSize, parentAnchor) {
    if (!parentAnchor) return Infinity;
    var parentCX = parentAnchor.x + DRAW_SIZE / 2;
    var parentCY = parentAnchor.y + DRAW_SIZE / 2;
    var childCX = x + drawSize / 2;
    var childCY = y + drawSize / 2;
    var dx = childCX - parentCX;
    var dy = childCY - parentCY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function isValidSubagentPosition(x, y, drawSize, parentAnchor) {
    if (!parentAnchor) return false;
    var bounds = getSubagentRadiusBounds(drawSize);
    var minRadius = bounds.min;
    var maxRadius = bounds.max;
    var dist = subagentDistanceFromParent(x, y, drawSize, parentAnchor);
    return dist >= minRadius && dist <= maxRadius + 2;
  }

  function getSubagentRadiusBounds(drawSize) {
    var minRadius = Math.ceil((DRAW_SIZE + drawSize) * 0.5) + 2;
    var maxRadius = minRadius + Math.max(6, Math.round(drawSize * 0.35));
    return { min: minRadius, max: maxRadius };
  }

  function clampSubagentToParentRadius(x, y, roomIndex, drawSize, parentAnchor) {
    var clamped = clampToArea(x, y, roomIndex, drawSize);
    if (!parentAnchor) return null;
    if (isValidSubagentPosition(clamped.x, clamped.y, drawSize, parentAnchor)) {
      return clamped;
    }
    return pickNearbySubagentSlot(parentAnchor, roomIndex, hashCode(String(x) + ',' + String(y)), drawSize);
  }

  function ensureEntity(agent) {
    let entity = appState.entityById.get(agent.agentId);
    if (entity) return entity;

    var drawSize = agent.parentId ? SUBAGENT_DRAW_SIZE : DRAW_SIZE;
    var parentAnchor = agent.parentId ? getParentAnchor(agent.parentId, getAreaIndex(agent)) : null;

    // Try to restore from localStorage cache
    var cached = positionCache[agent.agentId];
    if (cached && typeof cached.x === 'number' && typeof cached.y === 'number') {
      var cachedRoom = typeof cached.roomIndex === 'number' ? cached.roomIndex : getAreaIndex(agent);
      var cachedPos = clampToArea(cached.x, cached.y, cachedRoom, drawSize);
      if (agent.parentId) {
        var cachedParentAnchor = getParentAnchor(agent.parentId, cachedRoom);
        if (!cachedParentAnchor) {
          cached = null;
        } else if (!isValidSubagentPosition(cachedPos.x, cachedPos.y, drawSize, cachedParentAnchor)) {
          cachedPos = pickNearbySubagentSlot(cachedParentAnchor, cachedRoom, hashCode(agent.agentId), drawSize, agent.agentId);
        }
      }
      if (cached) {
        appState.roomAssignments.set(agent.agentId, cachedRoom);
        entity = {
          id: agent.agentId,
          parentId: agent.parentId || null,
          x: cachedPos.x,
          y: cachedPos.y,
          baseX: cachedPos.x,
          baseY: cachedPos.y,
        roomIndex: cachedRoom
        ,
        drawSize: drawSize
      };
        appState.entityById.set(agent.agentId, entity);
        savePositionCache();
        startSpawnAnimation(agent.agentId, entity);
        return entity;
      }
    }

    const roomIndex = getAreaIndex(agent);
    const room = AREAS[roomIndex];

    var slot;
    if (agent.parentId) {
      if (parentAnchor) {
        var siblingIndex = 0;
        for (const e of appState.entityById.values()) {
          if (e.parentId === agent.parentId) siblingIndex++;
        }
        // Shrink orbit radius for deeper nesting levels
        var depth = getEntityDepth(agent.parentId) + 1;
        var radiusShrink = Math.max(0.4, 1.0 - (depth - 1) * 0.25);
        var baseRadius = SUBAGENT_RING_BASE_RADIUS * radiusShrink;
        var stepRadius = SUBAGENT_RING_STEP * radiusShrink;
        var radiusBounds = getSubagentRadiusBounds(drawSize);

        var ring = Math.floor(siblingIndex / SUBAGENT_RING_SLOTS);
        var slotInRing = siblingIndex % SUBAGENT_RING_SLOTS;
        // Offset angle by depth to avoid overlapping orbit patterns
        var angleOffset = depth * (Math.PI / 7);
        var angle = (Math.PI * 2 * slotInRing / SUBAGENT_RING_SLOTS) - Math.PI / 2 + angleOffset;
        var orbitRadius = Math.min(radiusBounds.max, Math.max(radiusBounds.min + 1, baseRadius + ring * (stepRadius + 2)));

        var parentCX = parentAnchor.x + DRAW_SIZE / 2;
        var parentCY = parentAnchor.y + DRAW_SIZE / 2;
        slot = {
          x: parentCX + Math.cos(angle) * orbitRadius - drawSize / 2,
          y: parentCY + Math.sin(angle) * orbitRadius - drawSize / 2
        };

        // Keep subagents close to the parent even when area clamping kicks in.
        var clamped = clampSubagentToParentRadius(slot.x, slot.y, roomIndex, drawSize, parentAnchor);
        // Check if clamped position is too close to parent
        var dx = (clamped.x + drawSize / 2) - parentCX;
        var dy = (clamped.y + drawSize / 2) - parentCY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < ((DRAW_SIZE + drawSize) * 0.5) + 2) {
          clamped = pickNearbySubagentSlot(parentAnchor, roomIndex, hashCode(agent.agentId + ':near'), drawSize, agent.agentId);
        }
        // If still overlapping another entity, find a non-overlapping spot
        if (overlapsExistingAt(clamped.x, clamped.y, drawSize, agent.agentId)) {
          var nearby = pickNearbySubagentSlot(parentAnchor, roomIndex, hashCode(agent.agentId), drawSize, agent.agentId);
          clamped.x = nearby.x;
          clamped.y = nearby.y;
        }
        slot.x = clamped.x;
        slot.y = clamped.y;
      } else {
        return null;
      }
    } else {
      // Root agent: use mask to place inside the area
      slot = pickSlotInArea(roomIndex, hashCode(agent.agentId));
    }

    slot = agent.parentId
      ? clampSubagentToParentRadius(slot.x, slot.y, roomIndex, drawSize, parentAnchor)
      : clampToArea(slot.x, slot.y, roomIndex, drawSize);
    if (!slot) return null;

    entity = {
      id: agent.agentId,
      parentId: agent.parentId || null,
      x: slot.x,
      y: slot.y,
      baseX: slot.x,
      baseY: slot.y,
      roomIndex: roomIndex
      ,
      drawSize: drawSize
    };

    appState.entityById.set(agent.agentId, entity);
    savePositionCache();
    startSpawnAnimation(agent.agentId, entity);
    return entity;
  }

  function reconcileEntities(agents) {
    const live = new Set(agents.map(function (a) { return a.agentId; }));
    for (const agentId in subagentPokemonCache) {
      if (!live.has(agentId)) {
        delete subagentPokemonCache[agentId];
      }
    }
    for (const [id, entity] of appState.entityById.entries()) {
      if (!live.has(id)) {
        // Start despawn animation instead of instant removal
        if (!animations.has(id)) {
          var lastAgent = appState.prevAgentMap ? appState.prevAgentMap.get(id) : null;
          startDespawnAnimation(id, entity, lastAgent);
        }
        appState.entityById.delete(id);
      }
    }
    for (const id of appState.roomAssignments.keys()) {
      if (!live.has(id)) {
        // Delay room cleanup until despawn animation finishes
        if (!animations.has(id)) appState.roomAssignments.delete(id);
      }
    }
    savePositionCache();
    // Keep a map of current agents for despawn sprite reference
    appState.prevAgentMap = new Map(agents.map(function (a) { return [a.agentId, a]; }));

    // Sort agents so parents are always processed before children
    var agentById = {};
    for (var i = 0; i < agents.length; i++) {
      agentById[agents[i].agentId] = agents[i];
    }
    var sorted = [];
    var visited = {};
    function visit(agent) {
      if (visited[agent.agentId]) return;
      visited[agent.agentId] = true;
      if (agent.parentId && agentById[agent.parentId]) {
        visit(agentById[agent.parentId]);
      }
      sorted.push(agent);
    }
    for (var i = 0; i < agents.length; i++) {
      visit(agents[i]);
    }

    for (var i = 0; i < sorted.length; i++) {
      ensureEntity(sorted[i]);
    }
  }

  function filteredAgents() {
    return appState.snapshot.agents.filter(function (agent) {
      if (uiState.projectFilter !== 'all' && agent.projectId !== uiState.projectFilter) return false;
      if (uiState.sessionFilter !== 'all' && agent.sessionId !== uiState.sessionFilter) return false;
      return true;
    });
  }

  function updateFilterOptions() {
    const projects = Array.from(new Set(appState.snapshot.agents.map(function (a) { return a.projectId; }))).sort();
    const sessions = Array.from(new Set(appState.snapshot.agents.map(function (a) { return a.sessionId; }))).sort();
    appState.projects = projects;
    appState.sessions = sessions;

    projectFilterEl.innerHTML = '<option value="all">All</option>';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      if (p === uiState.projectFilter) opt.selected = true;
      projectFilterEl.appendChild(opt);
    }
    if (!projects.includes(uiState.projectFilter)) uiState.projectFilter = 'all';
    projectFilterEl.value = uiState.projectFilter;

    sessionFilterEl.innerHTML = '<option value="all">All</option>';
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      if (s === uiState.sessionFilter) opt.selected = true;
      sessionFilterEl.appendChild(opt);
    }
    if (!sessions.includes(uiState.sessionFilter)) uiState.sessionFilter = 'all';
    sessionFilterEl.value = uiState.sessionFilter;
  }

  function resetFilters() {
    uiState.projectFilter = 'all';
    uiState.sessionFilter = 'all';
    projectFilterEl.value = 'all';
    sessionFilterEl.value = 'all';
  }

  function buildAgentTree(agents) {
    var byId = {};
    var roots = [];
    for (var i = 0; i < agents.length; i++) {
      byId[agents[i].agentId] = agents[i];
    }
    for (var i = 0; i < agents.length; i++) {
      var agent = agents[i];
      if (agent.parentId && byId[agent.parentId]) {
        var parent = byId[agent.parentId];
        if (!parent._children) parent._children = [];
        parent._children.push(agent);
      } else {
        roots.push(agent);
      }
    }
    return { roots: roots, byId: byId };
  }

  function renderAgentCard(agent, depth, tree, expandedIds, collapsedIds) {
    var contextMax = agent.contextMax || 200000;
    var contextUsed = agent.contextUsed || 0;
    var contextRemaining = contextMax - contextUsed;
    var hpRatio = contextRemaining / contextMax;
    var barColor = hpBarColor(hpRatio);
    var barPct = Math.max(0, Math.min(100, hpRatio * 100));
    var childCount = agent._children ? agent._children.length : 0;

    var activeClass = agent.isActive ? ' active' : (agent.isSleeping ? ' sleeping' : ' idle');
    var isExpanded = expandedIds[agent.agentId] ? ' expanded' : '';
    var hierarchyClass = depth > 0 ? ' subagent-card' : ' root-card';
    var branchHostClass = childCount > 0 ? ' branch-host' : '';

    var xp = agentLevelProgress(agent);
    var spriteUrl = agent.isSleeping ? pokemonStaticIconUrl(agent) : pokemonIconUrl(agent);
    var name = agentPanelName(agent);
    var lastCommand = commandText(agent.lastCommand);
    var parentAgent = depth > 0 && agent.parentId ? tree.byId[agent.parentId] : null;
    var parentName = parentAgent ? agentPanelName(parentAgent) : (agent.parentId ? toShortId(agent.parentId) : '');
    var fullLabel = agentLabel(agent);
    var subhistoryCount = subhistoryFamilyCount(agent.agentId);
    var uptime = formatUptime(agent.createdAt);
    var secsAgo = Math.max(0, Math.floor((Date.now() - agent.lastSeen) / 1000));
    var visibleChildLabel = childCount + ' sub' + (childCount === 1 ? '' : 's');
    var isCollapsed = isSubtreeCollapsed(agent.agentId, depth, childCount, collapsedIds);

    var html = '';
    html += '<article class="poke-slot' + hierarchyClass + activeClass + isExpanded + branchHostClass + '" data-agent-id="' + escapeHtml(agent.agentId) + '" data-depth="' + depth + '">';

    html += '<img class="poke-slot-sprite" src="' + escapeHtml(spriteUrl) + '" />';

    html += '<div class="poke-slot-info">';

    html += '<div class="poke-slot-row1">';
    html += '<div class="poke-slot-title">';
    html += '<div class="poke-lv-row">';
    html += '<span class="poke-lv">LV.' + xp.level + '</span>';
    if (!agent.parentId) {
      var projName = shortProjectName(agent.projectId);
      html += '<span class="poke-project-badge" data-full="' + escapeHtml(projName) + '">' + escapeHtml(projName) + '</span>';
    }
    html += '</div>';
    html += '<span class="poke-slot-name" title="' + escapeHtml(fullLabel) + '">' + escapeHtml(name) + '</span>';
    html += '</div>';
    html += '<span class="poke-slot-status">' + escapeHtml(agent.status) + '</span>';
    html += '</div>';

    if (depth > 0 || childCount > 0) {
      html += '<div class="poke-slot-row-meta">';
      if (depth > 0) {
        html += '<span class="poke-subagent-badge">SUB</span>';
        html += '<span class="poke-depth-badge">D' + depth + '</span>';
        if (parentName) {
          html += '<span class="poke-parent-pill" title="Parent: ' + escapeHtml(parentName) + '">Parent ' + escapeHtml(parentName) + '</span>';
        }
      }
      if (childCount > 0) {
        html += '<span class="poke-children-pill">' + escapeHtml(visibleChildLabel) + '</span>';
        html += '<button class="poke-hierarchy-toggle' + (isCollapsed ? ' collapsed' : '') + '" type="button" data-action="toggle-subtree" data-agent-id="' + escapeHtml(agent.agentId) + '" data-depth="' + depth + '" aria-expanded="' + String(!isCollapsed) + '" title="' + (isCollapsed ? 'Show sub-agent hierarchy' : 'Hide sub-agent hierarchy') + '">';
        html += '<span class="poke-hierarchy-toggle-label">' + (isCollapsed ? 'Show' : 'Hide') + '</span>';
        html += '</button>';
      }
      html += '</div>';
    }

    html += '<div class="poke-slot-row2">';
    html += '<span class="poke-hp-label">HP</span>';
    html += '<div class="poke-hp-track"><div class="poke-hp-fill" style="width:' + barPct.toFixed(1) + '%;background:' + barColor + '"></div></div>';
    html += '<span class="poke-hp-nums">' + formatContextK(contextRemaining) + '/' + formatContextK(contextMax) + '</span>';
    html += '</div>';

    html += '<div class="poke-slot-row3">';
    html += '<span class="poke-exp-label">EXP</span>';
    html += '<div class="poke-exp-track"><div class="poke-exp-fill" style="width:' + xp.progress.toFixed(1) + '%"></div></div>';
    html += '<span class="poke-exp-nums">' + formatTokenCount(xp.intoLevel) + ' / ' + formatTokenCount(xp.needed) + '</span>';
    html += '</div>';

    html += '<div class="poke-slot-row4">';
    var modelName = formatModelName(agent.model, contextMax);
    if (modelName) {
      html += '<span class="poke-model-badge">' + escapeHtml(modelName) + '</span>';
    }
    html += '<span class="poke-token-nums">TOK ' + formatTokenCount(xp.totalTokens) + '</span>';
    html += '</div>';
    html += '</div>';

    html += '<div class="poke-slot-details">';
    html += '<div class="detail-row detail-title"><span class="detail-value">' + escapeHtml(fullLabel) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">' + escapeHtml(toShortId(agent.agentId)) + '</span></div>';
    if (depth > 0) {
      html += '<div class="detail-row"><span class="detail-label">Depth</span><span class="detail-value">' + depth + '</span></div>';
      html += '<div class="detail-row"><span class="detail-label">Parent</span><span class="detail-value">' + escapeHtml(parentName || '-') + '</span></div>';
    }
    if (agent.model) {
      html += '<div class="detail-row"><span class="detail-label">Model</span><span class="detail-value">' + escapeHtml(modelName || agent.model) + '</span></div>';
    }
    html += '<div class="detail-row"><span class="detail-label">Started</span><span class="detail-value">' + formatTime(agent.createdAt) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Uptime</span><span class="detail-value">' + escapeHtml(uptime) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Last seen</span><span class="detail-value">' + secsAgo + 's ago</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Last tool</span><span class="detail-value">' + escapeHtml(agent.lastTool || '-') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Tools run</span><span class="detail-value">' + (agent.counters.toolStarts || 0) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Context</span><span class="detail-value">' + formatContextK(contextRemaining) + ' / ' + formatContextK(contextMax) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Tokens</span><span class="detail-value">' + formatTokenCount(xp.totalTokens) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Project</span><span class="detail-value">' + escapeHtml(agent.projectId) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Session</span><span class="detail-value">' + escapeHtml(agent.sessionId) + '</span></div>';
    if (childCount > 0) {
      html += '<div class="detail-row"><span class="detail-label">Visible subs</span><span class="detail-value">' + childCount + '</span></div>';
    }
    if (agent.childrenIds && agent.childrenIds.length > 0) {
      html += '<div class="detail-row"><span class="detail-label">Sub-agents</span><span class="detail-value">' + agent.childrenIds.length + '</span></div>';
    }
    if (subhistoryCount > 0) {
      html += '<div class="detail-row"><span class="detail-label">Sub history</span><span class="detail-value">' + subhistoryCount + '</span></div>';
      html += '<button class="box-detail-btn" data-action="open-subhistory" data-agent-id="' + escapeHtml(agent.agentId) + '">Open Sub-agent History</button>';
    }
    if (lastCommand) {
      html += '<div class="detail-command" title="' + escapeHtml(lastCommand) + '"><span class="detail-label">Last command</span><span class="detail-value">' + escapeHtml(lastCommand) + '</span></div>';
    }
    if (agent.lastUserQuery) {
      html += '<div class="detail-row detail-query"><span class="detail-label">Last query</span><span class="detail-value">' + escapeHtml(agent.lastUserQuery) + '</span></div>';
    }
    if (!agent.isPromoCustom || !agent.parentId) {
      html += '<button class="box-btn" data-action="box" data-agent-id="' + escapeHtml(agent.agentId) + '">Box</button>';
    }
    html += '</div>';

    html += '</article>';
    return html;
  }

  function renderAgentBranch(agent, depth, tree, expandedIds, collapsedIds, renderState, isLastChild) {
    if (renderState.count >= 80) return '';

    var childCount = agent._children ? agent._children.length : 0;
    var isCollapsed = isSubtreeCollapsed(agent.agentId, depth, childCount, collapsedIds);
    var branchClasses = ['agent-branch'];
    if (depth === 0) branchClasses.push('root-branch');
    if (depth > 0 && !isLastChild) {
      branchClasses.push('branch-continued');
    }
    if (childCount > 0) branchClasses.push('has-children');
    if (isCollapsed) branchClasses.push('collapsed');

    var html = '<div class="' + branchClasses.join(' ') + '" data-depth="' + depth + '">';
    html += '<div class="agent-branch-node">';
    html += renderAgentCard(agent, depth, tree, expandedIds, collapsedIds);
    html += '</div>';
    renderState.count += 1;

    if (childCount > 0 && !isCollapsed && renderState.count < 80) {
      var children = agent._children.slice();
      children.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      html += '<div class="agent-branch-children">';
      for (var i = 0; i < children.length && renderState.count < 80; i++) {
        html += renderAgentBranch(children[i], depth + 1, tree, expandedIds, collapsedIds, renderState, i === children.length - 1);
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function formatUptime(createdAt) {
    var secs = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
    if (secs < 60) return secs + 's';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ' + (secs % 60) + 's';
    var hrs = Math.floor(mins / 60);
    return hrs + 'h ' + (mins % 60) + 'm';
  }

  function formatTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    var h = String(d.getHours()).padStart(2, '0');
    var m = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return mo + '/' + day + ' ' + h + ':' + m + ':' + s;
  }

  function formatDuration(startTs, endTs) {
    if (!startTs || !endTs) return '-';
    var secs = Math.max(0, Math.floor((endTs - startTs) / 1000));
    if (secs < 60) return secs + 's';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ' + (secs % 60) + 's';
    var hrs = Math.floor(mins / 60);
    return hrs + 'h ' + (mins % 60) + 'm';
  }

  function boxedSubagentsForParent(parentId) {
    var boxed = appState.snapshot.subagentHistory || [];
    var result = [];
    for (var i = 0; i < boxed.length; i++) {
      if (boxed[i].parentId === parentId) {
        result.push(boxed[i]);
      }
    }
    result.sort(function (a, b) {
      return (b.doneAt || 0) - (a.doneAt || 0);
    });
    return result;
  }

  function liveSubagentsForParent(parentId) {
    var live = appState.snapshot.agents || [];
    var result = [];
    for (var i = 0; i < live.length; i++) {
      if (live[i].parentId === parentId) {
        result.push(live[i]);
      }
    }
    result.sort(function (a, b) {
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    return result;
  }

  function boxedAgentById(agentId) {
    var boxed = appState.snapshot.boxedAgents || [];
    for (var i = 0; i < boxed.length; i++) {
      if (boxed[i].agentId === agentId) return boxed[i];
    }
    return null;
  }

  function parentHistoryLabel(parentId) {
    var live = appState.agentById && appState.agentById.get(parentId);
    if (live) return agentLabel(live);
    var boxed = boxedAgentById(parentId);
    if (boxed) return agentLabel(boxed);
    return toShortId(parentId);
  }

  function parentHistoryAgent(parentId) {
    var live = appState.agentById && appState.agentById.get(parentId);
    if (live) return { isLive: true, isHistory: false, source: 'live', ...live, doneAt: null };
    var boxed = boxedAgentById(parentId);
    if (boxed) return { isLive: false, isHistory: true, source: 'history', ...boxed };
    return {
      agentId: parentId,
      displayName: null,
      subagentType: 'Parent',
      projectId: '-',
      sessionId: '-',
      totalTokens: 0,
      createdAt: 0,
      doneAt: 0,
      counters: {},
      isLive: false,
      isHistory: true,
      source: 'history'
    };
  }

  function subhistoryKey(agent) {
    return String(agent.agentId || 'unknown') + ':' + String(agent.createdAt || 0) + ':' + String(agent.doneAt || 0);
  }

  function subhistoryLineageForParent(parentId) {
    var items = appState.snapshot.subagentHistory || [];
    var live = appState.snapshot.agents || [];
    var byParent = new Map();
    var relevantKeys = {};
    var stack = [parentId];
    var ordered = [];

    for (var i = 0; i < items.length; i++) {
      var entry = {
        source: 'history',
        isLive: false,
        isHistory: true,
        ...items[i]
      };
      var bucket = byParent.get(entry.parentId || '');
      if (!bucket) {
        bucket = [];
        byParent.set(entry.parentId || '', bucket);
      }
      bucket.push(entry);
    }

    for (var j = 0; j < live.length; j++) {
      if (!live[j].parentId) continue;
      var liveEntry = {
        source: 'live',
        isLive: true,
        isHistory: false,
        ...live[j],
        doneAt: null
      };
      var liveBucket = byParent.get(liveEntry.parentId || '');
      if (!liveBucket) {
        liveBucket = [];
        byParent.set(liveEntry.parentId || '', liveBucket);
      }
      liveBucket.push(liveEntry);
    }

    byParent.forEach(function (bucket) {
      bucket.sort(function (a, b) {
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
    });

    while (stack.length > 0) {
      var currentParent = stack.shift();
      var children = byParent.get(currentParent || '') || [];
      for (var j = 0; j < children.length; j++) {
        var child = children[j];
        var key = subhistoryKey(child);
        if (relevantKeys[key]) continue;
        relevantKeys[key] = true;
        ordered.push(child);
        stack.push(child.agentId);
      }
    }

    return ordered;
  }

  function subhistoryFamilyCount(parentId) {
    return subhistoryLineageForParent(parentId).length;
  }

  function buildSubhistoryTree(parentId) {
    var items = subhistoryLineageForParent(parentId);
    var nodesByParent = new Map();
    var roots = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      item._subhistoryChildren = [];
      var key = item.parentId || '';
      if (!nodesByParent.has(key)) nodesByParent.set(key, []);
      nodesByParent.get(key).push(item);
    }

    function attach(node) {
      var children = nodesByParent.get(node.agentId) || [];
      for (var i = 0; i < children.length; i++) {
        node._subhistoryChildren.push(children[i]);
        attach(children[i]);
      }
    }

    roots = nodesByParent.get(parentId || '') || [];
    for (var r = 0; r < roots.length; r++) {
      attach(roots[r]);
    }
    return roots;
  }

  function collectSubhistoryGenerations(nodes, depth, generations) {
    if (!generations[depth]) generations[depth] = [];
    for (var i = 0; i < nodes.length; i++) {
      generations[depth].push(nodes[i]);
      if (nodes[i]._subhistoryChildren && nodes[i]._subhistoryChildren.length > 0) {
        collectSubhistoryGenerations(nodes[i]._subhistoryChildren, depth + 1, generations);
      }
    }
  }

  function historyStatSnapshot(agent) {
    var xp = agentLevelProgress(agent);
    var contextMax = agent.contextMax || 200000;
    var contextUsed = agent.contextUsed || 0;
    var contextRemaining = Math.max(0, contextMax - contextUsed);
    var hpRatio = contextMax > 0 ? (contextRemaining / contextMax) : 0;

    return {
      xp: xp,
      contextMax: contextMax,
      contextRemaining: contextRemaining,
      hpPct: Math.max(0, Math.min(100, hpRatio * 100)),
      hpColor: hpBarColor(hpRatio)
    };
  }

  function renderHistoryStats(agent, extraClass) {
    var stats = historyStatSnapshot(agent);
    var className = extraClass ? ' ' + extraClass : '';
    var html = '';

    html += '<div class="history-stats' + className + '">';
    html += '<div class="history-stats-summary">';
    html += '<span class="history-stats-level">LV.' + stats.xp.level + '</span>';
    html += '<span class="history-stats-token">TOK ' + formatTokenCount(stats.xp.totalTokens) + '</span>';
    html += '</div>';

    html += '<div class="history-stats-bar">';
    html += '<span class="history-stats-label">HP</span>';
    html += '<div class="history-stats-track history-stats-track-hp">';
    html += '<div class="history-stats-fill" style="width:' + stats.hpPct.toFixed(1) + '%;background:' + stats.hpColor + '"></div>';
    html += '</div>';
    html += '<span class="history-stats-value">' + formatContextK(stats.contextRemaining) + '/' + formatContextK(stats.contextMax) + '</span>';
    html += '</div>';

    html += '<div class="history-stats-bar">';
    html += '<span class="history-stats-label">EXP</span>';
    html += '<div class="history-stats-track history-stats-track-exp">';
    html += '<div class="history-stats-fill history-stats-fill-exp" style="width:' + stats.xp.progress.toFixed(1) + '%"></div>';
    html += '</div>';
    html += '<span class="history-stats-value">' + formatTokenCount(stats.xp.intoLevel) + '/' + formatTokenCount(stats.xp.needed) + '</span>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  function renderSubhistoryCard(agent, kind) {
    var key = kind + ':' + subhistoryKey(agent);
    var label = agent.displayName || agent.subagentType || toShortId(agent.agentId);
    var timeValue = kind === 'parent'
      ? (agent.lastSeen || agent.doneAt || agent.createdAt)
      : (agent.isLive ? (agent.lastSeen || agent.createdAt) : agent.doneAt);
    var iconUrl = agent.isLive && !(agent.isSleeping || !agent.isActive)
      ? pokemonIconUrl(agent)
      : pokemonStaticIconUrl(agent);
    appState.subhistoryEntryByKey.set(key, agent);

    var html = '';
    html += '<article class="subhistory-lineage-card" data-subhistory-key="' + escapeHtml(key) + '">';
    html += '<div class="subhistory-lineage-header">';
    html += '<img class="subhistory-lineage-icon" src="' + escapeHtml(iconUrl) + '" alt="" />';
    html += '<div class="subhistory-lineage-main">';
    html += '<div class="subhistory-lineage-top">';
    html += '<span class="subhistory-lineage-name">' + escapeHtml(label) + '</span>';
    html += '</div>';
    html += renderHistoryStats(agent, 'subhistory-lineage-stats');
    html += '<div class="subhistory-lineage-bottom">';
    html += '<span class="subhistory-lineage-type">' + escapeHtml(agent.subagentType || (kind === 'parent' ? 'Parent' : 'Sub-agent')) + '</span>';
    html += '<span class="subhistory-lineage-time">' + escapeHtml(agent.isLive ? 'Live' : formatTime(timeValue)) + '</span>';
    html += '</div>';
    html += '</div>';
    html += '</div>';
    html += '</article>';
    return html;
  }

  function renderSubhistoryColumns(parentId) {
    var roots = buildSubhistoryTree(parentId);
    var generations = [];
    var parent = parentHistoryAgent(parentId);
    collectSubhistoryGenerations(roots, 1, generations);

    var html = '<div class="subhistory-columns">';
    html += '<section class="subhistory-column">';
    html += '<div class="subhistory-column-title">Parent</div>';
    html += renderSubhistoryCard(parent, 'parent');
    html += '</section>';

    for (var depth = 1; depth < generations.length; depth++) {
      var generation = generations[depth] || [];
      if (generation.length === 0) continue;
      html += '<section class="subhistory-column">';
      html += '<div class="subhistory-column-title">Depth ' + depth + '</div>';
      for (var i = 0; i < generation.length; i++) {
        html += renderSubhistoryCard(generation[i], 'child');
      }
      html += '</section>';
    }

    html += '</div>';
    return html;
  }

  function renderSubagentHistory(items, options) {
    var html = '';
    var limit = options && typeof options.limit === 'number' ? options.limit : items.length;
    for (var i = 0; i < items.length && i < limit; i++) {
      var agent = items[i];
      var label = agent.displayName || agent.subagentType || toShortId(agent.agentId);
      html += '<div class="subhistory-item">';
      html += '<div class="subhistory-row">';
      html += '<span class="subhistory-name">' + escapeHtml(label) + '</span>';
      html += '<span class="subhistory-time">' + escapeHtml(formatTime(agent.doneAt)) + '</span>';
      html += '</div>';
      html += '<div class="subhistory-meta">';
      html += '<span>' + escapeHtml(agent.subagentType || 'Sub-agent') + '</span>';
      html += '<span>Tools ' + (agent.counters.toolStarts || 0) + '</span>';
      html += '<span>TOK ' + formatTokenCount(agent.totalTokens || 0) + '</span>';
      html += '<span>' + escapeHtml(formatDuration(agent.createdAt, agent.doneAt)) + '</span>';
      html += '</div>';
      html += '</div>';
    }
    return html;
  }

  function setSubhistoryOpen(isOpen, parentId) {
    uiState.subhistoryOpen = !!isOpen;
    uiState.subhistoryParentId = isOpen ? (parentId || uiState.subhistoryParentId) : null;
    subhistoryModalEl.hidden = !uiState.subhistoryOpen;
    if (!uiState.subhistoryOpen) {
      hideBoxTooltip();
      hideSubhistoryTooltip();
    }
  }

  function renderSubhistoryModal() {
    var parentId = uiState.subhistoryParentId;
    var items = parentId ? subhistoryLineageForParent(parentId) : [];
    var label = parentId ? parentHistoryLabel(parentId) : 'Sub-agent History';
    var countLabel = items.length === 1 ? '1 record' : items.length + ' records';
    appState.subhistoryEntryByKey = new Map();
    subhistoryTitleEl.textContent = label;
    subhistorySummaryEl.textContent = countLabel;
    subhistoryGridEl.innerHTML = items.length
      ? renderSubhistoryColumns(parentId)
      : '<div class="box-empty">No boxed sub-agent history yet.</div>';
  }

  function pokemonSpriteUrl(agent, sleeping) {
    var id = getRenderPokemonId(agent);
    var spec = pokemonSpriteSpec(sleeping);
    return '/sprites/' + spec.folder + '/' + id + '.' + spec.ext;
  }

  function pokemonIconUrl(agent) {
    var id = getRenderPokemonId(agent);
    return '/sprites/icon/' + id + '.png';
  }

  function pokemonStaticIconUrl(agent) {
    var id = getRenderPokemonId(agent);
    return '/sprites/icon-static/' + id + '.png';
  }

  function pokemonSpriteSpec(sleeping) {
    return sleeping
      ? { folder: 'static', ext: 'png' }
      : { folder: 'animated', ext: 'gif' };
  }

  function agentSleepSpriteScale(agent) {
    if (!agent || agent.parentId) return 1;
    if (!(appState.snapshot.config && appState.snapshot.config.enablePokeapiSprites)) return 1;
    return pokeProvider.getSleepScale(agent);
  }

  function formatContextK(value) {
    return Math.floor(value / 1000) + 'k';
  }

  function formatTokenCount(value) {
    return Math.max(0, Math.floor(value || 0)).toLocaleString('en-US');
  }

  function agentPanelName(agent) {
    if (!agent) return 'unknown';
    if (agent.parentId) {
      return agent.displayName || agent.subagentType || toShortId(agent.agentId);
    }
    return rootAgentBadge(agent);
  }

  function filteredTokenTotal(agents) {
    var total = 0;
    for (var i = 0; i < agents.length; i++) {
      total += agents[i].selfTokens || 0;
    }
    return total;
  }

  function hpBarColor(ratio) {
    if (ratio > 0.5) return '#58d058';
    if (ratio > 0.2) return '#f0c838';
    return '#e85040';
  }

  function formatModelName(model, contextMax) {
    if (!model) return null;
    var m = String(model).toLowerCase();
    // Parse family and version from model ID (e.g. "claude-opus-4-6" → "Opus 4.6")
    var family = '';
    var version = '';
    if (m.includes('opus')) family = 'Opus';
    else if (m.includes('sonnet')) family = 'Sonnet';
    else if (m.includes('haiku')) family = 'Haiku';
    else return model;
    // Extract version: match "4-6", "4-5", etc. after the family name
    var vMatch = m.match(/(\d+)-(\d+)/);
    if (vMatch) {
      version = ' ' + vMatch[1] + '.' + vMatch[2];
    }
    var tier = (contextMax && contextMax >= 1000000) ? ' (1M)' : '';
    return family + version + tier;
  }

  function expToNextLevel(level) {
    var stage = Math.max(0, level - 1);
    return 69000 + stage * 4800;
  }

  function agentLevelProgress(agent) {
    var totalTokens = Math.max(0, agent && agent.totalTokens ? agent.totalTokens : 0);
    var level = 1;
    var currentBase = 0;

    while (level < 100) {
      var nextDelta = expToNextLevel(level);
      if (totalTokens < currentBase + nextDelta) {
        break;
      }
      currentBase += nextDelta;
      level += 1;
    }

    var nextLevelBase = level >= 100 ? currentBase : currentBase + expToNextLevel(level);
    var intoLevel = totalTokens - currentBase;
    var needed = Math.max(1, nextLevelBase - currentBase);
    var progress = level >= 100 ? 100 : Math.max(0, Math.min(100, (intoLevel / needed) * 100));

    return {
      level: level,
      totalTokens: totalTokens,
      currentBase: currentBase,
      nextLevelBase: nextLevelBase,
      intoLevel: level >= 100 ? needed : intoLevel,
      needed: needed,
      progress: progress
    };
  }

  function promoStudioAvailable() {
    var snapshot = appState.liveSnapshot || appState.snapshot || {};
    var config = snapshot.config || {};
    return !!config.isMockMode;
  }

  function promoSceneCounts() {
    var roots = promoStudioState.roots || [];
    var boxed = promoBoxState.sessions || [];
    var subagents = 0;
    for (var i = 0; i < roots.length; i++) {
      subagents += Array.isArray(roots[i].subagents) ? roots[i].subagents.length : 0;
    }
    return {
      roots: roots.length,
      subagents: subagents,
      boxed: boxed.length
    };
  }

  function promoDisplayLabel(unit) {
    var label = unit && typeof unit.label === 'string' ? unit.label.trim() : '';
    return label || pokemonDisplayName(unit && unit.pokemonId ? unit.pokemonId : POKEDEX_MIN);
  }

  function promoLevelDetails(unit) {
    var level = promoClampInt(unit && unit.level, 1, 100, 1);
    var needed = level >= 100 ? 0 : expToNextLevel(level);
    var intoLevel = promoClampInt(unit && unit.exp, 0, level >= 100 ? 0 : needed, 0);
    var totalTokens = 0;
    for (var cursor = 1; cursor < level; cursor++) {
      totalTokens += expToNextLevel(cursor);
    }
    totalTokens += intoLevel;
    return {
      level: level,
      needed: needed,
      intoLevel: intoLevel,
      totalTokens: totalTokens,
      hp: promoClampInt(unit && unit.hp, 0, 100, 100)
    };
  }

  function promoSlug(value, fallback) {
    var text = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return text || fallback;
  }

  function promoRootProjectId(root, index) {
    var label = root && typeof root.label === 'string' && root.label.trim()
      ? root.label.trim()
      : 'pokemon-' + String(root && root.pokemonId ? root.pokemonId : (index + 1));
    return 'promo-' + promoSlug(label, 'team-' + (index + 1));
  }

  function resolvePromoRenderedPokemonId(unit, parentAgent) {
    var configuredPokemonId = promoClampInt(unit && unit.pokemonId, POKEDEX_MIN, POKEDEX_MAX, POKEDEX_MIN);
    if (!parentAgent) return configuredPokemonId;

    var parentConfiguredPokemonId = promoClampInt(
      parentAgent && parentAgent.promoConfiguredPokemonId,
      POKEDEX_MIN,
      POKEDEX_MAX,
      parentAgent && parentAgent.forcedPokemonId ? parentAgent.forcedPokemonId : configuredPokemonId
    );

    if (configuredPokemonId !== parentConfiguredPokemonId) {
      return configuredPokemonId;
    }

    var candidates = getEvolutionPath(configuredPokemonId);
    if (!candidates.length) {
      return configuredPokemonId;
    }
    return candidates[hashCode(String(unit && unit.id ? unit.id : configuredPokemonId)) % candidates.length];
  }

  function buildPromoAgentsForRoots(roots, now, options) {
    var agents = [];
    var settings = options || {};
    var baseTime = typeof settings.baseTime === 'number' ? settings.baseTime : now;
    var doneAt = typeof settings.doneAt === 'number' ? settings.doneAt : null;
    var rootIndexOffset = Number.isFinite(settings.rootIndexOffset) ? settings.rootIndexOffset : 0;

    function buildPromoAgent(unit, rootIndex, parentAgent, depth, siblingIndex) {
      var details = promoLevelDetails(unit);
      var isSleeping = unit.status === 'Sleeping';
      var displayName = unit && typeof unit.label === 'string' && unit.label.trim() ? unit.label.trim() : null;
      var configuredPokemonId = promoClampInt(unit && unit.pokemonId, POKEDEX_MIN, POKEDEX_MAX, POKEDEX_MIN);
      var renderedPokemonId = resolvePromoRenderedPokemonId(unit, parentAgent);
      var absoluteRootIndex = rootIndexOffset + rootIndex;
      var projectId = parentAgent ? parentAgent.projectId : promoRootProjectId(unit, absoluteRootIndex);
      var childUnits = Array.isArray(unit.subagents) ? unit.subagents : [];
      var createdOffset = absoluteRootIndex * 8000 + depth * 1800 + siblingIndex * 420;
      var agent = {
        agentId: unit.id,
        name: displayName || unit.id,
        displayName: displayName,
        subagentType: null,
        projectId: projectId,
        sessionId: settings.sessionId || 'promo-studio',
        parentId: parentAgent ? parentAgent.agentId : null,
        childrenIds: [],
        status: unit.status,
        activity: doneAt ? 'Boxed Promo Scene' : (isSleeping ? 'Sleeping' : 'Promo Scene'),
        lastTool: unit.status === 'Tool-Running' ? 'bash' : null,
        lastCommand: unit.status === 'Tool-Running'
          ? 'node cli.js mock'
          : (unit.status === 'Thinking'
            ? 'Plan the promo composition'
            : (unit.status === 'Outputting' ? 'Draft launch copy' : null)),
        lastSeen: doneAt || (baseTime - createdOffset),
        createdAt: baseTime - (createdOffset + 3200),
        doneAt: doneAt,
        isActive: doneAt ? false : !isSleeping,
        isSleeping: isSleeping,
        contextUsed: Math.round(DEFAULT_PROMO_CONTEXT_MAX * ((100 - details.hp) / 100)),
        contextMax: DEFAULT_PROMO_CONTEXT_MAX,
        selfTokens: details.totalTokens,
        totalTokens: details.totalTokens,
        lastUserQuery: parentAgent
          ? 'Support the main agent with a promo-friendly subtask.'
          : 'Compose a promotional scene with custom Pokemon agents.',
        counters: {
          seen: 1,
          toolStarts: unit.status === 'Tool-Running' ? 1 : 0,
          toolEnds: unit.status === 'Tool-Running' ? 1 : 0,
          outputs: unit.status === 'Outputting' ? 1 : 0,
          waits: unit.status === 'Waiting' ? 1 : 0,
          spawns: childUnits.length
        },
        promoConfiguredPokemonId: configuredPokemonId,
        forcedPokemonId: renderedPokemonId,
        isPromoCustom: true
      };

      agents.push(agent);

      for (var subIndex = 0; subIndex < childUnits.length; subIndex++) {
        var childUnit = childUnits[subIndex];
        agent.childrenIds.push(childUnit.id);
        buildPromoAgent(childUnit, rootIndex, agent, depth + 1, subIndex);
      }

      return agent;
    }

    var rootUnits = Array.isArray(roots) ? roots : [];
    for (var rootIndex = 0; rootIndex < rootUnits.length; rootIndex++) {
      buildPromoAgent(rootUnits[rootIndex], rootIndex, null, 0, rootIndex);
    }

    return agents;
  }

  function buildPromoAgents(now) {
    return buildPromoAgentsForRoots(promoStudioState.roots || [], now, { sessionId: 'promo-studio' });
  }

  function buildPromoBoxSnapshot(now) {
    var boxedAgents = [];
    var subagentHistory = [];
    var sessions = promoBoxState.sessions || [];

    for (var i = 0; i < sessions.length; i++) {
      var session = sessions[i];
      if (!session || !session.root) continue;
      var boxedAt = typeof session.boxedAt === 'number' ? session.boxedAt : now;
      var agents = buildPromoAgentsForRoots([session.root], boxedAt, {
        sessionId: session.id || 'promo-box',
        baseTime: boxedAt,
        doneAt: boxedAt,
        rootIndexOffset: i
      });
      if (!agents.length) continue;
      boxedAgents.push(agents[0]);
      for (var j = 1; j < agents.length; j++) {
        subagentHistory.push(agents[j]);
      }
    }

    boxedAgents.sort(function (a, b) {
      return (a.doneAt || 0) - (b.doneAt || 0);
    });
    subagentHistory.sort(function (a, b) {
      var doneDiff = (a.doneAt || 0) - (b.doneAt || 0);
      if (doneDiff) return doneDiff;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    return {
      boxedAgents: boxedAgents,
      subagentHistory: subagentHistory
    };
  }

  function buildPromoDiscoveryRecord(agent, agents, pokemonId, now) {
    var parentPromoAgent = null;
    if (agent.parentId) {
      for (var i = 0; i < agents.length; i++) {
        if (agents[i].agentId === agent.parentId) {
          parentPromoAgent = agents[i];
          break;
        }
      }
    }
    return {
      agentId: agent.agentId,
      agentName: agent.displayName || promoDisplayLabel({ pokemonId: pokemonId }),
      projectId: agent.projectId,
      sessionId: agent.sessionId,
      createdAt: agent.createdAt,
      discoveredAt: now,
      parentId: agent.parentId || null,
      parentName: parentPromoAgent ? agentLabel(parentPromoAgent) : null,
      viaSubagent: !!agent.parentId
    };
  }

  function promoPokedexSnapshotForAgents(agents, now) {
    var previous = normalizePromoPokedexState(promoPokedexState);
    var seenPokemonIds = new Set(previous.seenPokemonIds || []);
    var firstDiscoveryByPokemon = { ...(previous.firstDiscoveryByPokemon || {}) };
    var changed = false;

    for (var i = 0; i < agents.length; i++) {
      var promoAgent = agents[i];
      var pokemonId = Number(promoAgent.forcedPokemonId);
      if (!Number.isInteger(pokemonId)) continue;
      if (!seenPokemonIds.has(pokemonId)) {
        seenPokemonIds.add(pokemonId);
        changed = true;
      }
      if (!firstDiscoveryByPokemon[pokemonId]) {
        firstDiscoveryByPokemon[pokemonId] = buildPromoDiscoveryRecord(promoAgent, agents, pokemonId, now);
        changed = true;
      }
    }

    var snapshot = {
      seenPokemonIds: Array.from(seenPokemonIds).sort(function (a, b) { return a - b; }),
      firstDiscoveryByPokemon: firstDiscoveryByPokemon,
      discoveredCount: seenPokemonIds.size,
      totalCount: POKEDEX_TOTAL
    };

    if (
      changed ||
      previous.discoveredCount !== snapshot.discoveredCount ||
      (previous.totalCount || POKEDEX_TOTAL) !== snapshot.totalCount
    ) {
      promoPokedexState = snapshot;
      savePromoPokedexState();
    } else {
      promoPokedexState = previous;
      snapshot = previous;
    }

    return snapshot;
  }

  function buildPromoSnapshot(baseSnapshot) {
    var source = baseSnapshot || appState.liveSnapshot || appState.snapshot;
    var base = source || {
      config: { isMockMode: true, enablePokeapiSprites: true },
      pokedex: { seenPokemonIds: [], firstDiscoveryByPokemon: {}, totalCount: POKEDEX_TOTAL }
    };
    var now = Date.now();
    var agents = buildPromoAgents(now);
    var promoBoxSnapshot = buildPromoBoxSnapshot(now);
    var promoPokedex = promoPokedexSnapshotForAgents(agents, now);

    return {
      now: now,
      lastUpdate: now,
      activeTimeoutSec: base.activeTimeoutSec || 8,
      staleTimeoutSec: base.staleTimeoutSec || 120,
      activeAgentCount: agents.filter(function (agent) { return agent.isActive; }).length,
      pokedex: promoPokedex,
      agents: agents,
      recentEvents: [],
      boxedAgents: promoBoxSnapshot.boxedAgents,
      subagentHistory: promoBoxSnapshot.subagentHistory,
      config: {
        ...(base.config || {}),
        promoStudioActive: true
      }
    };
  }

  function applyDisplaySnapshot(snapshot) {
    var agents;
    var config = snapshot.config || {};
    appState.snapshot = snapshot;
    applyPositionCacheScope(config);
    if (hardResetBtnEl) {
      hardResetBtnEl.hidden = !(config.isMockMode && config.supportsHardReset);
    }
    renderPromoStudio(false);
    appState.agentById = new Map((snapshot.agents || []).map(function (agent) {
      return [agent.agentId, agent];
    }));
    reconcileEntities(snapshot.agents);
    updateFilterOptions();
    renderAgentList();
    renderBoxList();
    if (uiState.boxHistoryOpen) {
      renderBoxHistory();
    }
    if (uiState.subhistoryOpen) {
      renderSubhistoryModal();
    }
    renderPokedex();
    agents = filteredAgents();
    activeCountEl.textContent = String(snapshot.activeAgentCount || 0);
    lastUpdateEl.textContent = new Date(snapshot.lastUpdate || Date.now()).toLocaleTimeString();
    tokenTotalEl.textContent = formatTokenCount(filteredTokenTotal(agents));
  }

  function syncVisibleSnapshot() {
    var baseSnapshot = appState.liveSnapshot || appState.snapshot;
    if (!baseSnapshot) return;
    if (!promoStudioAvailable()) {
      applyDisplaySnapshot(baseSnapshot);
      return;
    }
    applyDisplaySnapshot(uiState.promoStudioEnabled ? buildPromoSnapshot(baseSnapshot) : baseSnapshot);
  }

  function promoPokemonOptionsHtml(selectedId) {
    var html = '';
    for (var pokemonId = POKEDEX_MIN; pokemonId <= POKEDEX_MAX; pokemonId++) {
      html += '<option value="' + pokemonId + '"' + (pokemonId === selectedId ? ' selected' : '') + '>';
      html += '#' + String(pokemonId).padStart(3, '0') + ' ' + escapeHtml(pokemonDisplayName(pokemonId));
      html += '</option>';
    }
    return html;
  }

  function promoStatusOptionsHtml(selectedStatus) {
    var html = '';
    for (var i = 0; i < PROMO_STATUSES.length; i++) {
      var status = PROMO_STATUSES[i];
      html += '<option value="' + escapeHtml(status) + '"' + (status === selectedStatus ? ' selected' : '') + '>' + escapeHtml(status) + '</option>';
    }
    return html;
  }

  function renderPromoSubagentCard(rootId, subagent, index) {
    var stats = promoLevelDetails(subagent);
    var expMax = stats.level >= 100 ? 0 : stats.needed;
    var subtitle = '#' + String(subagent.pokemonId).padStart(3, '0') + ' ' + escapeHtml(pokemonDisplayName(subagent.pokemonId));
    var html = '';
    html += '<article class="promo-scene-card subagent-card" data-root-id="' + escapeHtml(rootId) + '" data-sub-id="' + escapeHtml(subagent.id) + '">';
    html += '<div class="promo-scene-card-head">';
    html += '<div class="promo-scene-card-title-wrap">';
    html += '<h3 class="promo-scene-card-title">Sub-agent ' + (index + 1) + '</h3>';
    html += '<p class="promo-scene-card-subtitle">' + subtitle + '</p>';
    html += '</div>';
    html += '<button class="promo-scene-remove" type="button" data-action="remove-subagent" data-root-id="' + escapeHtml(rootId) + '" data-sub-id="' + escapeHtml(subagent.id) + '">Remove</button>';
    html += '</div>';
    html += '<div class="promo-scene-fields">';
    html += '<label class="promo-field-wide"><span class="promo-field-label">Name</span><input type="text" data-root-id="' + escapeHtml(rootId) + '" data-sub-id="' + escapeHtml(subagent.id) + '" data-field="label" value="' + escapeHtml(subagent.label || '') + '" maxlength="40" /></label>';
    html += '<label class="promo-field-wide"><span class="promo-field-label">Pokemon</span><select data-root-id="' + escapeHtml(rootId) + '" data-sub-id="' + escapeHtml(subagent.id) + '" data-field="pokemonId">' + promoPokemonOptionsHtml(subagent.pokemonId) + '</select></label>';
    html += '<label class="promo-field"><span class="promo-field-label">Level</span><input type="number" min="1" max="100" data-root-id="' + escapeHtml(rootId) + '" data-sub-id="' + escapeHtml(subagent.id) + '" data-field="level" value="' + stats.level + '" /></label>';
    html += '<label class="promo-field"><span class="promo-field-label">EXP</span><input type="number" min="0" max="' + expMax + '" data-root-id="' + escapeHtml(rootId) + '" data-sub-id="' + escapeHtml(subagent.id) + '" data-field="exp" value="' + stats.intoLevel + '" /><span class="promo-field-note">Token total updates automatically.</span></label>';
    html += '<label class="promo-field"><span class="promo-field-label">HP %</span><input type="number" min="0" max="100" data-root-id="' + escapeHtml(rootId) + '" data-sub-id="' + escapeHtml(subagent.id) + '" data-field="hp" value="' + stats.hp + '" /></label>';
    html += '<label class="promo-field"><span class="promo-field-label">Status</span><select data-root-id="' + escapeHtml(rootId) + '" data-sub-id="' + escapeHtml(subagent.id) + '" data-field="status">' + promoStatusOptionsHtml(subagent.status) + '</select></label>';
    html += '</div>';
    html += '<div class="promo-scene-stats">';
    html += '<span class="promo-scene-chip">TOK ' + formatTokenCount(stats.totalTokens) + '</span>';
    html += '<span class="promo-scene-chip">EXP ' + formatTokenCount(stats.intoLevel) + ' / ' + formatTokenCount(stats.needed) + '</span>';
    html += '<span class="promo-scene-chip">HP ' + stats.hp + '%</span>';
    html += '</div>';
    html += '</article>';
    return html;
  }

  function renderPromoRootCard(root, index) {
    var stats = promoLevelDetails(root);
    var subagents = Array.isArray(root.subagents) ? root.subagents : [];
    var expMax = stats.level >= 100 ? 0 : stats.needed;
    var html = '';
    html += '<article class="promo-scene-card" data-root-id="' + escapeHtml(root.id) + '">';
    html += '<div class="promo-scene-card-head">';
    html += '<div class="promo-scene-card-title-wrap">';
    html += '<h3 class="promo-scene-card-title">Root Agent ' + (index + 1) + '</h3>';
    html += '<p class="promo-scene-card-subtitle">#' + String(root.pokemonId).padStart(3, '0') + ' ' + escapeHtml(pokemonDisplayName(root.pokemonId)) + ' · ' + subagents.length + ' sub-agent' + (subagents.length === 1 ? '' : 's') + '</p>';
    html += '</div>';
    html += '<div class="promo-scene-card-actions">';
    html += '<button class="promo-scene-box" type="button" data-action="box-root" data-root-id="' + escapeHtml(root.id) + '">Box</button>';
    html += '<button class="promo-scene-remove" type="button" data-action="remove-root" data-root-id="' + escapeHtml(root.id) + '">Remove</button>';
    html += '</div>';
    html += '</div>';
    html += '<div class="promo-scene-fields">';
    html += '<label class="promo-field-wide"><span class="promo-field-label">Name</span><input type="text" data-root-id="' + escapeHtml(root.id) + '" data-field="label" value="' + escapeHtml(root.label || '') + '" maxlength="40" /></label>';
    html += '<label class="promo-field-wide"><span class="promo-field-label">Pokemon</span><select data-root-id="' + escapeHtml(root.id) + '" data-field="pokemonId">' + promoPokemonOptionsHtml(root.pokemonId) + '</select></label>';
    html += '<label class="promo-field"><span class="promo-field-label">Level</span><input type="number" min="1" max="100" data-root-id="' + escapeHtml(root.id) + '" data-field="level" value="' + stats.level + '" /></label>';
    html += '<label class="promo-field"><span class="promo-field-label">EXP</span><input type="number" min="0" max="' + expMax + '" data-root-id="' + escapeHtml(root.id) + '" data-field="exp" value="' + stats.intoLevel + '" /><span class="promo-field-note">EXP is converted into token totals.</span></label>';
    html += '<label class="promo-field"><span class="promo-field-label">HP %</span><input type="number" min="0" max="100" data-root-id="' + escapeHtml(root.id) + '" data-field="hp" value="' + stats.hp + '" /></label>';
    html += '<label class="promo-field"><span class="promo-field-label">Status</span><select data-root-id="' + escapeHtml(root.id) + '" data-field="status">' + promoStatusOptionsHtml(root.status) + '</select></label>';
    html += '</div>';
    html += '<div class="promo-scene-stats">';
    html += '<span class="promo-scene-chip">TOK ' + formatTokenCount(stats.totalTokens) + '</span>';
    html += '<span class="promo-scene-chip">EXP ' + formatTokenCount(stats.intoLevel) + ' / ' + formatTokenCount(stats.needed) + '</span>';
    html += '<span class="promo-scene-chip">HP ' + stats.hp + '%</span>';
    html += '</div>';
    html += '<section class="promo-scene-subagents">';
    html += '<div class="promo-scene-subagents-head">';
    html += '<div><h4 class="promo-scene-subagents-title">Sub-agents</h4><div class="promo-scene-subagents-count">' + subagents.length + ' configured</div></div>';
    html += '<button class="promo-studio-btn promo-scene-add-subagent" type="button" data-action="add-subagent" data-root-id="' + escapeHtml(root.id) + '">Add Sub-agent</button>';
    html += '</div>';
    html += '<div class="promo-scene-subagents-list">';
    for (var i = 0; i < subagents.length; i++) {
      html += renderPromoSubagentCard(root.id, subagents[i], i);
    }
    html += '</div>';
    html += '</section>';
    html += '</article>';
    return html;
  }

  function renderPromoStudio(rebuildList) {
    var shouldRebuildList = rebuildList !== false;
    if (!promoStudioToggleEl || !promoStudioPanelEl) return;
    var available = promoStudioAvailable();
    promoStudioToggleEl.hidden = !available;
    if (!available) {
      uiState.promoStudioOpen = false;
      promoStudioPanelEl.hidden = true;
      return;
    }
    promoStudioToggleEl.setAttribute('aria-pressed', String(uiState.promoStudioOpen));
    promoStudioPanelEl.hidden = !uiState.promoStudioOpen;
    promoStudioEnabledEl.checked = !!uiState.promoStudioEnabled;
    var counts = promoSceneCounts();
    promoStudioSummaryEl.textContent = counts.roots + ' root agent' + (counts.roots === 1 ? '' : 's') + ', ' + counts.subagents + ' sub-agent' + (counts.subagents === 1 ? '' : 's') + ', ' + counts.boxed + ' boxed.';
    if (!shouldRebuildList) {
      return;
    }
    if (!uiState.promoStudioOpen) {
      return;
    }
    if (!counts.roots) {
      promoStudioListEl.innerHTML = '<div class="promo-scene-empty">No custom agents yet. Add a root Pokemon to start composing a promo scene.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < promoStudioState.roots.length; i++) {
      html += renderPromoRootCard(promoStudioState.roots[i], i);
    }
    promoStudioListEl.innerHTML = html;
  }

  function syncPromoStudioState() {
    promoStudioState = normalizePromoStudioState(promoStudioState);
    promoBoxState = normalizePromoBoxState(promoBoxState);
    savePromoStudioState();
    savePromoBoxState();
    renderPromoStudio();
    syncVisibleSnapshot();
  }

  function findPromoRoot(rootId) {
    var roots = promoStudioState.roots || [];
    for (var i = 0; i < roots.length; i++) {
      if (roots[i].id === rootId) return roots[i];
    }
    return null;
  }

  function findPromoSubagent(root, subId) {
    if (!root || !Array.isArray(root.subagents)) return null;
    for (var i = 0; i < root.subagents.length; i++) {
      if (root.subagents[i].id === subId) return root.subagents[i];
    }
    return null;
  }

  function collectPromoUnitIds(unit, out) {
    if (!unit) return;
    out.push(unit.id);
    var subagents = Array.isArray(unit.subagents) ? unit.subagents : [];
    for (var i = 0; i < subagents.length; i++) {
      collectPromoUnitIds(subagents[i], out);
    }
  }

  function invalidateAgentPosition(agentId) {
    if (!agentId) return;
    delete positionCache[agentId];
    appState.entityById.delete(agentId);
    appState.roomAssignments.delete(agentId);
    animations.delete(agentId);
  }

  function invalidatePromoFamilyPositions(rootId) {
    var root = findPromoRoot(rootId);
    if (!root) return;
    invalidatePromoUnitTree(root);
  }

  function invalidatePromoUnitTree(root) {
    if (!root) return;
    var ids = [];
    collectPromoUnitIds(root, ids);
    for (var i = 0; i < ids.length; i++) {
      invalidateAgentPosition(ids[i]);
    }
    savePositionCache();
  }

  function findPromoBoxSession(agentId) {
    var sessions = promoBoxState.sessions || [];
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i] && sessions[i].root && sessions[i].root.id === agentId) {
        return { index: i, session: sessions[i] };
      }
    }
    return null;
  }

  function boxPromoRoot(rootId) {
    var root = findPromoRoot(rootId);
    if (!root) return false;
    invalidatePromoUnitTree(root);
    promoBoxState.sessions.push({
      id: createPromoId('promo-box'),
      boxedAt: Date.now(),
      root: normalizePromoUnit(root, true)
    });
    promoStudioState.roots = (promoStudioState.roots || []).filter(function (item) {
      return item.id !== rootId;
    });
    syncPromoStudioState();
    return true;
  }

  function unboxPromoRoot(agentId) {
    var match = findPromoBoxSession(agentId);
    if (!match) return false;
    promoBoxState.sessions.splice(match.index, 1);
    var root = normalizePromoUnit(match.session.root, true);
    invalidatePromoUnitTree(root);
    promoStudioState.roots.push(root);
    syncPromoStudioState();
    return true;
  }

  function updatePromoUnitField(rootId, subId, field, rawValue) {
    var targetRoot = findPromoRoot(rootId);
    var target = subId ? findPromoSubagent(targetRoot, subId) : targetRoot;
    if (!target) return;
    var shouldRespawnFamily = false;

    if (field === 'label') {
      target.label = String(rawValue || '').slice(0, 40);
    } else if (field === 'pokemonId') {
      target.pokemonId = promoClampInt(rawValue, POKEDEX_MIN, POKEDEX_MAX, target.pokemonId || POKEDEX_MIN);
      shouldRespawnFamily = !subId;
    } else if (field === 'level') {
      target.level = promoClampInt(rawValue, 1, 100, target.level || 1);
      target.exp = promoClampInt(target.exp, 0, target.level >= 100 ? 0 : expToNextLevel(target.level), 0);
    } else if (field === 'exp') {
      var currentLevel = promoClampInt(target.level, 1, 100, 1);
      target.exp = promoClampInt(rawValue, 0, currentLevel >= 100 ? 0 : expToNextLevel(currentLevel), target.exp || 0);
    } else if (field === 'hp') {
      target.hp = promoClampInt(rawValue, 0, 100, target.hp || 100);
    } else if (field === 'status') {
      target.status = PROMO_STATUSES.indexOf(rawValue) >= 0 ? rawValue : target.status;
    }
    if (shouldRespawnFamily) {
      invalidatePromoFamilyPositions(rootId);
    }
    syncPromoStudioState();
  }

  function rootAgentBadge(agent) {
    if (agent && agent.isPromoCustom) {
      return agent.displayName || pokemonDisplayName(getRenderPokemonId(agent));
    }
    if (agent && agent.displayName) {
      return stripProjectPrefix(agent.displayName);
    }
    return shortProjectName(agent && agent.projectId);
  }

  function renderAgentList() {
    var agents = filteredAgents();

    if (agents.length === 0) {
      agentListEl.innerHTML = '<div class="poke-slot" style="cursor:default;justify-content:center">No agents match current filter.</div>';
      return;
    }

    // Remember which cards are expanded
    var expandedIds = {};
    var existingCards = agentListEl.querySelectorAll('.poke-slot.expanded');
    for (var e = 0; e < existingCards.length; e++) {
      var eid = existingCards[e].getAttribute('data-agent-id');
      if (eid) expandedIds[eid] = true;
    }

    // Resolve room index for each agent — use entity if available, else derive from pokemon habitat
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      var entity = appState.entityById.get(a.agentId);
      if (entity) {
        a._roomIndex = entity.roomIndex;
      } else {
        // Derive from pokemon habitat even if entity hasn't been created yet
        var pid = getPokemonId(a.agentId);
        var hIdx = getPokemonAreaIndex(pid);
        a._roomIndex = hIdx >= 0 ? hIdx : 999;
      }
    }

    // Build tree, then sort roots by area index → createdAt
    var tree = buildAgentTree(agents);
    tree.roots.sort(function (a, b) {
      if (a._roomIndex !== b._roomIndex) return a._roomIndex - b._roomIndex;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    var collapsedIds = uiState.collapsedSubtrees || {};
    var html = '';
    var currentRoom = -1;
    var renderState = { count: 0 };
    for (var i = 0; i < tree.roots.length && renderState.count < 80; i++) {
      var agent = tree.roots[i];
      var roomIndex = agent._roomIndex;

      if (roomIndex !== currentRoom) {
        currentRoom = roomIndex;
        var roomLabel = AREAS[roomIndex] ? AREAS[roomIndex].label : 'Area ?';
        html += '<div class="room-header">' + escapeHtml(roomLabel) + '</div>';
      }

      html += '<section class="agent-family">';
      html += renderAgentBranch(agent, 0, tree, expandedIds, collapsedIds, renderState, true);
      html += '</section>';
    }

    for (var j = 0; j < agents.length; j++) {
      delete agents[j]._children;
      delete agents[j]._roomIndex;
    }

    agentListEl.innerHTML = html;
  }

  // Project badge tooltip (fixed-position to escape overflow:hidden parents)
  var projectTooltipEl = document.createElement('div');
  projectTooltipEl.className = 'project-tooltip';
  document.body.appendChild(projectTooltipEl);

  agentListEl.addEventListener('mouseover', function (e) {
    var badge = e.target.closest('.poke-project-badge');
    if (!badge) return;
    var text = badge.getAttribute('data-full');
    if (!text) return;
    projectTooltipEl.textContent = text;
    var rect = badge.getBoundingClientRect();
    projectTooltipEl.style.left = rect.left + 'px';
    projectTooltipEl.style.top = (rect.bottom + 4) + 'px';
    projectTooltipEl.classList.add('visible');
  });
  agentListEl.addEventListener('mouseout', function (e) {
    var badge = e.target.closest('.poke-project-badge');
    if (badge) {
      projectTooltipEl.classList.remove('visible');
    }
  });

  // Map tooltip for hovering sprites on the map
  var mapTooltipEl = document.createElement('div');
  mapTooltipEl.className = 'map-tooltip';
  document.body.appendChild(mapTooltipEl);
  mapTooltipEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="box"]');
    if (btn) {
      var agentId = btn.getAttribute('data-agent-id');
      fetch('/api/box/' + encodeURIComponent(agentId), { method: 'POST' });
      hideMapTooltip();
    }
  });

  function showMapTooltip(agent, anchorRect) {
    var isSleep = agent.isSleeping || !agent.isActive;
    var spriteUrl = pokemonSpriteUrl(agent, isSleep);
    var rawName = stripProjectPrefix(agent.displayName) || agent.subagentType || toShortId(agent.agentId);
    var name = rawName.length > 20 ? rawName.slice(0, 19) + '…' : rawName;
    var fullLabel = agentLabel(agent);
    var lastCommand = commandText(agent.lastCommand);
    var xp = agentLevelProgress(agent);
    var contextMax = agent.contextMax || 200000;
    var contextUsed = agent.contextUsed || 0;
    var contextRemaining = contextMax - contextUsed;
    var hpRatio = contextRemaining / contextMax;
    var barColor = hpBarColor(hpRatio);
    var barPct = Math.max(0, Math.min(100, hpRatio * 100));

    var html = '';
    html += '<div class="map-tooltip-title">' + escapeHtml(fullLabel) + '</div>';
    html += '<div class="map-tooltip-header">';
    html += '<img class="map-tooltip-sprite" src="' + escapeHtml(spriteUrl) + '" />';
    html += '<div class="map-tooltip-info">';
    html += '<span class="map-tooltip-name">' + escapeHtml(name) + '</span>';
    html += '<div class="map-tooltip-lv-row">';
    html += '<span class="map-tooltip-lv">LV.' + xp.level + '</span>';
    var projName = shortProjectName(agent.projectId);
    html += '<span class="map-tooltip-project">' + escapeHtml(projName) + '</span>';
    html += '</div>';
    html += '</div></div>';
    html += '<div class="map-tooltip-hp">';
    html += '<span class="poke-hp-label">HP</span>';
    html += '<div class="poke-hp-track"><div class="poke-hp-fill" style="width:' + barPct.toFixed(1) + '%;background:' + barColor + '"></div></div>';
    html += '<span class="map-tooltip-hp-nums">' + formatContextK(contextRemaining) + '/' + formatContextK(contextMax) + '</span>';
    html += '</div>';
    html += '<div class="map-tooltip-exp">';
    html += '<span class="poke-exp-label">EXP</span>';
    html += '<div class="poke-exp-track"><div class="poke-exp-fill" style="width:' + xp.progress.toFixed(1) + '%"></div></div>';
    html += '<span class="map-tooltip-exp-nums">' + formatTokenCount(xp.intoLevel) + '/' + formatTokenCount(xp.needed) + '</span>';
    html += '</div>';
    html += '<div class="map-tooltip-details">';
    html += '<div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">' + escapeHtml(agent.status) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Started</span><span class="detail-value">' + formatTime(agent.createdAt) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Last tool</span><span class="detail-value">' + escapeHtml(agent.lastTool || '-') + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Tools run</span><span class="detail-value">' + (agent.counters.toolStarts || 0) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Tokens</span><span class="detail-value">' + formatTokenCount(xp.totalTokens) + '</span></div>';
    var secsAgo = Math.max(0, Math.floor((Date.now() - agent.lastSeen) / 1000));
    html += '<div class="detail-row"><span class="detail-label">Last seen</span><span class="detail-value">' + secsAgo + 's ago</span></div>';
    html += '</div>';
    if (lastCommand) {
      html += '<div class="map-tooltip-command" title="' + escapeHtml(lastCommand) + '"><span class="map-tooltip-command-label">Last command</span><span class="map-tooltip-command-value">' + escapeHtml(lastCommand) + '</span></div>';
    }
    if (agent.lastUserQuery) {
      html += '<div class="map-tooltip-query">' + escapeHtml(agent.lastUserQuery) + '</div>';
    }
    html += '<button class="map-tooltip-box-btn" data-action="box" data-agent-id="' + escapeHtml(agent.agentId) + '">Box</button>';

    mapTooltipEl.innerHTML = html;
    mapTooltipEl.style.display = 'block';

    var tw = 220;
    var left = anchorRect.left + anchorRect.width / 2 - tw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    var th = mapTooltipEl.offsetHeight;
    var top = anchorRect.top - th - 6;
    if (top < 4) top = anchorRect.bottom + 6;
    mapTooltipEl.style.left = left + 'px';
    mapTooltipEl.style.top = top + 'px';
  }

  function hideMapTooltip() {
    mapTooltipEl.style.display = 'none';
  }

  // Shared fixed-position tooltip for box items
  var boxTooltipEl = document.createElement('div');
  boxTooltipEl.className = 'box-tooltip';
  document.body.appendChild(boxTooltipEl);

  var pokedexTooltipEl = document.createElement('div');
  pokedexTooltipEl.className = 'pokedex-tooltip';
  document.body.appendChild(pokedexTooltipEl);

  var subhistoryTooltipEl = document.createElement('div');
  subhistoryTooltipEl.className = 'subhistory-tooltip';
  document.body.appendChild(subhistoryTooltipEl);

  function showBoxTooltip(agent, anchorRect) {
    var spriteUrl = pokemonStaticIconUrl(agent);
    var name = agent.displayName || agent.subagentType || toShortId(agent.agentId);
    var lastCommand = commandText(agent.lastCommand);
    var xp = agentLevelProgress(agent);
    var contextMax = agent.contextMax || 200000;
    var contextUsed = agent.contextUsed || 0;
    var contextRemaining = contextMax - contextUsed;
    var hpRatio = contextRemaining / contextMax;
    var barColor = hpBarColor(hpRatio);
    var barPct = Math.max(0, Math.min(100, hpRatio * 100));
    var duration = formatDuration(agent.createdAt, agent.doneAt);

    var html = '';
    html += '<div class="box-tooltip-header">';
    html += '<img class="box-tooltip-sprite" src="' + escapeHtml(spriteUrl) + '" />';
    html += '<div class="box-tooltip-title">';
    html += '<span class="box-tooltip-name">' + escapeHtml(name) + '</span>';
    html += '<div class="map-tooltip-lv-row">';
    html += '<span class="box-tooltip-lv">LV.' + xp.level + '</span>';
    var projName = shortProjectName(agent.projectId);
    html += '<span class="map-tooltip-project">' + escapeHtml(projName) + '</span>';
    html += '</div>';
    html += '</div></div>';
    html += '<div class="box-tooltip-hp">';
    html += '<span class="poke-hp-label">HP</span>';
    html += '<div class="poke-hp-track"><div class="poke-hp-fill" style="width:' + barPct.toFixed(1) + '%;background:' + barColor + '"></div></div>';
    html += '<span class="box-tooltip-hp-nums">' + formatContextK(contextRemaining) + '/' + formatContextK(contextMax) + '</span>';
    html += '</div>';
    html += '<div class="box-tooltip-exp">';
    html += '<span class="poke-exp-label">EXP</span>';
    html += '<div class="poke-exp-track"><div class="poke-exp-fill" style="width:' + xp.progress.toFixed(1) + '%"></div></div>';
    html += '<span class="box-tooltip-exp-nums">' + formatTokenCount(xp.intoLevel) + '/' + formatTokenCount(xp.needed) + '</span>';
    html += '</div>';
    html += '<div class="box-tooltip-details">';
    html += '<div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">' + escapeHtml(toShortId(agent.agentId)) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Started</span><span class="detail-value">' + formatTime(agent.createdAt) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Ended</span><span class="detail-value">' + formatTime(agent.doneAt) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Duration</span><span class="detail-value">' + duration + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Tools run</span><span class="detail-value">' + (agent.counters.toolStarts || 0) + '</span></div>';
    html += '<div class="detail-row"><span class="detail-label">Tokens</span><span class="detail-value">' + formatTokenCount(xp.totalTokens) + '</span></div>';
    if (agent.subagentType) {
      html += '<div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">' + escapeHtml(agent.subagentType) + '</span></div>';
    }
    html += '</div>';
    if (lastCommand) {
      html += '<div class="box-tooltip-command" title="' + escapeHtml(lastCommand) + '"><span class="box-tooltip-command-label">Last command</span><span class="box-tooltip-command-value">' + escapeHtml(lastCommand) + '</span></div>';
    }

    boxTooltipEl.innerHTML = html;
    boxTooltipEl.style.display = 'block';

    // Position above the hovered sprite, clamped to viewport
    var tw = 210;
    var left = anchorRect.left + anchorRect.width / 2 - tw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    // Measure tooltip height after content is set
    var th = boxTooltipEl.offsetHeight;
    var top = anchorRect.top - th - 6;
    if (top < 4) top = anchorRect.bottom + 6; // flip below if no room above
    boxTooltipEl.style.left = left + 'px';
    boxTooltipEl.style.top = top + 'px';
  }

  function hideBoxTooltip() {
    boxTooltipEl.style.display = 'none';
  }

  function showPokedexTooltip(pokemonId, anchorRect) {
    var discovery = pokedexDiscoveryInfo(pokemonId);
    var rarity = discovery ? getPokemonRarity(pokemonId) : null;
    var name = pokemonDisplayName(pokemonId);
    var html = '';

    html += '<div class="pokedex-tooltip-head">';
    html += '<div class="pokedex-tooltip-head-main">';
    html += '<span class="pokedex-tooltip-number">#' + String(pokemonId).padStart(3, '0') + '</span>';
    html += '<div class="pokedex-tooltip-title-wrap">';
    html += '<div class="pokedex-tooltip-title">' + escapeHtml(name) + '</div>';
    html += '<div class="pokedex-tooltip-subtitle">First discovery record</div>';
    html += '</div>';
    html += '</div>';
    if (rarity) {
      html += '<span class="pokedex-rarity-badge tier-' + rarity.tier + '">' + escapeHtml(rarity.label) + '</span>';
    }
    html += '</div>';

    if (discovery) {
      html += '<div class="pokedex-tooltip-details">';
      if (discovery.viaSubagent) {
        html += '<div class="pokedex-tooltip-item">';
        html += '<span class="pokedex-tooltip-label">Origin</span>';
        html += '<span class="pokedex-tooltip-value">' + escapeHtml((discovery.parentName || discovery.parentId || 'Unknown') + ' sub-agent') + '</span>';
        html += '</div>';
      }
      html += '<div class="pokedex-tooltip-item">';
      html += '<span class="pokedex-tooltip-label">Name</span>';
      html += '<span class="pokedex-tooltip-value">' + escapeHtml(discovery.agentName || discovery.agentId || '-') + '</span>';
      html += '</div>';
      html += '<div class="pokedex-tooltip-item">';
      html += '<span class="pokedex-tooltip-label">Created</span>';
      html += '<span class="pokedex-tooltip-value">' + escapeHtml(formatTime(discovery.createdAt)) + '</span>';
      html += '</div>';
      html += '<div class="pokedex-tooltip-item">';
      html += '<span class="pokedex-tooltip-label">Project</span>';
      html += '<span class="pokedex-tooltip-value">' + escapeHtml(discovery.projectId || '-') + '</span>';
      html += '</div>';
      html += '<div class="pokedex-tooltip-item">';
      html += '<span class="pokedex-tooltip-label">Session</span>';
      html += '<span class="pokedex-tooltip-value">' + escapeHtml(discovery.sessionId || '-') + '</span>';
      html += '</div>';
      html += '</div>';
    } else {
      html += '<div class="pokedex-tooltip-empty">Not discovered yet.</div>';
    }

    pokedexTooltipEl.innerHTML = html;
    pokedexTooltipEl.style.display = 'block';

    var tw = 240;
    var left = anchorRect.left + anchorRect.width / 2 - tw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    var th = pokedexTooltipEl.offsetHeight;
    var top = anchorRect.top - th - 8;
    if (top < 4) top = anchorRect.bottom + 8;
    pokedexTooltipEl.style.left = left + 'px';
    pokedexTooltipEl.style.top = top + 'px';
  }

  function hidePokedexTooltip() {
    pokedexTooltipEl.style.display = 'none';
  }

  function showSubhistoryTooltip(agent, anchorRect) {
    if (!agent) return;
    var label = agent.displayName || agent.subagentType || toShortId(agent.agentId);
    var lastCommand = commandText(agent.lastCommand);
    var endTs = agent.isLive ? (agent.lastSeen || Date.now()) : agent.doneAt;
    var duration = formatDuration(agent.createdAt, endTs);
    var html = '';
    html += '<div class="subhistory-tooltip-head">';
    html += '<div class="subhistory-tooltip-title">' + escapeHtml(label) + '</div>';
    html += '<div class="subhistory-tooltip-subtitle">' + escapeHtml(agent.subagentType || 'Sub-agent') + (agent.isLive ? ' • Live' : ' • Finished') + '</div>';
    html += '</div>';
    html += '<div class="subhistory-tooltip-details">';
    html += '<div class="subhistory-tooltip-item"><span class="subhistory-tooltip-label">Tokens</span><span class="subhistory-tooltip-value">' + formatTokenCount(agent.totalTokens || 0) + '</span></div>';
    html += '<div class="subhistory-tooltip-item"><span class="subhistory-tooltip-label">Tools</span><span class="subhistory-tooltip-value">' + (agent.counters.toolStarts || 0) + '</span></div>';
    html += '<div class="subhistory-tooltip-item"><span class="subhistory-tooltip-label">Started</span><span class="subhistory-tooltip-value">' + escapeHtml(formatTime(agent.createdAt)) + '</span></div>';
    html += '<div class="subhistory-tooltip-item"><span class="subhistory-tooltip-label">' + (agent.isLive ? 'Last seen' : 'Ended') + '</span><span class="subhistory-tooltip-value">' + escapeHtml(formatTime(endTs)) + '</span></div>';
    html += '<div class="subhistory-tooltip-item"><span class="subhistory-tooltip-label">Duration</span><span class="subhistory-tooltip-value">' + escapeHtml(duration) + '</span></div>';
    html += '<div class="subhistory-tooltip-item"><span class="subhistory-tooltip-label">Project</span><span class="subhistory-tooltip-value">' + escapeHtml(agent.projectId || '-') + '</span></div>';
    html += '<div class="subhistory-tooltip-item"><span class="subhistory-tooltip-label">Session</span><span class="subhistory-tooltip-value">' + escapeHtml(agent.sessionId || '-') + '</span></div>';
    html += '</div>';
    if (lastCommand) {
      html += '<div class="subhistory-tooltip-command" title="' + escapeHtml(lastCommand) + '"><span class="subhistory-tooltip-command-label">Last command</span><span class="subhistory-tooltip-command-value">' + escapeHtml(lastCommand) + '</span></div>';
    }
    if (agent.lastUserQuery) {
      html += '<div class="subhistory-tooltip-query">' + escapeHtml(agent.lastUserQuery) + '</div>';
    }

    subhistoryTooltipEl.innerHTML = html;
    subhistoryTooltipEl.style.display = 'block';
    var tw = 280;
    var left = anchorRect.left + anchorRect.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    var th = subhistoryTooltipEl.offsetHeight;
    var top = anchorRect.top - th - 10;
    if (top < 8) top = anchorRect.bottom + 10;
    subhistoryTooltipEl.style.left = left + 'px';
    subhistoryTooltipEl.style.top = top + 'px';
  }

  function hideSubhistoryTooltip() {
    subhistoryTooltipEl.style.display = 'none';
  }

  function renderBoxItems(boxed, options) {
    var compact = !!(options && options.compact);
    var withDetails = !!(options && options.withDetails);
    var emptyMessage = (options && options.emptyMessage) || '';
    var html = '';
    for (var i = boxed.length - 1; i >= 0; i--) {
      var agent = boxed[i];
      var spriteUrl = pokemonStaticIconUrl(agent);
      var label = agent.displayName || agent.subagentType || shortProjectName(agent.projectId);
      var duration = formatDuration(agent.createdAt, agent.doneAt);
      var lastCommand = commandText(agent.lastCommand);

      var manualClass = agent.manuallyBoxed ? ' manually-boxed' : '';
      html += '<div class="box-item' + (compact ? ' compact' : ' detailed') + manualClass + '" data-box-index="' + i + '">';
      html += '<img class="box-sprite" src="' + escapeHtml(spriteUrl) + '" />';
      if (!compact) {
        var subhistoryCount = subhistoryFamilyCount(agent.agentId);
        html += '<div class="box-item-info">';
        html += '<div class="box-item-row">';
        html += '<div class="box-item-title">';
        html += '<div class="box-item-name-row">';
        html += '<span class="box-item-name" title="' + escapeHtml(agentLabel(agent)) + '">' + escapeHtml(label) + '</span>';
        if (agent.manuallyBoxed) {
          html += '<span class="box-item-manual-badge" title="Manually boxed — unboxes on next query">HOLD</span>';
        }
        html += '</div>';
        html += '</div>';
        html += '</div>';
        html += renderHistoryStats(agent, 'box-item-stats');
        html += '<div class="box-item-meta">' + escapeHtml(agent.sessionId || '-') + '</div>';
        html += '<div class="box-item-meta">Ended ' + escapeHtml(formatTime(agent.doneAt)) + '</div>';
        html += '<div class="box-item-meta">Duration ' + escapeHtml(duration) + '</div>';
        if (lastCommand) {
          html += '<div class="box-item-command" title="' + escapeHtml(lastCommand) + '"><span class="box-item-command-label">CMD</span><span class="box-item-command-value">' + escapeHtml(summarizeCommand(lastCommand, 56)) + '</span></div>';
        }
        if (withDetails) {
          html += '<div class="box-item-actions">';
          if (subhistoryCount > 0) {
            html += '<button class="box-detail-btn" data-action="open-subhistory" data-agent-id="' + escapeHtml(agent.agentId) + '">';
            html += 'Sub-history (' + subhistoryCount + ')';
            html += '</button>';
          } else {
            html += '<span class="box-item-action-spacer" aria-hidden="true"></span>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      html += '<button class="unbox-btn" data-action="unbox" data-agent-id="' + escapeHtml(agent.agentId) + '" title="Unbox">&#x2191;</button>';
      html += '</div>';
    }

    if (!html && emptyMessage) {
      html = '<div class="box-empty">' + escapeHtml(emptyMessage) + '</div>';
    }
    return html;
  }

  function renderBoxList() {
    var boxed = appState.snapshot.boxedAgents || [];
    boxCountEl.textContent = String(boxed.length);
    boxListEl.innerHTML = renderBoxItems(boxed.slice(-60), {
      compact: true,
      emptyMessage: 'No boxed sessions yet.'
    });
  }

  function setBoxHistoryOpen(isOpen) {
    uiState.boxHistoryOpen = !!isOpen;
    boxHistoryModalEl.hidden = !uiState.boxHistoryOpen;
    if (uiState.boxHistoryOpen) {
      renderBoxHistory();
    } else {
      boxHistorySummaryEl.textContent = '';
      boxHistoryGridEl.innerHTML = '';
    }
    if (!uiState.boxHistoryOpen) {
      hideBoxTooltip();
    }
  }

  function renderBoxHistory() {
    if (!uiState.boxHistoryOpen) return;
    var boxed = appState.snapshot.boxedAgents || [];
    boxHistorySummaryEl.textContent = boxed.length + ' boxed sessions';
    boxHistoryGridEl.innerHTML = renderBoxItems(boxed, {
      compact: false,
      withDetails: true,
      emptyMessage: 'No boxed session history yet.'
    });
  }

  function setPokedexOpen(isOpen) {
    uiState.pokedexOpen = !!isOpen;
    pokedexModalEl.hidden = !uiState.pokedexOpen;
    if (!uiState.pokedexOpen) {
      hidePokedexTooltip();
    }
  }

  function renderPokedex() {
    var pokedex = appState.snapshot.pokedex || {};
    var seenIds = Array.isArray(pokedex.seenPokemonIds) ? pokedex.seenPokemonIds : [];
    var seenLookup = {};
    for (var i = 0; i < seenIds.length; i++) {
      seenLookup[seenIds[i]] = true;
    }

    var discovered = typeof pokedex.discoveredCount === 'number' ? pokedex.discoveredCount : seenIds.length;
    var total = typeof pokedex.totalCount === 'number' ? pokedex.totalCount : POKEDEX_TOTAL;
    pokedexProgressEl.textContent = discovered + ' / ' + total;
    pokedexSummaryEl.textContent = discovered + ' / ' + total + ' discovered';

    var html = '';
    var scrollTop = pokedexGridEl.scrollTop;
    var activePokemonId = null;
    var activeCell = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest('.pokedex-cell[data-pokemon-id]')
      : null;
    if (activeCell) {
      activePokemonId = parseInt(activeCell.getAttribute('data-pokemon-id'), 10) || null;
    }
    for (var pokemonId = POKEDEX_MIN; pokemonId <= POKEDEX_MAX; pokemonId++) {
      var seen = !!seenLookup[pokemonId];
      html += '<div class="pokedex-cell' + (seen ? ' seen' : '') + '" data-pokemon-id="' + pokemonId + '" tabindex="0">';
      html += '<div class="pokedex-meta">';
      html += '<span class="pokedex-number">#' + String(pokemonId).padStart(3, '0') + '</span>';
      html += '<span class="pokedex-name">' + escapeHtml(pokemonDisplayName(pokemonId)) + '</span>';
      html += '</div>';
      html += '<div class="pokedex-media">';
      if (seen) {
        html += '<img class="pokedex-icon" src="/sprites/animated/' + pokemonId + '.gif" alt="' + escapeHtml(pokemonDisplayName(pokemonId)) + '" loading="lazy" />';
      } else {
        html += '<span class="pokedex-unknown">?</span>';
      }
      html += '</div>';
      html += '</div>';
    }
    pokedexGridEl.innerHTML = html;
    pokedexGridEl.scrollTop = scrollTop;
    if (activePokemonId) {
      var nextActiveCell = pokedexGridEl.querySelector('.pokedex-cell[data-pokemon-id="' + activePokemonId + '"]');
      if (nextActiveCell) {
        nextActiveCell.focus({ preventScroll: true });
      }
    }
    syncPokedexLanguageTabs();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function applySnapshot(snapshot) {
    appState.liveSnapshot = snapshot;
    syncVisibleSnapshot();
  }

  function updateEntityMotion(now) {
    const agents = filteredAgents();

    for (const agent of agents) {
      const entity = ensureEntity(agent);
      if (!entity) continue;
      entity.x = entity.baseX;
      entity.y = entity.baseY;
    }
  }

  // ── Load pre-rendered terrain PNG ──
  var terrainImage = null;
  (function loadTerrainImage() {
    var img = new Image();
    img.onload = function () { terrainImage = img; };
    img.src = '/data/island_map_cc.png';
  })();

  function drawBackground() {
    const { scale, offsetX, offsetY } = getTransform();
    worldCtx.clearRect(0, 0, worldCanvas.width, worldCanvas.height);
    worldCtx.fillStyle = '#1858A0';
    worldCtx.fillRect(0, 0, worldCanvas.width, worldCanvas.height);
    worldCtx.save();
    worldCtx.translate(offsetX, offsetY);
    worldCtx.scale(scale, scale);
    worldCtx.imageSmoothingEnabled = false;
    if (terrainImage) worldCtx.drawImage(terrainImage, 0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    worldCtx.restore();
  }

  
  function drawConnections(agents) {
    // Disabled: no longer drawing parent-child connection lines
  }

  function agentDrawSize(agent) {
    return agent.parentId ? SUBAGENT_DRAW_SIZE : DRAW_SIZE;
  }

  function animationBallSize(drawSize) {
    return Math.max(18, drawSize * 0.42);
  }

  function drawAgents(agents, now) {
    var usePokeSprites = appState.snapshot.config && appState.snapshot.config.enablePokeapiSprites;
    if (usePokeSprites) return;

    const { scale, offsetX, offsetY } = getTransform();

    const drawRows = agents
      .map(function (agent) { return { agent: agent, entity: appState.entityById.get(agent.agentId) }; })
      .filter(function (row) { return !!row.entity && !row.agent.parentId; })
      .sort(function (a, b) { return a.entity.y - b.entity.y; });

    const provider = spriteProvider();

    worldCtx.save();
    worldCtx.translate(offsetX, offsetY);
    worldCtx.scale(scale, scale);
    worldCtx.imageSmoothingEnabled = false;

    for (const row of drawRows) {
      const agent = row.agent;
      const entity = row.entity;
      // Skip if spawn animation hasn't reached the materialization phase yet
      var anim = animations.get(agent.agentId);
      if (anim && anim.type === 'spawn') {
        var animElapsed = now - anim.startTime;
        if (animElapsed < BALL_SHAKE_MS + BALL_OPEN_MS) continue; // still in ball phase
        if (animElapsed < SPAWN_DURATION_MS) continue; // handled by drawAnimations
      }
      if (anim && anim.type === 'despawn') continue; // handled by drawAnimations

      const frame = (agent.status === 'Sleeping' || agent.isSleeping)
        ? 0
        : Math.floor(now / 200 + hashCode(agent.agentId)) % 3;
      const sprite = provider.getSprite(agent, frame, agent.status);

      worldCtx.drawImage(sprite, Math.round(entity.x), Math.round(entity.y), DRAW_SIZE, DRAW_SIZE);
    }

    worldCtx.restore();
  }

  function drawAnimations(agents, now) {
    const { scale, offsetX, offsetY } = getTransform();
    var finished = [];

    worldCtx.save();
    worldCtx.translate(offsetX, offsetY);
    worldCtx.scale(scale, scale);
    worldCtx.imageSmoothingEnabled = false;

    for (var [id, anim] of animations) {
      var elapsed = now - anim.startTime;
      var cx = Math.round(anim.x);
      var cy = Math.round(anim.y);
      var animAgent = getAgentById(id) || anim.agent || null;
      var drawSize = animAgent ? agentDrawSize(animAgent) : DRAW_SIZE;
      var centerX = cx + drawSize / 2;
      var centerY = cy + drawSize / 2;

      if (anim.type === 'spawn') {
        // Phase 1: ball falls in + shakes (0 ~ BALL_SHAKE_MS)
        // Phase 2: ball opens + white flash (BALL_SHAKE_MS ~ BALL_SHAKE_MS + BALL_OPEN_MS)
        // Phase 3: monster materializes (BALL_SHAKE_MS + BALL_OPEN_MS ~ SPAWN_DURATION_MS)
        if (elapsed >= SPAWN_DURATION_MS) {
          finished.push(id);
          continue;
        }

        if (elapsed < BALL_SHAKE_MS) {
          // Ball drops in and shakes
          var dropT = Math.min(1, elapsed / 150);
          var dropY = cy + (1 - dropT) * -15;
          var shakeX = 0;
          if (elapsed > 100) {
            var shakeT = (elapsed - 100) / (BALL_SHAKE_MS - 100);
            shakeX = Math.sin(shakeT * Math.PI * 4) * 2 * (1 - shakeT);
          }
          var ballSize = animationBallSize(drawSize);
          var bx = cx + (drawSize - ballSize) / 2 + shakeX;
          var by = dropY + (drawSize - ballSize) / 2;
          worldCtx.drawImage(pokeballSprite, bx, by, ballSize, ballSize);
        } else if (elapsed < BALL_SHAKE_MS + BALL_OPEN_MS) {
          // Ball opens with flash
          var openT = (elapsed - BALL_SHAKE_MS) / BALL_OPEN_MS;
          var ballSize = animationBallSize(drawSize);

          // Draw open ball (shrinking)
          var shrink = 1 - openT * 0.6;
          var sbs = ballSize * shrink;
          var sbx = cx + (drawSize - sbs) / 2;
          var sby = cy + drawSize - sbs;
          worldCtx.globalAlpha = 1 - openT;
          worldCtx.drawImage(pokeballOpenSprite, sbx, sby, sbs, sbs);
          worldCtx.globalAlpha = 1;

          // White flash circle expanding
          var flashRadius = drawSize * 0.22 + openT * drawSize * 0.28;
          var flashAlpha = 0.8 * (1 - openT);
          worldCtx.beginPath();
          worldCtx.arc(centerX, centerY, flashRadius, 0, Math.PI * 2);
          worldCtx.fillStyle = 'rgba(255,255,255,' + flashAlpha + ')';
          worldCtx.fill();
        } else {
          // Phase 3: sparkle effect only (actual sprite appears via normal render path after animation ends)
          var appearT = (elapsed - BALL_SHAKE_MS - BALL_OPEN_MS) / APPEAR_MS;

          // Fading white glow where monster will appear
          var glowAlpha = 0.5 * (1 - appearT);
          if (glowAlpha > 0) {
            var glowRadius = drawSize * 0.24 * (1 - appearT * 0.45);
            worldCtx.beginPath();
            worldCtx.arc(centerX, centerY, glowRadius, 0, Math.PI * 2);
            worldCtx.fillStyle = 'rgba(255,255,255,' + glowAlpha + ')';
            worldCtx.fill();
          }

          // Sparkle particles
          if (appearT < 0.8) {
            var sparkles = 4;
            for (var s = 0; s < sparkles; s++) {
              var sa = (s / sparkles) * Math.PI * 2 + now * 0.008;
              var sr = drawSize * 0.26 * (1 - appearT);
              var spx = centerX + Math.cos(sa) * sr;
              var spy = centerY + Math.sin(sa) * sr;
              worldCtx.fillStyle = 'rgba(255,255,220,' + (0.9 - appearT) + ')';
              worldCtx.fillRect(spx - 0.5, spy - 0.5, 1, 1);
            }
          }
        }
      } else if (anim.type === 'despawn') {
        // Phase 1: monster shrinks + red tint (0 ~ DESPAWN_DURATION_MS * 0.4)
        // Phase 2: red beam into ball (DESPAWN_DURATION_MS * 0.4 ~ 0.7)
        // Phase 3: ball shrinks away (DESPAWN_DURATION_MS * 0.7 ~ 1.0)
        if (elapsed >= DESPAWN_DURATION_MS) {
          finished.push(id);
          appState.roomAssignments.delete(id);
          continue;
        }

        var t = elapsed / DESPAWN_DURATION_MS;

        if (t < 0.4) {
          // Red silhouette shrinks (no actual sprite drawn)
          var shrinkT = t / 0.4;
          var scaleDown = 1 - shrinkT * 0.7;
          var silSize = drawSize * scaleDown;
          var silX = cx + (drawSize - silSize) / 2;
          var silY = cy + (drawSize - silSize);
          // Shrinking red glow blob
          worldCtx.globalAlpha = 1 - shrinkT * 0.3;
          var grad = worldCtx.createRadialGradient(
            centerX, centerY, silSize * 0.1,
            centerX, centerY, silSize * 0.6
          );
          grad.addColorStop(0, 'rgba(255,80,80,0.8)');
          grad.addColorStop(1, 'rgba(255,50,50,0)');
          worldCtx.fillStyle = grad;
          worldCtx.fillRect(silX, silY, silSize, silSize);
          worldCtx.globalAlpha = 1;
        } else if (t < 0.7) {
          // Red beam converges into ball center
          var beamT = (t - 0.4) / 0.3;
          var bcx = centerX;
          var bcy = centerY;
          // Converging beam lines
          for (var b = 0; b < 6; b++) {
            var ba = (b / 6) * Math.PI * 2;
            var bRadius = drawSize * 0.6 * (1 - beamT);
            var bsx = bcx + Math.cos(ba) * bRadius;
            var bsy = bcy + Math.sin(ba) * bRadius;
            worldCtx.strokeStyle = 'rgba(255,80,80,' + (0.8 - beamT * 0.5) + ')';
            worldCtx.lineWidth = 1.5 / scale;
            worldCtx.beginPath();
            worldCtx.moveTo(bsx, bsy);
            worldCtx.lineTo(bcx, bcy);
            worldCtx.stroke();
          }
          // Ball appears at center
          var ballSize = animationBallSize(drawSize) * beamT;
          worldCtx.drawImage(pokeballSprite, bcx - ballSize / 2, bcy - ballSize / 2, ballSize, ballSize);
        } else {
          // Ball shrinks and fades
          var fadeT = (t - 0.7) / 0.3;
          var ballSize = animationBallSize(drawSize) * (1 - fadeT * 0.8);
          var bcx = centerX;
          var bcy = centerY;
          worldCtx.globalAlpha = 1 - fadeT;
          worldCtx.drawImage(pokeballSprite, bcx - ballSize / 2, bcy - ballSize / 2, ballSize, ballSize);
          worldCtx.globalAlpha = 1;
        }
      }
    }

    worldCtx.restore();

    for (var f = 0; f < finished.length; f++) {
      animations.delete(finished[f]);
    }
  }

  function renderOverlay(agents, now) {
    const { scale, offsetX, offsetY } = getTransform();
    const dpr = window.devicePixelRatio || 1;
    var usePokeSprites = appState.snapshot.config && appState.snapshot.config.enablePokeapiSprites;

    var html = '';
    var zzzHtml = '';

    for (var i = 0; i < agents.length; i++) {
      var agent = agents[i];
      var entity = appState.entityById.get(agent.agentId);
      if (!entity) continue;

      // Hide labels while spawn animation is playing
      var anim = animations.get(agent.agentId);
      if (anim && anim.type === 'spawn' && (performance.now() - anim.startTime) < SPAWN_DURATION_MS) continue;

      // Convert device-pixel coords to CSS pixel coords for HTML overlay
      var sx = (offsetX + Math.round(entity.x) * scale) / dpr;
      var sy = (offsetY + Math.round(entity.y) * scale) / dpr;
      var drawSizeCss = agentDrawSize(agent) * scale / dpr;

      var isSleep = agent.isSleeping || !agent.isActive;
      var isSubagent = !!agent.parentId;
      var sleepScale = isSleep ? agentSleepSpriteScale(agent) : 1;
      var sleepScaleStyle = isSleep ? ';--sleep-sprite-scale:' + sleepScale.toFixed(3) : '';

      // Subagents always use the compact icon sprite treatment.
      if (isSubagent) {
        var subagentSpriteUrl = isSleep ? pokemonStaticIconUrl(agent) : pokemonIconUrl(agent);
        var subagentSleepClass = isSleep ? ' agent-sprite-sleeping' : '';
        html += '<span class="agent-sprite agent-sprite-subagent' + subagentSleepClass + '" data-agent-id="' + escapeHtml(agent.agentId) + '" style="left:' + sx + 'px;top:' + sy + 'px;width:' + drawSizeCss + 'px;height:' + drawSizeCss + 'px' + sleepScaleStyle + '">';
        html += '<img class="agent-sprite-image" src="' + escapeHtml(subagentSpriteUrl) + '" />';
        html += '</span>';
      } else if (usePokeSprites) {
        var spriteUrl = pokeProvider.getSpriteUrl(agent, isSleep);
        if (spriteUrl) {
          var sleepClass = isSleep ? ' agent-sprite-sleeping' : '';
          html += '<span class="agent-sprite' + sleepClass + '" data-agent-id="' + escapeHtml(agent.agentId) + '" style="left:' + sx + 'px;top:' + sy + 'px;width:' + drawSizeCss + 'px;height:' + drawSizeCss + 'px' + sleepScaleStyle + '">';
          html += '<img class="agent-sprite-image" src="' + escapeHtml(spriteUrl) + '" />';
          html += '</span>';
        }
      } else {
        // Invisible hit area for canvas-rendered sprites
        html += '<span class="agent-sprite" data-agent-id="' + escapeHtml(agent.agentId) + '" style="left:' + sx + 'px;top:' + sy + 'px;width:' + drawSizeCss + 'px;height:' + drawSizeCss + 'px"></span>';
      }

      if (!isSubagent) {
        var badgeRaw = rootAgentBadge(agent);
        var badge = badgeRaw.length > 20 ? badgeRaw.slice(0, 19) + '…' : badgeRaw;
        var labelX = sx + drawSizeCss * 0.5;
        var labelY = sy - 2;
        html += '<span class="agent-label" style="left:' + labelX + 'px;top:' + labelY + 'px" title="' + escapeHtml(badgeRaw) + '">' + escapeHtml(badge) + '</span>';
      }

      if (isSleep) {
        // Collect zzz bubbles separately so they render on top of everything
        var zzzClass = isSubagent ? ' agent-zzz-bubble-subagent' : '';
        var zzzPhase = now / 1100 + (Math.abs(hashCode(agent.agentId)) % 628) / 100;
        var zzzOffsetX = Math.sin(zzzPhase) * 2.6;
        var zzzOffsetY = Math.cos(zzzPhase * 0.82) * 1.8;
        zzzHtml += '<span class="agent-zzz-bubble' + zzzClass + '" style="left:' + (sx + drawSizeCss * 0.68 + zzzOffsetX) + 'px;top:' + (sy + drawSizeCss * 0.1 + zzzOffsetY) + 'px">zzz<span class="agent-zzz-tail"><span class="agent-zzz-dot agent-zzz-dot-1"></span><span class="agent-zzz-dot agent-zzz-dot-2"></span><span class="agent-zzz-dot agent-zzz-dot-3"></span></span></span>';
      }
    }

    // zzz bubbles appended last so they sit on top of all sprites/labels
    overlayEl.innerHTML = html + zzzHtml;
    clampOverlayDecorations();
  }

  function clampOverlayDecorations() {
    var overlayRect = overlayEl.getBoundingClientRect();
    if (!overlayRect.width || !overlayRect.height) return;

    var nodes = overlayEl.querySelectorAll('.agent-label, .agent-zzz-bubble');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      var dx = 0;
      var dy = 0;

      if (rect.left < overlayRect.left + OVERLAY_EDGE_PAD) {
        dx = (overlayRect.left + OVERLAY_EDGE_PAD) - rect.left;
      } else if (rect.right > overlayRect.right - OVERLAY_EDGE_PAD) {
        dx = (overlayRect.right - OVERLAY_EDGE_PAD) - rect.right;
      }

      if (rect.top < overlayRect.top + OVERLAY_EDGE_PAD) {
        dy = (overlayRect.top + OVERLAY_EDGE_PAD) - rect.top;
      } else if (rect.bottom > overlayRect.bottom - OVERLAY_EDGE_PAD) {
        dy = (overlayRect.bottom - OVERLAY_EDGE_PAD) - rect.bottom;
      }

      if (!dx && !dy) continue;

      var left = parseFloat(el.style.left) || 0;
      var top = parseFloat(el.style.top) || 0;
      el.style.left = (left + dx) + 'px';
      el.style.top = (top + dy) + 'px';
    }
  }

  function loadExportImage(url) {
    if (!url) return Promise.resolve(null);
    if (exportImageCache.has(url)) {
      return exportImageCache.get(url);
    }
    var promise = new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
    exportImageCache.set(url, promise);
    return promise;
  }

  function drawExportBadge(ctx, centerX, topY, label) {
    var raw = String(label || 'Agent');
    var text = raw.length > 20 ? raw.slice(0, 19) + '…' : raw;
    ctx.save();
    ctx.font = 'bold 11px Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var width = Math.max(44, Math.ceil(ctx.measureText(text).width + 16));
    var height = 18;
    var x = centerX - width / 2;
    var y = topY - height;
    ctx.fillStyle = 'rgba(18, 31, 39, 0.88)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, centerX, y + height / 2 + 0.5);
    ctx.restore();
  }

  function drawExportSleepMarker(ctx, x, y) {
    ctx.save();
    ctx.font = 'bold 12px Trebuchet MS, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(26, 40, 52, 0.6)';
    ctx.lineWidth = 3;
    ctx.strokeText('zzz', x, y);
    ctx.fillText('zzz', x, y);
    ctx.restore();
  }

  async function drawExportOverlay(ctx, agents, now) {
    var transform = getTransform();
    var usePokeSprites = appState.snapshot.config && appState.snapshot.config.enablePokeapiSprites;

    for (var i = 0; i < agents.length; i++) {
      var agent = agents[i];
      var entity = appState.entityById.get(agent.agentId);
      if (!entity) continue;

      var anim = animations.get(agent.agentId);
      if (anim && anim.type === 'spawn' && (performance.now() - anim.startTime) < SPAWN_DURATION_MS) continue;

      var sx = transform.offsetX + Math.round(entity.x) * transform.scale;
      var sy = transform.offsetY + Math.round(entity.y) * transform.scale;
      var drawSizePx = agentDrawSize(agent) * transform.scale;
      var isSubagent = !!agent.parentId;
      var isSleep = agent.isSleeping || !agent.isActive;
      var spriteUrl = null;

      if (isSubagent) {
        spriteUrl = isSleep ? pokemonStaticIconUrl(agent) : pokemonIconUrl(agent);
      } else if (usePokeSprites) {
        spriteUrl = pokeProvider.getSpriteUrl(agent, isSleep);
      }

      if (spriteUrl) {
        var img = await loadExportImage(spriteUrl);
        if (img) {
          ctx.drawImage(img, sx, sy, drawSizePx, drawSizePx);
        }
      }

      if (!isSubagent) {
        drawExportBadge(ctx, sx + drawSizePx * 0.5, sy - 4, rootAgentBadge(agent));
      }

      if (isSleep) {
        var zzzPhase = now / 1100 + (Math.abs(hashCode(agent.agentId)) % 628) / 100;
        var zzzOffsetX = Math.sin(zzzPhase) * 2.6;
        var zzzOffsetY = Math.cos(zzzPhase * 0.82) * 1.8;
        drawExportSleepMarker(ctx, sx + drawSizePx * 0.68 + zzzOffsetX, sy + drawSizePx * 0.18 + zzzOffsetY);
      }
    }
  }

  async function downloadPromoScenePng() {
    var agents = filteredAgents();
    var exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width * PROMO_EXPORT_SCALE;
    exportCanvas.height = canvas.height * PROMO_EXPORT_SCALE;
    var exportCtx = exportCanvas.getContext('2d');
    exportCtx.imageSmoothingEnabled = false;
    exportCtx.scale(PROMO_EXPORT_SCALE, PROMO_EXPORT_SCALE);
    exportCtx.drawImage(canvas, 0, 0);
    await drawExportOverlay(exportCtx, agents, performance.now());

    var blob = await new Promise(function (resolve) {
      exportCanvas.toBlob(resolve, 'image/png');
    });
    if (!blob) {
      throw new Error('PNG export failed');
    }
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'promo-scene-' + stamp + '.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function composeToScreen() {
    screenCtx.setTransform(1, 0, 0, 1, 0, 0);
    screenCtx.imageSmoothingEnabled = false;
    screenCtx.drawImage(worldCanvas, 0, 0);
  }

  function render(now) {
    updateEntityMotion(now);
    drawBackground();
    const agents = filteredAgents();
    drawConnections(agents);
    drawAgents(agents, now);
    drawAnimations(agents, now);
    composeToScreen();
    renderOverlay(agents, now);
    requestAnimationFrame(render);
  }

  async function loadInitialState() {
    const res = await fetch('/api/state', { cache: 'no-cache' });
    if (!res.ok) throw new Error('state load failed: ' + res.status);
    const data = await res.json();
    applySnapshot(data);
  }

  function connectEvents() {
    const stream = new EventSource('/events');
    stream.addEventListener('state', function (event) {
      try { applySnapshot(JSON.parse(event.data)); } catch (e) {}
    });
    stream.onerror = function () {};
    return stream;
  }

  function bindUi() {
    // Map sprite hover → tooltip
    function updateMapTooltipForSprite(sprite) {
      if (!sprite) {
        hideMapTooltip();
        return;
      }
      var agentId = sprite.getAttribute('data-agent-id');
      var agents = (appState.snapshot && appState.snapshot.agents) || [];
      var agent = null;
      for (var i = 0; i < agents.length; i++) {
        if (agents[i].agentId === agentId) { agent = agents[i]; break; }
      }
      if (agent) showMapTooltip(agent, sprite.getBoundingClientRect());
      else hideMapTooltip();
    }

    overlayEl.addEventListener('mouseover', function (e) {
      updateMapTooltipForSprite(e.target.closest('.agent-sprite[data-agent-id]'));
    });
    overlayEl.addEventListener('mousemove', function (e) {
      updateMapTooltipForSprite(e.target.closest('.agent-sprite[data-agent-id]'));
    });
    overlayEl.addEventListener('mouseout', function (e) {
      var related = e.relatedTarget;
      if (!related || !related.closest || !related.closest('.agent-sprite[data-agent-id]')) {
        hideMapTooltip();
      }
    });
    // overlayEl has pointer-events:none so mouseleave on it never fires.
    // Instead listen on the parent canvas-area and the canvas itself.
    var canvasAreaEl = overlayEl.parentElement;
    canvasAreaEl.addEventListener('mouseleave', function () {
      hideMapTooltip();
    });
    // When mouse is on the canvas background (not a sprite), hide any stuck tooltip.
    var officeCanvasEl = document.getElementById('office-canvas');
    if (officeCanvasEl) {
      officeCanvasEl.addEventListener('mousemove', function () {
        hideMapTooltip();
      });
    }

    if (promoStudioToggleEl) {
      promoStudioToggleEl.addEventListener('click', function () {
        if (!promoStudioAvailable()) return;
        uiState.promoStudioOpen = !uiState.promoStudioOpen;
        renderPromoStudio();
      });
    }
    if (promoStudioCloseEl) {
      promoStudioCloseEl.addEventListener('click', function () {
        uiState.promoStudioOpen = false;
        renderPromoStudio();
      });
    }
    if (promoStudioEnabledEl) {
      promoStudioEnabledEl.addEventListener('change', function () {
        uiState.promoStudioEnabled = !!promoStudioEnabledEl.checked;
        promoStudioState.enabled = uiState.promoStudioEnabled;
        savePromoStudioState();
        syncVisibleSnapshot();
        renderPromoStudio();
      });
    }
    if (promoAddRootEl) {
      promoAddRootEl.addEventListener('click', function () {
        promoStudioState.roots.push(createPromoRoot());
        syncPromoStudioState();
      });
    }
    if (promoResetEl) {
      promoResetEl.addEventListener('click', function () {
        if (!window.confirm('Reset the custom promo scene to the default starter setup?')) return;
        promoStudioState = createDefaultPromoStudioState();
        promoStudioState.enabled = uiState.promoStudioEnabled;
        resetPromoBoxState();
        resetPromoPokedexState();
        syncPromoStudioState();
      });
    }
    if (promoExportEl) {
      promoExportEl.addEventListener('click', async function () {
        promoExportEl.disabled = true;
        try {
          await downloadPromoScenePng();
        } catch (err) {
          window.alert(err.message);
        } finally {
          promoExportEl.disabled = false;
        }
      });
    }
    if (promoStudioListEl) {
      promoStudioListEl.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.getAttribute('data-action');
        var rootId = btn.getAttribute('data-root-id');
        var subId = btn.getAttribute('data-sub-id');
        var root = findPromoRoot(rootId);
        if (!root) return;

        if (action === 'add-subagent') {
          root.subagents.push(createPromoSubagent(root.pokemonId));
          syncPromoStudioState();
          return;
        }
        if (action === 'box-root') {
          boxPromoRoot(rootId);
          return;
        }
        if (action === 'remove-root') {
          promoStudioState.roots = promoStudioState.roots.filter(function (item) { return item.id !== rootId; });
          syncPromoStudioState();
          return;
        }
        if (action === 'remove-subagent') {
          root.subagents = root.subagents.filter(function (item) { return item.id !== subId; });
          syncPromoStudioState();
        }
      });

      promoStudioListEl.addEventListener('change', function (e) {
        var fieldEl = e.target.closest('[data-field]');
        if (!fieldEl) return;
        updatePromoUnitField(
          fieldEl.getAttribute('data-root-id'),
          fieldEl.getAttribute('data-sub-id'),
          fieldEl.getAttribute('data-field'),
          fieldEl.value
        );
      });
    }

    projectFilterEl.addEventListener('change', function () {
      uiState.projectFilter = projectFilterEl.value;
      renderAgentList();
      tokenTotalEl.textContent = formatTokenCount(filteredTokenTotal(filteredAgents()));
    });
    sessionFilterEl.addEventListener('change', function () {
      uiState.sessionFilter = sessionFilterEl.value;
      renderAgentList();
      tokenTotalEl.textContent = formatTokenCount(filteredTokenTotal(filteredAgents()));
    });
    if (hardResetBtnEl) {
      hardResetBtnEl.addEventListener('click', async function () {
        var config = (appState.snapshot && appState.snapshot.config) || {};
        if (!config.supportsHardReset) return;
        var mode = config.mode || (config.isMockMode ? 'mock' : 'watch');
        if (!window.confirm('Reset ' + mode + ' state, boxed agents, and discovered Pokedex progress?')) return;
        hardResetBtnEl.disabled = true;
        try {
          var res = await fetch('/api/hard-reset', { method: 'POST' });
          if (!res.ok) {
            throw new Error('hard reset failed: ' + res.status);
          }
          resetFilters();
          renderAgentList();
          tokenTotalEl.textContent = formatTokenCount(filteredTokenTotal(filteredAgents()));
        } catch (err) {
          window.alert(err.message);
        } finally {
          hardResetBtnEl.disabled = false;
        }
      });
    }
    agentListEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action="box"]');
      if (btn) {
        e.stopPropagation();
        var agentId = btn.getAttribute('data-agent-id');
        var promoAgent = appState.agentById && appState.agentById.get(agentId);
        if (promoAgent && promoAgent.isPromoCustom) {
          if (!promoAgent.parentId) {
            boxPromoRoot(agentId);
          }
          return;
        }
        fetch('/api/box/' + encodeURIComponent(agentId), { method: 'POST' });
        return;
      }
      btn = e.target.closest('[data-action="toggle-subtree"]');
      if (btn) {
        e.stopPropagation();
        var toggleAgentId = btn.getAttribute('data-agent-id');
        var toggleDepth = parseInt(btn.getAttribute('data-depth') || '0', 10);
        if (toggleAgentId) {
          var liveAgents = (appState.snapshot && appState.snapshot.agents) || [];
          var toggleAgent = null;
          for (var i = 0; i < liveAgents.length; i++) {
            if (liveAgents[i].agentId === toggleAgentId) {
              toggleAgent = liveAgents[i];
              break;
            }
          }
          var currentChildCount = toggleAgent && Array.isArray(toggleAgent.childrenIds) ? toggleAgent.childrenIds.length : 0;
          var currentlyCollapsed = isSubtreeCollapsed(toggleAgentId, Number.isFinite(toggleDepth) ? toggleDepth : 0, currentChildCount, uiState.collapsedSubtrees);
          uiState.collapsedSubtrees[toggleAgentId] = !currentlyCollapsed;
          renderAgentList();
        }
        return;
      }
      btn = e.target.closest('[data-action="open-subhistory"]');
      if (btn) {
        e.stopPropagation();
        setSubhistoryOpen(true, btn.getAttribute('data-agent-id'));
        renderSubhistoryModal();
        return;
      }
      var card = e.target.closest('.poke-slot');
      if (card) card.classList.toggle('expanded');
    });
    function handleUnboxClick(e) {
      var btn = e.target.closest('[data-action="unbox"]');
      if (btn) {
        e.stopPropagation();
        var agentId = btn.getAttribute('data-agent-id');
        var boxedAgent = boxedAgentById(agentId);
        if (boxedAgent && boxedAgent.isPromoCustom) {
          unboxPromoRoot(agentId);
          return;
        }
        fetch('/api/unbox/' + encodeURIComponent(agentId), { method: 'POST' });
        return;
      }
      btn = e.target.closest('[data-action="open-subhistory"]');
      if (btn) {
        e.stopPropagation();
        setSubhistoryOpen(true, btn.getAttribute('data-agent-id'));
        renderSubhistoryModal();
      }
    }

    function updateBoxTooltipForItem(item) {
      if (!item) {
        hideBoxTooltip();
        return;
      }
      var idx = parseInt(item.getAttribute('data-box-index'), 10);
      var boxed = appState.snapshot.boxedAgents || [];
      if (idx >= 0 && idx < boxed.length) {
        showBoxTooltip(boxed[idx], item.getBoundingClientRect());
      } else {
        hideBoxTooltip();
      }
    }

    function bindBoxInteractions(rootEl) {
      rootEl.addEventListener('click', handleUnboxClick);
      rootEl.addEventListener('mouseenter', function (e) {
        updateBoxTooltipForItem(e.target.closest('.box-item'));
      }, true);
      rootEl.addEventListener('mouseleave', function (e) {
        if (e.target.closest('.box-item')) {
          hideBoxTooltip();
        }
      }, true);
      rootEl.addEventListener('mouseover', function (e) {
        updateBoxTooltipForItem(e.target.closest('.box-item'));
      });
      rootEl.addEventListener('mouseout', function (e) {
        var related = e.relatedTarget;
        if (!related || !related.closest || !related.closest('.box-item')) {
          hideBoxTooltip();
        }
      });
    }

    bindBoxInteractions(boxListEl);
    bindBoxInteractions(boxHistoryGridEl);
    subhistoryGridEl.addEventListener('mouseover', function (e) {
      var card = e.target.closest('.subhistory-lineage-card[data-subhistory-key]');
      if (!card) return;
      var key = card.getAttribute('data-subhistory-key');
      showSubhistoryTooltip(appState.subhistoryEntryByKey.get(key), card.getBoundingClientRect());
    });
    subhistoryGridEl.addEventListener('mouseout', function (e) {
      var card = e.target.closest('.subhistory-lineage-card[data-subhistory-key]');
      if (!card) {
        var related = e.relatedTarget;
        if (!related || !subhistoryGridEl.contains(related)) hideSubhistoryTooltip();
        return;
      }
      var related = e.relatedTarget;
      if (related && related.closest && related.closest('.subhistory-lineage-card[data-subhistory-key]') === card) {
        return;
      }
      hideSubhistoryTooltip();
    });
    subhistoryGridEl.addEventListener('mouseleave', function () {
      hideSubhistoryTooltip();
    });
    boxHistoryToggleEl.addEventListener('click', function () {
      setBoxHistoryOpen(true);
    });
    boxHistoryCloseEl.addEventListener('click', function () {
      setBoxHistoryOpen(false);
    });
    boxHistoryBackdropEl.addEventListener('click', function () {
      setBoxHistoryOpen(false);
    });
    subhistoryCloseEl.addEventListener('click', function () {
      setSubhistoryOpen(false);
    });
    subhistoryBackdropEl.addEventListener('click', function () {
      setSubhistoryOpen(false);
    });
    pokedexToggleEl.addEventListener('click', function () {
      setPokedexOpen(true);
    });
    pokedexCloseEl.addEventListener('click', function () {
      setPokedexOpen(false);
    });
    pokedexBackdropEl.addEventListener('click', function () {
      setPokedexOpen(false);
    });
    pokedexLangEnEl.addEventListener('click', function () {
      if (uiState.pokedexLanguage === 'en') return;
      uiState.pokedexLanguage = 'en';
      renderPokedex();
      renderPromoStudio();
      hidePokedexTooltip();
    });
    pokedexLangKoEl.addEventListener('click', function () {
      if (uiState.pokedexLanguage === 'ko') return;
      uiState.pokedexLanguage = 'ko';
      renderPokedex();
      renderPromoStudio();
      hidePokedexTooltip();
    });
    pokedexGridEl.addEventListener('mouseover', function (e) {
      var cell = e.target.closest('.pokedex-cell[data-pokemon-id]');
      if (!cell) return;
      var pokemonId = parseInt(cell.getAttribute('data-pokemon-id'), 10);
      if (!pokemonId) return;
      showPokedexTooltip(pokemonId, cell.getBoundingClientRect());
    });
    pokedexGridEl.addEventListener('mouseout', function (e) {
      var cell = e.target.closest('.pokedex-cell[data-pokemon-id]');
      if (!cell) {
        var related = e.relatedTarget;
        if (!related || !pokedexGridEl.contains(related)) hidePokedexTooltip();
        return;
      }
      var related = e.relatedTarget;
      if (related && related.closest && related.closest('.pokedex-cell[data-pokemon-id]') === cell) {
        return;
      }
      hidePokedexTooltip();
    });
    pokedexGridEl.addEventListener('mouseleave', function () {
      hidePokedexTooltip();
    });
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (uiState.boxHistoryOpen) {
        setBoxHistoryOpen(false);
        return;
      }
      if (uiState.subhistoryOpen) {
        setSubhistoryOpen(false);
        hideSubhistoryTooltip();
        return;
      }
      if (uiState.pokedexOpen) {
        setPokedexOpen(false);
        return;
      }
      if (uiState.promoStudioOpen) {
        uiState.promoStudioOpen = false;
        renderPromoStudio();
      }
    });
    window.addEventListener('resize', setCanvasSize);
  }

  async function boot() {
    bindUi();
    setCanvasSize();
    try { await loadInitialState(); } catch (e) {
      agentListEl.innerHTML = '<div class="agent-card">Failed to load state: ' + escapeHtml(e.message) + '</div>';
    }
    connectEvents();
    requestAnimationFrame(render);
  }

  boot();
})();
