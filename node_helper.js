const NodeHelper = require("node_helper");
const https = require("https");
const fs = require("fs");
const path = require("path");
const cocData = require("clash-of-clans-data");

// The official API's maxLevel is the unit's absolute max (at max Town Hall),
// not the max reachable at the player's current Town Hall, so we rebuild that
// cap ourselves from static game data (this is what third-party trackers do).
const LEVEL_CAP_INDEX = buildLevelCapIndex();

function buildLevelCapIndex() {
  const byName = (list) => {
    const map = {};
    list.forEach((item) => {
      map[String(item.name).toLowerCase()] = item;
    });
    return map;
  };

  return {
    troops: byName(cocData.home().troops().get()),
    siegeMachines: byName(cocData.home().siegeMachines().get()),
    spells: byName(cocData.home().spells().get()),
    pets: byName(cocData.home().pets().get()),
    heroes: byName(cocData.home().heroes().get()),
    equipment: byName(cocData.home().heroEquipment().get()),
    heroHallLevels: cocData.home().armyBuildings().heroHall().first().levels,
    blacksmithLevels: cocData.home().armyBuildings().blacksmith().first().levels
  };
}

function maxLevelForTownHall(def, townHallLevel) {
  if (!def || !Array.isArray(def.levels)) {
    return null;
  }

  const unlocked = def.levels.filter((lvl) => (Number(lvl.townHallRequired) || 0) <= townHallLevel);
  if (!unlocked.length) {
    return 0;
  }

  return unlocked.reduce((max, lvl) => Math.max(max, Number(lvl.level) || 0), 0);
}

function highestRequirementEntry(entries, townHallLevel) {
  const unlocked = entries.filter((entry) => (Number(entry.townHallRequired) || 0) <= townHallLevel);
  if (!unlocked.length) {
    return null;
  }

  return unlocked.reduce((best, entry) => (entry.level > best.level ? entry : best), unlocked[0]);
}

