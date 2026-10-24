/*!
name: Workflow & Plugin Manager
icon: layout-grid
description: Control Obsidian plugins and Sync Engine modules by workflow profiles, sync layouts with workspaces, optimize boot times, and convert plugins to modules.
version: 1.0.10
readme: https://github.com/amarjt/sync-engine-modules
*/

// Retrieve Obsidian & Sync Engine bridges
function getObsidianApi() {
  if (typeof window !== "undefined") {
    if (window.syncEngineApiBridge?.ItemView) return window.syncEngineApiBridge;
    if (window.syncEngineApiBridge?.default?.ItemView) return window.syncEngineApiBridge.default;
    if (window.__obsidian_require__) {
      try {
        const obs = window.__obsidian_require__("obsidian");
        if (obs?.ItemView) return obs;
        if (obs?.default?.ItemView) return obs.default;
      } catch (_) {}
    }
    if (window.obsidian?.ItemView) return window.obsidian;
  }
  if (typeof require === "function") {
    try {
      const obs = require("obsidian");
      if (obs?.ItemView) return obs;
      if (obs?.default?.ItemView) return obs.default;
    } catch (_) {}
  }
  return (typeof window !== "undefined" ? window.syncEngineApiBridge : null) || {};
}

const obsidianApi = getObsidianApi();
const {
  Modal,
  ItemView,
  View,
  FuzzySuggestModal,
  Notice,
  Setting,
  ToggleComponent,
  PluginSettingTab,
  requestUrl,
  setIcon,
  Menu
} = obsidianApi || {};

const WORKFLOW_MANAGER_VIEW_TYPE = "workflow-manager-dashboard-view";

// FNV-1a Hash helper matching Sync Engine's internal hashing
function getVaultHash(name) {
  let t = JSON.stringify(name), n = 2166136261;
  for (let e = 0; e < t.length; e++) {
    n ^= t.charCodeAt(e);
    n = Math.imul(n, 16777619);
  }
  return (n >>> 0).toString(16);
}

// Universal Obsidian Module Loader Probe Fallback
async function ensureObsidianRequire(app) {
  if (typeof window !== "undefined" && typeof window.__obsidian_require__ === "function") {
    return window.__obsidian_require__;
  }
  if (typeof require === "function") {
    try {
      require("@codemirror/view");
      window.__obsidian_require__ = require;
      return require;
    } catch (_) {}
  }
  if (!app || !app.plugins) return null;
  try {
    const probeId = "__probe_req_" + Date.now();
    const origRead = app.vault.adapter.read;
    app.vault.adapter.read = async function(path) {
      if (path && path.includes(probeId)) {
        return "module.exports = class ProbePlugin { constructor(app) { if (typeof window !== 'undefined') window.__obsidian_require__ = require; } };";
      }
      return origRead.apply(this, arguments);
    };
    app.plugins.manifests[probeId] = { id: probeId, name: "Probe", version: "1.0.0", minAppVersion: "0.15.0", dir: probeId };
    await app.plugins.loadPlugin(probeId);
    try { await app.plugins.unloadPlugin(probeId); } catch (_) {}
    delete app.plugins.manifests[probeId];
    delete app.plugins.plugins[probeId];
    app.vault.adapter.read = origRead;
    return window.__obsidian_require__ || null;
  } catch (err) {
    return null;
  }
}

// -------------------------------------------------------------
// UI Modal: Quick Profile Switcher (Fuzzy Suggest)
// -------------------------------------------------------------
class WorkflowProfileSuggestModal extends (FuzzySuggestModal || class {}) {
  constructor(app, moduleInstance) {
    super(app);
    this.module = moduleInstance;
    this.setPlaceholder("Select a workflow profile to switch to...");
  }

  getItems() {
    return Object.keys(this.module.moduleSettings.profiles);
  }

  getItemText(item) {
    const profile = this.module.moduleSettings.profiles[item];
    const ws = profile.workspace ? ` [Workspace: ${profile.workspace}]` : "";
    const plugCount = profile.plugins ? Object.keys(profile.plugins).length : 0;
    const modCount = profile.modules ? Object.keys(profile.modules).length : 0;
    return `${item}${ws} (${plugCount} plugins, ${modCount} modules)`;
  }

  onChooseItem(item, evt) {
    this.module.switchProfile(item);
  }
}


const MenuClass = Menu || obsidianApi?.Menu || (typeof window !== "undefined" ? (window.obsidian?.Menu || window.syncEngineApiBridge?.Menu) : null);

function createContextMenu() {
  if (MenuClass) {
    try {
      return new MenuClass();
    } catch (_) {}
  }
  return {
    items: [],
    addItem(cb) {
      const item = {
        title: "",
        icon: "",
        disabled: false,
        warning: false,
        setTitle(t) { this.title = t; return this; },
        setIcon(i) { this.icon = i; return this; },
        setDisabled(d) { this.disabled = d; return this; },
        setWarning(w) { this.warning = w; return this; },
        onClick(fn) { this.action = fn; return this; }
      };
      cb(item);
      this.items.push(item);
      return this;
    },
    addSeparator() {
      this.items.push({ separator: true });
      return this;
    },
    showAtMouseEvent() {},
    showAtPosition() {}
  };
}

