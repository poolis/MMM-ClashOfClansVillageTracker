const NodeHelper = require("node_helper");
const https = require("https");
const fs = require("fs");
const path = require("path");
const cocData = require("clash-of-clans-data");

// The official API's maxLevel is the unit's absolute max (at max Town Hall),
// not the max reachable at the player's current Town Hall, so we rebuild that
// cap ourselves from static game data (this is what third-party trackers do).
const LEVEL_CAP_INDEX = buildLevelCapIndex();

// Buildings/traps have no equivalent live-API maxLevel to fall back on (the
// local export only reports their current level), so this index is keyed by
// the export's numeric "data" id instead of by name.
const STRUCTURE_CAP_INDEX = buildStructureCapIndex();

function buildLevelCapIndex() {
  const byName = (list) => {
    const map = {};
    list.forEach((item) => {
      map[String(item.name).toLowerCase()] = item;
    });
    return map;
  };

  const home = cocData.home();
  const heroHallLevels = home.armyBuildings().heroHall().data[0].levels;
  const blacksmithLevels = home.armyBuildings().blacksmith().data[0].levels;
  const troops = byName(home.troops().data);
  const siegeMachines = byName(home.siegeMachines().data);
  const spells = byName(home.spells().data);
  const pets = byName(home.pets().data);

  return {
    troops: troops,
    troopsMaxTownHall: maxTownHallAcrossDefs(troops),
    siegeMachines: siegeMachines,
    siegeMachinesMaxTownHall: maxTownHallAcrossDefs(siegeMachines),
    spells: spells,
    spellsMaxTownHall: maxTownHallAcrossDefs(spells),
    pets: pets,
    petsMaxTownHall: maxTownHallAcrossDefs(pets),
    heroes: byName(home.heroes().data),
    equipment: byName(home.heroEquipment().data),
    craftedDefenses: byName(home.craftedDefenses().data),
    heroHallLevels: heroHallLevels,
    heroHallMaxTownHall: maxTownHallRequired(heroHallLevels),
    blacksmithLevels: blacksmithLevels,
    blacksmithMaxTownHall: maxTownHallRequired(blacksmithLevels)
  };
}

// Builds a dataId -> definition index covering every ordinary home-village
// building/trap (walls and crafted defenses are tracked as their own
// categories elsewhere, so they're excluded here). Several armyBuildings
// accessors return the single building wrapped in an array rather than a
// bare object, so this recurses into arrays instead of assuming either shape.
function buildStructureCapIndex() {
  const home = cocData.home();
  const byDataId = {};

  const add = (item) => {
    if (Array.isArray(item)) {
      item.forEach(add);
      return;
    }
    if (item && item.dataId) {
      byDataId[item.dataId] = item;
    }
  };

  add(home.defenses().data);
  add(home.resourceBuildings().data);
  add(home.resourceBuildings().clanCastle().data);
  add(home.otherBuildings().data);
  add(home.traps().data);
  add(home.armyBuildings().armyCamp().data);
  add(home.armyBuildings().barracks().data);
  add(home.armyBuildings().darkBarracks().data);
  add(home.armyBuildings().laboratory().data);
  add(home.armyBuildings().spellFactory().data);
  add(home.armyBuildings().darkSpellFactory().data);
  add(home.armyBuildings().heroBanner().data);
  add(home.armyBuildings().heroHall().data);
  add(home.armyBuildings().blacksmith().data);
  add(home.armyBuildings().workshop().data);
  add(home.armyBuildings().petHouse().data);
  add(home.townHall().data);

  return {
    byDataId: byDataId,
    maxTownHall: maxTownHallAcrossDefs(byDataId)
  };
}

function maxTownHallRequired(entries) {
  return (Array.isArray(entries) ? entries : []).reduce(
    (max, entry) => Math.max(max, Number(entry.townHallRequired) || 0),
    0
  );
}

// The highest Town Hall covered anywhere in this category's static data.
// Individual units legitimately stop getting new levels at different Town
// Halls (that's real game design), but if *no* unit in the category has
// data past this Town Hall, the package itself hasn't been updated for it.
function maxTownHallAcrossDefs(defsByName) {
  return Object.keys(defsByName).reduce((max, key) => {
    return Math.max(max, maxTownHallRequired(defsByName[key].levels));
  }, 0);
}

