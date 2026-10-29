/*!
name: Workflow & Plugin Manager
icon: layout-grid
description: Control Obsidian plugins and Sync Engine modules by workflow profiles, sync layouts with workspaces, optimize boot times, and convert plugins to modules.
version: 1.2.0
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

// Lightweight Debounce Utility
function debounce(fn, waitMs = 120) {
  let timeout = null;
  return function(...args) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      fn.apply(this, args);
    }, waitMs);
  };
}

// Universal Obsidian Module Loader Safe Resolver (Non-Invasive)
async function ensureObsidianRequire(app) {
  if (typeof window !== "undefined" && typeof window.__obsidian_require__ === "function") {
    return window.__obsidian_require__;
  }
  if (typeof window !== "undefined" && typeof window.require === "function") {
    try {
      const obs = window.require("obsidian");
      if (obs) {
        window.__obsidian_require__ = window.require;
        return window.require;
      }
    } catch (_) {}
  }
  if (typeof require === "function") {
    try {
      const obs = require("obsidian");
      if (obs) {
        if (typeof window !== "undefined") window.__obsidian_require__ = require;
        return require;
      }
    } catch (_) {}
  }
  return null;
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

class EditModuleModal extends (Modal || class {}) {
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

class StandaloneModuleSettingModal extends (Modal || class {}) {
  constructor(app, moduleItem, settingTab, targetDoc = null) {
    super(app);
    this.moduleItem = moduleItem || {};
    this.settingTab = settingTab;
    this.targetDoc = targetDoc;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    const containerEl = modalEl?.parentElement || this.containerEl;

    // Attach to active target document (ensures modal opens in front inside popout windows)
    try {
      const activeDoc = this.targetDoc || (typeof activeDocument !== "undefined" ? activeDocument : document);
      if (containerEl && activeDoc && containerEl.ownerDocument !== activeDoc) {
        activeDoc.body.appendChild(containerEl);
      }
    } catch (_) {}

    // Highest z-index layer to guarantee it renders in front of any dashboard modal/view
    if (containerEl) {
      containerEl.style.zIndex = "2500";
    }

    contentEl.empty();
    if (modalEl) {
      modalEl.addClass("mod-module-settings");
      modalEl.style.zIndex = "2501";
      modalEl.style.width = "85vw";
      modalEl.style.maxWidth = "960px";
      modalEl.style.minHeight = "480px";
      modalEl.style.maxHeight = "85vh";
      modalEl.style.display = "flex";
      modalEl.style.flexDirection = "column";
      modalEl.style.boxShadow = "0 24px 64px rgba(0, 0, 0, 0.45)";
    }
    contentEl.addClass("module-settings-modal-content");
    contentEl.style.display = "flex";
    contentEl.style.flexDirection = "column";
    contentEl.style.flex = "1";
    contentEl.style.overflow = "hidden";
    contentEl.style.padding = "16px 24px";

    // Header section
    const header = contentEl.createDiv("module-settings-modal-header");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.paddingBottom = "12px";
    header.style.marginBottom = "14px";
    header.style.borderBottom = "1px solid var(--background-modifier-border)";

    const titleGroup = header.createDiv("module-settings-modal-title-group");
    const h2 = titleGroup.createEl("h2", {
      text: (this.moduleItem.name || this.moduleItem.id || "Module") + " Settings"
    });
    h2.style.margin = "0 0 4px 0";

    const badgeLine = titleGroup.createDiv("module-settings-modal-badge-line");
    badgeLine.style.display = "flex";
    badgeLine.style.gap = "8px";
    badgeLine.style.alignItems = "center";

    const tagBadge = badgeLine.createSpan({
      cls: "manager-stat-pill is-accent",
      text: "Sync Engine Module"
    });
    tagBadge.style.fontSize = "11px";

    if (this.moduleItem.version) {
      const verBadge = badgeLine.createSpan({
        cls: "manager-stat-pill",
        text: "v" + this.moduleItem.version
      });
      verBadge.style.fontSize = "11px";
    }

    const subtitle = badgeLine.createSpan({
      text: "Autonomous standalone settings, independent of Community Plugins"
    });
    subtitle.style.fontSize = "12px";
    subtitle.style.color = "var(--text-muted)";

    const actions = header.createDiv("module-settings-modal-actions");
    actions.style.display = "flex";
    actions.style.gap = "8px";

    if (this.app?.setting?.open && this.moduleItem?.type !== "module") {
      const openNativeBtn = actions.createEl("button", {
        cls: "manager-action-btn",
        text: "Open in Obsidian Settings"
      });
      openNativeBtn.style.fontSize = "12px";
      openNativeBtn.addEventListener("click", () => {
        this.close();
        try {
          this.app.setting.open();
          if (this.app.setting.openTabById) {
            this.app.setting.openTabById(this.moduleItem.id);
          }
        } catch (_) {}
      });
    }

    // Scrollable content area for settings
    const bodyEl = contentEl.createDiv("vertical-tab-content mod-settings module-settings-scroll-area");
    bodyEl.style.flex = "1";
    bodyEl.style.overflowY = "auto";
    bodyEl.style.padding = "0 8px 16px 0";

    if (this.settingTab) {
      try {
        this.settingTab.containerEl = bodyEl;
        if (typeof this.settingTab.display === "function") {
          this.settingTab.display();
        }
      } catch (err) {
        console.error("[StandaloneModuleSettingModal] Error executing settingTab.display():", err);
        const errBox = bodyEl.createDiv("module-settings-error");
        errBox.createEl("p", { cls: "mod-warning", text: "Error displaying module settings: " + err.message });
      }
    } else {
      const emptyBox = bodyEl.createDiv("module-settings-empty");
      emptyBox.style.padding = "24px";
      emptyBox.style.textAlign = "center";
      emptyBox.createEl("p", { text: "No settings tab is currently available for this module." });
      emptyBox.createEl("p", {
        cls: "mod-muted",
        text: "Ensure the module is enabled in Workflow & Plugin Manager."
      });
    }
  }

  onClose() {
    if (this.settingTab && typeof this.settingTab.hide === "function") {
      try { this.settingTab.hide(); } catch (_) {}
    }
    this.contentEl.empty();
  }
}

// -------------------------------------------------------------
// UI Modal: Configure Workflow Profile
// -------------------------------------------------------------
class WorkflowProfileEditModal extends (Modal || class {}) {
  constructor(app, moduleInstance, profileName, onSave) {
    super(app);
    this.module = moduleInstance;
    this.profileName = profileName;
    this.onSave = onSave;

    const existing = this.module.moduleSettings?.profiles?.[profileName] || {
      workspace: "",
      plugins: {},
      modules: {}
    };

    this.workspace = existing.workspace || "";
    this.plugins = Object.assign({}, existing.plugins || {});
    this.modules = Object.assign({}, existing.modules || {});
    this.searchQuery = "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("profile-edit-modal");

    const header = contentEl.createDiv("profile-edit-header");
    header.createEl("h2", { text: `Edit Profile: ${this.profileName}` });

    const wsRow = contentEl.createDiv("profile-edit-row");
    wsRow.createEl("label", { text: "Bound Obsidian Workspace:" });

    const wsPlugin = this.app?.internalPlugins?.getPluginById("workspaces");
    const availableWs = wsPlugin?.instance?.workspaces ? Object.keys(wsPlugin.instance.workspaces) : [];

    const wsSelect = wsRow.createEl("select", { cls: "dropdown" });
    const noneOpt = wsSelect.createEl("option", { text: "(None - Do not switch workspace)", value: "" });
    if (!this.workspace) noneOpt.selected = true;

    availableWs.forEach((ws) => {
      const opt = wsSelect.createEl("option", { text: ws, value: ws });
      if (this.workspace === ws) opt.selected = true;
    });

    wsSelect.addEventListener("change", (e) => {
      this.workspace = e.target.value;
    });

    const toolsRow = contentEl.createDiv("profile-edit-tools");
    const searchInput = toolsRow.createEl("input", {
      type: "search",
      cls: "manager-search-input",
      placeholder: "Filter plugins and modules..."
    });
    searchInput.addEventListener("input", (e) => {
      this.searchQuery = e.target.value.toLowerCase().trim();
      this.renderLists(listContainer);
    });

    const snapBtn = toolsRow.createEl("button", {
      cls: "manager-action-btn",
      text: "Snapshot Active Vault"
    });
    snapBtn.addEventListener("click", () => {
      if (this.app?.plugins?.manifests) {
        for (const id of Object.keys(this.app.plugins.manifests)) {
          this.plugins[id] = this.app.plugins.enabledPlugins?.has(id) || false;
        }
      }
      if (this.module.ctx?.discoveredModules) {
        for (const id of this.module.ctx.discoveredModules.keys()) {
          this.modules[id] = this.module.ctx.settings?.modules?.[id]?.enabled ?? true;
        }
      }
      new Notice("✓ Captured live vault setup into editor.");
      this.renderLists(listContainer);
    });

    const listContainer = contentEl.createDiv("profile-edit-lists");
    this.renderLists(listContainer);

    const footer = contentEl.createDiv("profile-edit-footer");
    const cancelBtn = footer.createEl("button", { cls: "manager-action-btn", text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = footer.createEl("button", { cls: "manager-action-btn is-cta", text: "Save Profile" });
    saveBtn.addEventListener("click", async () => {
      if (!this.module.moduleSettings.profiles) this.module.moduleSettings.profiles = {};
      this.module.moduleSettings.profiles[this.profileName] = {
        workspace: this.workspace,
        plugins: this.plugins,
        modules: this.modules
      };
      await this.module.saveSettings();
      new Notice(`✓ Saved profile '${this.profileName}'.`);
      if (typeof this.onSave === "function") this.onSave();
      this.close();
    });
  }

  renderLists(container) {
    container.empty();

    const plugSection = container.createDiv("profile-section");
    const plugHeader = plugSection.createDiv("profile-section__header");
    plugHeader.createEl("h4", { text: "Community Plugins" });

    const plugTools = plugHeader.createDiv("profile-section__tools");
    const allOnBtn = plugTools.createEl("button", { cls: "manager-action-btn", text: "Enable All" });
    allOnBtn.addEventListener("click", () => {
      Object.keys(this.app?.plugins?.manifests || {}).forEach((id) => { this.plugins[id] = true; });
      this.renderLists(container);
    });
    const allOffBtn = plugTools.createEl("button", { cls: "manager-action-btn", text: "Disable All" });
    allOffBtn.addEventListener("click", () => {
      Object.keys(this.app?.plugins?.manifests || {}).forEach((id) => {
        if (id !== "sync-engine" && id !== this.module.getModuleId()) this.plugins[id] = false;
      });
      this.renderLists(container);
    });

    const manifests = this.app?.plugins?.manifests || {};
    const filteredPlugins = Object.entries(manifests).filter(([id, m]) => {
      if (!this.searchQuery) return true;
      return id.toLowerCase().includes(this.searchQuery) || (m.name || "").toLowerCase().includes(this.searchQuery);
    });

    const plugGrid = plugSection.createDiv("profile-items-grid");
    filteredPlugins.forEach(([id, m]) => {
      const isEnabled = this.plugins[id] !== false;
      const row = plugGrid.createDiv(`profile-item-row ${isEnabled ? "is-enabled" : ""}`);
      row.createSpan({ text: m.name || id, cls: "profile-item-name" });
      if (id === "sync-engine") {
        row.createSpan({ text: "(Core Host - Locked)", cls: "manager-tag" });
      } else {
        const toggle = row.createEl("input", { type: "checkbox" });
        toggle.checked = isEnabled;
        toggle.addEventListener("change", (e) => {
          this.plugins[id] = e.target.checked;
          row.toggleClass("is-enabled", e.target.checked);
        });
      }
    });

    const modSection = container.createDiv("profile-section");
    const modHeader = modSection.createDiv("profile-section__header");
    modHeader.createEl("h4", { text: "Sync Engine Modules" });

    const discovered = this.module.ctx?.discoveredModules || new Map();
    const filteredMods = Array.from(discovered.entries()).filter(([id, m]) => {
      if (!this.searchQuery) return true;
      return id.toLowerCase().includes(this.searchQuery) || (m.name || "").toLowerCase().includes(this.searchQuery);
    });

    const modGrid = modSection.createDiv("profile-items-grid");
    filteredMods.forEach(([id, m]) => {
      const isEnabled = this.modules[id] !== false;
      const row = modGrid.createDiv(`profile-item-row ${isEnabled ? "is-enabled" : ""}`);
      row.createSpan({ text: m.name || id, cls: "profile-item-name" });
      if (id === this.module.getModuleId()) {
        row.createSpan({ text: "(Workflow Manager - Locked)", cls: "manager-tag" });
      } else {
        const toggle = row.createEl("input", { type: "checkbox" });
        toggle.checked = isEnabled;
        toggle.addEventListener("change", (e) => {
          this.modules[id] = e.target.checked;
          row.toggleClass("is-enabled", e.target.checked);
        });
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// -------------------------------------------------------------
// UI Modal: Create Workflow Profile
// -------------------------------------------------------------
class WorkflowProfileCreateModal extends (Modal || class {}) {
  constructor(app, moduleInstance, onCreated) {
    super(app);
    this.module = moduleInstance;
    this.onCreated = onCreated;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("profile-edit-modal");

    contentEl.createEl("h2", { text: "Create New Workflow Profile" });

    const nameRow = contentEl.createDiv("profile-edit-row");
    nameRow.createEl("label", { text: "Profile Name:" });
    const nameInput = nameRow.createEl("input", { type: "text", placeholder: "e.g. Research & Writing" });

    const cloneRow = contentEl.createDiv("profile-edit-row");
    const cloneCheck = cloneRow.createEl("input", { type: "checkbox" });
    cloneCheck.checked = true;
    cloneRow.createEl("label", { text: " Clone current active plugins & modules setup into new profile" });

    const btnRow = contentEl.createDiv("profile-edit-footer");
    const cancelBtn = btnRow.createEl("button", { cls: "manager-action-btn", text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const createBtn = btnRow.createEl("button", { cls: "manager-action-btn is-cta", text: "Create Profile" });
    createBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        new Notice("Please enter a profile name.");
        return;
      }
      if (cloneCheck.checked) {
        await this.module.snapshotProfile(name);
      } else {
        if (!this.module.moduleSettings.profiles) this.module.moduleSettings.profiles = {};
        this.module.moduleSettings.profiles[name] = {
          workspace: "",
          plugins: {},
          modules: {}
        };
        await this.module.saveSettings();
      }
      new Notice(`✓ Created workflow profile '${name}'.`);
      if (typeof this.onCreated === "function") this.onCreated(name);
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// -------------------------------------------------------------
// UI Modal: Publish Converted Module to Git Catalog
// -------------------------------------------------------------
class PublishModuleToGitModal extends (Modal || class {}) {
  constructor(app, moduleInstance, moduleInfo = {}) {
    super(app);
    this.module = moduleInstance;
    this.info = Object.assign({
      id: "",
      name: "",
      version: "1.0.0",
      description: "",
      author: "",
      icon: "puzzle",
      repoPath: "D:/All Obsidian Vaults/sync-engine-modules"
    }, moduleInfo);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("publish-git-modal");

    contentEl.createEl("h2", { text: "Publish Converted Module to Git Catalog" });
    const desc = contentEl.createEl("p", { cls: "text-muted" });
    desc.setText("Export this converted module directly into the Git repository, recompute its SHA-256 integrity hash, synchronize modules.json with live raw GitHub URL, and sync your vault.");

    const form = contentEl.createDiv("publish-git-form");

    const addField = (label, value, onChange, placeholder = "") => {
      const row = form.createDiv("publish-form-row");
      row.createEl("label", { text: label });
      const input = row.createEl("input", {
        type: "text",
        value: value || "",
        placeholder: placeholder
      });
      input.addEventListener("input", (e) => onChange(e.target.value));
      return input;
    };

    addField("Module ID (Slug)", this.info.id, (v) => { this.info.id = v.trim(); });
    addField("Module Name", this.info.name || this.info.id, (v) => { this.info.name = v.trim(); });
    addField("Version", this.info.version || "1.0.0", (v) => { this.info.version = v.trim(); });
    addField("Description", this.info.description || "", (v) => { this.info.description = v.trim(); });
    addField("Icon (Lucide name)", this.info.icon || "puzzle", (v) => { this.info.icon = v.trim(); });
    addField("Git Repository Path", this.info.repoPath, (v) => { this.info.repoPath = v.trim(); });

    const btnRow = contentEl.createDiv("publish-btn-row");
    const cancelBtn = btnRow.createEl("button", { cls: "manager-action-btn", text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = btnRow.createEl("button", {
      cls: "manager-action-btn is-cta",
      text: "Package & Sync to Catalog"
    });

    submitBtn.addEventListener("click", async () => {
      submitBtn.disabled = true;
      submitBtn.setText("Packaging & Syncing...");
      try {
        const result = await this.module.publishModuleToGit(this.info);
        new Notice(`✓ Successfully packaged '${result.name}' to Git catalog!`, 5000);
        this.close();
      } catch (err) {
        new Notice(`Failed to publish module: ${err.message}`, 7000);
        submitBtn.disabled = false;
        submitBtn.setText("Package & Sync to Catalog");
      }
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
    this.converterSubTab = "community"; // "community" | "github" | "local" | "updates"
    this.communitySortBy = "downloads"; // "downloads" | "name" | "updated"
    this.communitySearchQuery = "";
    this.communityCatalog = [];
    this.githubRepoInput = "";
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

  openSyncEngineModuleManagement() {
    if (this.isModalHost && typeof this.onCloseCallback === "function") {
      try {
        this.onCloseCallback();
      } catch (_) {}
    }

    const mainWindow = (typeof window !== "undefined" && window.electron?.remote?.BrowserWindow)
      ? window
      : (this.app?.workspace?.containerEl?.ownerDocument?.defaultView || (typeof window !== "undefined" ? window : null));

    if (this.app?.setting) {
      try {
        if (typeof this.app.setting.open === "function") {
          this.app.setting.open();
        }
        if (typeof this.app.setting.openTabById === "function") {
          const tab = this.app.setting.openTabById("sync-engine");
          setTimeout(() => {
            try {
              const container = tab?.containerEl || this.app?.setting?.containerEl;
              if (container) {
                const items = container.querySelectorAll(".setting-item");
                for (const item of items) {
                  const nameEl = item.querySelector(".setting-item-name");
                  if (nameEl && /module\s*management/i.test(nameEl.textContent)) {
                    const btn = item.querySelector("button, .setting-item-control, .clickable-icon") || item;
                    btn.click();
                    break;
                  }
                }
              }
            } catch (e) {
              console.error("[WorkflowManager] Failed to navigate to module management subpage:", e);
            }
          }, 120);
        }
      } catch (err) {
        console.error("[WorkflowManager] Failed to open Sync Engine module management:", err);
      }
    }

    if (mainWindow && typeof mainWindow.focus === "function") {
      try {
        mainWindow.focus();
      } catch (_) {}
    }
  }

  openPluginOrModuleSettings(id) {
    const targetDoc = this.containerEl?.ownerDocument || document;

    // 1. Locate module or plugin item metadata
    let moduleItem = { id };
    if (this.module?.ctx?.discoveredModules?.has(id)) {
      moduleItem = this.module.ctx.discoveredModules.get(id);
    } else if (this.app?.plugins?.manifests?.[id]) {
      moduleItem = this.app.plugins.manifests[id];
    }

    // 2. Locate module settingTab
    let settingTab = null;

    // Check window registry (converted modules & standalone modules)
    if (typeof window !== "undefined" && window.__syncEngineModuleSettingTabs__?.[id]) {
      settingTab = window.__syncEngineModuleSettingTabs__[id];
    }

    // Check loaded module instance in Sync Engine
    if (!settingTab && this.module?.ctx?.loadedModules?.has(id)) {
      const loaded = this.module.ctx.loadedModules.get(id);
      const inst = this.module.ctx.__getModule__ ? this.module.ctx.__getModule__(loaded) : loaded;
      if (inst) {
        settingTab = inst.settingTab || inst.instance?.settingTab;
      }
    }

    // Check active plugin instance if any
    if (!settingTab && this.app?.plugins?.plugins?.[id]?.settingTab) {
      settingTab = this.app.plugins.plugins[id].settingTab;
    }

    // Check settingTabs or pluginTabs in app.setting
    if (!settingTab && this.app?.setting) {
      settingTab = this.app.setting.pluginTabs?.find((t) => t && (t.id === id || t.plugin?.manifest?.id === id))
        || this.app.setting.settingTabs?.find((t) => t && (t.id === id || t.id === "module:" + id));
    }

    // 3. PRIORITY: If settingTab is found, open StandaloneModuleSettingModal in front inside active window!
    if (settingTab) {
      try {
        const modal = new StandaloneModuleSettingModal(this.app, moduleItem, settingTab, targetDoc);
        modal.open();
        return;
      } catch (err) {
        console.error("[WorkflowManager] Failed to open StandaloneModuleSettingModal for " + id + ":", err);
      }
    }

    // 4. Fallback: Open native Obsidian Settings dialog at front
    if (this.isModalHost && typeof this.onCloseCallback === "function") {
      try {
        this.onCloseCallback();
      } catch (_) {}
    }

    const mainWindow = (typeof window !== "undefined" && window.electron?.remote?.BrowserWindow)
      ? window
      : (this.app?.workspace?.containerEl?.ownerDocument?.defaultView || (typeof window !== "undefined" ? window : null));

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
    const updateCount = this.module?.getAvailableUpdatesCount ? this.module.getAvailableUpdatesCount() : 0;
    addTab("converter", updateCount > 0 ? `Plugin Converter (${updateCount})` : "Plugin Converter", "wrench");

    const tools = toolbar.createDiv("manager-toolbar__tools");

    // Refresh tool: Reload Plugins & Modules (Obsidian native aria-label ONLY)
    const refreshBtn = tools.createEl("button", {
      cls: "manager-action-btn",
      attr: {
        "aria-label": "Rescan Plugins & Modules"
      }
    });
    if (typeof setIcon === "function") setIcon(refreshBtn, "refresh-ccw");
    else refreshBtn.setText("↻");
    refreshBtn.createSpan({ text: "Rescan" });
    refreshBtn.addEventListener("click", async () => {
      try {
        if (this.app.plugins?.loadManifests) await this.app.plugins.loadManifests();
        if (typeof this.module.ctx?.fetchSources === "function") {
          await this.module.ctx.fetchSources(true);
        }
        if (typeof this.module.ctx?.loadAllModules === "function") {
          await this.module.ctx.loadAllModules();
        }
        new Notice("✓ Rescanned plugins and modules catalog.");
        this.renderHeader();
        this.renderFilterSection();
        this.renderActiveTab();
      } catch (e) {
        new Notice("Rescan failed: " + e.message);
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

    // Dedicated Quick-Access Navigation Group
    const quickLinks = tools.createDiv("manager-toolbar__quicklinks");

    const modMgmtBtn = quickLinks.createEl("button", {
      cls: "manager-quicklink-btn manager-quicklink-btn--accent",
      attr: { "aria-label": "Open Sync Engine Module Management" }
    });
    if (typeof setIcon === "function") setIcon(modMgmtBtn, "package");
    else modMgmtBtn.setText("📦");
    modMgmtBtn.createSpan({ text: "Module Management" });
    modMgmtBtn.addEventListener("click", () => {
      this.openSyncEngineModuleManagement();
    });

    const obsPluginsBtn = quickLinks.createEl("button", {
      cls: "manager-quicklink-btn",
      attr: { "aria-label": "Open Obsidian Community Plugins Settings" }
    });
    if (typeof setIcon === "function") setIcon(obsPluginsBtn, "puzzle");
    else obsPluginsBtn.setText("🧩");
    obsPluginsBtn.createSpan({ text: "Community Plugins" });
    obsPluginsBtn.addEventListener("click", () => {
      this.openObsidianSetting("community-plugins");
    });

    const syncEngineBtn = quickLinks.createEl("button", {
      cls: "manager-quicklink-btn",
      attr: { "aria-label": "Open Sync Engine Settings" }
    });
    if (typeof setIcon === "function") setIcon(syncEngineBtn, "settings");
    else syncEngineBtn.setText("⚙️");
    syncEngineBtn.createSpan({ text: "Sync Engine" });
    syncEngineBtn.addEventListener("click", () => {
      this.openObsidianSetting("sync-engine");
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
    const debouncedFilterSearch = debounce((val) => {
      this.searchQuery = val.toLowerCase().trim();
      this.renderActiveTab();
    }, 120);

    searchInput.addEventListener("input", (e) => {
      debouncedFilterSearch(e.target.value);
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
    }
  }

  renderActiveTab() {
    this.pageEl.empty();

    if (this.activeTab === "items") {
      this.renderItemsTab();
    } else if (this.activeTab === "syncmodules") {
      this.renderSyncModulesTab();
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

    const fragment = (typeof document !== "undefined" && typeof document.createDocumentFragment === "function")
      ? document.createDocumentFragment()
      : null;

    filtered.forEach((item) => {
      const card = fragment ? document.createElement("div") : this.pageEl.createDiv("manager-card");
      if (fragment) {
        card.className = "manager-card";
        fragment.appendChild(card);
      }

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
          this.app.setting?.pluginTabs?.some((t) => t && (t.id === item.id || t.plugin?.manifest?.id === item.id)) ||
          this.app.setting?.settingTabs?.some((t) => t && (t.id === item.id || t.id === "module:" + item.id)) ||
          (typeof window !== "undefined" && window.__syncEngineModuleSettingTabs__?.[item.id]) ||
          this.module?.ctx?.loadedModules?.has(item.id) ||
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

          // Hot-Reload Module
          if (item.type === "module") {
            menu.addItem((menuItem) => {
              menuItem
                .setTitle("Hot-Reload Module")
                .setIcon("refresh-cw")
                .onClick(async () => {
                  await this.module.hotReloadModule(item.id);
                  this.renderActiveTab();
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
          this.app.setting?.pluginTabs?.some((t) => t && (t.id === item.id || t.plugin?.manifest?.id === item.id)) ||
          this.app.setting?.settingTabs?.some((t) => t && (t.id === item.id || t.id === "module:" + item.id)) ||
          (typeof window !== "undefined" && window.__syncEngineModuleSettingTabs__?.[item.id]) ||
          this.module?.ctx?.loadedModules?.has(item.id) ||
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

    if (fragment) {
      this.pageEl.appendChild(fragment);
    }
  }

  // Tab 2: Workflow Profiles
  renderProfilesTab() {
    this.pageEl.empty();

    const profiles = this.module.moduleSettings?.profiles || {};
    const activeProf = this.module.moduleSettings?.activeProfile || "Default";

    const topSection = this.pageEl.createDiv();
    topSection.style.display = "flex";
    topSection.style.alignItems = "center";
    topSection.style.justifyContent = "space-between";
    topSection.style.marginBottom = "14px";

    const titleGroup = topSection.createDiv();
    titleGroup.createEl("h3", { text: "Workflow Profiles", cls: "m-0" });
    const sub = titleGroup.createEl("p", { cls: "text-muted m-0" });
    sub.setText("Create specialized environments by switching active plugins, modules, and workspace layouts in one click.");

    const btnGroup = topSection.createDiv();
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "8px";

    const newBtn = btnGroup.createEl("button", { cls: "manager-action-btn is-cta" });
    if (typeof setIcon === "function") setIcon(newBtn, "plus");
    newBtn.createSpan({ text: "Create Profile" });
    newBtn.addEventListener("click", () => {
      new WorkflowProfileCreateModal(this.app, this.module, (createdName) => {
        this.renderProfilesTab();
        new WorkflowProfileEditModal(this.app, this.module, createdName, () => {
          this.renderProfilesTab();
        }).open();
      }).open();
    });

    const snapCurrentBtn = btnGroup.createEl("button", { cls: "manager-action-btn" });
    if (typeof setIcon === "function") setIcon(snapCurrentBtn, "camera");
    snapCurrentBtn.createSpan({ text: "Snapshot Active Vault" });
    snapCurrentBtn.addEventListener("click", async () => {
      const name = prompt("Save current active vault setup as profile name:", activeProf);
      if (name && name.trim()) {
        await this.module.snapshotProfile(name.trim());
        new Notice(`✓ Saved current setup as profile '${name.trim()}'.`);
        this.renderHeader();
        this.renderProfilesTab();
      }
    });

    if (Object.keys(profiles).length === 0) {
      const emptyBox = this.pageEl.createDiv();
      emptyBox.style.padding = "40px";
      emptyBox.style.textAlign = "center";
      emptyBox.style.color = "var(--text-muted)";
      emptyBox.setText("No workflow profiles found. Click 'Create Profile' to add your first profile.");
      return;
    }

    for (const [profName, prof] of Object.entries(profiles)) {
      const isActive = profName === activeProf;
      const card = this.pageEl.createDiv(`manager-card ${isActive ? "is-active-card" : ""}`);

      const left = card.createDiv("manager-card__left");
      const iconBox = left.createDiv("manager-card__icon");
      if (typeof setIcon === "function") setIcon(iconBox, "workflow");
      else iconBox.setText("⚡");

      const info = left.createDiv("manager-card__info");
      const titleRow = info.createDiv("manager-card__title-row");
      titleRow.createSpan({ cls: "manager-card__title", text: profName });

      if (isActive) {
        titleRow.createSpan({ cls: "manager-tag manager-tag--module", text: "ACTIVE PROFILE" });
      }

      const plugCount = prof.plugins ? Object.keys(prof.plugins).filter((k) => prof.plugins[k]).length : 0;
      const modCount = prof.modules ? Object.keys(prof.modules).filter((k) => prof.modules[k]).length : 0;
      const wsText = prof.workspace ? `Workspace: "${prof.workspace}"` : "No workspace bound";

      info.createDiv({ cls: "manager-card__desc", text: `${wsText} · ${plugCount} active plugins · ${modCount} active modules` });

      const right = card.createDiv("manager-card__right");

      // Edit Profile button
      const editBtn = right.createEl("button", { cls: "manager-action-btn", attr: { "aria-label": "Configure plugins, modules & workspace" } });
      if (typeof setIcon === "function") setIcon(editBtn, "settings-2");
      editBtn.createSpan({ text: "Edit Profile" });
      editBtn.addEventListener("click", () => {
        new WorkflowProfileEditModal(this.app, this.module, profName, () => {
          this.renderProfilesTab();
        }).open();
      });

      // Update snapshot button
      const updateBtn = right.createEl("button", { cls: "manager-action-btn", attr: { "aria-label": "Capture current vault state to this profile" } });
      if (typeof setIcon === "function") setIcon(updateBtn, "save");
      updateBtn.createSpan({ text: "Snapshot" });
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
          actBtn.disabled = true;
          try {
            await this.module.switchProfile(profName);
            this.renderHeader();
            this.renderProfilesTab();
          } finally {
            actBtn.disabled = false;
          }
        }
      });

      // Delete button (if not Default)
      if (profName !== "Default") {
        const delBtn = right.createEl("button", { cls: "manager-action-btn manager-action-btn--icon-only", attr: { "aria-label": "Delete profile" } });
        if (typeof setIcon === "function") setIcon(delBtn, "trash");
        delBtn.addEventListener("click", async () => {
          if (confirm(`Delete workflow profile '${profName}'?`)) {
            delete profiles[profName];
            await this.module.saveSettings();
            new Notice(`Deleted profile '${profName}'.`);
            this.renderProfilesTab();
          }
        });
      }
    }
  }

  // Tab 3: Sync Engine Module Management & Catalogs
  renderSyncModulesTab() {
    this.pageEl.empty();

    const topSection = this.pageEl.createDiv("sync-modules-header");
    topSection.createEl("h3", { text: "Sync Engine Module Management", cls: "m-0" });
    const desc = topSection.createEl("p", { cls: "text-muted" });
    desc.setText("Manage module sources, discover and install remote community modules, configure auto-updates, and author custom modules without visiting Obsidian settings.");

    // Top action row
    const actionRow = this.pageEl.createDiv("sync-modules-actions");
    actionRow.style.display = "flex";
    actionRow.style.gap = "8px";
    actionRow.style.marginBottom = "16px";

    const rescanBtn = actionRow.createEl("button", { cls: "manager-action-btn" });
    if (typeof setIcon === "function") setIcon(rescanBtn, "refresh-ccw");
    rescanBtn.createSpan({ text: "Rescan & Fetch Sources" });
    rescanBtn.addEventListener("click", async () => {
      try {
        if (typeof this.module.ctx?.fetchSources === "function") await this.module.ctx.fetchSources(true);
        if (typeof this.module.ctx?.loadAllModules === "function") await this.module.ctx.loadAllModules();
        new Notice("✓ Rescanned all module sources and disk.");
        this.renderSyncModulesTab();
      } catch (e) {
        new Notice("Rescan failed: " + e.message);
      }
    });

    const reloadBtn = actionRow.createEl("button", { cls: "manager-action-btn is-cta" });
    if (typeof setIcon === "function") setIcon(reloadBtn, "power");
    reloadBtn.createSpan({ text: "Reload Engine" });
    reloadBtn.addEventListener("click", async () => {
      await this.module.reloadSyncEngine();
    });

    const newModBtn = actionRow.createEl("button", { cls: "manager-action-btn" });
    if (typeof setIcon === "function") setIcon(newModBtn, "plus");
    newModBtn.createSpan({ text: "New Custom Module" });
    newModBtn.addEventListener("click", async () => {
      const id = prompt("Enter new module ID (slug):", "my-custom-module");
      if (id && id.trim()) {
        const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
        const path = `${this.app.vault.configDir}/plugins/sync-engine/modules/${cleanId}.js`;
        if (await this.app.vault.adapter.exists(path)) {
          new Notice(`Module '${cleanId}' already exists.`);
        } else {
          const template = `/*!\nname: ${cleanId}\nicon: puzzle\ndescription: Custom Sync Engine module\nversion: 1.0.0\n*/\n\nexport default class CustomModule {\n  constructor(ctx) {\n    this.ctx = ctx;\n  }\n  async start() {\n    console.log("[${cleanId}] Started!");\n  }\n  dispose() {\n    console.log("[${cleanId}] Disposed!");\n  }\n}\n`;
          await this.app.vault.adapter.write(path, template);
          if (typeof this.module.ctx?.loadAllModules === "function") await this.module.ctx.loadAllModules();
          new Notice(`✓ Created custom module at ${path}`);
          this.renderSyncModulesTab();
        }
      }
    });

    // 1. Module Sources Section
    const sourcesCard = this.pageEl.createDiv("manager-card");
    sourcesCard.style.flexDirection = "column";
    sourcesCard.style.alignItems = "stretch";

    const sHeader = sourcesCard.createDiv("sync-card-header");
    sHeader.createEl("h4", { text: "Module Sources (Remote Catalogs)" });
    sHeader.createEl("p", { cls: "text-muted", text: "Configure catalog endpoints from which third-party Sync Engine modules are discovered and updated." });

    const sourcesList = sourcesCard.createDiv("sync-sources-list");
    const configuredSources = this.module.ctx?.settings?.moduleSources || [];

    configuredSources.forEach((src, idx) => {
      const row = sourcesList.createDiv("sync-source-row");
      row.createSpan({ cls: "sync-source-url", text: src });

      if (src.includes("raw.githubusercontent.com")) {
        row.createSpan({ cls: "manager-tag manager-tag--module", text: "Live Git Source" });
      } else if (src.includes("sync.consensia.cc")) {
        row.createSpan({ cls: "manager-tag", text: "Official" });
      }

      if (configuredSources.length > 1) {
        const rmBtn = row.createEl("button", { cls: "manager-action-btn manager-action-btn--icon-only", attr: { "aria-label": "Remove source" } });
        if (typeof setIcon === "function") setIcon(rmBtn, "trash");
        rmBtn.addEventListener("click", async () => {
          configuredSources.splice(idx, 1);
          if (this.module.ctx?.saveSettings) await this.module.ctx.saveSettings();
          new Notice("Removed source.");
          this.renderSyncModulesTab();
        });
      }
    });

    // Add source input row
    const addRow = sourcesCard.createDiv("sync-source-add-row");
    addRow.style.display = "flex";
    addRow.style.gap = "8px";
    addRow.style.marginTop = "10px";

    const addInput = addRow.createEl("input", {
      type: "text",
      cls: "manager-search-input",
      placeholder: "https://raw.githubusercontent.com/username/repo/main/modules.json"
    });
    addInput.style.flex = "1";

    const addBtn = addRow.createEl("button", { cls: "manager-action-btn is-cta", text: "Add Source" });
    addBtn.addEventListener("click", async () => {
      const url = addInput.value.trim();
      if (!url) return;
      if (!this.module.ctx.settings.moduleSources) this.module.ctx.settings.moduleSources = [];
      if (!this.module.ctx.settings.moduleSources.includes(url)) {
        this.module.ctx.settings.moduleSources.push(url);
        if (this.module.ctx.saveSettings) await this.module.ctx.saveSettings();
        if (typeof this.module.ctx.fetchSources === "function") await this.module.ctx.fetchSources(true);
        new Notice("✓ Added module source.");
        this.renderSyncModulesTab();
      } else {
        new Notice("Source already configured.");
      }
    });

    // 2. Discovered & Remote Modules Catalog
    const catCard = this.pageEl.createDiv("sync-modules-section");
    catCard.createEl("h4", { text: "Discovered Modules Catalog", cls: "mt-4 mb-2" });

    const discovered = this.module.ctx?.discoveredModules || new Map();
    const installed = this.module.ctx?.settings?.modules || {};

    if (discovered.size === 0) {
      const empty = catCard.createDiv();
      empty.style.padding = "24px";
      empty.style.color = "var(--text-muted)";
      empty.setText("No modules discovered yet. Click 'Rescan & Fetch Sources' above.");
    }

    discovered.forEach((meta, id) => {
      const card = catCard.createDiv("manager-card");
      const left = card.createDiv("manager-card__left");
      const iconBox = left.createDiv("manager-card__icon");
      if (typeof setIcon === "function") setIcon(iconBox, meta.icon || "layers");

      const info = left.createDiv("manager-card__info");
      const titleRow = info.createDiv("manager-card__title-row");
      titleRow.createSpan({ cls: "manager-card__title", text: meta.name || id });
      titleRow.createSpan({ cls: "manager-stat-pill", text: `v${meta.version || "1.0.0"}` });

      const isInstalled = this.module.ctx?.loadedModules?.has(id) || !!installed[id];
      const isEnabled = installed[id]?.enabled ?? true;

      if (isInstalled) {
        titleRow.createSpan({ cls: `manager-tag ${isEnabled ? "manager-tag--module" : ""}`, text: isEnabled ? "ENABLED" : "DISABLED" });
      } else {
        titleRow.createSpan({ cls: "manager-tag", text: "NOT INSTALLED" });
      }

      info.createDiv({ cls: "manager-card__desc", text: meta.description || "Sync Engine standalone module" });
      info.createDiv({ cls: "manager-card__meta", text: `ID: ${id} · Source: ${meta.source || "Local"}` });

      const right = card.createDiv("manager-card__right");

      if (isInstalled) {
        // Toggle Switch
        const toggleWrapper = right.createDiv("manager-toggle-wrapper");
        const toggle = toggleWrapper.createEl("input", { type: "checkbox", cls: "checkbox" });
        toggle.checked = isEnabled;
        toggle.addEventListener("change", async (e) => {
          await this.module.toggleModule(id, e.target.checked);
          new Notice(`${e.target.checked ? "Enabled" : "Disabled"} module '${meta.name || id}'.`);
          this.renderSyncModulesTab();
        });

        // Hot Reload
        const hrBtn = right.createEl("button", { cls: "manager-action-btn", attr: { "aria-label": "Hot-Reload module code" } });
        if (typeof setIcon === "function") setIcon(hrBtn, "refresh-cw");
        hrBtn.createSpan({ text: "Hot-Reload" });
        hrBtn.addEventListener("click", async () => {
          await this.module.hotReloadModule(id);
          this.renderSyncModulesTab();
        });

        // Settings (if available)
        const hasModuleSettings = Boolean(window.__syncEngineModuleSettingTabs__?.[id]);
        if (hasModuleSettings) {
          const setBtn = right.createEl("button", { cls: "manager-action-btn manager-action-btn--icon-only", attr: { "aria-label": "Open module settings" } });
          if (typeof setIcon === "function") setIcon(setBtn, "settings");
          setBtn.addEventListener("click", () => this.openPluginOrModuleSettings(id));
        }

        // Uninstall
        const unBtn = right.createEl("button", { cls: "manager-action-btn manager-action-btn--icon-only", attr: { "aria-label": "Uninstall module" } });
        if (typeof setIcon === "function") setIcon(unBtn, "trash");
        unBtn.addEventListener("click", async () => {
          if (confirm(`Uninstall module '${meta.name || id}'?`)) {
            if (typeof this.module.ctx?.deleteModule === "function") {
              await this.module.ctx.deleteModule(id);
            } else if (typeof this.module.ctx?.unloadModule === "function") {
              this.module.ctx.unloadModule(id);
              const path = `${this.app.vault.configDir}/plugins/sync-engine/modules/${id}.js`;
              if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
              this.module.ctx.discoveredModules.delete(id);
              if (this.module.ctx.saveSettings) await this.module.ctx.saveSettings();
            }
            new Notice(`Uninstalled module '${meta.name || id}'.`);
            this.renderSyncModulesTab();
          }
        });
      } else {
        // Install button
        const insBtn = right.createEl("button", { cls: "manager-action-btn is-cta" });
        if (typeof setIcon === "function") setIcon(insBtn, "download");
        insBtn.createSpan({ text: "Install" });
        insBtn.addEventListener("click", async () => {
          insBtn.disabled = true;
          try {
            if (typeof this.module.ctx?.downloadModule === "function") {
              await this.module.ctx.downloadModule(meta, true);
            }
            new Notice(`✓ Installed module '${meta.name || id}'.`);
            this.renderSyncModulesTab();
          } catch (e) {
            new Notice(`Installation failed: ${e.message}`);
            insBtn.disabled = false;
          }
        });
      }
    });
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

  // Tab 4: Plugin-to-Module Converter & Discovery Hub
  renderConverterTab() {
    this.pageEl.empty();
    const manifests = this.app.plugins?.manifests || {};
    const discovered = this.module.ctx?.discoveredModules || new Map();
    const convertedMap = this.module.moduleSettings?.convertedModules || {};

    const topSection = this.pageEl.createDiv();
    topSection.style.marginBottom = "14px";
    topSection.createEl("h3", { text: "Plugin-to-Module Converter & Discovery Hub", cls: "m-0" });
    const desc = topSection.createEl("p", { cls: "text-muted" });
    desc.setText("Browse 1,500+ Obsidian community plugins, convert direct from GitHub repositories (BRAT-style), or wrap locally installed plugins into standalone Sync Engine modules with automated release update tracking.");

    // Sub-Navigation bar
    const subnav = this.pageEl.createDiv("converter-subnav");
    const updateCount = this.module?.getAvailableUpdatesCount ? this.module.getAvailableUpdatesCount() : 0;
    const trackedCount = Object.keys(convertedMap).length;

    const subTabs = [
      { id: "community", label: "Browse Community", icon: "globe" },
      { id: "github", label: "GitHub Repo (BRAT)", icon: "download-cloud" },
      { id: "installed", label: "Installed Plugins", icon: "hard-drive" },
      { id: "updates", label: updateCount > 0 ? `Updates Available (${updateCount})` : `Converted & Updates (${trackedCount})`, icon: "refresh-cw", badge: updateCount > 0 }
    ];

    if (!this.converterSubTab) this.converterSubTab = "community";

    subTabs.forEach((st) => {
      const btn = subnav.createEl("button", {
        cls: `converter-subnav__btn ${this.converterSubTab === st.id ? "is-active" : ""} ${st.badge ? "has-badge" : ""}`
      });
      if (typeof setIcon === "function") setIcon(btn, st.icon);
      btn.createSpan({ text: st.label });
      btn.addEventListener("click", () => {
        this.converterSubTab = st.id;
        this.renderConverterTab();
      });
    });

    const bodyContainer = this.pageEl.createDiv();

    if (this.converterSubTab === "community") {
      this.renderCommunitySubTab(bodyContainer, discovered, convertedMap);
    } else if (this.converterSubTab === "github") {
      this.renderGitHubSubTab(bodyContainer, discovered, convertedMap);
    } else if (this.converterSubTab === "installed") {
      this.renderInstalledSubTab(bodyContainer, manifests, discovered, convertedMap);
    } else if (this.converterSubTab === "updates") {
      this.renderUpdatesSubTab(bodyContainer, discovered, convertedMap);
    }
  }

  renderCommunitySubTab(container, discovered, convertedMap) {
    const searchRow = container.createDiv("converter-search-row");
    const searchInput = searchRow.createEl("input", {
      type: "search",
      cls: "converter-search-input",
      placeholder: "Search 1,500+ Community Plugins by name, author, or keyword...",
      value: this.communitySearchQuery || ""
    });

    const sortSelect = searchRow.createEl("select", { cls: "converter-sort-select" });
    sortSelect.createEl("option", { value: "downloads", text: "Sort: Most Downloads" });
    sortSelect.createEl("option", { value: "name", text: "Sort: Name (A-Z)" });
    sortSelect.createEl("option", { value: "updated", text: "Sort: Recently Updated" });
    sortSelect.value = this.communitySortBy || "downloads";

    const refreshBtn = searchRow.createEl("button", {
      cls: "manager-action-btn",
      attr: { "aria-label": "Refresh Community Catalog" }
    });
    if (typeof setIcon === "function") setIcon(refreshBtn, "refresh-cw");
    refreshBtn.createSpan({ text: "Refresh" });

    const listContainer = container.createDiv();

    const doRenderList = (catalog) => {
      listContainer.empty();
      let filtered = (catalog || []).slice();
      const query = (this.communitySearchQuery || "").toLowerCase().trim();
      if (query) {
        filtered = filtered.filter(p => 
          p._searchKey 
            ? p._searchKey.includes(query)
            : ((p.name && p.name.toLowerCase().includes(query)) ||
               (p.id && p.id.toLowerCase().includes(query)) ||
               (p.description && p.description.toLowerCase().includes(query)) ||
               (p.author && p.author.toLowerCase().includes(query)))
        );
      }

      const sortBy = this.communitySortBy || "downloads";
      filtered.sort((a, b) => {
        if (sortBy === "downloads") return (b.downloads || 0) - (a.downloads || 0);
        if (sortBy === "updated") return (b.updated || 0) - (a.updated || 0);
        return (a.name || "").localeCompare(b.name || "");
      });

      if (filtered.length === 0) {
        const empty = listContainer.createDiv();
        empty.style.padding = "40px";
        empty.style.textAlign = "center";
        empty.style.color = "var(--text-muted)";
        empty.setText("No community plugins matched your search.");
        return;
      }

      // Render top 50 matches for smooth performance
      const pageSlice = filtered.slice(0, 50);
      const fragment = (typeof document !== "undefined" && typeof document.createDocumentFragment === "function")
        ? document.createDocumentFragment()
        : null;

      pageSlice.forEach(plugin => {
        const isConverted = discovered.has(plugin.id);
        const card = fragment ? document.createElement("div") : listContainer.createDiv("manager-card");
        if (fragment) {
          card.className = "manager-card";
          fragment.appendChild(card);
        }

        const left = card.createDiv("manager-card__left");
        const iconBox = left.createDiv("manager-card__icon");
        if (typeof setIcon === "function") setIcon(iconBox, isConverted ? "check-circle" : "puzzle");
        else iconBox.setText("🧩");

        const info = left.createDiv("manager-card__info");
        const titleRow = info.createDiv("manager-card__title-row");
        titleRow.createSpan({ cls: "manager-card__title", text: plugin.name || plugin.id });

        if (isConverted) {
          titleRow.createSpan({ cls: "manager-tag manager-tag--module", text: "CONVERTED ✓" });
        }

        if (plugin.downloads) {
          const dlText = plugin.downloads >= 1000000 
            ? `${(plugin.downloads / 1000000).toFixed(1)}M` 
            : plugin.downloads >= 1000 
              ? `${Math.round(plugin.downloads / 1000)}K` 
              : plugin.downloads;
          const dlPill = titleRow.createSpan({ cls: "manager-stat-pill", text: `⬇ ${dlText}` });
          dlPill.style.fontSize = "11px";
        }

        if (plugin.description) {
          info.createDiv({ cls: "manager-card__desc", text: plugin.description });
        }

        info.createDiv({ cls: "manager-card__meta", text: `ID: ${plugin.id} · Author: ${plugin.author} · GitHub: ${plugin.repo}` });

        const right = card.createDiv("manager-card__right");
        const convertBtn = right.createEl("button", {
          cls: `manager-action-btn ${isConverted ? "" : "is-cta"}`
        });
        if (typeof setIcon === "function") setIcon(convertBtn, "download");
        const btnLabel = convertBtn.createSpan({ text: isConverted ? "Re-Convert" : "Convert & Install" });

        convertBtn.addEventListener("click", async () => {
          convertBtn.disabled = true;
          btnLabel.setText("Downloading...");
          try {
            new Notice(`Fetching '${plugin.name}' from ${plugin.repo}...`);
            const assets = await this.module.fetchRemotePluginAssets(plugin.repo);
            btnLabel.setText("Converting...");
            const res = await this.module.convertPluginToModule(plugin.id, {
              remoteAssets: assets,
              repo: plugin.repo,
              source: "community"
            });
            new Notice(`✓ Successfully converted & installed '${res.name}' into Sync Engine!`);
            this.renderHeader();
            this.renderConverterTab();
          } catch (err) {
            console.error("[WorkflowManager] Remote conversion error:", err);
            new Notice(`Failed to convert: ${err.message}`, 6000);
            convertBtn.disabled = false;
            btnLabel.setText(isConverted ? "Re-Convert" : "Convert & Install");
          }
        });
      });

      if (fragment) {
        listContainer.appendChild(fragment);
      }

      if (filtered.length > 50) {
        const moreNote = listContainer.createDiv();
        moreNote.style.padding = "16px";
        moreNote.style.textAlign = "center";
        moreNote.style.color = "var(--text-faint)";
        moreNote.style.fontSize = "12px";
        moreNote.setText(`Showing top 50 of ${filtered.length} plugins. Refine query to narrow search.`);
      }
    };

    const debouncedCommunitySearch = debounce((val) => {
      this.communitySearchQuery = val;
      doRenderList(this.communityCatalog || []);
    }, 120);

    searchInput.addEventListener("input", (e) => {
      debouncedCommunitySearch(e.target.value);
    });

    sortSelect.addEventListener("change", (e) => {
      this.communitySortBy = e.target.value;
      doRenderList(this.communityCatalog || []);
    });

    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      try {
        new Notice("Fetching community plugins catalog...");
        this.communityCatalog = await this.module.fetchCommunityCatalog(true);
        doRenderList(this.communityCatalog);
        new Notice(`✓ Loaded ${this.communityCatalog.length} community plugins.`);
      } catch (e) {
        new Notice(`Failed to fetch catalog: ${e.message}`);
      } finally {
        refreshBtn.disabled = false;
      }
    });

    // Initial load
    if (!this.communityCatalog || this.communityCatalog.length === 0) {
      listContainer.empty();
      const loading = listContainer.createDiv();
      loading.style.padding = "40px";
      loading.style.textAlign = "center";
      loading.style.color = "var(--text-muted)";
      loading.setText("Loading 1,500+ Obsidian Community Plugins...");

      this.module.fetchCommunityCatalog(false).then((catalog) => {
        this.communityCatalog = catalog;
        doRenderList(this.communityCatalog);
      }).catch((e) => {
        loading.empty();
        loading.setText(`Could not load community catalog: ${e.message}`);
      });
    } else {
      doRenderList(this.communityCatalog);
    }
  }

  renderGitHubSubTab(container, discovered, convertedMap) {
    const box = container.createDiv();
    box.style.padding = "20px";
    box.style.background = "var(--background-secondary)";
    box.style.border = "1px solid var(--background-modifier-border)";
    box.style.borderRadius = "10px";
    box.style.marginBottom = "20px";

    box.createEl("h4", { text: "Import & Convert Plugin Direct from GitHub (BRAT-Style)", cls: "m-0" });
    const p = box.createEl("p", { cls: "text-muted" });
    p.setText("Enter any public GitHub repository (e.g. owner/repo or full URL). Assets (manifest.json, main.js, styles.css) will be fetched directly from GitHub releases and wrapped into a Sync Engine module.");

    const row = box.createDiv();
    row.style.display = "flex";
    row.style.gap = "10px";
    row.style.marginTop = "12px";

    const input = row.createEl("input", {
      type: "text",
      cls: "converter-search-input",
      placeholder: "e.g. eondrcode/obsidian-manager or https://github.com/...",
      value: this.githubRepoInput || ""
    });
    input.style.flex = "1";

    const fetchBtn = row.createEl("button", {
      cls: "manager-action-btn is-cta"
    });
    if (typeof setIcon === "function") setIcon(fetchBtn, "download-cloud");
    const btnLabel = fetchBtn.createSpan({ text: "Inspect & Convert" });

    fetchBtn.addEventListener("click", async () => {
      const repo = input.value.trim();
      if (!repo) {
        new Notice("Please enter a GitHub repository (owner/repo).");
        return;
      }
      this.githubRepoInput = repo;
      fetchBtn.disabled = true;
      btnLabel.setText("Fetching...");

      try {
        new Notice(`Fetching release assets from ${repo}...`);
        const assets = await this.module.fetchRemotePluginAssets(repo);
        btnLabel.setText("Converting...");
        const m = assets.manifest;
        const res = await this.module.convertPluginToModule(m.id, {
          remoteAssets: assets,
          repo: assets.repo,
          source: "github"
        });
        new Notice(`✓ Successfully converted & installed '${res.name}' (v${m.version || "1.0.0"})!`);
        input.value = "";
        this.githubRepoInput = "";
        this.renderHeader();
        this.renderConverterTab();
      } catch (err) {
        console.error("[WorkflowManager] GitHub conversion failed:", err);
        new Notice(`GitHub conversion failed: ${err.message}`, 6000);
        fetchBtn.disabled = false;
        btnLabel.setText("Inspect & Convert");
      }
    });
  }

  renderInstalledSubTab(container, manifests, discovered, convertedMap) {
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
      const empty = container.createDiv();
      empty.style.padding = "30px";
      empty.style.textAlign = "center";
      empty.style.color = "var(--text-muted)";
      empty.setText("No local plugins found to convert.");
      return;
    }

    filteredIds.forEach((id) => {
      const m = manifests[id] || { name: id };
      const isAlreadyConverted = discovered.has(id);

      const card = container.createDiv("manager-card");

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
          this.renderConverterTab();
        } catch (err) {
          console.error("Conversion failed:", err);
          new Notice(`Conversion error: ${err.message}`, 6000);
          convertBtn.disabled = false;
          labelSpan.setText(isAlreadyConverted ? "Re-Convert" : "Convert to Module");
        }
      });
    });
  }

  renderUpdatesSubTab(container, discovered, convertedMap) {
    const topBar = container.createDiv();
    topBar.style.display = "flex";
    topBar.style.justifyContent = "space-between";
    topBar.style.alignItems = "center";
    topBar.style.marginBottom = "14px";
    topBar.style.paddingBottom = "10px";
    topBar.style.borderBottom = "1px solid var(--background-modifier-border)";

    const titleDiv = topBar.createDiv();
    titleDiv.createEl("h4", { text: "Manage Converted Modules & Updates", cls: "m-0" });
    const p = titleDiv.createEl("p", { cls: "text-muted m-0" });
    p.setText("Check upstream GitHub releases and update converted modules in-place with zero downtime.");

    const checkBtn = topBar.createEl("button", { cls: "manager-action-btn is-cta" });
    if (typeof setIcon === "function") setIcon(checkBtn, "refresh-cw");
    const checkLabel = checkBtn.createSpan({ text: "Check for Updates" });

    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      checkLabel.setText("Checking...");
      try {
        await this.module.checkForModuleUpdates(true);
        this.renderHeader();
        this.renderConverterTab();
      } catch (e) {
        new Notice(`Error checking updates: ${e.message}`);
      } finally {
        checkBtn.disabled = false;
        checkLabel.setText("Check for Updates");
      }
    });

    const entries = Object.values(convertedMap || {});
    if (entries.length === 0) {
      const empty = container.createDiv();
      empty.style.padding = "40px";
      empty.style.textAlign = "center";
      empty.style.color = "var(--text-muted)";
      empty.setText("No converted modules tracked yet. Use 'Browse Community' or 'GitHub Repo' to install modules.");
      return;
    }

    entries.forEach((mod) => {
      const card = container.createDiv("manager-card");

      const left = card.createDiv("manager-card__left");
      const iconBox = left.createDiv("manager-card__icon");
      if (typeof setIcon === "function") setIcon(iconBox, mod.hasUpdate ? "arrow-up-circle" : "check-circle");

      const info = left.createDiv("manager-card__info");
      const titleRow = info.createDiv("manager-card__title-row");
      titleRow.createSpan({ cls: "manager-card__title", text: mod.name || mod.id });

      if (mod.hasUpdate) {
        titleRow.createSpan({ cls: "manager-tag--update", text: `UPDATE: v${mod.version} ➔ v${mod.latestVersion}` });
      } else {
        titleRow.createSpan({ cls: "manager-stat-pill", text: `v${mod.version}` });
      }

      info.createDiv({ cls: "manager-card__meta", text: `ID: ${mod.id} · Repo: ${mod.repo || "Local"} · Source: ${mod.sourceType || "local"}` });

      const right = card.createDiv("manager-card__right");

      if (mod.hasUpdate) {
        const updateBtn = right.createEl("button", {
          cls: "manager-action-btn is-update",
          attr: { "aria-label": `Update ${mod.name} to v${mod.latestVersion}` }
        });
        if (typeof setIcon === "function") setIcon(updateBtn, "arrow-up");
        const uLabel = updateBtn.createSpan({ text: `Update to v${mod.latestVersion}` });

        updateBtn.addEventListener("click", async () => {
          updateBtn.disabled = true;
          uLabel.setText("Updating...");
          try {
            await this.module.updateConvertedModule(mod.id);
            new Notice(`✓ Successfully updated '${mod.name}' to v${mod.latestVersion}!`);
            this.renderHeader();
            this.renderConverterTab();
          } catch (err) {
            new Notice(`Update failed: ${err.message}`, 6000);
            updateBtn.disabled = false;
            uLabel.setText(`Update to v${mod.latestVersion}`);
          }
        });
      } else {
        const recheckBtn = right.createEl("button", {
          cls: "manager-action-btn",
          attr: { "aria-label": `Re-convert or refresh ${mod.name}` }
        });
        if (typeof setIcon === "function") setIcon(recheckBtn, "refresh-cw");
        recheckBtn.createSpan({ text: "Re-Check" });

        recheckBtn.addEventListener("click", async () => {
          recheckBtn.disabled = true;
          try {
            await this.module.checkForModuleUpdates(true);
            this.renderConverterTab();
          } finally {
            recheckBtn.disabled = false;
          }
        });
      }

      // Publish to Git Catalog button
      const publishBtn = right.createEl("button", {
        cls: "manager-action-btn",
        attr: { "aria-label": `Publish ${mod.name} to Git Catalog` }
      });
      if (typeof setIcon === "function") setIcon(publishBtn, "upload-cloud");
      publishBtn.createSpan({ text: "Publish to Git" });
      publishBtn.addEventListener("click", () => {
        new PublishModuleToGitModal(this.app, this.module, {
          id: mod.id,
          name: mod.name,
          version: mod.version,
          description: mod.description,
          repo: mod.repo
        }).open();
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

    // Determine strictly if this view is in a separate popout window
    try {
      const isPopoutLeaf = Boolean(this.leaf && typeof this.leaf.getRoot === "function" && this.leaf.getRoot() !== this.app?.workspace?.rootSplit);
      const isDifferentWindow = Boolean(contentEl.ownerDocument && contentEl.ownerDocument !== (this.app?.workspace?.containerEl?.ownerDocument || document));
      const isPopout = isPopoutLeaf || isDifferentWindow;

      if (isPopout) {
        if (this.leaf?.parent?.containerEl) {
          this.leaf.parent.containerEl.addClass("is-popout-manager-tabs");
        }
        if (contentEl.ownerDocument?.body) {
          contentEl.ownerDocument.body.addClass("is-workflow-manager-popout-win");
        }
      }
    } catch (_) {}

    // isModalHost = false: Popout window stays open and focused when opening settings
    this.renderer.mount(contentEl, null, null, false);
  }

  async onClose() {
    try {
      if (this.leaf?.parent?.containerEl) {
        this.leaf.parent.containerEl.removeClass("is-popout-manager-tabs");
      }
      if (this.contentEl?.ownerDocument?.body) {
        this.contentEl.ownerDocument.body.removeClass("is-workflow-manager-popout-win");
        this.contentEl.ownerDocument.body.removeClass("is-workflow-manager-popout");
      }
    } catch (_) {}
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
      .setDesc("Open the full Better Manager dashboard in a new tab (styled like Settings), dedicated window, or modal.")
      .addButton((btn) => {
        btn
          .setButtonText("Open in New Tab")
          .setCta()
          .setIcon("layout-grid")
          .onClick(() => {
            this.module.openDashboardInTab();
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText("Open in Own Window")
          .setIcon("external-link")
          .onClick(() => {
            this.module.openDashboardInOwnWindow();
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText("Open as Modal")
          .setIcon("layers")
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
/* Tab View Container: Styled like Settings Window */
.manager-view-container {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 100% !important;
    height: 100% !important;
    min-height: 0 !important;
    max-height: 100% !important;
    padding: 24px !important;
    margin: 0 !important;
    box-sizing: border-box !important;
    background-color: var(--background-secondary) !important;
    overflow: hidden !important;
}

.manager-view-container .manager-modal-shell {
    display: flex !important;
    flex-direction: column !important;
    width: clamp(880px, 86vw, 1160px) !important;
    max-width: 100% !important;
    height: clamp(600px, 88vh, 940px) !important;
    max-height: 100% !important;
    border-radius: 12px !important;
    background-color: var(--background-primary) !important;
    box-shadow: 0 20px 52px rgba(0, 0, 0, 0.32) !important;
    border: 1px solid var(--background-modifier-border) !important;
    overflow: hidden !important;
}

/* In Popout Window, shell fills popout window cleanly */
body.is-workflow-manager-popout-win .manager-view-container {
    padding: 0 !important;
    background-color: var(--background-primary) !important;
}
body.is-workflow-manager-popout-win .manager-view-container .manager-modal-shell {
    width: 100% !important;
    height: 100% !important;
    max-width: 100% !important;
    max-height: 100% !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    border: none !important;
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

/* Standalone Module Setting Modal: Always in front */
.modal-container:has(.mod-module-settings) {
    z-index: 2500 !important;
}
.modal.mod-module-settings {
    z-index: 2501 !important;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45) !important;
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

/* Popout Window: Settings Panel Mode (Strip Tab Bar & New Tab Buttons only for popout manager) */
.workspace-tabs.is-popout-manager-tabs > .workspace-tab-header-container {
    display: none !important;
}
.workspace-tabs.is-popout-manager-tabs {
    border-top: none !important;
    padding-top: 0 !important;
}
.workspace-tabs.is-popout-manager-tabs > .workspace-tab-container {
    height: 100% !important;
    padding: 0 !important;
}
body.is-workflow-manager-popout-win .manager-header {
    -webkit-app-region: drag;
}
body.is-workflow-manager-popout-win .manager-header button,
body.is-workflow-manager-popout-win .manager-header input,
body.is-workflow-manager-popout-win .manager-header select {
    -webkit-app-region: no-drag;
}

/* Converter Sub-Navigation & Elements */
.converter-subnav {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0 14px 0;
    border-bottom: 1px solid var(--background-modifier-border);
    margin-bottom: 14px;
    flex-wrap: wrap;
}
.converter-subnav__btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
}
.converter-subnav__btn:hover {
    color: var(--text-normal);
    background: var(--background-modifier-hover);
}
.converter-subnav__btn.is-active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-color: transparent;
    font-weight: 600;
}
.converter-subnav__btn.has-badge {
    border-color: #22c55e;
    color: #22c55e;
}
.converter-search-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
    flex-wrap: wrap;
}
.converter-search-input {
    flex: 1 1 240px;
    padding: 7px 12px;
    border-radius: 6px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: 13px;
}
.converter-search-input:focus {
    border-color: var(--interactive-accent);
    outline: none;
}
.converter-sort-select {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-primary);
    color: var(--text-normal);
    font-size: 12px;
    cursor: pointer;
}
.manager-tag--update {
    background: color-mix(in srgb, #22c55e 18%, transparent);
    color: #22c55e;
    border: 1px solid color-mix(in srgb, #22c55e 40%, transparent);
    font-weight: 600;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 10px;
}
.manager-action-btn.is-update {
    background: #16a34a;
    color: #ffffff;
    border-color: transparent;
    font-weight: 600;
}
.manager-action-btn.is-update:hover {
    background: #15803d;
}

/* Quicklinks in header toolbar */
.manager-toolbar__quicklinks {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 8px;
    padding-left: 8px;
    border-left: 1px solid var(--background-modifier-border);
}

.manager-quicklink-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    cursor: pointer;
    transition: all 0.15s ease;
}

.manager-quicklink-btn:hover {
    color: var(--text-normal);
    background: var(--background-modifier-hover);
    border-color: var(--text-accent);
}

.manager-quicklink-btn--accent {
    color: var(--text-on-accent) !important;
    background: var(--interactive-accent) !important;
    border-color: transparent !important;
    font-weight: 600;
}

.manager-quicklink-btn--accent:hover {
    background: var(--interactive-accent-hover) !important;
    color: var(--text-on-accent) !important;
}

/* Profile Edit & Publish Modals */
.profile-edit-modal, .publish-git-modal {
    max-width: 640px !important;
    width: 90vw !important;
}

.profile-edit-row, .publish-form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
}

.profile-edit-row label, .publish-form-row label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-normal);
}

.profile-edit-row input, .publish-form-row input, .profile-edit-row select {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--background-modifier-border);
    background: var(--background-secondary);
    color: var(--text-normal);
}

.profile-edit-tools {
    display: flex;
    gap: 8px;
    margin: 14px 0 10px 0;
}

.profile-edit-lists {
    max-height: 50vh;
    overflow-y: auto;
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    padding: 10px;
    background: var(--background-secondary);
}

.profile-section {
    margin-bottom: 16px;
}

.profile-section__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 6px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--background-modifier-border);
}

.profile-section__header h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
}

.profile-section__tools {
    display: flex;
    gap: 6px;
}

.profile-items-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 6px;
}

.profile-item-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--background-primary);
    border: 1px solid var(--background-modifier-border);
    font-size: 12px;
}

.profile-item-row.is-enabled {
    border-color: rgba(var(--interactive-accent-rgb), 0.4);
    background: var(--background-primary-alt);
}

.profile-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
}

.profile-edit-footer, .publish-btn-row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--background-modifier-border);
}

/* Sync Engine Module Management Tab Styles */
.sync-modules-header {
    margin-bottom: 14px;
}

.sync-source-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 6px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    margin-bottom: 6px;
}

.sync-source-url {
    font-family: var(--font-monospace);
    font-size: 12px;
    word-break: break-all;
    flex: 1;
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

    this.communityCatalogCache = null;
    this.communityCatalogExpiresAt = 0;

    // Default configuration & profile store
    this.moduleSettings = {
      activeProfile: "Default",
      syncWithWorkspaces: true,
      delayedPlugins: [],
      convertedModules: {},
      autoCheckModuleUpdates: true,
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

  // Open the dashboard in a new tab (styled like the Settings window)
  async openDashboardInTab() {
    const app = this.ctx.app;
    if (!app || !app.workspace) return;
    this.registerDashboardView();

    let targetLeaf = null;
    app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view && typeof leaf.view.getViewType === "function" && leaf.view.getViewType() === WORKFLOW_MANAGER_VIEW_TYPE) {
        targetLeaf = leaf;
      }
    });

    if (targetLeaf) {
      app.workspace.revealLeaf(targetLeaf);
      return targetLeaf;
    }

    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: WORKFLOW_MANAGER_VIEW_TYPE,
      active: true
    });
    app.workspace.revealLeaf(leaf);
    return leaf;
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
      if (leaf.view && typeof leaf.view.getViewType === "function" && leaf.view.getViewType() === WORKFLOW_MANAGER_VIEW_TYPE) {
        targetLeaf = leaf;
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
    // Zero-leak isolation: Do not mutate Obsidian's internal app.setting.pluginTabs
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
        id: "workflow-manager-open-tab",
        name: "Workflow Manager: Open Dashboard in New Tab",
        callback: () => {
          this.openDashboardInTab();
        }
      });

      this.ctx.addCommand({
        id: "workflow-manager-open-window",
        name: "Workflow Manager: Open Dashboard in New Window",
        callback: () => {
          this.openDashboardInOwnWindow();
        }
      });

      this.ctx.addCommand({
        id: "workflow-manager-open-modal",
        name: "Workflow Manager: Open Dashboard Modal (Settings Window)",
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

      this.ctx.addCommand({
        id: "workflow-manager-reload-sync-engine",
        name: "Workflow Manager: Quick Reload Sync Engine & All Modules",
        callback: async () => {
          await this.reloadSyncEngine();
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

    // Background module updates check (delayed by 8s to not affect initial boot)
    if (this.moduleSettings?.autoCheckModuleUpdates !== false) {
      window.setTimeout(() => {
        this.checkForModuleUpdates(false).catch(() => {});
      }, 8000);
    }
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

    try {
      if (enable) {
        if (typeof this.ctx.enableModule === "function") {
          await this.ctx.enableModule(moduleId);
        } else {
          const meta = this.ctx.discoveredModules?.get(moduleId) || { id: moduleId, enabled: true };
          if (typeof this.ctx.loadModule === "function") {
            await this.ctx.loadModule(meta, true);
          }
        }
      } else {
        if (typeof this.ctx.disableModule === "function") {
          await this.ctx.disableModule(moduleId);
        } else if (typeof this.ctx.unloadModule === "function") {
          this.ctx.unloadModule(moduleId);
        }
      }
    } catch (e) {
      console.warn(`[WorkflowManager] Could not dynamically toggle module ${moduleId}:`, e);
    }
  }

  // Hot-reload a single module without restarting Sync Engine
  async hotReloadModule(moduleId) {
    const app = this.ctx?.app || this.app || window.app;
    try {
      new Notice(`Hot-reloading module '${moduleId}'...`, 2000);
      if (typeof this.ctx.unloadModule === "function") {
        this.ctx.unloadModule(moduleId);
      }

      const meta = this.ctx.discoveredModules?.get(moduleId);
      if (meta && typeof this.ctx.loadModule === "function") {
        await this.ctx.loadModule(meta, true);
        new Notice(`✓ Module '${moduleId}' hot-reloaded successfully.`);
        return true;
      } else {
        if (typeof this.ctx.loadAllModules === "function") {
          await this.ctx.loadAllModules();
        }
        new Notice(`✓ Rescanned modules from disk.`);
        return true;
      }
    } catch (err) {
      console.error(`Failed to hot-reload module ${moduleId}:`, err);
      new Notice(`Hot-reload failed: ${err.message}`);
      return false;
    }
  }

  // Quick reload Sync Engine and all modules via 150ms auto-cycle
  async reloadSyncEngine() {
    const app = this.ctx?.app || this.app || window.app;
    if (!app?.plugins) {
      new Notice("Obsidian plugins system not accessible.");
      return;
    }

    const pluginId = "sync-engine";
    if (!app.plugins.plugins?.[pluginId]) {
      new Notice("Sync Engine plugin is not loaded.");
      return;
    }

    try {
      new Notice("🔄 Reloading Sync Engine & modules...", 2000);
      await app.plugins.disablePlugin(pluginId);
      window.setTimeout(async () => {
        try {
          await app.plugins.enablePlugin(pluginId);
          new Notice("✓ Sync Engine & all modules reloaded successfully!", 3000);
          if (this.renderer && typeof this.renderer.renderActiveTab === "function") {
            this.renderer.renderHeader();
            this.renderer.renderFilterSection();
            this.renderer.renderActiveTab();
          }
        } catch (enableErr) {
          console.error("Failed to re-enable Sync Engine:", enableErr);
          new Notice(`Failed to re-enable Sync Engine: ${enableErr.message}`);
        }
      }, 150);
    } catch (err) {
      console.error("Failed to disable Sync Engine:", err);
      new Notice(`Reload failed: ${err.message}`);
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
    const profile = this.moduleSettings?.profiles?.[profileName];
    if (!profile) {
      new Notice(`Workflow profile '${profileName}' not found!`);
      return;
    }

    this.moduleSettings.activeProfile = profileName;
    await this.saveSettings();

    const appPlugins = this.ctx.app?.plugins;
    let pluginsChanged = 0;
    let modulesChanged = 0;

    // 1. Switch plugins safely
    if (profile.plugins && appPlugins?.manifests) {
      const enabledSet = appPlugins.enabledPlugins || new Set();
      for (const [pluginId, shouldEnable] of Object.entries(profile.plugins)) {
        // SAFETY LOCK: Never disable sync-engine or self
        if (!shouldEnable && (pluginId === "sync-engine" || pluginId === this.getModuleId())) {
          continue;
        }

        const isCurrentlyEnabled = enabledSet.has(pluginId);
        if (shouldEnable && !isCurrentlyEnabled && appPlugins.manifests[pluginId]) {
          try {
            await appPlugins.enablePluginAndSave(pluginId);
            pluginsChanged++;
          } catch (err) {
            console.error(`Failed to enable plugin ${pluginId}:`, err);
          }
        } else if (!shouldEnable && isCurrentlyEnabled) {
          try {
            await appPlugins.disablePluginAndSave(pluginId);
            pluginsChanged++;
          } catch (err) {
            console.error(`Failed to disable plugin ${pluginId}:`, err);
          }
        }
      }
    }

    // 2. Switch modules safely
    if (profile.modules && this.ctx.discoveredModules) {
      for (const [moduleId, shouldEnable] of Object.entries(profile.modules)) {
        if (!shouldEnable && moduleId === this.getModuleId()) {
          continue; // SAFETY LOCK: Never disable self
        }
        const currentEnabled = this.ctx.settings?.modules?.[moduleId]?.enabled ?? true;
        if (currentEnabled !== shouldEnable) {
          await this.toggleModule(moduleId, shouldEnable);
          modulesChanged++;
        }
      }
    }

    // 3. Switch workspace layout safely
    if (profile.workspace && !options.skipWorkspaceSwitch && this.moduleSettings.syncWithWorkspaces) {
      const wsPlugin = this.ctx.app.internalPlugins?.getPluginById("workspaces");
      if (wsPlugin && wsPlugin.instance && typeof wsPlugin.instance.loadWorkspace === "function") {
        try {
          const fn = this.originalLoadWorkspace || wsPlugin.instance.loadWorkspace;
          await fn.call(wsPlugin.instance, profile.workspace);
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

  // Convert an installed or remote community/GitHub plugin into a Sync Engine module
  async convertPluginToModule(pluginId, options = {}) {
    const app = this.ctx.app;
    const adapter = app.vault.adapter;

    let manifest = null;
    let mainSource = "";
    let stylesSource = "";
    let repo = options.repo || "";

    if (options.remoteAssets) {
      manifest = options.remoteAssets.manifest;
      mainSource = options.remoteAssets.mainJs;
      stylesSource = options.remoteAssets.stylesCss || "";
      repo = options.remoteAssets.repo || repo;
    } else {
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
      manifest = JSON.parse(manifestRaw);

      // Read main.js
      const mainPath = `${pluginFolder}/main.js`;
      if (!(await adapter.exists(mainPath))) {
        throw new Error(`Plugin main.js not found in ${pluginFolder}`);
      }
      mainSource = await adapter.read(mainPath);

      // Read styles.css if present
      const stylesPath = `${pluginFolder}/styles.css`;
      if (await adapter.exists(stylesPath)) {
        stylesSource = await adapter.read(stylesPath);
      }
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
  if (typeof window !== "undefined" && typeof window.require === "function") {
    try {
      const obs = window.require("obsidian");
      if (obs) {
        window.__obsidian_require__ = window.require;
        return window.require;
      }
    } catch (_) {}
  }
  if (typeof require === "function") {
    try {
      const obs = require("obsidian");
      if (obs) {
        if (typeof window !== "undefined") window.__obsidian_require__ = require;
        return require;
      }
    } catch (_) {}
  }
  return null;
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
      const moduleDataDir = \`\${this.app.vault.configDir}/plugins/sync-engine/module-data/\${pluginId}\`;

      // 0. Ensure isolated module storage directory exists
      if (!(await this.app.vault.adapter.exists(moduleDataDir))) {
        await this.app.vault.adapter.mkdir(moduleDataDir);
      }

      // Seamless migration: If old community plugin directory has data.json or icons.json, migrate them
      const oldPluginDir = \`\${this.app.vault.configDir}/plugins/\${pluginId}\`;
      const oldDataJsonPath = \`\${oldPluginDir}/data.json\`;
      const dataJsonPath = \`\${moduleDataDir}/data.json\`;
      try {
        if (await this.app.vault.adapter.exists(oldDataJsonPath) && !(await this.app.vault.adapter.exists(dataJsonPath))) {
          const oldData = await this.app.vault.adapter.read(oldDataJsonPath);
          await this.app.vault.adapter.write(dataJsonPath, oldData);
        }
      } catch (_) {}

      try {
        const oldIconsJson = \`\${oldPluginDir}/icons.json\`;
        const newIconsJson = \`\${moduleDataDir}/icons.json\`;
        if (await this.app.vault.adapter.exists(oldIconsJson) && !(await this.app.vault.adapter.exists(newIconsJson))) {
          const iconsData = await this.app.vault.adapter.read(oldIconsJson);
          await this.app.vault.adapter.write(newIconsJson, iconsData);
        }
      } catch (_) {}

      const manifest = {
        ...${JSON.stringify(manifest)},
        dir: moduleDataDir
      };

      this.instance = new OriginalPluginClass(this.app, manifest);

      // 1. Resilient loadData / saveData proxying pointing to self-contained module storage
      const origLoadData = typeof this.instance.loadData === "function" ? this.instance.loadData.bind(this.instance) : null;
      this.instance.loadData = async () => {
        try {
          if (await this.app.vault.adapter.exists(dataJsonPath)) {
            const raw = await this.app.vault.adapter.read(dataJsonPath);
            return JSON.parse(raw);
          }
        } catch (e) {
          console.warn("[ConvertedModule:\${pluginId}] Custom loadData read:", e);
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
          if (!(await this.app.vault.adapter.exists(moduleDataDir))) {
            await this.app.vault.adapter.mkdir(moduleDataDir);
          }
          await this.app.vault.adapter.write(dataJsonPath, JSON.stringify(data, null, 2));
        } catch (e) {
          console.warn("[ConvertedModule:\${pluginId}] Custom saveData write:", e);
        }
        if (origSaveData) {
          try {
            await origSaveData(data);
          } catch (_) {}
        }
      };

      // 2. Safe app.plugins integration without polluting manifests or Community Plugins list
      if (this.app.plugins && this.app.plugins.plugins) {
        this.app.plugins.plugins[pluginId] = this.instance;
        this.cleanups.push(() => {
          if (this.app.plugins?.plugins && this.app.plugins.plugins[pluginId] === this.instance) {
            delete this.app.plugins.plugins[pluginId];
          }
        });
      }

      // 3. Isolated SettingTab registration for StandaloneModuleSettingModal (Zero pollution of native Obsidian settings)
      this.instance.addSettingTab = (settingTab) => {
        if (!settingTab.id) settingTab.id = ${JSON.stringify(pluginId)};
        settingTab.name = manifest.name;
        this.instance.settingTab = settingTab;
        this.settingTab = settingTab;

        if (typeof window !== "undefined") {
          if (!window.__syncEngineModuleSettingTabs__) window.__syncEngineModuleSettingTabs__ = {};
          window.__syncEngineModuleSettingTabs__[pluginId] = settingTab;
        }

        this.cleanups.push(() => {
          if (this.instance) this.instance.settingTab = null;
          this.settingTab = null;
          if (typeof window !== "undefined" && window.__syncEngineModuleSettingTabs__) {
            delete window.__syncEngineModuleSettingTabs__[pluginId];
          }
        });
      };

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
          await this.instance.unload();
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

    if (typeof window !== "undefined" && window.__syncEngineModuleSettingTabs__) {
      delete window.__syncEngineModuleSettingTabs__[${JSON.stringify(pluginId)}];
    }
    if (this.app?.plugins?.plugins && this.app.plugins.plugins[${JSON.stringify(pluginId)}] === this.instance) {
      delete this.app.plugins.plugins[${JSON.stringify(pluginId)}];
    }
  };
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

    // Record converted module provenance for auto-updates & discovery
    if (!this.moduleSettings.convertedModules) {
      this.moduleSettings.convertedModules = {};
    }
    this.moduleSettings.convertedModules[pluginId] = {
      id: pluginId,
      name: moduleName,
      version: moduleVer,
      repo: repo || options.repo || manifest.repo || "",
      sourceType: options.source || (options.remoteAssets ? "remote" : "local"),
      convertedAt: Date.now(),
      lastCheckedAt: Date.now(),
      latestVersion: moduleVer,
      hasUpdate: false
    };

    if (this.ctx.saveSettings) {
      await this.ctx.saveSettings();
    }

    return {
      id: pluginId,
      name: moduleName,
      file: targetModuleFile
    };
  }

  getAvailableUpdatesCount() {
    const converted = this.moduleSettings?.convertedModules || {};
    return Object.values(converted).filter((m) => m && m.hasUpdate).length;
  }

  // Fetch official community plugins catalog + download stats
  async fetchCommunityCatalog(force = false) {
    const now = Date.now();
    if (!force && this.communityCatalogCache && now < this.communityCatalogExpiresAt) {
      return this.communityCatalogCache;
    }

    try {
      const [pluginsRes, statsRes] = await Promise.all([
        fetch("https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json"),
        fetch("https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json").catch(() => null)
      ]);

      if (!pluginsRes.ok) throw new Error(`HTTP ${pluginsRes.status} fetching community plugins catalog`);
      const plugins = await pluginsRes.json();
      let stats = {};
      if (statsRes && statsRes.ok) {
        try { stats = await statsRes.json(); } catch (_) {}
      }

      const catalog = plugins.map((p) => {
        const s = stats[p.id] || {};
        const name = p.name || p.id;
        const author = p.author || "Unknown";
        const desc = p.description || "";
        return {
          id: p.id,
          name,
          author,
          description: desc,
          repo: p.repo || "",
          downloads: s.downloads || 0,
          updated: s.updated || 0,
          _searchKey: `${name} ${p.id} ${desc} ${author}`.toLowerCase()
        };
      });

      this.communityCatalogCache = catalog;
      this.communityCatalogExpiresAt = now + 12 * 60 * 60 * 1000; // 12 hours cache
      return catalog;
    } catch (err) {
      console.warn("[WorkflowManager] Failed to fetch community catalog:", err);
      if (this.communityCatalogCache) return this.communityCatalogCache;
      throw err;
    }
  }

  // Fetch release assets (manifest.json, main.js, styles.css) from GitHub
  async fetchRemotePluginAssets(repo, version = null) {
    if (!repo) throw new Error("GitHub repository is required (owner/repo)");
    const cleanRepo = repo.replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, "");

    const baseReleaseUrl = version 
      ? `https://github.com/${cleanRepo}/releases/download/${version}` 
      : `https://github.com/${cleanRepo}/releases/latest/download`;

    let manifest = null;
    let mainJs = "";
    let stylesCss = "";

    try {
      const manifestRes = await fetch(`${baseReleaseUrl}/manifest.json`);
      if (manifestRes.ok) {
        manifest = await manifestRes.json();
      }
    } catch (_) {}

    if (!manifest) {
      const rawManifestRes = await fetch(`https://raw.githubusercontent.com/${cleanRepo}/HEAD/manifest.json`);
      if (!rawManifestRes.ok) throw new Error(`Could not find manifest.json in ${cleanRepo}`);
      manifest = await rawManifestRes.json();
    }

    let mainRes = await fetch(`${baseReleaseUrl}/main.js`);
    if (mainRes.ok) {
      mainJs = await mainRes.text();
    } else {
      mainRes = await fetch(`https://raw.githubusercontent.com/${cleanRepo}/HEAD/main.js`);
      if (!mainRes.ok) throw new Error(`Could not find main.js in ${cleanRepo}`);
      mainJs = await mainRes.text();
    }

    try {
      const stylesRes = await fetch(`${baseReleaseUrl}/styles.css`);
      if (stylesRes.ok) {
        stylesCss = await stylesRes.text();
      } else {
        const rawStylesRes = await fetch(`https://raw.githubusercontent.com/${cleanRepo}/HEAD/styles.css`);
        if (rawStylesRes.ok) stylesCss = await rawStylesRes.text();
      }
    } catch (_) {}

    return {
      manifest,
      mainJs,
      stylesCss,
      repo: cleanRepo
    };
  }

  // Check for updates across all converted modules
  async checkForModuleUpdates(notify = true) {
    const converted = this.moduleSettings.convertedModules || {};
    const moduleIds = Object.keys(converted);
    if (moduleIds.length === 0) {
      if (notify) new Notice("No converted modules found to check.");
      return 0;
    }

    let updatesFound = 0;
    for (const id of moduleIds) {
      const item = converted[id];
      if (!item || !item.repo) continue;

      try {
        const manifestRes = await fetch(`https://raw.githubusercontent.com/${item.repo}/HEAD/manifest.json`);
        if (!manifestRes.ok) continue;
        const remoteManifest = await manifestRes.json();
        const latestVer = remoteManifest.version;
        if (latestVer) {
          item.latestVersion = latestVer;
          item.lastCheckedAt = Date.now();
          if (this.compareSemVer(latestVer, item.version) > 0) {
            item.hasUpdate = true;
            updatesFound++;
          } else {
            item.hasUpdate = false;
          }
        }
      } catch (e) {
        console.warn(`[WorkflowManager] Update check failed for ${id}:`, e);
      }
    }

    await this.saveSettings();

    if (notify) {
      if (updatesFound > 0) {
        new Notice(`Workflow Manager: ${updatesFound} module update(s) available!`);
      } else {
        new Notice("✓ All converted modules are up to date.");
      }
    }
    return updatesFound;
  }

  // Update a converted module to its latest release
  async updateConvertedModule(pluginId) {
    const item = this.moduleSettings.convertedModules?.[pluginId];
    if (!item) throw new Error(`Converted module ${pluginId} not found in tracking manifest.`);
    if (!item.repo) throw new Error(`No repository registered for ${pluginId}.`);

    const assets = await this.fetchRemotePluginAssets(item.repo);
    await this.convertPluginToModule(pluginId, {
      remoteAssets: assets,
      repo: item.repo,
      source: item.sourceType || "community"
    });

    item.version = assets.manifest.version || item.latestVersion;
    item.latestVersion = item.version;
    item.hasUpdate = false;
    item.lastCheckedAt = Date.now();
    await this.saveSettings();

    return item;
  }

  compareSemVer(v1, v2) {
    if (!v1 || !v2) return 0;
    const p1 = String(v1).replace(/^v/, "").split(".").map(Number);
    const p2 = String(v2).replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const num1 = p1[i] || 0;
      const num2 = p2[i] || 0;
      if (num1 > num2) return 1;
      if (num1 < num2) return -1;
    }
    return 0;
  }

  // Package and publish a converted module directly to Git repository & modules.json catalog
  async publishModuleToGit(config) {
    const { id, name, version, description, icon, repoPath } = config;
    if (!id || !repoPath) throw new Error("Module ID and Repository Path are required.");

    const adapter = this.ctx.app?.vault?.adapter;
    if (!adapter) throw new Error("Vault adapter not accessible.");

    const modDir = `${repoPath}/modules`;
    const catalogFile = `${repoPath}/modules.json`;

    // 1. Read source JS code from local modules
    const localModulePath = `${this.ctx.app.vault.configDir}/plugins/sync-engine/modules/${id}.js`;
    let code = "";
    if (await adapter.exists(localModulePath)) {
      code = await adapter.read(localModulePath);
    } else {
      throw new Error(`Local module file not found at ${localModulePath}`);
    }

    // Strip any existing header
    code = code.replace(/\/\*![\s\S]*?\*\/\s*/, "");

    // 2. Prepend standard header
    const header = `/*!\nname: ${name || id}\nicon: ${icon || "puzzle"}\ndescription: ${description || ""}\nversion: ${version || "1.0.0"}\nreadme: https://github.com/amarjt/sync-engine-modules\n*/\n\n`;
    const fullCode = header + code.trim() + "\n";

    // 3. Write to repository modules directory
    let fs = null;
    let crypto = null;
    try {
      if (typeof require === "function") {
        fs = require("fs");
        crypto = require("crypto");
      }
    } catch (_) {}

    const targetModuleFile = `${modDir}/${id}.js`;
    let sha256 = "";

    if (fs && crypto) {
      if (!fs.existsSync(modDir)) fs.mkdirSync(modDir, { recursive: true });
      fs.writeFileSync(targetModuleFile, fullCode, "utf8");
      sha256 = crypto.createHash("sha256").update(Buffer.from(fullCode, "utf8")).digest("hex");

      // Update modules.json
      let catalog = [];
      if (fs.existsSync(catalogFile)) {
        try {
          catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
        } catch (_) { catalog = []; }
      }

      const rawGitUrl = `https://raw.githubusercontent.com/amarjt/sync-engine-modules/main/modules/${id}.js`;
      const existingIdx = catalog.findIndex((m) => m.id === id);
      const newEntry = {
        id,
        name: name || id,
        version: version || "1.0.0",
        description: description || "",
        icon: icon || "puzzle",
        main: rawGitUrl,
        minPluginVersion: "3.3.0",
        integrity: sha256,
        readme: "https://github.com/amarjt/sync-engine-modules"
      };

      if (existingIdx !== -1) {
        catalog[existingIdx] = newEntry;
      } else {
        catalog.push(newEntry);
      }

      fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2) + "\n", "utf8");

      // Also ensure live local copy in vault has the formatted code
      await adapter.write(localModulePath, fullCode);

      // Verify moduleSources in Sync Engine settings
      if (this.ctx.settings) {
        if (!Array.isArray(this.ctx.settings.moduleSources)) this.ctx.settings.moduleSources = [];
        const catalogUrl = "https://raw.githubusercontent.com/amarjt/sync-engine-modules/main/modules.json";
        if (!this.ctx.settings.moduleSources.includes(catalogUrl)) {
          this.ctx.settings.moduleSources.push(catalogUrl);
          if (this.ctx.saveSettings) await this.ctx.saveSettings();
        }
      }

      // Rescan modules in Sync Engine
      if (typeof this.ctx.loadAllModules === "function") {
        await this.ctx.loadAllModules();
      }

      return {
        id,
        name: name || id,
        version: version || "1.0.0",
        sha256,
        targetModuleFile,
        catalogFile
      };
    } else {
      throw new Error("Node fs/crypto required to package module to repository.");
    }
  }

  async loadSettings() {
    const myId = this.getModuleId();
    const modObj = this.ctx.settings?.modules?.[myId] || {};
    const stored = modObj.workflowSettings || (modObj.profiles ? modObj : null);
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
    Object.assign(this.ctx.settings.modules[myId], this.moduleSettings);

    if (this.ctx.saveSettings) {
      await this.ctx.saveSettings();
    }
  }
}

export default WorkflowManagerModule;