class EditModuleModal extends Modal {
  constructor(app, moduleMeta, onSave) {
    super(app);
    this.moduleMeta = { ...moduleMeta };
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("manager-edit-modal");

    this.titleEl.setText("Edit Module Information");

    new Setting(contentEl)
      .setName("Module ID")
      .setDesc("Unique identifier for this module file (read-only)")
      .addText((text) => {
        text.setValue(this.moduleMeta.id || "").setDisabled(true);
      });

    let nameInput;
    new Setting(contentEl)
      .setName("Name")
      .setDesc("Display name shown in module lists and cards")
      .addText((text) => {
        nameInput = text;
        text.setValue(this.moduleMeta.name || "").setPlaceholder("Enter module name");
      });

    let descInput;
    new Setting(contentEl)
      .setName("Description")
      .setDesc("Brief description of what this module does")
      .addTextArea((ta) => {
        descInput = ta;
        ta.setValue(this.moduleMeta.description || "").setPlaceholder("This module is...");
        ta.inputEl.rows = 3;
      });

    let iconInput;
    new Setting(contentEl)
      .setName("Icon")
      .setDesc("Lucide icon identifier (e.g. puzzle, zap, layers, layout-grid)")
      .addText((text) => {
        iconInput = text;
        text.setValue(this.moduleMeta.icon || "puzzle").setPlaceholder("puzzle");
      });

    let readmeInput;
    new Setting(contentEl)
      .setName("Readme URL")
      .setDesc("Link to module documentation or vault note")
      .addText((text) => {
        readmeInput = text;
        text.setValue(this.moduleMeta.readme || "").setPlaceholder("https://github.com/...");
      });

    const buttonRow = new Setting(contentEl);
    buttonRow.addButton((btn) => {
      btn.setButtonText("Cancel").onClick(() => this.close());
    });
    buttonRow.addButton((btn) => {
      btn
        .setButtonText("Save Changes")
        .setCta()
        .onClick(async () => {
          const updated = {
            ...this.moduleMeta,
            name: nameInput.getValue().trim() || this.moduleMeta.id,
            description: descInput.getValue().trim(),
            icon: iconInput.getValue().trim() || "puzzle",
            readme: readmeInput.getValue().trim() || undefined
          };
          this.close();
          if (this.onSave) await this.onSave(updated);
        });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// -------------------------------------------------------------
// Reusable Better Manager Dashboard Component
// Mounts into either a Standalone Popout Window (ItemView) or Modal
// -------------------------------------------------------------
class WorkflowManagerDashboardRenderer {
  constructor(app, moduleInstance) {
    this.app = app || moduleInstance?.ctx?.app || (typeof window !== "undefined" ? window.app : null);
    this.module = moduleInstance;
    this.activeTab = "items"; // "items" | "profiles" | "delayed" | "converter"
    this.filterStatus = "all"; // "all" | "enabled" | "disabled" | "modules" | "plugins" | "delayed"
    this.searchQuery = "";
    this.containerEl = null;
    this.chromeEl = null;
    this.pageEl = null;
    this.onPopoutCallback = null;
    this.onCloseCallback = null;
    this.isModalHost = false;
  }

  mount(hostEl, onCloseCallback = null, onPopoutCallback = null, isModalHost = false) {
    this.containerEl = hostEl;
    this.onCloseCallback = onCloseCallback;
    this.onPopoutCallback = onPopoutCallback;
    this.isModalHost = isModalHost;

    hostEl.empty();
    const shell = hostEl.createDiv("manager-modal-shell");
    this.chromeEl = shell.createDiv("manager-modal-chrome");
    this.headerSlot = this.chromeEl.createDiv("manager-chrome-slot manager-chrome-slot--header");
    this.toolbarSlot = this.chromeEl.createDiv("manager-chrome-slot manager-chrome-slot--toolbar");
    this.filterSlot = this.chromeEl.createDiv("manager-chrome-slot manager-chrome-slot--filters");
    this.pageEl = shell.createDiv("manager-item-container");

    this.renderHeader();
    this.renderToolbar();
    this.renderFilterSection();
    this.renderActiveTab();
  }

  unmount() {
    if (this.containerEl) {
      this.containerEl.empty();
      this.containerEl = null;
    }
  }

  openObsidianSetting(tabId, query = null) {
    // Only dismiss modal if running inside an in-vault modal dialog (never close popout window)
    if (this.isModalHost && typeof this.onCloseCallback === "function") {
      try {
        this.onCloseCallback();
      } catch (_) {}
    }

    const mainWindow = (typeof window !== "undefined" && window.electron?.remote?.BrowserWindow)
      ? window
      : (this.app?.workspace?.containerEl?.ownerDocument?.defaultView || (typeof window !== "undefined" ? window : null));

    if (mainWindow) {
      try {
        if (typeof mainWindow.focus === "function") mainWindow.focus();
      } catch (_) {}
      try {
        if (typeof activeWindow !== "undefined") activeWindow = mainWindow;
      } catch (_) {}
    }

    if (this.app?.setting) {
      try {
        if (typeof this.app.setting.open === "function") {
          this.app.setting.open();
        }
        if (tabId && typeof this.app.setting.openTabById === "function") {
          const tab = this.app.setting.openTabById(tabId);
          if (query && tab && typeof tab.setQuery === "function") {
            tab.setQuery(query);
          }
        }
      } catch (err) {
        console.error("[WorkflowManager] Failed to open Obsidian setting tab:", err);
      }
    }

    if (mainWindow && typeof mainWindow.focus === "function") {
      try {
        mainWindow.focus();
      } catch (_) {}
    }
  }

  openPluginOrModuleSettings(id) {
    // Only dismiss modal if running inside an in-vault modal dialog (never close popout window)
    if (this.isModalHost && typeof this.onCloseCallback === "function") {
      try {
        this.onCloseCallback();
      } catch (_) {}
    }

    const mainWindow = (typeof window !== "undefined" && window.electron?.remote?.BrowserWindow)
      ? window
      : (this.app?.workspace?.containerEl?.ownerDocument?.defaultView || (typeof window !== "undefined" ? window : null));

    if (mainWindow) {
      try {
        if (typeof mainWindow.focus === "function") mainWindow.focus();
      } catch (_) {}
      try {
        if (typeof activeWindow !== "undefined") activeWindow = mainWindow;
      } catch (_) {}
    }

    if (this.app?.setting?.open) {
      try {
        this.app.setting.open();
        const tab = this.app.setting.openTabById ? this.app.setting.openTabById(id) : null;
        if (!tab && this.app.setting.openTabById) {
          this.app.setting.openTabById("sync-engine");
        }
      } catch (err) {
        console.error("[WorkflowManager] Failed to open settings for " + id + ":", err);
      }
    }

    if (mainWindow && typeof mainWindow.focus === "function") {
      try {
        mainWindow.focus();
      } catch (_) {}
    }
  }

  renderHeader() {
    if (!this.headerSlot) return;
    this.headerSlot.empty();

    const titleBar = this.headerSlot.createDiv("manager-header");
    const identity = titleBar.createDiv("manager-header__identity");
    const mark = identity.createDiv("manager-header__mark");
    if (typeof setIcon === "function") {
      setIcon(mark, "blocks");
    } else {
      mark.setText("⚡");
    }

    // Redesigned non-redundant Title Section
    const titleGroup = identity.createDiv("manager-header__title-group");
    titleGroup.createEl("h2", { cls: "manager-header__title", text: "Workflow & Plugin Manager" });
    titleGroup.createDiv({ cls: "manager-header__subtitle", text: "Profiles, Fast Boot & Module Extensions" });

    // Stats pill
    const statsEl = titleBar.createDiv("manager-header__stats");
    const plugTotal = Object.keys(this.app.plugins?.manifests || {}).length;
    const plugEnabled = this.app.plugins?.enabledPlugins?.size || 0;
    const modTotal = this.module.ctx?.discoveredModules?.size || 0;
    const activeProf = this.module.moduleSettings.activeProfile || "Default";

    statsEl.createSpan({ cls: "manager-stat-pill is-accent", text: `Profile: ${activeProf}` });
    statsEl.createSpan({ cls: "manager-stat-pill", text: `${plugEnabled}/${plugTotal} Plugins Active` });
    statsEl.createSpan({ cls: "manager-stat-pill", text: `${modTotal} Modules` });

    // Header popout button: icon-only with Obsidian native aria-label (NO "Popout" text)
    if (this.onPopoutCallback) {
      const popoutBtn = statsEl.createEl("button", {
        cls: "manager-action-btn manager-action-btn--icon-only",
        attr: { "aria-label": "Open in Dedicated Window" }
      });
      if (typeof setIcon === "function") setIcon(popoutBtn, "external-link");
      else popoutBtn.setText("↗");
      popoutBtn.addEventListener("click", () => this.onPopoutCallback());
    }

    // Redundant top-right close/cancel button removed per user request
  }

  renderToolbar() {
    if (!this.toolbarSlot) return;
    this.toolbarSlot.empty();

    const actionWrapper = this.toolbarSlot.createDiv("manager-section manager-section--actions");
    const toolbar = actionWrapper.createDiv("manager-toolbar");
    const tabs = toolbar.createDiv("manager-toolbar__tabs");

    const addTab = (id, label, icon) => {
      const tab = tabs.createEl("button", {
        cls: `manager-toolbar__tab ${this.activeTab === id ? "is-active" : ""}`,
        attr: {
          "aria-label": label,
          "aria-selected": this.activeTab === id ? "true" : "false",
          role: "tab"
        }
      });
      tab.type = "button";
      if (typeof setIcon === "function") {
        const iconSpan = tab.createSpan();
        setIcon(iconSpan, icon);
      }
      tab.createSpan({ text: label });
      tab.addEventListener("click", () => {
        this.activeTab = id;
        this.renderToolbar();
        this.renderFilterSection();
        this.renderActiveTab();
      });
    };

    addTab("items", "Plugins & Modules", "blocks");
    addTab("profiles", "Workflow Profiles", "workflow");
    addTab("delayed", "Delayed Startup", "zap");
    addTab("converter", "Plugin Converter", "wrench");

    const tools = toolbar.createDiv("manager-toolbar__tools");

    // Refresh tool: Reload Plugins & Modules (Obsidian native aria-label ONLY)
    const refreshBtn = tools.createEl("button", {
      cls: "manager-action-btn",
      attr: {
        "aria-label": "Reload Plugins & Modules"
      }
    });
    if (typeof setIcon === "function") setIcon(refreshBtn, "refresh-ccw");
    else refreshBtn.setText("↻");
    refreshBtn.createSpan({ text: "Reload" });
    refreshBtn.addEventListener("click", async () => {
      try {
        if (this.app.plugins?.loadManifests) await this.app.plugins.loadManifests();
        if (this.module.ctx?.loadDiscoveredModules) await this.module.ctx.loadDiscoveredModules();
        new Notice("✓ Reloaded plugins and modules catalog.");
        this.renderHeader();
        this.renderFilterSection();
        this.renderActiveTab();
      } catch (e) {
        new Notice("Reload failed: " + e.message);
      }
    });

    // Save tool: Save Current Setup (Obsidian native aria-label ONLY)
    const snapBtn = tools.createEl("button", {
      cls: "manager-action-btn",
      attr: {
        "aria-label": "Save Current Setup"
      }
    });
    if (typeof setIcon === "function") setIcon(snapBtn, "save");
    else snapBtn.setText("💾");
    snapBtn.createSpan({ text: "Save Setup" });
    snapBtn.addEventListener("click", async () => {
      const name = prompt("Enter profile name to save current setup:", "My Workflow");
      if (name && name.trim()) {
        await this.module.snapshotProfile(name.trim());
        new Notice(`✓ Saved current setup as profile '${name.trim()}'.`);
        this.renderHeader();
        this.renderFilterSection();
        this.renderActiveTab();
      }
    });
  }

  renderFilterSection() {
    if (!this.filterSlot) return;
    this.filterSlot.empty();

    if (this.activeTab !== "items" && this.activeTab !== "converter") {
      return;
    }

    const filterWrapper = this.filterSlot.createDiv("manager-section manager-section--filters");
    filterWrapper.style.flexDirection = "column";
    filterWrapper.style.alignItems = "stretch";

    // Search line
    const searchLine = filterWrapper.createDiv("manager-search-line");
    const inputWrapper = searchLine.createDiv("manager-search-input-wrapper");
    const iconSpan = inputWrapper.createSpan("manager-search-icon");
    if (typeof setIcon === "function") setIcon(iconSpan, "search");
    else iconSpan.setText("🔍");

    const searchInput = inputWrapper.createEl("input", {
      cls: "manager-search-input",
      attr: {
        type: "text",
        placeholder: this.activeTab === "items" ? "Search plugins, modules, authors, tags..." : "Search plugins to convert...",
        value: this.searchQuery
      }
    });
    searchInput.style.paddingLeft = "38px";
    searchInput.addEventListener("input", (e) => {
      this.searchQuery = e.target.value.toLowerCase().trim();
      this.renderActiveTab();
    });

    if (this.searchQuery) {
      const clearSpan = inputWrapper.createSpan("manager-search-clear");
      if (typeof setIcon === "function") setIcon(clearSpan, "x");
      else clearSpan.setText("×");
      clearSpan.addEventListener("click", () => {
        this.searchQuery = "";
        searchInput.value = "";
        this.renderActiveTab();
      });
    }

    // Filter chips (for items tab)
    if (this.activeTab === "items") {
      const chipsEl = filterWrapper.createDiv("manager-filter-chips");
      const chipsList = chipsEl.createDiv("manager-filter-chips__list");
      const chips = [
        { id: "all", label: "All" },
        { id: "enabled", label: "Enabled" },
        { id: "disabled", label: "Disabled" },
        { id: "modules", label: "Modules" },
        { id: "plugins", label: "Plugins" },
        { id: "delayed", label: "Delayed ⚡" }
      ];

      chips.forEach((c) => {
        const chipBtn = chipsList.createEl("button", {
          cls: `manager-chip ${this.filterStatus === c.id ? "is-active" : ""}`,
          text: c.label
        });
        chipBtn.addEventListener("click", () => {
          this.filterStatus = c.id;
          this.renderFilterSection();
          this.renderActiveTab();
        });
      });

      // Direct shortcuts to Obsidian Community Plugins & Sync Engine Settings
      const navGroup = chipsEl.createDiv("manager-filter-chips__nav");

      const obsPluginsBtn = navGroup.createEl("button", {
        cls: "manager-action-btn manager-action-btn--nav",
        attr: { "aria-label": "Open Obsidian Community Plugins Manager" }
      });
      if (typeof setIcon === "function") setIcon(obsPluginsBtn, "puzzle");
      obsPluginsBtn.createSpan({ text: "Community Plugins" });
      obsPluginsBtn.addEventListener("click", () => {
        this.openObsidianSetting("community-plugins");
      });

      const syncEngineBtn = navGroup.createEl("button", {
        cls: "manager-action-btn manager-action-btn--nav",
        attr: { "aria-label": "Open Sync Engine Module Management" }
      });
      if (typeof setIcon === "function") setIcon(syncEngineBtn, "layers");
      syncEngineBtn.createSpan({ text: "Sync Engine" });
      syncEngineBtn.addEventListener("click", () => {
        this.openObsidianSetting("sync-engine");
      });
    }
  }

  renderActiveTab() {
    this.pageEl.empty();

    if (this.activeTab === "items") {
      this.renderItemsTab();
    } else if (this.activeTab === "profiles") {
      this.renderProfilesTab();
    } else if (this.activeTab === "delayed") {
      this.renderDelayedTab();
    } else if (this.activeTab === "converter") {
      this.renderConverterTab();
    }
  }

  // Tab 1: Plugins & Modules Unified Dashboard
  renderItemsTab() {
    const manifests = this.app.plugins?.manifests || {};
    const enabledPlugins = this.app.plugins?.enabledPlugins || new Set();
    const discoveredMods = this.module.ctx?.discoveredModules || new Map();
    const modSettings = this.module.ctx?.settings?.modules || {};
    const delayedSet = new Set((this.module.moduleSettings.delayedPlugins || []).map((p) => p.id));

    const allItems = [];

    // Modules
    for (const [id, meta] of discoveredMods.entries()) {
      const isEnabled = modSettings[id]?.enabled ?? true;
      const isDelayed = delayedSet.has(id);
      allItems.push({
        id,
        type: "module",
        name: meta.name || id,
        description: meta.description || "Sync Engine standalone module",
        author: meta.author || "Sync Engine",
        version: meta.version || "1.0.0",
        icon: meta.icon || "layers",
        readme: meta.readme || "",
        rawMeta: meta,
        isEnabled,
        isDelayed
      });
    }

    // Plugins
    for (const [id, m] of Object.entries(manifests)) {
      const isEnabled = enabledPlugins.has(id);
      const isDelayed = delayedSet.has(id);
      allItems.push({
        id,
        type: "plugin",
        name: m.name || id,
        description: m.description || "",
        author: m.author || "",
        version: m.version || "",
        icon: "puzzle",
        manifest: m,
        isEnabled,
        isDelayed
      });
    }

    // Filter items
    const filtered = allItems.filter((item) => {
      // Query filter
      if (this.searchQuery) {
        const matchesQuery =
          item.name.toLowerCase().includes(this.searchQuery) ||
          item.id.toLowerCase().includes(this.searchQuery) ||
          item.description.toLowerCase().includes(this.searchQuery) ||
          item.author.toLowerCase().includes(this.searchQuery);
        if (!matchesQuery) return false;
      }

      // Status chip filter
      if (this.filterStatus === "enabled") return item.isEnabled;
      if (this.filterStatus === "disabled") return !item.isEnabled;
      if (this.filterStatus === "modules") return item.type === "module";
      if (this.filterStatus === "plugins") return item.type === "plugin";
      if (this.filterStatus === "delayed") return item.isDelayed;
      return true;
    });

    if (filtered.length === 0) {
      const emptyBox = this.pageEl.createDiv();
      emptyBox.style.padding = "40px";
      emptyBox.style.textAlign = "center";
      emptyBox.style.color = "var(--text-muted)";
      emptyBox.setText("No plugins or modules matched your search.");
      return;
    }

    filtered.forEach((item) => {
      const card = this.pageEl.createDiv("manager-card");

      // Left info
      const left = card.createDiv("manager-card__left");
      const iconBox = left.createDiv("manager-card__icon");
      if (typeof setIcon === "function") setIcon(iconBox, item.icon);
      else iconBox.setText(item.type === "module" ? "⚙" : "🧩");

      const info = left.createDiv("manager-card__info");
      const titleRow = info.createDiv("manager-card__title-row");
      titleRow.createSpan({ cls: "manager-card__title", text: item.name });

      // Badges
      if (item.type === "module") {
        titleRow.createSpan({ cls: "manager-tag manager-tag--module", text: "MODULE" });
      } else {
        titleRow.createSpan({ cls: "manager-tag manager-tag--plugin", text: "PLUGIN" });
      }

      if (item.isDelayed) {
        const delayEntry = (this.module.moduleSettings.delayedPlugins || []).find((p) => p.id === item.id);
        const delaySec = delayEntry ? (delayEntry.delayMs / 1000).toFixed(1) : "3";
        titleRow.createSpan({ cls: "manager-tag manager-tag--delay", text: `⚡ ${delaySec}s` });
      }

      if (item.version) {
        titleRow.createSpan({ cls: "manager-card__meta", text: `v${item.version}` });
      }

      if (item.description) {
        info.createDiv({ cls: "manager-card__desc", text: item.description });
      }

      if (item.author) {
        info.createDiv({ cls: "manager-card__meta", text: `By ${item.author} · ${item.id}` });
      }

      // Right controls
      const right = card.createDiv("manager-card__right");

      if (item.type === "module") {
        // Module Card Actions (matching Sync Engine's module management section & Community Plugin Manager)

        // 1. Open Readme (if available)
        if (item.readme) {
          const readmeBtn = right.createEl("button", {
            cls: "manager-action-btn manager-action-btn--icon-only",
            attr: { "aria-label": "Open Readme" }
          });
          if (typeof setIcon === "function") setIcon(readmeBtn, "book-open-text");
          else readmeBtn.setText("📖");
          readmeBtn.addEventListener("click", () => {
            if (item.readme.startsWith("http://") || item.readme.startsWith("https://")) {
              window.open(item.readme, "_blank");
            } else {
              const file = this.app.vault.getAbstractFileByPath(item.readme);
              if (file) this.app.workspace.getLeaf(false).openFile(file);
              else window.open(item.readme, "_blank");
            }
          });
        }

        // 2. Settings button (if module has settings tab or is registered in Obsidian)
        const hasModuleSettings = Boolean(
          this.app.setting?.pluginTabs?.some((t) => t.id === item.id) ||
          this.app.setting?.settingTabs?.some((t) => t.id === item.id) ||
          this.app.plugins?.plugins?.[item.id] !== undefined
        );
        if (hasModuleSettings) {
          const settingsBtn = right.createEl("button", {
            cls: "manager-action-btn manager-action-btn--icon-only",
            attr: { "aria-label": "Open module settings" }
          });
          if (typeof setIcon === "function") setIcon(settingsBtn, "settings");
          else settingsBtn.setText("⚙");
          settingsBtn.addEventListener("click", () => {
            this.openPluginOrModuleSettings(item.id);
          });
        }

        // 3. Edit Module Information
        const editBtn = right.createEl("button", {
          cls: "manager-action-btn manager-action-btn--icon-only",
          attr: { "aria-label": "Edit module information" }
        });
        if (typeof setIcon === "function") setIcon(editBtn, "pencil");
        else editBtn.setText("✏");
        editBtn.addEventListener("click", () => {
          new EditModuleModal(this.app, item.rawMeta || item, async (updated) => {
            try {
              if (typeof this.module.ctx?.updateModuleMeta === "function") {
                await this.module.ctx.updateModuleMeta(updated);
              } else {
                if (this.module.ctx?.discoveredModules) {
                  this.module.ctx.discoveredModules.set(updated.id, updated);
                }
                if (this.module.ctx?.moduleStore?.set) {
                  await this.module.ctx.moduleStore.set(updated.id, updated);
                }
                if (this.module.ctx?.saveSettings) {
                  await this.module.ctx.saveSettings();
                }
              }
              new Notice(`Updated module info for '${updated.name}'.`);
              this.renderHeader();
              this.renderActiveTab();
            } catch (err) {
              new Notice(`Failed to update module: ${err.message}`);
            }
          }).open();
        });

        // 4. Delete Module
        const deleteBtn = right.createEl("button", {
          cls: "manager-action-btn manager-action-btn--icon-only manager-action-btn--danger",
          attr: { "aria-label": "Delete module" }
        });
        if (typeof setIcon === "function") setIcon(deleteBtn, "trash-2");
        else deleteBtn.setText("🗑");
        deleteBtn.addEventListener("click", async () => {
          const confirmed = confirm(`Are you sure you want to delete module '${item.name}' (${item.id})?\n\nThis will remove the module script from your vault.`);
          if (!confirmed) return;
          try {
            if (typeof this.module.ctx?.deleteModule === "function") {
              await this.module.ctx.deleteModule(item.id);
            } else {
              if (typeof this.module.ctx?.unloadModule === "function") {
                this.module.ctx.unloadModule(item.id);
              }
              const modPath = `${this.app.vault.configDir}/plugins/sync-engine/modules/${item.id}.js`;
              if (await this.app.vault.adapter.exists(modPath)) {
                await this.app.vault.adapter.remove(modPath);
              }
              if (this.module.ctx?.discoveredModules) {
                this.module.ctx.discoveredModules.delete(item.id);
              }
              if (this.module.ctx?.moduleStore?.delete) {
                await this.module.ctx.moduleStore.delete(item.id);
              }
              if (this.module.ctx?.saveSettings) {
                await this.module.ctx.saveSettings();
              }
            }
            new Notice(`Deleted module '${item.name}'.`);
            this.renderHeader();
            this.renderActiveTab();
          } catch (err) {
            new Notice(`Failed to delete module: ${err.message}`);
          }
        });

        // 5. More Options Context Menu
        const moreBtn = right.createEl("button", {
          cls: "manager-action-btn manager-action-btn--icon-only",
          attr: { "aria-label": "More options" }
        });
        if (typeof setIcon === "function") setIcon(moreBtn, "more-vertical");
        else moreBtn.setText("⋮");
        moreBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          evt.preventDefault();
          const menu = createContextMenu();

          // Open Module Settings
          if (hasModuleSettings) {
            menu.addItem((menuItem) => {
              menuItem
                .setTitle("Open Module Settings")
                .setIcon("settings")
                .onClick(() => {
                  this.openPluginOrModuleSettings(item.id);
                });
            });
          }

          // Open in Sync Engine Settings
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Open in Sync Engine Settings")
              .setIcon("sliders-horizontal")
              .onClick(() => {
                this.openObsidianSetting("sync-engine");
              });
          });

          // Show Module File
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Show Module File")
              .setIcon("folder-open")
              .onClick(() => {
                const modPath = `${this.app.vault.configDir}/plugins/sync-engine/modules/${item.id}.js`;
                if (typeof this.app.showInFolder === "function") {
                  this.app.showInFolder(modPath);
                } else if (typeof this.app.openWithDefaultApp === "function") {
                  this.app.openWithDefaultApp(modPath);
                }
              });
          });

          // Edit Module Information
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Edit Module Information")
              .setIcon("pencil")
              .onClick(() => {
                editBtn.click();
              });
          });

          // Open Readme
          if (item.readme) {
            menu.addItem((menuItem) => {
              menuItem
                .setTitle("Open Readme")
                .setIcon("book-open-text")
                .onClick(() => {
                  if (item.readme.startsWith("http://") || item.readme.startsWith("https://")) {
                    window.open(item.readme, "_blank");
                  } else {
                    const file = this.app.vault.getAbstractFileByPath(item.readme);
                    if (file) this.app.workspace.getLeaf(false).openFile(file);
                    else window.open(item.readme, "_blank");
                  }
                });
            });
          }

          // Delete Module
          menu.addSeparator();
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Delete Module")
              .setIcon("trash-2");
            if (typeof menuItem.setWarning === "function") menuItem.setWarning(true);
            menuItem.onClick(() => {
              deleteBtn.click();
            });
          });

