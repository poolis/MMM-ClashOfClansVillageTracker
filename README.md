# MMM-ClashOfClansVillageTracker

MagicMirror module that visualizes Clash of Clans village completion progress using official Clash API data.

## What It Shows

- Home Village completion ring and category breakdown.
- Builder Base completion ring and category breakdown (optional).
- Progress is computed from upgradeable unit data returned by the Clash API:
  - Troops
  - Spells (Home Village)
  - Heroes
  - Hero Equipment

The visual style is inspired by dashboard progress graphics similar to clash.ninja.

## Prerequisites

1. Create a Clash Developer account at <https://developer.clashofclans.com>.
2. Create an API key bound to your MagicMirror device/network public IP.
3. Get your player tag (example: `#ABC123`).

## Installation

Place this module in your MagicMirror modules directory:

```bash
cd ~/MagicMirror/modules
git clone https://github.com/<your-user>/MMM-ClashOfClansVillageTracker.git
```

## Configuration

Add this to `config/config.js`:

```js
{
  module: "MMM-ClashOfClansVillageTracker",
  position: "top_right",
  config: {
    title: "Village Completion",
    playerTags: ["#ABC123", "#DEF456"],
    apiToken: "YOUR_CLASH_API_TOKEN",
    updateInterval: 1000 * 60 * 20,
    scrollInterval: 1000 * 15,
    showBuilderBase: true,
    compactMode: false,
    backgroundColor: ["#3a2a1a", "#1a3048"]
  }
}
```

## Options

- `title`: Header shown in the module.
- `playerTags`: Array of Clash player tags (with or without `#`). The module scrolls through these tags.
- `apiToken`: Bearer token from Clash Developer API.
- `updateInterval`: How often data is reloaded from API/local export in milliseconds.
- `scrollInterval`: Time in milliseconds before switching to the next player in `playerTags` (display rotation only, no forced reload each cycle).
- `showBuilderBase`: Show/hide Builder Base panel.
- `compactMode`: When `true`, shows only the Home Village and Builder Base circular gauges.
- `backgroundColor`: Either a single CSS color string or an array of CSS colors. When using an array, each player uses the matching index color while scrolling.
- `animationSpeed`: MagicMirror DOM update animation speed.

## Notes

- This module uses only official Clash API endpoints.
- Local export JSON is loaded per active player tag using this filename pattern: `clash_export_<playerTag>.json` (example: `clash_export_#LQGVJCLPG.json`).
- Completion score is a weighted ratio:

  ```
  completion = sum(current levels) / sum(max levels)
  ```

- Building/wall completion is not exposed by the player endpoint, so it is not included in this version.
