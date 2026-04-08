'use strict';

const fs = require('fs');
const path = require('path');

const POKEDEX_MIN = 1;
const POKEDEX_MAX = 251;
const TIER_WEIGHTS = Object.freeze({ 1: 40, 2: 25, 3: 15, 4: 5, 5: 1 });
const DATA_FILE = path.join(__dirname, 'data', 'pokemon_data.json');
const EVOLUTION_PATHS = Object.freeze({
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
});

let cachedCatalog = null;

function hashCode(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function loadPokemonCatalog() {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  let weightedPool = [];

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.pokemon)) {
      for (const pokemon of data.pokemon) {
        const pokemonId = Number(pokemon && pokemon.pokemon_id);
        if (!Number.isInteger(pokemonId) || pokemonId < POKEDEX_MIN || pokemonId > POKEDEX_MAX) {
          continue;
        }
        const weight = TIER_WEIGHTS[pokemon.final_tier] || 1;
        for (let i = 0; i < weight; i += 1) {
          weightedPool.push(pokemonId);
        }
      }
    }
  } catch (_) {
    weightedPool = [];
  }

  if (weightedPool.length === 0) {
    for (let pokemonId = POKEDEX_MIN; pokemonId <= POKEDEX_MAX; pokemonId += 1) {
      weightedPool.push(pokemonId);
    }
  }

  cachedCatalog = { weightedPool };
  return cachedCatalog;
}

function getPokemonIdForAgent(agentId) {
  if (!agentId) {
    return POKEDEX_MIN;
  }

  const catalog = loadPokemonCatalog();
  const index = hashCode(String(agentId)) % catalog.weightedPool.length;
  return catalog.weightedPool[index];
}

function getEvolutionPath(pokemonId) {
  return EVOLUTION_PATHS[pokemonId] || [pokemonId];
}

function resolveRenderedPokemonIdForAgent(agentId, options = {}) {
  if (!agentId) {
    return POKEDEX_MIN;
  }

  const parentId = options.parentId || null;
  if (!parentId) {
    return getPokemonIdForAgent(agentId);
  }

  const getAgentById = typeof options.getAgentById === 'function' ? options.getAgentById : null;
  const lookupTs = typeof options.createdAt === 'number'
    ? options.createdAt
    : (typeof options.ts === 'number' ? options.ts : Infinity);
  let parentPokemonId = null;

  if (getAgentById) {
    const parentAgent = getAgentById(parentId, { beforeTs: lookupTs });
    if (parentAgent) {
      parentPokemonId = resolveRenderedPokemonIdForAgent(parentId, {
        parentId: parentAgent.parentId || null,
        getAgentById,
        createdAt: typeof parentAgent.createdAt === 'number' ? parentAgent.createdAt : lookupTs
      });
    }
  }

  if (!parentPokemonId) {
    parentPokemonId = getPokemonIdForAgent(parentId);
  }

  const candidates = getEvolutionPath(parentPokemonId);
  return candidates[hashCode(String(agentId)) % candidates.length];
}

module.exports = {
  POKEDEX_MIN,
  POKEDEX_MAX,
  getPokemonIdForAgent,
  getEvolutionPath,
  resolveRenderedPokemonIdForAgent
};