          if (typeof MouseEvent !== "undefined" && evt instanceof MouseEvent) {
            menu.showAtMouseEvent(evt);
          } else {
            const rect = moreBtn.getBoundingClientRect();
            menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
          }
        });

        // 5. Toggle switch
        const toggleWrapper = right.createDiv();
        const toggle = new ToggleComponent(toggleWrapper);
        toggle.setValue(item.isEnabled);
        toggle.onChange(async (val) => {
          try {
            await this.module.toggleModule(item.id, val);
            item.isEnabled = val;
            this.renderHeader();
          } catch (err) {
            new Notice(`Failed to toggle ${item.name}: ${err.message}`);
            toggle.setValue(!val);
          }
        });

      } else {
        // Plugin Card Actions (matching Obsidian's native community plugin manager)

        // 1. Convert button
        const convertBtn = right.createEl("button", {
          cls: "manager-action-btn",
          attr: { "aria-label": "Convert to Sync Engine Module" }
        });
        if (typeof setIcon === "function") setIcon(convertBtn, "wrench");
        convertBtn.createSpan({ text: "Convert" });
        convertBtn.addEventListener("click", () => {
          this.activeTab = "converter";
          this.searchQuery = item.id;
          this.renderToolbar();
          this.renderFilterSection();
          this.renderActiveTab();
        });

        // 2. Delay toggle button
        const delayBtn = right.createEl("button", {
          cls: `manager-action-btn ${item.isDelayed ? "is-cta" : ""}`,
          attr: { "aria-label": item.isDelayed ? "Configure Startup Delay" : "Add to Delayed Startup" }
        });
        if (typeof setIcon === "function") setIcon(delayBtn, "zap");
        delayBtn.createSpan({ text: item.isDelayed ? "Delayed" : "Delay" });
        delayBtn.addEventListener("click", async () => {
          if (item.isDelayed) {
            this.module.moduleSettings.delayedPlugins = (this.module.moduleSettings.delayedPlugins || []).filter((p) => p.id !== item.id);
            new Notice(`Removed '${item.name}' from delayed startup.`);
          } else {
            const delayStr = prompt(`Set startup delay for '${item.name}' in milliseconds:`, "3000");
            if (delayStr && parseInt(delayStr, 10)) {
              const delayMs = parseInt(delayStr, 10);
              if (!this.module.moduleSettings.delayedPlugins) this.module.moduleSettings.delayedPlugins = [];
              this.module.moduleSettings.delayedPlugins.push({ id: item.id, delayMs });
              new Notice(`✓ '${item.name}' will load with ${delayMs}ms delay on startup.`);
            }
          }
          await this.module.saveSettings();
          this.renderActiveTab();
        });

        // 3. Settings gear
        const hasPluginSettings = Boolean(
          this.app.setting?.pluginTabs?.some((t) => t.id === item.id) ||
          this.app.setting?.settingTabs?.some((t) => t.id === item.id) ||
          this.app.plugins?.plugins?.[item.id] !== undefined
        );
        let settingBtn = null;
        if (hasPluginSettings) {
          settingBtn = right.createEl("button", {
            cls: "manager-action-btn manager-action-btn--icon-only",
            attr: { "aria-label": "Options" }
          });
          if (typeof setIcon === "function") setIcon(settingBtn, "settings");
          else settingBtn.setText("⚙");
          settingBtn.addEventListener("click", () => {
            this.openPluginOrModuleSettings(item.id);
          });
        }

        // 4. More Options Context Menu
        const moreBtn = right.createEl("button", {
          cls: "manager-action-btn manager-action-btn--icon-only",
          attr: { "aria-label": "More options" }
        });
        if (typeof setIcon === "function") setIcon(moreBtn, "more-vertical");
        else moreBtn.setText("⋮");
        moreBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          evt.preventDefault();
          const menu = createContextMenu();

          // Options / Settings
          if (hasPluginSettings) {
            menu.addItem((menuItem) => {
              menuItem
                .setTitle("Settings")
                .setIcon("settings")
                .onClick(() => {
                  this.openPluginOrModuleSettings(item.id);
                });
            });
          }

          // Hotkeys
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Hotkeys")
              .setIcon("keyboard")
              .onClick(() => {
                this.openObsidianSetting("hotkeys", item.name || item.id);
              });
          });

          // Open Community Page
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Open Community Page")
              .setIcon("globe")
              .onClick(() => {
                window.open(`https://community.obsidian.md/plugins/${item.id}`, "_blank");
              });
          });

          // Show in Folder
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Show in Folder")
              .setIcon("folder-open")
              .onClick(() => {
                const manifest = this.app.plugins?.manifests?.[item.id];
                const dir = manifest?.dir || `${this.app.vault.configDir}/plugins/${item.id}`;
                if (typeof this.app.showInFolder === "function") {
                  this.app.showInFolder(dir);
                } else if (typeof this.app.openWithDefaultApp === "function") {
                  this.app.openWithDefaultApp(dir);
                }
              });
          });

          // Open in Community Plugins
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Open in Community Plugins")
              .setIcon("puzzle")
              .onClick(() => {
                this.openObsidianSetting("community-plugins");
              });
          });

          // Convert to Module
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Convert to Module")
              .setIcon("wrench")
              .onClick(async () => {
                const confirmed = confirm(`Are you sure you want to convert plugin '${item.name}' (${item.id}) into a Sync Engine module?\n\nThis will wrap the plugin into a standalone module and disable the original community plugin.`);
                if (!confirmed) return;
                try {
                  const notice = new Notice(`Converting '${item.name}' to module...`, 0);
                  const result = await this.module.convertPluginToModule(item.id, { disableOriginal: true });
                  if (typeof notice.hide === "function") notice.hide();
                  new Notice(`✓ Successfully converted '${result.name}' to module!`);
                  this.renderHeader();
                  this.renderActiveTab();
                } catch (err) {
                  console.error("Conversion failed:", err);
                  new Notice(`Conversion error: ${err.message}`, 6000);
                }
              });
          });

          // Delay Startup
          menu.addItem((menuItem) => {
            menuItem
              .setTitle(item.isDelayed ? "Remove Startup Delay" : "Delay Startup")
              .setIcon("zap")
              .onClick(() => {
                delayBtn.click();
              });
          });

          // Uninstall
          menu.addSeparator();
          menu.addItem((menuItem) => {
            menuItem
              .setTitle("Uninstall")
              .setIcon("trash-2");
            if (typeof menuItem.setWarning === "function") menuItem.setWarning(true);
            menuItem.onClick(async () => {
              const confirmed = confirm(`Are you sure you want to uninstall plugin '${item.name}' (${item.id})?`);
              if (!confirmed) return;
              try {
                await this.app.plugins.uninstallPlugin(item.id);
                new Notice(`Uninstalled plugin '${item.name}'.`);
                this.renderHeader();
                this.renderActiveTab();
              } catch (err) {
                new Notice(`Failed to uninstall plugin: ${err.message}`);
              }
            });
          });

          if (typeof MouseEvent !== "undefined" && evt instanceof MouseEvent) {
            menu.showAtMouseEvent(evt);
          } else {
            const rect = moreBtn.getBoundingClientRect();
            menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
          }
        });

        // 5. Toggle switch
        const toggleWrapper = right.createDiv();
        const toggle = new ToggleComponent(toggleWrapper);
        toggle.setValue(item.isEnabled);
        toggle.onChange(async (val) => {
          try {
            if (val) {
              await this.app.plugins.enablePluginAndSave(item.id);
            } else {
              await this.app.plugins.disablePluginAndSave(item.id);
            }
            item.isEnabled = val;
            this.renderHeader();
          } catch (err) {
            new Notice(`Failed to toggle ${item.name}: ${err.message}`);
            toggle.setValue(!val);
          }
        });
      }
    });
  }

  // Tab 2: Workflow Profiles
  renderProfilesTab() {
    const profiles = this.module.moduleSettings.profiles || {};
    const activeProf = this.module.moduleSettings.activeProfile || "Default";

    const topSection = this.pageEl.createDiv();
    topSection.style.display = "flex";
    topSection.style.alignItems = "center";
    topSection.style.justifyContent = "space-between";
    topSection.style.marginBottom = "14px";

    topSection.createEl("h3", { text: "Configured Workflow Profiles", cls: "m-0" });

    const newBtn = topSection.createEl("button", { cls: "manager-action-btn is-cta" });
    if (typeof setIcon === "function") setIcon(newBtn, "plus");
    newBtn.createSpan({ text: "Create Profile" });
    newBtn.addEventListener("click", async () => {
      const name = prompt("Enter a name for the new workflow profile:", "Coding Workflow");
      if (name && name.trim()) {
        await this.module.snapshotProfile(name.trim());
        new Notice(`✓ Created workflow profile '${name.trim()}'`);
        this.renderProfilesTab();
      }
    });

    for (const [profName, prof] of Object.entries(profiles)) {
      const isActive = profName === activeProf;
      const card = this.pageEl.createDiv("manager-card");

      const left = card.createDiv("manager-card__left");
      const iconBox = left.createDiv("manager-card__icon");
      if (typeof setIcon === "function") setIcon(iconBox, "workflow");
      else iconBox.setText("⚡");

      const info = left.createDiv("manager-card__info");
      const titleRow = info.createDiv("manager-card__title-row");
      titleRow.createSpan({ cls: "manager-card__title", text: profName });

      if (isActive) {
        titleRow.createSpan({ cls: "manager-tag manager-tag--module", text: "ACTIVE" });
      }

      const plugCount = prof.plugins ? Object.keys(prof.plugins).filter((k) => prof.plugins[k]).length : 0;
      const modCount = prof.modules ? Object.keys(prof.modules).filter((k) => prof.modules[k]).length : 0;
      const wsText = prof.workspace ? `Workspace: "${prof.workspace}"` : "No workspace linked";

      info.createDiv({ cls: "manager-card__desc", text: `${wsText} · ${plugCount} active plugins · ${modCount} active modules` });

      const right = card.createDiv("manager-card__right");

      // Link workspace button
      const linkWsBtn = right.createEl("button", { cls: "manager-action-btn", attr: { "aria-label": "Bind to Obsidian Workspace" } });
      if (typeof setIcon === "function") setIcon(linkWsBtn, "layout");
      linkWsBtn.createSpan({ text: "Workspace" });
      linkWsBtn.addEventListener("click", async () => {
        const wsName = prompt(`Enter Obsidian workspace name for profile '${profName}' (leave blank to unlink):`, prof.workspace || "");
        if (wsName !== null) {
          prof.workspace = wsName.trim();
          await this.module.saveSettings();
          this.renderProfilesTab();
        }
      });

      // Update snapshot button
      const updateBtn = right.createEl("button", { cls: "manager-action-btn", attr: { "aria-label": "Save current vault setup to this profile" } });
      if (typeof setIcon === "function") setIcon(updateBtn, "save");
      updateBtn.createSpan({ text: "Update" });
      updateBtn.addEventListener("click", async () => {
        await this.module.snapshotProfile(profName);
        new Notice(`✓ Updated profile '${profName}' snapshot.`);
        this.renderProfilesTab();
      });

      // Activate button
      const actBtn = right.createEl("button", {
        cls: `manager-action-btn ${isActive ? "" : "is-cta"}`,
        attr: { disabled: isActive ? "true" : undefined }
      });
      if (typeof setIcon === "function") setIcon(actBtn, isActive ? "check" : "play");
      actBtn.createSpan({ text: isActive ? "Active" : "Activate" });
      actBtn.addEventListener("click", async () => {
        if (!isActive) {
          await this.module.switchProfile(profName);
          new Notice(`✓ Switched to profile '${profName}'`);
          this.renderHeader();
          this.renderProfilesTab();
        }
      });

      // Delete button (if not Default)
      if (profName !== "Default") {
        const delBtn = right.createEl("button", { cls: "manager-action-btn", attr: { "aria-label": "Delete profile" } });
        if (typeof setIcon === "function") setIcon(delBtn, "trash");
        delBtn.addEventListener("click", async () => {
          if (confirm(`Delete workflow profile '${profName}'?`)) {
            delete profiles[profName];
            await this.module.saveSettings();
            this.renderProfilesTab();
          }
        });
      }
    }
  }

  // Tab 3: Delayed Startup (BPM)
  renderDelayedTab() {
    const delayed = this.module.moduleSettings.delayedPlugins || [];

    const topSection = this.pageEl.createDiv();
    topSection.style.marginBottom = "14px";
    topSection.createEl("h3", { text: "Delayed Startup Optimization (BPM Engine)", cls: "m-0" });
    const desc = topSection.createEl("p", { cls: "text-muted" });
    desc.setText("Stagger the background loading of heavy community plugins after Obsidian startup to dramatically speed up cold launch times.");

    const addSection = this.pageEl.createDiv();
    addSection.style.display = "flex";
    addSection.style.gap = "8px";
    addSection.style.marginBottom = "16px";

    const addBtn = addSection.createEl("button", { cls: "manager-action-btn is-cta" });
    if (typeof setIcon === "function") setIcon(addBtn, "plus");
    addBtn.createSpan({ text: "Add Plugin to Delayed Startup" });
    addBtn.addEventListener("click", async () => {
      const manifests = this.app.plugins?.manifests || {};
      const pluginIds = Object.keys(manifests);
      const plugId = prompt(`Enter plugin ID to delay (available: ${pluginIds.slice(0, 10).join(", ")}...):`);
      if (plugId && manifests[plugId.trim()]) {
        const delayStr = prompt(`Startup delay in milliseconds for '${manifests[plugId.trim()].name}':`, "3000");
        const delayMs = parseInt(delayStr, 10) || 3000;
        this.module.moduleSettings.delayedPlugins = (this.module.moduleSettings.delayedPlugins || []).filter((p) => p.id !== plugId.trim());
        this.module.moduleSettings.delayedPlugins.push({ id: plugId.trim(), delayMs });
        await this.module.saveSettings();
        new Notice(`✓ Added '${plugId.trim()}' with ${delayMs}ms delay.`);
        this.renderDelayedTab();
      } else if (plugId) {
        new Notice(`Plugin ID '${plugId}' not found.`);
      }
    });

    if (delayed.length === 0) {
      const empty = this.pageEl.createDiv();
      empty.style.padding = "30px";
      empty.style.textAlign = "center";
      empty.style.color = "var(--text-muted)";
      empty.setText("No plugins currently configured for delayed startup.");
      return;
    }

    delayed.forEach((entry) => {
      const card = this.pageEl.createDiv("manager-card");
      const m = this.app.plugins?.manifests?.[entry.id] || { name: entry.id };

      const left = card.createDiv("manager-card__left");
      const iconBox = left.createDiv("manager-card__icon");
      if (typeof setIcon === "function") setIcon(iconBox, "zap");
      else iconBox.setText("⚡");

      const info = left.createDiv("manager-card__info");
      const titleRow = info.createDiv("manager-card__title-row");
      titleRow.createSpan({ cls: "manager-card__title", text: m.name || entry.id });
      titleRow.createSpan({ cls: "manager-tag manager-tag--delay", text: `${entry.delayMs}ms` });

      info.createDiv({ cls: "manager-card__desc", text: `Post-startup delay: ${(entry.delayMs / 1000).toFixed(1)} seconds. ID: ${entry.id}` });

      const right = card.createDiv("manager-card__right");

      // Edit delay button
      const editBtn = right.createEl("button", { cls: "manager-action-btn", attr: { "aria-label": "Adjust delay timer" } });
      if (typeof setIcon === "function") setIcon(editBtn, "clock");
      editBtn.createSpan({ text: "Adjust" });
      editBtn.addEventListener("click", async () => {
        const val = prompt(`New delay in milliseconds for '${m.name}':`, `${entry.delayMs}`);
        if (val && parseInt(val, 10)) {
          entry.delayMs = parseInt(val, 10);
          await this.module.saveSettings();
          this.renderDelayedTab();
        }
      });

      // Remove button
      const removeBtn = right.createEl("button", { cls: "manager-action-btn", attr: { "aria-label": "Remove from delayed startup" } });
      if (typeof setIcon === "function") setIcon(removeBtn, "trash");
      removeBtn.addEventListener("click", async () => {
        this.module.moduleSettings.delayedPlugins = (this.module.moduleSettings.delayedPlugins || []).filter((p) => p.id !== entry.id);
        await this.module.saveSettings();
        this.renderDelayedTab();
      });
    });
  }

  // Tab 4: Plugin-to-Module Converter
  renderConverterTab() {
    const manifests = this.app.plugins?.manifests || {};
    const discovered = this.module.ctx?.discoveredModules || new Map();

    const topSection = this.pageEl.createDiv();
    topSection.style.marginBottom = "14px";
    topSection.createEl("h3", { text: "Convert Community Plugins into Standalone Sync Engine Modules", cls: "m-0" });
    const desc = topSection.createEl("p", { cls: "text-muted" });
    desc.setText("Wrap any installed Obsidian community plugin into a standalone Sync Engine module. Converted modules run inside Sync Engine's lifecycle, can be toggled per-workflow profile, and synced via Git/Cloud without community plugin overhead.");

    const pluginIds = Object.keys(manifests).sort();
    const filteredIds = pluginIds.filter((id) => {
      if (this.searchQuery) {
        const m = manifests[id] || {};
        return (
          id.toLowerCase().includes(this.searchQuery) ||
          (m.name && m.name.toLowerCase().includes(this.searchQuery)) ||
          (m.description && m.description.toLowerCase().includes(this.searchQuery))
        );
      }
      return true;
    });

    if (filteredIds.length === 0) {
      const empty = this.pageEl.createDiv();
      empty.style.padding = "30px";
      empty.style.textAlign = "center";
      empty.style.color = "var(--text-muted)";
      empty.setText("No plugins found to convert.");
      return;
    }

    filteredIds.forEach((id) => {
      const m = manifests[id] || { name: id };
      const isAlreadyConverted = discovered.has(id);

      const card = this.pageEl.createDiv("manager-card");

      const left = card.createDiv("manager-card__left");
      const iconBox = left.createDiv("manager-card__icon");
      if (typeof setIcon === "function") setIcon(iconBox, isAlreadyConverted ? "check-circle" : "puzzle");
      else iconBox.setText("🧩");

      const info = left.createDiv("manager-card__info");
      const titleRow = info.createDiv("manager-card__title-row");
      titleRow.createSpan({ cls: "manager-card__title", text: m.name || id });

      if (isAlreadyConverted) {
        titleRow.createSpan({ cls: "manager-tag manager-tag--module", text: "CONVERTED ✓" });
      }

      if (m.version) titleRow.createSpan({ cls: "manager-card__meta", text: `v${m.version}` });

      if (m.description) {
        info.createDiv({ cls: "manager-card__desc", text: m.description });
      }

      info.createDiv({ cls: "manager-card__meta", text: `ID: ${id} · Author: ${m.author || "Unknown"}` });

      const right = card.createDiv("manager-card__right");

      const convertBtn = right.createEl("button", {
        cls: `manager-action-btn ${isAlreadyConverted ? "" : "is-cta"}`,
        attr: { "aria-label": isAlreadyConverted ? "Re-convert plugin to Sync Engine module" : "Convert plugin to Sync Engine module" }
      });
      if (typeof setIcon === "function") setIcon(convertBtn, "wrench");
      const labelSpan = convertBtn.createSpan({ text: isAlreadyConverted ? "Re-Convert" : "Convert to Module" });

      convertBtn.addEventListener("click", async () => {
        convertBtn.disabled = true;
        labelSpan.setText("Converting...");
        try {
          const result = await this.module.convertPluginToModule(id, { disableOriginal: true });
          new Notice(`✓ Successfully converted '${result.name}' to module!`);
          this.renderHeader();
          this.renderActiveTab();
        } catch (err) {
          console.error("Conversion failed:", err);
          new Notice(`Conversion error: ${err.message}`, 6000);
          convertBtn.disabled = false;
          labelSpan.setText(isAlreadyConverted ? "Re-Convert" : "Convert to Module");
        }
      });
    });
  }
}

