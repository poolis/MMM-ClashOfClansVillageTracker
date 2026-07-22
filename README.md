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
    playerTag: "#ABC123",
    apiToken: "YOUR_CLASH_API_TOKEN",
    updateInterval: 1000 * 60 * 20,
    showBuilderBase: true,
    compactMode: false,
    backgroundColor: "#3a2a1a"
  }
}
```

## Options

- `title`: Header shown in the module.
- `playerTag`: Clash player tag (with or without `#`).
- `apiToken`: Bearer token from Clash Developer API.
- `updateInterval`: Refresh interval in milliseconds.
- `showBuilderBase`: Show/hide Builder Base panel.
- `compactMode`: When `true`, shows only the Home Village and Builder Base circular gauges.
- `backgroundColor`: Any valid CSS color used for the module card background (example: `#3a2a1a` or `rgb(40,30,20)`).
- `animationSpeed`: MagicMirror DOM update animation speed.

## Notes

- This module uses only official Clash API endpoints.
- Completion score is a weighted ratio:

  ```
  completion = sum(current levels) / sum(max levels)
  ```

- Building/wall completion is not exposed by the player endpoint, so it is not included in this version.
