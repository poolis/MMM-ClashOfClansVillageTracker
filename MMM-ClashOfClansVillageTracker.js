Module.register("MMM-ClashOfClansVillageTracker", {
  defaults: {
    playerTags: [],
    apiToken: "",
    updateInterval: 1000 * 60 * 20,
    scrollInterval: 1000 * 15,
    animationSpeed: 600,
    showBuilderBase: true,
    compactMode: false,
    backgroundColor: "",
    title: "Village Completion",
    locale: "en"
  },

  start: function () {
    this.playerTags = this.getConfiguredPlayerTags();
    this.activePlayerIndex = 0;
    this.playerStates = {};

    this.dataState = {
      loading: true,
      error: null,
      payload: null,
      updatedAt: null
    };

    this.syncDataStateFromTag(this.getActivePlayerTag());
    this.getData(true);
    this.scheduleUpdate();
    this.scheduleScroll();
  },

  scheduleUpdate: function () {
    const interval = Number(this.config.updateInterval) || 0;
    if (interval <= 0) {
      return;
    }

    const self = this;
    setInterval(function () {
      self.getData(true);
    }, interval);
  },

  scheduleScroll: function () {
    if (this.playerTags.length < 2) {
      return;
    }

    const interval = Number(this.config.scrollInterval) || 0;
    if (interval <= 0) {
      return;
    }

    const self = this;
    setInterval(function () {
      self.activePlayerIndex = (self.activePlayerIndex + 1) % self.playerTags.length;
      self.syncDataStateFromTag(self.getActivePlayerTag());
      self.updateDom(self.config.animationSpeed);

      if (!self.dataState.payload && !self.dataState.loading) {
        self.getData(true);
      }
    }, interval);
  },

  getConfiguredPlayerTags: function () {
    const configured = Array.isArray(this.config.playerTags) ? this.config.playerTags : [];

    return configured
      .map((tag) => String(tag || "").trim())
      .filter((tag) => tag.length > 0);
  },

  getActivePlayerTag: function () {
    if (!this.playerTags.length) {
      return "";
    }

    return this.playerTags[this.activePlayerIndex % this.playerTags.length];
  },

  getPlayerState: function (playerTag) {
    if (!playerTag) {
      return {
        loading: false,
        error: null,
        payload: null,
        updatedAt: null,
        lastFetchAt: 0
      };
    }

    if (!this.playerStates[playerTag]) {
      this.playerStates[playerTag] = {
        loading: false,
        error: null,
        payload: null,
        updatedAt: null,
        lastFetchAt: 0
      };
    }

    return this.playerStates[playerTag];
  },

  syncDataStateFromTag: function (playerTag) {
    const source = this.getPlayerState(playerTag);
    this.dataState = {
      loading: source.loading,
      error: source.error,
      payload: source.payload,
      updatedAt: source.updatedAt
    };
  },

  getCurrentBackgroundColor: function () {
    if (Array.isArray(this.config.backgroundColor)) {
      const colors = this.config.backgroundColor.filter((color) => String(color || "").trim().length > 0);
      if (!colors.length) {
        return "";
      }

      return colors[this.activePlayerIndex % colors.length];
    }

    return this.config.backgroundColor;
  },

  getData: function (force) {
    const activeTag = this.getActivePlayerTag();

    if (!activeTag || !this.config.apiToken) {
      this.dataState.loading = false;
      this.dataState.error = "Missing playerTags or apiToken in module config.";
      this.updateDom(this.config.animationSpeed);
      return;
    }

    const state = this.getPlayerState(activeTag);
    if (state.loading) {
      return;
    }

    const updateInterval = Number(this.config.updateInterval) || 0;
    const isStale = updateInterval <= 0 || !state.lastFetchAt || (Date.now() - state.lastFetchAt) >= updateInterval;
    if (!force && !isStale) {
      this.syncDataStateFromTag(activeTag);
      this.updateDom(this.config.animationSpeed);
      return;
    }

    state.loading = true;
    state.error = null;

    this.syncDataStateFromTag(activeTag);
    this.updateDom(this.config.animationSpeed);

    this.sendSocketNotification("COC_FETCH_PLAYER", {
      playerTag: activeTag,
      apiToken: this.config.apiToken,
      showBuilderBase: this.config.showBuilderBase
    });
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "COC_PLAYER_DATA") {
      const responseTag = payload && payload.playerTag ? payload.playerTag : null;
      const normalizedPayload = payload && payload.data ? payload.data : payload;
      const resolvedTag = responseTag || this.getActivePlayerTag();
      const state = this.getPlayerState(resolvedTag);

      state.loading = false;
      state.error = null;
      state.payload = normalizedPayload;
      state.updatedAt = new Date();
      state.lastFetchAt = Date.now();

      if (resolvedTag === this.getActivePlayerTag()) {
        this.syncDataStateFromTag(resolvedTag);
        this.updateDom(this.config.animationSpeed);
      }
    }

    if (notification === "COC_PLAYER_ERROR") {
      const errorTag = payload && payload.playerTag ? payload.playerTag : null;
      const resolvedTag = errorTag || this.getActivePlayerTag();
      const state = this.getPlayerState(resolvedTag);

      state.loading = false;
      state.error = payload && payload.message ? payload.message : "Unknown API error.";
      state.lastFetchAt = Date.now();

      if (resolvedTag === this.getActivePlayerTag()) {
        this.syncDataStateFromTag(resolvedTag);
        this.updateDom(this.config.animationSpeed);
      }
    }
  },

  getStyles: function () {
    return ["MMM-ClashOfClansVillageTracker.css"];
  },

  getDom: function () {
    const wrapper = document.createElement("div");
    wrapper.className = "coc-tracker";

    const backgroundColor = this.getCurrentBackgroundColor();
    if (backgroundColor) {
      wrapper.style.setProperty("--bg-top", backgroundColor);
      wrapper.style.setProperty("--bg-bottom", backgroundColor);
    }

    if (this.dataState.loading) {
      wrapper.classList.add("loading");
      wrapper.innerText = "Loading Clash of Clans village progress for " + this.getActivePlayerTag() + "...";
      return wrapper;
    }

    if (this.dataState.error) {
      wrapper.classList.add("error");
      wrapper.innerText = "Clash API error: " + this.dataState.error;
      return wrapper;
    }

    if (!this.dataState.payload) {
      wrapper.innerText = "No data available.";
      return wrapper;
    }

    const card = document.createElement("div");
    card.className = "coc-card";

    const heading = document.createElement("div");
    heading.className = "coc-heading";
    heading.innerHTML =
      "<h2>" + this.config.title + "</h2>" +
      "<div class='player-name'>" + this.escapeHtml(this.dataState.payload.player.name) + " (" + this.escapeHtml(this.dataState.payload.player.tag) + ")</div>";

    const gauges = document.createElement("div");
    gauges.className = "coc-gauges";
    gauges.innerHTML = this.renderCircularGauge(this.dataState.payload.homeVillage, "Home Village");

    if (this.config.showBuilderBase && this.dataState.payload.builderBase) {
      gauges.innerHTML += this.renderCircularGauge(this.dataState.payload.builderBase, "Builder Base");
    }

    if (this.config.compactMode) {
      card.appendChild(gauges);
      wrapper.appendChild(card);
      return wrapper;
    }

    const bars = document.createElement("div");
    bars.className = "coc-bars";
    bars.innerHTML = this.renderCategoryBars(this.dataState.payload.homeVillage.categories, "Home Breakdown");

    if (this.config.showBuilderBase && this.dataState.payload.builderBase) {
      bars.innerHTML += this.renderCategoryBars(this.dataState.payload.builderBase.categories, "Builder Breakdown");
    }

    const footer = document.createElement("div");
    footer.className = "coc-footer";
    footer.innerText = "Last updated: " + (this.dataState.updatedAt ? this.dataState.updatedAt.toLocaleTimeString() : "-");

    card.appendChild(heading);
    card.appendChild(gauges);
    card.appendChild(bars);
    card.appendChild(footer);
    wrapper.appendChild(card);

    return wrapper;
  },

  renderCircularGauge: function (progressData, label) {
    const pct = Math.max(0, Math.min(100, progressData.percent));
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    const strokeOffset = circumference * (1 - pct / 100);

    return [
      "<div class='coc-gauge'>",
      "<svg viewBox='0 0 120 120' class='coc-ring' role='img' aria-label='" + this.escapeHtml(label) + " completion " + pct.toFixed(1) + " percent'>",
      "<circle class='ring-bg' cx='60' cy='60' r='" + radius + "'></circle>",
      "<circle class='ring-fill' cx='60' cy='60' r='" + radius + "' style='stroke-dasharray:" + circumference.toFixed(2) + ";stroke-dashoffset:" + strokeOffset.toFixed(2) + ";'></circle>",
      "<text x='60' y='58' class='ring-value'>" + pct.toFixed(1) + "%</text>",
      "<text x='60' y='74' class='ring-sub'>" + this.escapeHtml(progressData.earned.toString()) + "/" + this.escapeHtml(progressData.total.toString()) + "</text>",
      "</svg>",
      "<div class='gauge-label'>" + this.escapeHtml(label) + "</div>",
      "<div class='gauge-meta'>TH " + this.escapeHtml(String(progressData.hallLevel || "-")) + "</div>",
      "</div>"
    ].join("");
  },

  renderCategoryBars: function (categories, heading) {
    let html = "<div class='bar-section'><div class='bar-heading'>" + this.escapeHtml(heading) + "</div>";

    categories.forEach((category) => {
      const pct = Math.max(0, Math.min(100, category.percent));
      html += [
        "<div class='bar-row'>",
        "<div class='bar-label'>" + this.escapeHtml(category.label) + "</div>",
        "<div class='bar-track'><div class='bar-fill' style='width:" + pct.toFixed(1) + "%'></div></div>",
        "<div class='bar-value'>" + pct.toFixed(0) + "%</div>",
        "</div>"
      ].join("");
    });

    html += "</div>";
    return html;
  },

  escapeHtml: function (text) {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };

    return String(text).replace(/[&<>"']/g, function (m) {
      return map[m];
    });
  }
});