// -------------------------------------------------------------
// UI View: Dedicated Popout Window (ItemView)
// -------------------------------------------------------------
class WorkflowManagerView extends (ItemView || View || class {}) {
  constructor(leaf, moduleInstance) {
    super(leaf);
    this.navigation = false;
    this.app = leaf?.app || moduleInstance?.ctx?.app || (typeof window !== "undefined" ? window.app : null);
    this.module = moduleInstance;
    this.renderer = new WorkflowManagerDashboardRenderer(this.app, this.module);
  }

  getViewType() {
    return WORKFLOW_MANAGER_VIEW_TYPE;
  }

  getDisplayText() {
    return "Workflow & Plugin Manager";
  }

  getIcon() {
    return "layout-grid";
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("manager-view-container");
    // isModalHost = false: Popout window stays open and focused when opening settings
    this.renderer.mount(contentEl, null, null, false);
  }

  async onClose() {
    this.renderer.unmount();
    this.contentEl.empty();
  }
}

// -------------------------------------------------------------
// UI Modal: Quick Modal Dialog
// -------------------------------------------------------------
class WorkflowManagerDashboardModal extends (Modal || class {}) {
  constructor(app, moduleInstance) {
    super(app);
    this.module = moduleInstance;
    this.renderer = new WorkflowManagerDashboardRenderer(app, moduleInstance);
  }