// heroLevelCaps keys are camelCase, but hero "id" values from the data package are kebab-case.
function toCamelCase(kebabId) {
  return String(kebabId).replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

module.exports = NodeHelper.create({
  socketNotificationReceived: function (notification, payload) {
    if (notification !== "COC_FETCH_PLAYER") {
      return;
    }

    this.fetchPlayer(payload)
      .then((playerData) => {
        const localExport = this.readLocalExport(payload.playerTag);
        const normalized = this.normalizePlayerData(playerData, payload.showBuilderBase, localExport);
        this.sendSocketNotification("COC_PLAYER_DATA", {
          playerTag: payload.playerTag,
          data: normalized
        });
      })
      .catch((error) => {
        this.sendSocketNotification("COC_PLAYER_ERROR", {
          playerTag: payload.playerTag,
          message: error.message || "Failed to fetch player data"
        });
      });
  },

  fetchPlayer: function (payload) {
    const tag = encodeURIComponent(this.normalizePlayerTag(payload.playerTag));
    const options = {
      hostname: "api.clashofclans.com",
      port: 443,
      path: "/v1/players/" + tag,
      method: "GET",
      headers: {
        Authorization: "Bearer " + payload.apiToken,
        Accept: "application/json"
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let raw = "";

        res.on("data", (chunk) => {
          raw += chunk;
        });

        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const errorText = this.extractApiError(raw) || ("HTTP " + res.statusCode);
            reject(new Error(errorText));
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (parseError) {
            reject(new Error("Invalid JSON from Clash API"));
          }
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.end();
    });
  },

  normalizePlayerTag: function (playerTag) {
    const cleaned = String(playerTag || "").trim();

    if (!cleaned) {
      return "";
    }

    return cleaned.charAt(0) === "#" ? cleaned : ("#" + cleaned);
  },

  extractApiError: function (rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      return parsed.reason || parsed.message || null;
    } catch (error) {
      return null;
    }
  },

  normalizePlayerData: function (player, showBuilderBase, localExport) {
    const home = this.buildVillageProgress(player, "home", localExport);
    const builder = showBuilderBase ? this.buildVillageProgress(player, "builderBase", localExport) : null;

    return {
      player: {
        name: player.name,
        tag: player.tag
      },
      homeVillage: {
        hallLevel: player.townHallLevel,
        categories: home.categories,
        earned: home.earned,
        total: home.total,
        percent: home.percent
      },
      builderBase: builder
        ? {
            hallLevel: player.builderHallLevel,
            categories: builder.categories,
            earned: builder.earned,
            total: builder.total,
            percent: builder.percent
          }
        : null
    };
  },

  buildVillageProgress: function (player, villageType, localExport) {
    let categories;

    if (villageType === "home") {
      const effectiveTownHall = this.getEffectiveTownHallLevel(player.townHallLevel, localExport);
      const split = this.splitHomeTroopsAndPets(player.troops);
      const labTroops = this.getCategoryProgressFromItems(split.troops, "Lab", "troop", effectiveTownHall);
      const labSiegeMachines = this.getCategoryProgressFromItems(split.siegeMachines, "Lab", "siegeMachine", effectiveTownHall);
      const spells = this.getCategoryProgress(player.spells, villageType, "Spells", "spell", effectiveTownHall);
      const lab = this.mergeCategoryProgress([labTroops, labSiegeMachines, spells], "Lab");
      const heroes = this.getCategoryProgress(player.heroes, villageType, "Heroes", "hero", effectiveTownHall);
      const equipment = this.getCategoryProgress(player.heroEquipment, villageType, "Equipment", "equipment", effectiveTownHall);
      const pets = this.getCategoryProgressFromItems(split.pets, "Pets", "pet", effectiveTownHall);
      const apiCategories = [lab, heroes, equipment, pets];
      const exportCategories = localExport
        ? [
            this.getStructuresProgressFromExport(localExport),
            this.getSuperchargeProgressFromExport(localExport, effectiveTownHall),
            this.getCraftedDefProgressFromExport(localExport, effectiveTownHall),
            this.getWallsProgressFromExport(localExport, effectiveTownHall)
          ]
        : [];

      categories = apiCategories.concat(exportCategories).filter((item) => item && item.total > 0);
    } else {
      const troops = this.getCategoryProgress(player.troops, villageType, "Troops");
      const heroes = this.getCategoryProgress(player.heroes, villageType, "Heroes");
      categories = [troops, heroes].filter(Boolean);
    }

    const earned = categories.reduce((sum, item) => sum + item.earned, 0);
    const total = categories.reduce((sum, item) => sum + item.total, 0);
    const percent = total > 0 ? (earned / total) * 100 : 0;

    return {
      categories,
      earned,
      total,
      percent
    };
  },

  getCategoryProgress: function (items, villageType, label, category, townHallLevel) {
    if (!Array.isArray(items)) {
      return {
        label,
        earned: 0,
        total: 0,
        percent: 0
      };
    }

    const scoped = items.filter((item) => {
      return (item.village || "home") === villageType;
    });

    return this.summarizeItems(scoped, label, category, townHallLevel);
  },

  getCategoryProgressFromItems: function (items, label, category, townHallLevel) {
    if (!Array.isArray(items)) {
      return {
        label,
        earned: 0,
        total: 0,
        percent: 0
      };
    }

    return this.summarizeItems(items, label, category, townHallLevel);
  },

  summarizeItems: function (items, label, category, townHallLevel) {
    const earned = items.reduce((sum, item) => {
      return sum + (Number(item.level) || 0);
    }, 0);

    const total = items.reduce((sum, item) => {
      const rawLevel = Number(item.level) || 0;
      const cap = this.getTownHallLevelCap(category, item.name, townHallLevel);
      // The static data package can lag behind live game balance updates, so
      // never let a stale cap sit below what the player has actually reached.
      const effectiveCap = cap !== null ? Math.max(cap, rawLevel) : (Number(item.maxLevel) || 0);
      return sum + effectiveCap;
    }, 0);

    return {
      label,
      earned,
      total,
      percent: total > 0 ? (earned / total) * 100 : 0
    };
  },

  getTownHallLevelCap: function (category, name, townHallLevel) {
    if (!category || !townHallLevel) {
      return null;
    }

    const key = String(name || "").toLowerCase();

    if (category === "troop") {
      return maxLevelForTownHall(LEVEL_CAP_INDEX.troops[key], townHallLevel);
    }

    if (category === "siegeMachine") {
      return maxLevelForTownHall(LEVEL_CAP_INDEX.siegeMachines[key], townHallLevel);
    }

    if (category === "spell") {
      return maxLevelForTownHall(LEVEL_CAP_INDEX.spells[key], townHallLevel);
    }

    if (category === "pet") {
      return maxLevelForTownHall(LEVEL_CAP_INDEX.pets[key], townHallLevel);
    }

    if (category === "hero") {
      const def = LEVEL_CAP_INDEX.heroes[key];
      if (!def) {
        return null;
      }

      const entry = highestRequirementEntry(LEVEL_CAP_INDEX.heroHallLevels, townHallLevel);
      if (!entry || !entry.heroLevelCaps) {
        return 0;
      }

      return Number(entry.heroLevelCaps[toCamelCase(def.id)]) || 0;
    }

    if (category === "equipment") {
      const def = LEVEL_CAP_INDEX.equipment[key];
      if (!def) {
        return null;
      }

      const entry = highestRequirementEntry(LEVEL_CAP_INDEX.blacksmithLevels, townHallLevel);
      if (!entry || !entry.maxEquipmentLevel) {
        return 0;
      }

      return Number(entry.maxEquipmentLevel[String(def.rarity).toLowerCase()]) || 0;
    }

    return null;
  },

  mergeCategoryProgress: function (parts, label) {
    const list = Array.isArray(parts) ? parts.filter(Boolean) : [];
    const earned = list.reduce((sum, item) => sum + (Number(item.earned) || 0), 0);
    const total = list.reduce((sum, item) => sum + (Number(item.total) || 0), 0);

    return {
      label,
      earned,
      total,
      percent: total > 0 ? (earned / total) * 100 : 0
    };
  },

  readLocalExport: function (playerTag) {
    const normalizedTag = this.normalizePlayerTag(playerTag);
    if (!normalizedTag) {
      return null;
    }

    const exportFileName = "clash_export_" + normalizedTag + ".json";
    const exportPath = path.join(__dirname, exportFileName);

    if (!fs.existsSync(exportPath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(exportPath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  },

  getEffectiveTownHallLevel: function (apiTownHallLevel, localExport) {
    const apiTh = Number(apiTownHallLevel) || 0;
    if (apiTh > 0) {
      return apiTh;
    }

    return this.inferTownHallFromExport(localExport);
  },

  inferTownHallFromExport: function (localExport) {
    if (!localExport || !Array.isArray(localExport.buildings)) {
      return 0;
    }

    const walls = localExport.buildings.find((item) => item && item.data === 1000010);
    if (!walls) {
      return 0;
    }

    const wallLevel = Number(walls.lvl) || 0;
    const wallLevelToTh = {
      13: 11,
      14: 12,
      15: 13,
      16: 14,
      17: 15,
      18: 16,
      19: 17
    };

    return wallLevelToTh[wallLevel] || 0;
  },

  getStructuresProgressFromExport: function (localExport) {
    if (!localExport) {
      return null;
    }

    const buildings = Array.isArray(localExport.buildings) ? localExport.buildings : [];
    const traps = Array.isArray(localExport.traps) ? localExport.traps : [];
    const scoped = buildings
      .filter((item) => item && item.data !== 1000010 && item.data !== 1000097)
      .filter((item) => Number(item.cnt) > 0)
      .concat(traps);

    const total = scoped.reduce((sum, item) => sum + (Number(item.cnt) || 1), 0);
    const upgrading = scoped.reduce((sum, item) => {
      const count = Number(item.cnt) || 1;
      return sum + (item.timer ? count : 0);
    }, 0);

    return {
      label: "Structures",
      earned: Math.max(0, total - upgrading),
      total,
      percent: total > 0 ? ((total - upgrading) / total) * 100 : 0
    };
  },

  getSuperchargeProgressFromExport: function (localExport, townHallLevel) {
    if (!localExport || !Array.isArray(localExport.buildings)) {
      return null;
    }

    const scoped = localExport.buildings.filter((item) => {
      return item && Object.prototype.hasOwnProperty.call(item, "supercharge");
    });

    const observedTotal = scoped.reduce((sum, item) => sum + (Number(item.cnt) || 1), 0);
    const earned = scoped.reduce((sum, item) => {
      const count = Number(item.cnt) || 1;
      return sum + (Number(item.supercharge) > 0 ? count : 0);
    }, 0);

    const knownTotalsByTh = {
      17: 59,
      18: 59
    };

    const total = knownTotalsByTh[Number(townHallLevel)] || observedTotal;

    return {
      label: "Supercharge",
      earned,
      total,
      percent: total > 0 ? (earned / total) * 100 : 0
    };
  },

  getCraftedDefProgressFromExport: function (localExport, townHallLevel) {
    if (!localExport || !Array.isArray(localExport.buildings)) {
      return null;
    }

    const crafted = localExport.buildings.find((item) => item && item.data === 1000097);
    if (!crafted || !Array.isArray(crafted.types)) {
      return null;
    }

    const modules = [];
    crafted.types.forEach((type) => {
      if (type && Array.isArray(type.modules)) {
        type.modules.forEach((moduleItem) => {
          modules.push(moduleItem);
        });
      }
    });

    const earned = modules.reduce((sum, moduleItem) => {
      const lvl = Math.max(0, Number(moduleItem.lvl) || 0);
      return sum + lvl;
    }, 0);

    const observedTotal = modules.length * 10;
    const knownTotalsByTh = {
      17: 114,
      18: 114
    };

    const total = knownTotalsByTh[Number(townHallLevel)] || observedTotal;

    return {
      label: "Crafted Def",
      earned,
      total,
      percent: total > 0 ? (earned / total) * 100 : 0
    };
  },

  getWallsProgressFromExport: function (localExport, townHallLevel) {
    if (!localExport || !Array.isArray(localExport.buildings)) {
      return null;
    }

    const walls = localExport.buildings.find((item) => item && item.data === 1000010);
    if (!walls) {
      return null;
    }

    const maxWallLevelByTh = {
      11: 13,
      12: 14,
      13: 15,
      14: 16,
      15: 17,
      16: 18,
      17: 19,
      18: 19
    };

    const wallLevel = Math.max(0, Number(walls.lvl) || 0);
    const count = Math.max(1, Number(walls.cnt) || 1);
    const maxWallLevel = maxWallLevelByTh[Number(townHallLevel)] || wallLevel || 1;

    return {
      label: "Walls",
      earned: wallLevel * count,
      total: maxWallLevel * count,
      percent: maxWallLevel > 0 ? (wallLevel / maxWallLevel) * 100 : 0
    };
  },

  splitHomeTroopsAndPets: function (troops) {
    const homeTroops = Array.isArray(troops)
      ? troops.filter((item) => (item.village || "home") === "home")
      : [];

    const isPet = (item) => !!LEVEL_CAP_INDEX.pets[String(item.name || "").toLowerCase()];
    const isSiegeMachine = (item) => !!LEVEL_CAP_INDEX.siegeMachines[String(item.name || "").toLowerCase()];

    return {
      troops: homeTroops.filter((item) => !isPet(item) && !isSiegeMachine(item)),
      pets: homeTroops.filter(isPet),
      siegeMachines: homeTroops.filter(isSiegeMachine)
    };
  }
});