function maxLevelForTownHall(def, townHallLevel, categoryMaxTownHall) {
  if (!def || !Array.isArray(def.levels)) {
    return null;
  }

  if (typeof categoryMaxTownHall === "number" && townHallLevel > categoryMaxTownHall) {
    // No unit in this category has data past categoryMaxTownHall, meaning
    // the static data package doesn't cover this Town Hall yet. Let the
    // caller fall back to the live API's maxLevel instead of reusing this
    // unit's last known cap, which may now be stale rather than its true max.
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
            this.getStructuresProgressFromExport(localExport, effectiveTownHall),
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
      return maxLevelForTownHall(LEVEL_CAP_INDEX.troops[key], townHallLevel, LEVEL_CAP_INDEX.troopsMaxTownHall);
    }

    if (category === "siegeMachine") {
      return maxLevelForTownHall(
        LEVEL_CAP_INDEX.siegeMachines[key],
        townHallLevel,
        LEVEL_CAP_INDEX.siegeMachinesMaxTownHall
      );
    }

    if (category === "spell") {
      return maxLevelForTownHall(LEVEL_CAP_INDEX.spells[key], townHallLevel, LEVEL_CAP_INDEX.spellsMaxTownHall);
    }

    if (category === "pet") {
      return maxLevelForTownHall(LEVEL_CAP_INDEX.pets[key], townHallLevel, LEVEL_CAP_INDEX.petsMaxTownHall);
    }

    if (category === "hero") {
      const def = LEVEL_CAP_INDEX.heroes[key];
      if (!def) {
        return null;
      }

      if (townHallLevel > LEVEL_CAP_INDEX.heroHallMaxTownHall) {
        // The static hero hall data doesn't cover this Town Hall yet, so
        // fall back to the API's maxLevel instead of applying a stale,
        // lower cap from the highest Town Hall the data package knows about.
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

      if (townHallLevel > LEVEL_CAP_INDEX.blacksmithMaxTownHall) {
        // The static blacksmith data doesn't cover this Town Hall yet, so
        // fall back to the API's maxLevel instead of applying a stale,
        // lower cap from the highest Town Hall the data package knows about.
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

  getStructuresProgressFromExport: function (localExport, townHallLevel) {
    if (!localExport) {
      return null;
    }

    const buildings = Array.isArray(localExport.buildings) ? localExport.buildings : [];
    const traps = Array.isArray(localExport.traps) ? localExport.traps : [];
    const scoped = buildings
      .filter((item) => item && item.data !== 1000010 && item.data !== 1000097)
      .filter((item) => Number(item.cnt) > 0)
      .concat(traps);

    let earned = 0;
    let total = 0;

    scoped.forEach((item) => {
      const count = Math.max(1, Number(item.cnt) || 1);
      const level = Math.max(0, Number(item.lvl) || 0);
      const def = STRUCTURE_CAP_INDEX.byDataId[item.data];
      const cap = def ? maxLevelForTownHall(def, townHallLevel, STRUCTURE_CAP_INDEX.maxTownHall) : null;
      // Buildings have no live-API maxLevel to fall back on like
      // troops/heroes do, so when the static data doesn't identify or cover
      // this building, assume its current level is already its cap.
      const effectiveCap = cap !== null ? Math.max(cap, level) : level;

      earned += level * count;
      total += effectiveCap * count;
    });

    return {
      label: "Structures",
      earned,
      total,
      percent: total > 0 ? (earned / total) * 100 : 0
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

    // TH19's supercharge total is dynamic (it grows as more buildings unlock
    // supercharge eligibility), so it must be derived from the export rather
    // than fixed like the TH17/TH18 totals below.
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
      18: 114,
      19: 100
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

    const wallsArray = localExport.buildings.filter((item) => item && item.data === 1000010);
    if (!wallsArray || wallsArray.length === 0) {
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
      18: 19,
      19: 20
    };

    // Sum all wall levels: for each wall entry, sum level * count, and track
    // the highest observed level to use as a fallback cap for unmapped Town
    // Halls (e.g. TH10 and below) instead of incorrectly forcing it to 1.
    let earnedTotal = 0;
    let countTotal = 0;
    let maxObservedLevel = 0;

    wallsArray.forEach((wall) => {
      const level = Math.max(0, Number(wall.lvl) || 0);
      const count = Math.max(1, Number(wall.cnt) || 1);
      earnedTotal += level * count;
      countTotal += count;
      maxObservedLevel = Math.max(maxObservedLevel, level);
    });

    const maxWallLevel = maxWallLevelByTh[Number(townHallLevel)] || maxObservedLevel || 1;

    // Calculate total possible based on how many walls can reach max level
    // Some walls may have lower max levels due to availability/progression
    // For TH19: 150 walls can reach level 20, remaining walls capped at level 19
    let totalPossible = 0;
    if (townHallLevel === 19) {
      const upgradeableToMax = Math.min(150, countTotal);
      const remainingWalls = Math.max(0, countTotal - upgradeableToMax);
      totalPossible = (upgradeableToMax * maxWallLevel) + (remainingWalls * (maxWallLevel - 1));
    } else {
      totalPossible = maxWallLevel * countTotal;
    }

    return {
      label: "Walls",
      earned: earnedTotal,
      total: totalPossible,
      percent: totalPossible > 0 ? (earnedTotal / totalPossible) * 100 : 0
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