  onOpen() {
    const { contentEl } = this;
    const modalEl = contentEl.parentElement;
    if (modalEl) {
      modalEl.addClass("manager-container");
      modalEl.addClass("manager-container--main");
    }

    contentEl.empty();
    contentEl.addClass("manager-modal-shell-host");

    this.renderer.mount(
      contentEl,
      () => this.close(),
      () => {
        this.close();
        this.module.openDashboardInOwnWindow();
      },
      true
    );
  }

  onClose() {
    this.renderer.unmount();
    this.contentEl.empty();
  }
}

// -------------------------------------------------------------
// UI Settings Tab for Obsidian Settings Sidebar
// -------------------------------------------------------------
class WorkflowManagerSettingTab extends (PluginSettingTab || class {}) {
  constructor(app, hostPlugin, moduleInstance) {
    const myId = moduleInstance ? moduleInstance.getModuleId() : "workflow-manager";
    const pluginProxy = {
      app: app,
      manifest: {
        id: myId,
        get name() {
          return moduleInstance ? moduleInstance.getModuleName() : "Workflow & Plugin Manager";
        },
        version: "1.0.5",
        minAppVersion: "0.15.0",
        description: "Control plugins and modules by workflow profiles and sync with workspaces."
      }
    };
    super(app, pluginProxy);
    this.module = moduleInstance;
    this._id = myId;
    this._customName = moduleInstance ? moduleInstance.getModuleName() : "Workflow & Plugin Manager";
    this.icon = "layout-grid";
  }

  get id() {
    return this.module ? this.module.getModuleId() : (this._id || "workflow-manager");
  }

  set id(val) {
    this._id = val;
  }

  get name() {
    return this.module ? this.module.getModuleName() : (this._customName || "Workflow & Plugin Manager");
  }

  set name(val) {
    this._customName = val;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const currentTitle = this.module ? this.module.getModuleName() : "Workflow & Plugin Manager";
    containerEl.createEl("h1", { text: currentTitle });

    // Open Dashboard Action Buttons
    new Setting(containerEl)
      .setName("Workflow & Plugin Manager Dashboard")
      .setDesc("Open the full Better Manager (BPM) dashboard in its own dedicated popout window or as an overlay modal.")
      .addButton((btn) => {
        btn
          .setButtonText("Open in Own Window")
          .setCta()
          .setIcon("external-link")
          .onClick(() => {
            this.module.openDashboardInOwnWindow();
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText("Open as Modal")
          .setIcon("layout-grid")
          .onClick(() => {
            new WorkflowManagerDashboardModal(this.app, this.module).open();
          });
      });

    // Section 1: Active Workflow Profile Switcher
    containerEl.createEl("h2", { text: "Active Workflow Profile" });

    const profiles = this.module.moduleSettings.profiles || {};
    const profileNames = Object.keys(profiles);
    const activeProfile = this.module.moduleSettings.activeProfile || "Default";

    new Setting(containerEl)
      .setName("Current Profile")
      .setDesc("Select which workflow profile is currently active in this vault.")
      .addDropdown((dropdown) => {
        profileNames.forEach((name) => dropdown.addOption(name, name));
        dropdown.setValue(activeProfile);
        dropdown.onChange(async (val) => {
          await this.module.switchProfile(val);
          this.display();
        });
      })
      .addButton((btn) => {
        btn
          .setButtonText("Save Current Setup")
          .setIcon("save")
          .setTooltip("Save all currently active plugins, modules, and workspace layout as a new profile")
          .onClick(async () => {
            const newName = prompt("Enter profile name to save current setup:", "My Workflow");
            if (newName && newName.trim()) {
              await this.module.snapshotProfile(newName.trim());
              new Notice(`✓ Snapshot saved as profile '${newName.trim()}'`);
              this.display();
            }
          });
      });

    // Section 2: Workspace Synchronization
    new Setting(containerEl)
      .setName("Synchronize with Obsidian Workspaces")
      .setDesc("Automatically switch Obsidian workspace layout when switching workflow profiles, and switch workflow profile when an Obsidian workspace layout is loaded.")
      .addToggle((toggle) => {
        toggle.setValue(this.module.moduleSettings.syncWithWorkspaces ?? true);
        toggle.onChange(async (val) => {
          this.module.moduleSettings.syncWithWorkspaces = val;
          await this.module.saveSettings();
        });
      });

    // Section 3: Profile Configuration List
    containerEl.createEl("h2", { text: "Configured Workflow Profiles" });

    profileNames.forEach((profName) => {
      const prof = profiles[profName];
      const plugCount = prof.plugins ? Object.keys(prof.plugins).filter((k) => prof.plugins[k]).length : 0;
      const modCount = prof.modules ? Object.keys(prof.modules).filter((k) => prof.modules[k]).length : 0;

      const s = new Setting(containerEl)
        .setName(profName)
        .setDesc(`Workspace: ${prof.workspace || "None"} | Plugins Active: ${plugCount} | Modules Active: ${modCount}`);

      if (profName !== "Default") {
        s.addExtraButton((btn) => {
          btn
            .setIcon("trash")
            .setTooltip(`Delete profile '${profName}'`)
            .onClick(async () => {
              if (confirm(`Are you sure you want to delete profile '${profName}'?`)) {
                delete profiles[profName];
                await this.module.saveSettings();
                this.display();
              }
            });
        });
      }

      s.addButton((btn) => {
        btn
          .setButtonText(profName === activeProfile ? "Active" : "Activate")
          .setDisabled(profName === activeProfile)
          .onClick(async () => {
            await this.module.switchProfile(profName);
            this.display();
          });
      });
    });
  }
}

// -------------------------------------------------------------
// Embedded BPM CSS Stylesheet with Fixed Heights & Scrolling
// -------------------------------------------------------------
const BPM_CSS = `
/* Dedicated Popout View Container */
.manager-view-container {
    display: flex !important;
    flex-direction: column !important;
    width: 100% !important;
    height: 100vh !important;
    min-height: 0 !important;
    max-height: 100vh !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow: hidden !important;
    background-color: var(--background-primary) !important;
}

/* Modal Window Container */
.manager-container {
    display: flex !important;
    flex-direction: column !important;
    z-index: 100;
    width: clamp(880px, 80vw, 1140px);
    min-width: min(680px, calc(100vw - 48px));
    max-width: calc(100vw - 48px);
    height: clamp(600px, 85vh, 920px) !important;
    max-height: calc(100vh - 48px) !important;
    border-radius: 10px;
    background-color: var(--background-primary);
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
    overflow: hidden !important;
}

.modal-content.manager-modal-shell-host {
    display: flex !important;
    flex: 1 1 auto !important;
    flex-direction: column !important;
    height: 100% !important;
    min-height: 0 !important;
    max-height: 100% !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow: hidden !important;
}

.manager-modal-shell {
    display: flex !important;
    flex: 1 1 auto !important;
    flex-direction: column !important;
    width: 100% !important;
    height: 100% !important;
    min-height: 0 !important;
    max-height: 100% !important;
    overflow: hidden !important;
}

.manager-modal-chrome {
    display: flex !important;
    flex-direction: column !important;
    gap: 8px !important;
    padding: 16px 20px 8px 20px !important;
    background: var(--background-primary) !important;
    border-bottom: 1px solid var(--background-modifier-border) !important;
    flex-shrink: 0 !important;
}

.manager-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 48px;
    min-height: 48px;
}

.manager-header__identity {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}

.manager-header__mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--interactive-accent) 15%, transparent);
    color: var(--interactive-accent);
}

.manager-header__mark svg {
    width: 20px;
    height: 20px;
}

.manager-header__title-group {
    display: flex !important;
    flex-direction: column !important;
    gap: 2px !important;
}

.manager-header__title {
    margin: 0 !important;
    padding: 0 !important;
    font-size: 17px !important;
    font-weight: 700 !important;
    line-height: 1.2 !important;
    color: var(--text-normal) !important;
    letter-spacing: -0.01em !important;
}

.manager-header__subtitle {
    font-size: 11px !important;
    font-weight: 500 !important;
    color: var(--text-muted) !important;
    letter-spacing: 0.02em !important;
    line-height: 1.2 !important;
}

.manager-header__stats {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-muted);
}

.manager-stat-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 12px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    font-size: 11px;
    font-weight: 500;
}

.manager-stat-pill.is-accent {
    background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
    color: var(--interactive-accent);
    border-color: color-mix(in srgb, var(--interactive-accent) 30%, transparent);
}

.manager-section {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.manager-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
}

.manager-toolbar__tabs {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    background: var(--background-secondary);
}

.manager-toolbar__tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
}

.manager-toolbar__tab:hover {
    color: var(--text-normal);
    background: color-mix(in srgb, var(--text-normal) 6%, transparent);
}

.manager-toolbar__tab.is-active {
    background: var(--interactive-accent) !important;
    color: var(--text-on-accent, #ffffff) !important;
    font-weight: 600 !important;
    box-shadow: 0 2px 8px color-mix(in srgb, var(--interactive-accent) 35%, transparent) !important;
}

.manager-toolbar__tab.is-active svg {
    color: var(--text-on-accent, #ffffff) !important;
    stroke: var(--text-on-accent, #ffffff) !important;
}

.manager-container .modal-close-button {
    display: none !important;
}

.manager-action-btn--icon-only {
    padding: 6px 8px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
}

.manager-toolbar__tab svg {
    width: 14px;
    height: 14px;
}

.manager-toolbar__tools {
    display: flex;
    align-items: center;
    gap: 8px;
}

.manager-search-line {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    margin-top: 4px;
}

.manager-chrome-slot {
    width: 100% !important;
    display: flex !important;
    flex-direction: column !important;
}

.manager-search-input-wrapper {
    position: relative !important;
    flex: 1 1 auto !important;
    display: flex !important;
    align-items: center !important;
    width: 100% !important;
}

.manager-search-input {
    width: 100% !important;
    height: 36px !important;
    padding-left: 38px !important;
    padding-right: 32px !important;
    border-radius: 6px !important;
    border: 1px solid var(--background-modifier-border) !important;
    background: var(--background-secondary) !important;
    font-size: 13px !important;
    color: var(--text-normal) !important;
    box-sizing: border-box !important;
}

.manager-search-input:focus {
    border-color: var(--interactive-accent) !important;
    background: var(--background-primary) !important;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 25%, transparent) !important;
}

.manager-search-icon {
    position: absolute !important;
    left: 12px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    color: var(--text-muted) !important;
    pointer-events: none !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    z-index: 2 !important;
    width: 16px !important;
    height: 16px !important;
}

.manager-search-icon svg {
    width: 14px !important;
    height: 14px !important;
    display: block !important;
}

.manager-search-clear {
    position: absolute !important;
    right: 10px !important;
    top: 50% !important;
    transform: translateY(-50%) !important;
    cursor: pointer !important;
    color: var(--text-muted) !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 2px !important;
    z-index: 2 !important;
}

.manager-search-clear:hover {
    color: var(--text-normal);
}

.manager-filter-chips {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 6px;
}

.manager-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 10px;
    border-radius: 12px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
}

.manager-chip:hover {
    color: var(--text-normal);
    border-color: var(--text-muted);
}

.manager-chip.is-active {
    background: color-mix(in srgb, var(--interactive-accent) 15%, transparent);
    color: var(--interactive-accent);
    border-color: var(--interactive-accent);
    font-weight: 600;
}

/* Scrollable Item Container - Fully fixed for mouse wheel and touch */
.manager-item-container {
    display: flex !important;
    flex-direction: column !important;
    gap: 8px !important;
    padding: 16px 20px !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
    height: auto !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
    scroll-behavior: smooth;
    -webkit-overflow-scrolling: touch;
}

.manager-item-container::-webkit-scrollbar {
    width: 8px;
}
.manager-item-container::-webkit-scrollbar-track {
    background: transparent;
}
.manager-item-container::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--text-muted) 35%, transparent);
    border-radius: 8px;
}
.manager-item-container::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--text-muted) 60%, transparent);
}

.manager-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border: 1px solid var(--background-modifier-border);
    border-radius: 10px;
    background: var(--background-secondary);
    transition: transform 0.1s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

.manager-card:hover {
    border-color: color-mix(in srgb, var(--interactive-accent) 40%, var(--background-modifier-border));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.manager-card__left {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    min-width: 0;
    flex: 1 1 auto;
}

.manager-card__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    min-width: 36px;
    border-radius: 8px;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    color: var(--interactive-accent);
}

.manager-card__icon svg {
    width: 18px;
    height: 18px;
}

.manager-card__info {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
}

.manager-card__title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.manager-card__title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-normal);
}

.manager-tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 18px;
    padding: 0 6px;
    font-size: 10px;
    font-weight: 600;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1;
}

.manager-tag--module {
    background: color-mix(in srgb, var(--interactive-accent) 15%, transparent);
    color: var(--interactive-accent);
    border: 1px solid color-mix(in srgb, var(--interactive-accent) 30%, transparent);
}

.manager-tag--plugin {
    background: var(--background-modifier-border);
    color: var(--text-muted);
}

.manager-tag--delay {
    background: color-mix(in srgb, #f59e0b 15%, transparent);
    color: #f59e0b;
    border: 1px solid color-mix(in srgb, #f59e0b 35%, transparent);
}

.manager-card__desc {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.manager-card__meta {
    font-size: 11px;
    color: var(--text-faint);
    display: flex;
    align-items: center;
    gap: 8px;
}

.manager-card__right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
    margin-left: 12px;
}

.manager-action-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 30px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
}

.manager-action-btn:hover {
    background: var(--background-modifier-hover);
    border-color: var(--text-muted);
}

.manager-action-btn.is-cta {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-color: transparent;
}

.manager-action-btn.is-cta:hover {
    background: var(--interactive-accent-hover);
}
`;

// -------------------------------------------------------------
// Main Workflow & Plugin Manager Module
// -------------------------------------------------------------
class WorkflowManagerModule {
  constructor(ctx) {
    this.ctx = ctx;
    this.cleanups = [];
    this.settingTab = null;
    this.originalLoadWorkspace = null;

    // Default configuration & profile store
    this.moduleSettings = {
      activeProfile: "Default",
      syncWithWorkspaces: true,
      delayedPlugins: [],
      profiles: {
        "Default": {
          workspace: "",
          plugins: {},
          modules: {}
        },
        "Project Management": {
          workspace: "Projects",
          plugins: {
            "dataview": true,
            "obsidian-kanban": true,
            "tasknotes": true
          },
          modules: {
            "drive-attachments": true
          }
        },
        "Task Management": {
          workspace: "Tasks",
          plugins: {
            "tasknotes": true,
            "obsidian-day-planner": true
          },
          modules: {
            "drive-attachments": true
          }
        },
        "Writing & Research": {
          workspace: "Writing",
          plugins: {
            "dataview": false,
            "tasknotes": false
          },
          modules: {
            "drive-attachments": true
          }
        }
      }
    };

    this.ensureDiscovered();
  }

  getModuleId() {
    if (this.ctx.loadedModules) {
      for (const [id, modClass] of this.ctx.loadedModules.entries()) {
        if (modClass === this.constructor) return id;
      }
    }
    return "workflow-manager";
  }

  getModuleName() {
    const myId = this.getModuleId();
    const meta = this.ctx.discoveredModules?.get(myId);
    if (meta && meta.name) return meta.name;
    const configured = this.ctx.settings?.modules?.[myId];
    if (configured && configured.name) return configured.name;
    return "Workflow & Plugin Manager";
  }

  ensureDiscovered() {
    const myId = this.getModuleId();
    if (this.ctx.discoveredModules && !this.ctx.discoveredModules.has(myId)) {
      this.ctx.discoveredModules.set(myId, {
        name: "Workflow & Plugin Manager",
        icon: "layout-grid",
        description: "Control Obsidian plugins and Sync Engine modules by workflow profiles, sync layouts with workspaces, optimize boot times, and convert plugins to modules.",
        version: "1.0.2",
        readme: "https://github.com/amarjt/sync-engine-modules"
      });
    }
  }

  registerDashboardView() {
    const app = this.ctx.app;
    if (!app || !app.viewRegistry) return;
    const registry = app.viewRegistry;

    // Unregister existing view to avoid "Attempting to register an existing view" error
    try {
      if (typeof registry.unregisterView === "function") {
        registry.unregisterView(WORKFLOW_MANAGER_VIEW_TYPE);
      } else if (registry.viewByType && registry.viewByType[WORKFLOW_MANAGER_VIEW_TYPE]) {
        delete registry.viewByType[WORKFLOW_MANAGER_VIEW_TYPE];
      }
    } catch (_) {}

    // Register with Obsidian viewRegistry
    try {
      if (typeof registry.registerView === "function") {
        registry.registerView(
          WORKFLOW_MANAGER_VIEW_TYPE,
          (leaf) => new WorkflowManagerView(leaf, this)
        );
      } else if (registry.viewByType) {
        registry.viewByType[WORKFLOW_MANAGER_VIEW_TYPE] = (leaf) => new WorkflowManagerView(leaf, this);
      }
      console.log(`[WorkflowManager] Successfully registered view '${WORKFLOW_MANAGER_VIEW_TYPE}' with app.viewRegistry.`);
    } catch (err) {
      console.warn("[WorkflowManager] Could not register view in viewRegistry:", err);
    }
  }

  // Open the dashboard in its own dedicated native OS popout window
  async openDashboardInOwnWindow() {
    const app = this.ctx.app;
    if (!app || !app.workspace) return;

    // Always ensure view is registered in app.viewRegistry
    this.registerDashboardView();

    // Check if view is already open in any leaf
    let targetLeaf = null;
    app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view && leaf.view.getViewType && leaf.view.getViewType() === WORKFLOW_MANAGER_VIEW_TYPE) {
        if (leaf.view instanceof WorkflowManagerView || (leaf.view.renderer && typeof leaf.view.renderer.mount === "function")) {
          targetLeaf = leaf;
        } else {
          // Dead unknown pane ("Plugin no longer active")
          try {
            leaf.detach();
          } catch (_) {}
        }
      }
    });

    if (targetLeaf) {
      app.workspace.revealLeaf(targetLeaf);
      return targetLeaf;
    }

    // Open native popout window
    if (typeof app.workspace.openPopoutLeaf === "function") {
      try {
        const leaf = app.workspace.openPopoutLeaf({ size: { width: 1140, height: 800 } });
        await leaf.setViewState({
          type: WORKFLOW_MANAGER_VIEW_TYPE,
          active: true
        });
        return leaf;
      } catch (err) {
        console.warn("[WorkflowManager] Could not open popout window:", err);
      }
    }

    // Fallback: open in new tab
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: WORKFLOW_MANAGER_VIEW_TYPE,
      active: true
    });
    return leaf;
  }


  // Compute SHA-256 hash matching Sync Engine's Dr(e)
  async computeFileHash(text) {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      try {
        const t = new TextEncoder().encode(text);
        const n = await crypto.subtle.digest("SHA-256", t);
        const r = "0123456789abcdef";
        const a = new DataView(n);
        let o = "";
        for (let e = 0; e < 32; e++) {
          const byte = a.getUint8(e);
          o += r[byte >> 4] + r[byte & 15];
        }
        return o;
      } catch (_) {}
    }
    if (typeof require === "function") {
      try {
        return require("crypto").createHash("sha256").update(text, "utf8").digest("hex");
      } catch (_) {}
    }
    return "";
  }

  deduplicateSettingTabs() {
    try {
      const setting = this.ctx?.app?.setting || this.app?.setting;
      if (!setting || !Array.isArray(setting.pluginTabs)) return;

      const seenIds = new Set();
      const duplicates = [];

      for (const tab of setting.pluginTabs) {
        if (!tab) continue;
        const id = tab.id || tab.plugin?.manifest?.id;
        if (!id) continue;

        if (seenIds.has(id)) {
          duplicates.push(tab);
        } else {
          seenIds.add(id);
        }
      }

      for (const dup of duplicates) {
        try {
          if (typeof setting.removeSettingTab === "function") {
            setting.removeSettingTab(dup);
          } else {
            const idx = setting.pluginTabs.indexOf(dup);
            if (idx !== -1) setting.pluginTabs.splice(idx, 1);
            if (dup.navEl && typeof dup.navEl.detach === "function") {
              dup.navEl.detach();
            }
          }
        } catch (_) {}
      }

      if (duplicates.length > 0 && typeof setting.updatePluginSection === "function") {
        try { setting.updatePluginSection(); } catch (_) {}
      }
    } catch (err) {
      console.warn("[WorkflowManager] Failed to deduplicate setting tabs:", err);
    }
  }

  // Auto-heal module integrity and moduleSettings in Sync Engine
  async healModuleIntegrity() {
    this.deduplicateSettingTabs();
    if (!this.ctx?.discoveredModules) return;
    const adapter = this.ctx.app?.vault?.adapter;
    if (!adapter || typeof adapter.read !== "function") return;
    const moduleDir = `${this.ctx.app.vault.configDir}/plugins/sync-engine/modules`;

    for (const [id, meta] of this.ctx.discoveredModules.entries()) {
      try {
        const filePath = `${moduleDir}/${id}.js`;
        if (await adapter.exists(filePath)) {
          let fileContent = await adapter.read(filePath);
          let modified = false;

          // 1. Ensure ConvertedModule has this.moduleSettings = {};
          if (fileContent.includes("class ConvertedModule") && !fileContent.includes("this.moduleSettings")) {
            fileContent = fileContent.replace(
              /constructor\s*\(\s*ctx\s*\)\s*\{([\s\S]*?)this\.instance\s*=\s*null\s*;/m,
              "constructor(ctx) {$1this.instance = null;\n    this.moduleSettings = {};"
            );
            await adapter.write(filePath, fileContent);
            modified = true;
            console.log(`[WorkflowManager] Auto-healed missing this.moduleSettings in ${filePath}`);
          }

          // 2. Compute exact SHA-256 matching Sync Engine's Dr(e)
          const realHash = await this.computeFileHash(fileContent);
          if (realHash && (meta?.integrity !== realHash || modified)) {
            let targetMeta = meta;
            if (!targetMeta || typeof targetMeta !== "object") {
              targetMeta = { id, name: id, enabled: true };
            }
            targetMeta.integrity = realHash;
            this.ctx.discoveredModules.set(id, targetMeta);
            if (this.ctx.moduleStore?.set) {
              await this.ctx.moduleStore.set(id, targetMeta);
            }
            console.log(`[WorkflowManager] Auto-synced SHA-256 integrity for module ${id} -> ${realHash.slice(0, 12)}...`);
          }
        }
      } catch (e) {
        console.warn(`[WorkflowManager] Could not heal integrity for module ${id}:`, e);
      }
    }
  }

  start = async () => {
    this.ensureDiscovered();
    await this.healModuleIntegrity();
    this.deduplicateSettingTabs();

    // Ensure Obsidian's internal require is captured globally on window
    if (typeof window !== "undefined") {
      if (typeof require === "function") {
        window.__obsidian_require__ = require;
      }
      if (this.ctx.app) {
        await ensureObsidianRequire(this.ctx.app);
      }
    }

    // Register complete BPM CSS styling
    if (this.ctx.registerCss) {
      try {
        const cleanupCss = this.ctx.registerCss(BPM_CSS);
        if (cleanupCss) this.cleanups.push(cleanupCss);
      } catch (err) {
        console.warn("[WorkflowManager] Could not register BPM CSS:", err);
      }
    }

    // Register view type with Obsidian's viewRegistry
    this.registerDashboardView();
    this.cleanups.push(() => {
      try {
        if (this.ctx.app?.viewRegistry?.unregisterView) {
          this.ctx.app.viewRegistry.unregisterView(WORKFLOW_MANAGER_VIEW_TYPE);
        }
      } catch (_) {}
    });

    // Load persisted settings
    await this.loadSettings();

    // Register Dashboard command & Ribbon icon (opens in its own window!)
    const myName = this.getModuleName();

    if (this.ctx.addRibbonIcon) {
      try {
        const ribbonEl = this.ctx.addRibbonIcon("layout-grid", myName, () => {
          this.openDashboardInOwnWindow();
        });
        if (ribbonEl) {
          this.cleanups.push(() => ribbonEl.remove());
        }
      } catch (err) {
        console.warn("[WorkflowManager] Could not add ribbon icon:", err);
      }
    }

    if (this.ctx.addCommand) {
      this.ctx.addCommand({
        id: "workflow-manager-open-window",
        name: "Workflow Manager: Open Dashboard in New Window",
        callback: () => {
          this.openDashboardInOwnWindow();
        }
      });

      this.ctx.addCommand({
        id: "workflow-manager-open-modal",
        name: "Workflow Manager: Open Dashboard Modal",
        callback: () => {
          new WorkflowManagerDashboardModal(this.ctx.app, this).open();
        }
      });

      this.ctx.addCommand({
        id: "workflow-manager-switch-profile",
        name: "Workflow Manager: Switch Profile",
        callback: () => {
          new WorkflowProfileSuggestModal(this.ctx.app, this).open();
        }
      });

      this.ctx.addCommand({
        id: "workflow-manager-save-profile",
        name: "Workflow Manager: Save Current Setup to Profile",
        callback: async () => {
          const name = prompt("Enter profile name to save current setup:", "New Workflow");
          if (name && name.trim()) {
            await this.snapshotProfile(name.trim());
            new Notice(`✓ Saved current setup as profile '${name.trim()}'.`);
          }
        }
      });

      this.ctx.addCommand({
        id: "workflow-manager-convert-plugin",
        name: "Workflow Manager: Convert Plugin to Module",
        callback: async () => {
          await this.openDashboardInOwnWindow();
        }
      });
    }

    // Register setting tab in Obsidian
    if (this.ctx.app?.setting?.addSettingTab) {
      const hostPlugin = {
        app: this.ctx.app,
        manifest: {
          id: this.getModuleId(),
          name: myName,
          version: "1.0.2",
          minAppVersion: "0.15.0",
          description: "Control plugins and modules by workflow profiles and sync with workspaces."
        }
      };
      this.settingTab = new WorkflowManagerSettingTab(this.ctx.app, hostPlugin, this);
      this.ctx.app.setting.addSettingTab(this.settingTab);
      this.cleanups.push(() => {
        if (this.settingTab && this.ctx.app?.setting?.removeSettingTab) {
          this.ctx.app.setting.removeSettingTab(this.settingTab);
          this.settingTab = null;
        }
      });
    }

    // Hook workspace changes
    this.hookWorkspaceSync();

    // Execute Delayed Startup optimization if configured
    this.executeDelayedStartup();
  };

  dispose = async () => {
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch (_) {}
    }
    this.cleanups.length = 0;
    try {
      if (this.ctx.app?.viewRegistry?.unregisterView) {
        this.ctx.app.viewRegistry.unregisterView(WORKFLOW_MANAGER_VIEW_TYPE);
      }
    } catch (_) {}
    try {
      if (this.ctx.app?.workspace?.detachLeavesOfType) {
        this.ctx.app.workspace.detachLeavesOfType(WORKFLOW_MANAGER_VIEW_TYPE);
      }
    } catch (_) {}
    this.unhookWorkspaceSync();
  };

  // Toggle Sync Engine Module state
  async toggleModule(moduleId, enable) {
    if (!this.ctx.settings.modules) this.ctx.settings.modules = {};
    if (!this.ctx.settings.modules[moduleId]) {
      this.ctx.settings.modules[moduleId] = { enabled: enable };
    } else {
      this.ctx.settings.modules[moduleId].enabled = enable;
    }

    if (this.ctx.saveSettings) {
      await this.ctx.saveSettings();
    }

    // If live context has __getModule__, start or dispose
    try {
      const loadedMod = this.ctx.loadedModules?.get(moduleId);
      if (loadedMod) {
        const inst = this.ctx.__getModule__(loadedMod);
        if (enable && inst && typeof inst.start === "function") {
          await inst.start();
        } else if (!enable && inst && typeof inst.dispose === "function") {
          await inst.dispose();
        }
      }
    } catch (e) {
      console.warn(`[WorkflowManager] Could not dynamically toggle module ${moduleId}:`, e);
    }
  }

  // Hook workspace sync
  hookWorkspaceSync() {
    const app = this.ctx.app;
    if (!app || !app.internalPlugins) return;

    const wsPlugin = app.internalPlugins.getPluginById("workspaces");
    if (!wsPlugin || !wsPlugin.instance) return;

    const self = this;
    const originalLoadWorkspace = wsPlugin.instance.loadWorkspace;
    if (typeof originalLoadWorkspace === "function" && !wsPlugin.instance.__workflowManagerHooked) {
      wsPlugin.instance.__workflowManagerHooked = true;
      this.originalLoadWorkspace = originalLoadWorkspace;

      wsPlugin.instance.loadWorkspace = async function(name) {
        const res = await originalLoadWorkspace.apply(this, arguments);
        if (self.moduleSettings.syncWithWorkspaces) {
          self.handleWorkspaceLoaded(name);
        }
        return res;
      };
    }
  }

  unhookWorkspaceSync() {
    const app = this.ctx.app;
    if (!app || !app.internalPlugins) return;
    const wsPlugin = app.internalPlugins.getPluginById("workspaces");
    if (wsPlugin && wsPlugin.instance && this.originalLoadWorkspace) {
      wsPlugin.instance.loadWorkspace = this.originalLoadWorkspace;
      delete wsPlugin.instance.__workflowManagerHooked;
      this.originalLoadWorkspace = null;
    }
  }

  handleWorkspaceLoaded(workspaceName) {
    if (!workspaceName) return;
    const profiles = this.moduleSettings.profiles || {};
    for (const [profName, prof] of Object.entries(profiles)) {
      if (prof.workspace && prof.workspace.toLowerCase() === workspaceName.toLowerCase()) {
        if (this.moduleSettings.activeProfile !== profName) {
          this.switchProfile(profName, { skipWorkspaceSwitch: true });
        }
        break;
      }
    }
  }

  async switchProfile(profileName, options = {}) {
    const profile = this.moduleSettings.profiles[profileName];
    if (!profile) {
      new Notice(`Workflow profile '${profileName}' not found!`);
      return;
    }

    this.moduleSettings.activeProfile = profileName;
    await this.saveSettings();

    // 1. Switch plugins
    if (profile.plugins && this.ctx.app.plugins) {
      const appPlugins = this.ctx.app.plugins;
      for (const [pluginId, shouldEnable] of Object.entries(profile.plugins)) {
        const isEnabled = appPlugins.enabledPlugins?.has(pluginId);
        if (shouldEnable && !isEnabled) {
          try {
            await appPlugins.enablePluginAndSave(pluginId);
          } catch (err) {
            console.error(`Failed to enable plugin ${pluginId}:`, err);
          }
        } else if (!shouldEnable && isEnabled) {
          try {
            await appPlugins.disablePluginAndSave(pluginId);
          } catch (err) {
            console.error(`Failed to disable plugin ${pluginId}:`, err);
          }
        }
      }
    }

    // 2. Switch modules
    if (profile.modules && this.ctx.settings?.modules) {
      for (const [moduleId, shouldEnable] of Object.entries(profile.modules)) {
        await this.toggleModule(moduleId, shouldEnable);
      }
    }

    // 3. Switch workspace layout
    if (profile.workspace && !options.skipWorkspaceSwitch && this.moduleSettings.syncWithWorkspaces) {
      const wsPlugin = this.ctx.app.internalPlugins?.getPluginById("workspaces");
      if (wsPlugin && wsPlugin.instance && typeof wsPlugin.instance.loadWorkspace === "function") {
        try {
          await this.originalLoadWorkspace.call(wsPlugin.instance, profile.workspace);
        } catch (e) {
          console.warn(`Could not load workspace '${profile.workspace}':`, e);
        }
      }
    }

    new Notice(`✓ Activated profile: ${profileName}`);
  }

  async snapshotProfile(profileName) {
    const app = this.ctx.app;
    const pluginStates = {};
    if (app.plugins?.manifests) {
      for (const id of Object.keys(app.plugins.manifests)) {
        pluginStates[id] = app.plugins.enabledPlugins?.has(id) || false;
      }
    }

    const moduleStates = {};
    if (this.ctx.discoveredModules) {
      for (const id of this.ctx.discoveredModules.keys()) {
        const isEnabled = this.ctx.settings?.modules?.[id]?.enabled ?? true;
        moduleStates[id] = isEnabled;
      }
    }

    let currentWorkspace = "";
    const wsPlugin = app.internalPlugins?.getPluginById("workspaces");
    if (wsPlugin && wsPlugin.instance?.activeWorkspace) {
      currentWorkspace = wsPlugin.instance.activeWorkspace;
    }

    this.moduleSettings.profiles[profileName] = {
      workspace: currentWorkspace,
      plugins: pluginStates,
      modules: moduleStates
    };
    this.moduleSettings.activeProfile = profileName;

    await this.saveSettings();
  }

  executeDelayedStartup() {
    const delayed = this.moduleSettings.delayedPlugins;
    if (!Array.isArray(delayed) || delayed.length === 0) return;

    const appPlugins = this.ctx.app?.plugins;
    if (!appPlugins) return;

    window.setTimeout(() => {
      delayed.forEach(({ id, delayMs }) => {
        window.setTimeout(async () => {
          if (!appPlugins.enabledPlugins?.has(id) && appPlugins.manifests?.[id]) {
            console.log(`[WorkflowManager] Fast Boot activating delayed plugin: ${id}`);
            try {
              await appPlugins.enablePlugin(id);
            } catch (err) {
              console.error(`[WorkflowManager] Failed delayed activation for ${id}:`, err);
            }
          }
        }, delayMs || 3000);
      });
    }, 1000);
  }

  // Convert an installed Obsidian community plugin into a Sync Engine module
  async convertPluginToModule(pluginId, options = {}) {
    const app = this.ctx.app;
    const adapter = app.vault.adapter;
    const pluginFolder = `${app.vault.configDir}/plugins/${pluginId}`;

    if (!(await adapter.exists(pluginFolder))) {
      throw new Error(`Plugin directory not found: ${pluginFolder}`);
    }

    // Read manifest
    const manifestPath = `${pluginFolder}/manifest.json`;
    if (!(await adapter.exists(manifestPath))) {
      throw new Error(`Plugin manifest.json not found in ${pluginFolder}`);
    }
    const manifestRaw = await adapter.read(manifestPath);
    const manifest = JSON.parse(manifestRaw);

    // Read main.js
    const mainPath = `${pluginFolder}/main.js`;
    if (!(await adapter.exists(mainPath))) {
      throw new Error(`Plugin main.js not found in ${pluginFolder}`);
    }
    const mainSource = await adapter.read(mainPath);

    // Read styles.css if present
    let stylesSource = "";
    const stylesPath = `${pluginFolder}/styles.css`;
    if (await adapter.exists(stylesPath)) {
      stylesSource = await adapter.read(stylesPath);
    }

    const moduleName = options.targetName || manifest.name || pluginId;
    const moduleIcon = options.targetIcon || "puzzle";
    const moduleDesc = manifest.description || `Converted module from ${pluginId}`;
    const moduleVer = manifest.version || "1.0.0";

    // Resilient Converted Module Template with Universal CM6/Lezer resolver
    const convertedCode = `/*!
name: ${moduleName}
icon: ${moduleIcon}
description: ${moduleDesc.replace(/\\n/g, " ")}
version: ${moduleVer}
*/

// Generated by Workflow & Plugin Manager Converter for Sync Engine
const obsidianApi = (typeof window !== "undefined" && window.syncEngineApiBridge) || (typeof require === "function" ? require("obsidian") : null) || (typeof window !== "undefined" ? window.obsidian : null);
const { Notice } = obsidianApi || {};

async function ensureObsidianRequire(app) {
  if (typeof window !== "undefined" && typeof window.__obsidian_require__ === "function") {
    return window.__obsidian_require__;
  }
  if (typeof require === "function") {
    try {
      require("@codemirror/view");
      window.__obsidian_require__ = require;
      return require;
    } catch (_) {}
  }
  if (!app || !app.plugins) return null;
  try {
    const probeId = "__probe_req_" + Date.now();
    const origRead = app.vault.adapter.read;
    app.vault.adapter.read = async function(path) {
      if (path && path.includes(probeId)) {
        return "module.exports = class ProbePlugin { constructor(app) { if (typeof window !== 'undefined') window.__obsidian_require__ = require; } };";
      }
      return origRead.apply(this, arguments);
    };
    app.plugins.manifests[probeId] = { id: probeId, name: "Probe", version: "1.0.0", minAppVersion: "0.15.0", dir: probeId };
    await app.plugins.loadPlugin(probeId);
    try { await app.plugins.unloadPlugin(probeId); } catch (_) {}
    delete app.plugins.manifests[probeId];
    delete app.plugins.plugins[probeId];
    app.vault.adapter.read = origRead;
    return window.__obsidian_require__ || null;
  } catch (err) {
    return null;
  }
}

// Sandboxed execution of original plugin CommonJS source
function getPluginClass() {
  const exports = {};
  const module = { exports };
  const customRequire = (id) => {
    if (typeof window !== "undefined" && typeof window.__obsidian_require__ === "function") {
      try {
        const mod = window.__obsidian_require__(id);
        if (mod !== undefined) return mod;
      } catch (_) {}
    }
    if (id === "obsidian") return obsidianApi;
    if (typeof require === "function") {
      try {
        return require(id);
      } catch (_) {}
    }
    return null;
  };

  (function(module, exports, require) {
${mainSource}
  })(module, exports, customRequire);

  return module.exports && (module.exports.default || module.exports);
}

let OriginalPluginClass = null;

class ConvertedModule {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.cleanups = [];
    this.instance = null;
    this.moduleSettings = {};
  }

  start = async () => {
    if (!OriginalPluginClass) {
      if (typeof window !== "undefined" && !window.__obsidian_require__ && this.app) {
        await ensureObsidianRequire(this.app);
      }
      OriginalPluginClass = getPluginClass();
    }

    ${stylesSource ? `if (this.ctx.registerCss) {
      try {
        const cssCleanup = this.ctx.registerCss(${JSON.stringify(stylesSource)});
        if (cssCleanup) this.cleanups.push(cssCleanup);
      } catch (e) {
        console.warn("Could not register module CSS:", e);
      }
    }` : ""}

    try {
      const pluginId = ${JSON.stringify(pluginId)};
      const pluginDir = \`\${this.app.vault.configDir}/plugins/${pluginId}\`;
      const manifest = {
        ...${JSON.stringify(manifest)},
        dir: pluginDir
      };

      this.instance = new OriginalPluginClass(this.app, manifest);

      // 1. Resilient loadData / saveData proxying
      const dataJsonPath = \`\${pluginDir}/data.json\`;
      const origLoadData = typeof this.instance.loadData === "function" ? this.instance.loadData.bind(this.instance) : null;
      this.instance.loadData = async () => {
        try {
          if (await this.app.vault.adapter.exists(dataJsonPath)) {
            const raw = await this.app.vault.adapter.read(dataJsonPath);
            return JSON.parse(raw);
          }
        } catch (e) {
          console.warn("[ConvertedModule:${pluginId}] Custom loadData read:", e);
        }
        if (origLoadData) {
          try {
            return (await origLoadData()) || {};
          } catch (_) {}
        }
        return {};
      };

      const origSaveData = typeof this.instance.saveData === "function" ? this.instance.saveData.bind(this.instance) : null;
      this.instance.saveData = async (data) => {
        try {
          await this.app.vault.adapter.write(dataJsonPath, JSON.stringify(data, null, 2));
        } catch (e) {
          console.warn("[ConvertedModule:${pluginId}] Custom saveData write:", e);
        }
        if (origSaveData) {
          try {
            await origSaveData(data);
          } catch (_) {}
        }
      };

      // 2. Register instance into app.plugins so setting tabs, commands, and Obsidian plugin manager recognize it
      if (this.app.plugins) {
        if (!this.app.plugins.plugins) this.app.plugins.plugins = {};
        this.app.plugins.plugins[pluginId] = this.instance;
        if (!this.app.plugins.manifests) this.app.plugins.manifests = {};
        if (!this.app.plugins.manifests[pluginId]) {
          this.app.plugins.manifests[pluginId] = manifest;
        }
        this.cleanups.push(() => {
          if (this.app.plugins.plugins[pluginId] === this.instance) {
            delete this.app.plugins.plugins[pluginId];
          }
        });
      }

      // 0. Setting tab deduplication helper
      const purgeSettingTabs = () => {
        if (!this.app.setting) return;
        const targetId = ${JSON.stringify(pluginId)};
        const matches = (t) => t && (t.id === targetId || t.plugin?.manifest?.id === targetId);

        if (Array.isArray(this.app.setting.pluginTabs)) {
          const staleTabs = this.app.setting.pluginTabs.filter(matches);
          for (const tab of staleTabs) {
            try {
              if (typeof this.app.setting.removeSettingTab === "function") {
                this.app.setting.removeSettingTab(tab);
              } else {
                const idx = this.app.setting.pluginTabs.indexOf(tab);
                if (idx !== -1) this.app.setting.pluginTabs.splice(idx, 1);
                if (tab.navEl && typeof tab.navEl.detach === "function") tab.navEl.detach();
              }
            } catch (_) {}
          }
        }
        if (typeof this.app.setting.updatePluginSection === "function") {
          try { this.app.setting.updatePluginSection(); } catch (_) {}
        }
      };

      // Clean up any stale leftover tabs from prior sessions
      purgeSettingTabs();

      // 3. Intercept addSettingTab to enforce single-tab invariant and ensure clean teardown
      const origAddSettingTab = this.instance.addSettingTab?.bind(this.instance);
      if (origAddSettingTab) {
        this.instance.addSettingTab = (settingTab) => {
          if (!settingTab.id) settingTab.id = ${JSON.stringify(pluginId)};
          // Purge any pre-existing duplicate before adding
          purgeSettingTabs();
          origAddSettingTab(settingTab);
          this.cleanups.push(() => {
            purgeSettingTabs();
          });
        };
      }

      // 4. Proper Component Lifecycle Load
      if (typeof this.instance.load === "function") {
        await this.instance.load();
      } else if (typeof this.instance.onload === "function") {
        await this.instance.onload();
      }

      console.log("[ConvertedModule] Successfully loaded converted module " + ${JSON.stringify(pluginId)});
    } catch (err) {
      console.error("Failed to load converted module ${pluginId}:", err);
      new Notice("Error in module '${moduleName}': " + err.message);
    }
  };

  dispose = async () => {
    if (this.instance) {
      try {
        if (typeof this.instance.unload === "function") {
          this.instance.unload();
        } else if (typeof this.instance.onunload === "function") {
          await this.instance.onunload();
        }
      } catch (err) {
        console.error("Error unloading module ${pluginId}:", err);
      }
      this.instance = null;
    }

    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch (_) {}
    }
    this.cleanups.length = 0;

    // Force purge any lingering setting tabs on dispose
    if (this.app.setting && Array.isArray(this.app.setting.pluginTabs)) {
      const targetId = ${JSON.stringify(pluginId)};
      const staleTabs = this.app.setting.pluginTabs.filter(t => t && (t.id === targetId || t.plugin?.manifest?.id === targetId));
      for (const tab of staleTabs) {
        try {
          if (typeof this.app.setting.removeSettingTab === "function") {
            this.app.setting.removeSettingTab(tab);
          } else {
            const idx = this.app.setting.pluginTabs.indexOf(tab);
            if (idx !== -1) this.app.setting.pluginTabs.splice(idx, 1);
            if (tab.navEl && typeof tab.navEl.detach === "function") tab.navEl.detach();
          }
        } catch (_) {}
      }
      if (typeof this.app.setting.updatePluginSection === "function") {
        try { this.app.setting.updatePluginSection(); } catch (_) {}
      }
    }
  };
}

export default ConvertedModule;
`;

    // Ensure output modules directory exists
    const modulesDir = `${app.vault.configDir}/plugins/sync-engine/modules`;
    if (!(await adapter.exists(modulesDir))) {
      await adapter.mkdir(modulesDir);
    }

    const targetModuleFile = `${modulesDir}/${pluginId}.js`;
    await adapter.write(targetModuleFile, convertedCode);

    // Compute exact SHA-256 integrity hash matching Sync Engine's Dr(e)
    const integrityHash = await this.computeFileHash(convertedCode);

    const convertedMeta = {
      id: pluginId,
      name: moduleName,
      icon: moduleIcon,
      description: moduleDesc,
      version: moduleVer,
      file: `${pluginId}.js`,
      integrity: integrityHash || "",
      enabled: true
    };

    // Register into Sync Engine discovered modules map
    if (this.ctx.discoveredModules) {
      this.ctx.discoveredModules.set(pluginId, convertedMeta);
    }

    // Register into Sync Engine moduleStore (IndexedDB) with exact integrity hash
    if (this.ctx.moduleStore?.set) {
      try {
        await this.ctx.moduleStore.set(pluginId, convertedMeta);
      } catch (e) {
        console.warn("[WorkflowManager] Could not update moduleStore:", e);
      }
    }

    // Auto-enable module in Sync Engine settings
    if (!this.ctx.settings.modules) this.ctx.settings.modules = {};
    if (!this.ctx.settings.modules[pluginId]) {
      this.ctx.settings.modules[pluginId] = {
        enabled: true,
        name: moduleName,
        icon: moduleIcon,
        description: moduleDesc
      };
    } else {
      this.ctx.settings.modules[pluginId].enabled = true;
    }

    if (this.ctx.saveSettings) {
      await this.ctx.saveSettings();
    }

    // STEP 1: Disable original community plugin FIRST so it unloads before our converted module starts
    if (options.disableOriginal && app.plugins?.disablePluginAndSave) {
      try {
        await app.plugins.disablePluginAndSave(pluginId);
        console.log(`[WorkflowManager] Disabled original community plugin ${pluginId}.`);
      } catch (err) {
        console.warn(`[WorkflowManager] Could not disable original plugin ${pluginId}:`, err);
      }
    }

    // STEP 2: Hot-load converted module into Sync Engine SECOND so it remains loaded & registered
    if (typeof this.ctx.loadModule === "function") {
      try {
        if (typeof this.ctx.unloadModule === "function" && this.ctx.loadedModules?.get(pluginId)) {
          this.ctx.unloadModule(pluginId);
        }
        await this.ctx.loadModule(convertedMeta, true);
        console.log(`[WorkflowManager] Auto-loaded converted module ${pluginId} into Sync Engine.`);
      } catch (e) {
        console.warn("[WorkflowManager] Could not auto-load converted module:", e);
      }
    }

    return {
      id: pluginId,
      name: moduleName,
      file: targetModuleFile
    };
  }

  async loadSettings() {
    const myId = this.getModuleId();
    const stored = this.ctx.settings?.modules?.[myId]?.workflowSettings;
    if (stored) {
      this.moduleSettings = Object.assign(this.moduleSettings, stored);
    }
  }

  async saveSettings() {
    const myId = this.getModuleId();
    if (!this.ctx.settings.modules) this.ctx.settings.modules = {};
    if (!this.ctx.settings.modules[myId]) {
      this.ctx.settings.modules[myId] = { enabled: true };
    }
    this.ctx.settings.modules[myId].workflowSettings = this.moduleSettings;

    if (this.ctx.saveSettings) {
      await this.ctx.saveSettings();
    }
  }
}

export default WorkflowManagerModule;
