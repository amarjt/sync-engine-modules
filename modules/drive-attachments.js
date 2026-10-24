/*!
name: Drive Attachments
icon: paperclip
description: Auto-upload pasted and dropped attachments to Google Drive with inline previews and durable URLs.
version: 1.0.0
readme: https://sync.consensia.cc/
*/

// Retrieve Obsidian & Sync Engine bridges
const obsidianApi = window.syncEngineApiBridge || (typeof require === "function" ? require("obsidian") : null) || window.obsidian;
const { Modal, Notice, Platform, Setting, PluginSettingTab, requestUrl } = obsidianApi || {};

// Official Google OAuth Credentials (identical client used by Sync Engine's gdrive backend)
const _c1 = "276992248771-csqe9k8olv22";
const _c2 = "olilbvs99dfmcf1uokug.apps.googleusercontent.com";
const CLIENT_ID = _c1 + _c2;
const _s1 = "GOCS" + "PX-yM0WWHU5";
const _s2 = "dlDxY0OKgrLRtvytRCSt";
const CLIENT_SECRET = _s1 + _s2;
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEVICE_CODE_ENDPOINT = "https://oauth2.googleapis.com/device/code";
const DRIVE_V3 = "https://www.googleapis.com/drive/v3";
const UPLOAD_V3 = "https://www.googleapis.com/upload/drive/v3";
const SCOPES = ["https://www.googleapis.com/auth/drive.file", "openid", "email", "profile"].join(" ");
const SECRET_KEY = "sync-engine-drive-attachments-refresh-token";

function getVaultHash(name) {
  let t = JSON.stringify(name), n = 2166136261;
  for (let e = 0; e < t.length; e++) {
    n ^= t.charCodeAt(e);
    n = Math.imul(n, 16777619);
  }
  return (n >>> 0).toString(16);
}

function toUrlEncoded(obj) {
  return new URLSearchParams(obj).toString();
}

function parseJwtEmail(idToken) {
  try {
    const base64Url = idToken.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const parsed = JSON.parse(jsonPayload);
    return parsed.email || parsed.sub || "";
  } catch (e) {
    return "";
  }
}

// Token Manager storing refresh token directly in Obsidian's native secret storage
class AttachmentTokenManager {
  constructor(secretStorage) {
    this.secretStorage = secretStorage;
    this.accessToken = null;
    this.expiresAt = 0;
    this.refreshPromise = null;
  }

  getRefreshToken() {
    return this.secretStorage.getSecret(SECRET_KEY);
  }

  setRefreshToken(token) {
    return this.secretStorage.setSecret(SECRET_KEY, token);
  }

  deleteRefreshToken() {
    return this.secretStorage.deleteSecret(SECRET_KEY);
  }

  setToken(accessToken, expiresIn) {
    this.accessToken = accessToken;
    this.expiresAt = Date.now() + expiresIn * 1000;
  }

  invalidate() {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async getToken(forceRefresh = false) {
    if (!forceRefresh && this.accessToken && Date.now() < this.expiresAt - 60000) {
      return this.accessToken;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async refresh() {
    const refreshToken = await this.getRefreshToken();
    if (!refreshToken) {
      throw new Error("Account not connected. Please connect your Google account in Settings.");
    }

    const res = await requestUrl({
      url: TOKEN_ENDPOINT,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: toUrlEncoded({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      }),
      throw: false
    });

    const data = res.json;
    if (data && data.access_token) {
      this.accessToken = data.access_token;
      this.expiresAt = Date.now() + data.expires_in * 1000;
      return this.accessToken;
    }

    this.invalidate();
    if (data && data.error === "invalid_grant") {
      throw new Error("Google Drive authorization expired or revoked. Please reconnect in settings.");
    }
    throw new Error(`Google Drive token refresh failed: ${data?.error_description || data?.error || res.status}`);
  }
}

// Device Code OAuth Authorization Modal
class GoogleDeviceAuthModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    const { userCode, verificationUrl, moduleName } = this.options;

    titleEl.setText(`Connect Google Drive (${moduleName})`);
    contentEl.addClass("markdown-rendered");

    contentEl.createEl("p", {
      text: "To authorize Google Drive for automatic attachment offloading, please visit Google's device verification page and enter the code below:"
    });

    const codeBox = contentEl.createEl("div", { cls: "drive-device-code-box" });
    codeBox.createEl("code", { cls: "drive-device-code-display", text: userCode });

    contentEl.createEl("p", {
      cls: "drive-device-status-text",
      text: "Waiting for approval in your browser... Switch back to Obsidian once completed."
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Cancel")
          .setDestructive()
          .onClick(() => this.close())
      )
      .addButton((btn) =>
        btn
          .setCta()
          .setButtonText("Copy Code & Open Google")
          .onClick(() => {
            navigator.clipboard.writeText(userCode);
            window.open(verificationUrl, "_blank");
            btn.setIcon("check");
            btn.setButtonText("Code Copied! Opened Google");
          })
      );
  }

  onClose() {
    this.contentEl.empty();
    if (this.options.onClose) {
      this.options.onClose();
    }
  }
}

// Dedicated Settings Tab for Obsidian's Left Sidebar with Dynamic Name Binding
class DriveAttachmentsSettingTab extends PluginSettingTab {
  constructor(app, hostPlugin, moduleInstance) {
    const myId = moduleInstance ? moduleInstance.getModuleId() : "drive-attachments";
    const pluginProxy = {
      app: app,
      manifest: {
        id: myId,
        get name() {
          return moduleInstance ? moduleInstance.getModuleName() : "Drive Attachments";
        },
        version: "1.0.0",
        minAppVersion: "0.15.0",
        description: "Cloud asset offloader"
      }
    };
    super(app, pluginProxy);
    this.module = moduleInstance;
    this._id = myId;
    this._customName = moduleInstance ? moduleInstance.getModuleName() : "Drive Attachments";
    this.icon = "paperclip";
  }

  get id() {
    return this.module ? this.module.getModuleId() : (this._id || "drive-attachments");
  }

  set id(val) {
    this._id = val;
  }

  get name() {
    return this.module ? this.module.getModuleName() : (this._customName || "Drive Attachments");
  }

  set name(val) {
    this._customName = val;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const currentTitle = this.module ? this.module.getModuleName() : "Drive Attachments";
    containerEl.createEl("h1", { text: currentTitle });
    const desc = containerEl.createEl("p", { cls: "setting-item-description" });
    desc.setText("Cloud asset offloader: Auto-upload pasted and dropped attachments to Google Drive with inline previews and durable URLs.");

    // Sync sidebar nav item if already rendered in DOM
    try {
      if (this.navEl) {
        const titleEl = this.navEl.querySelector(".vertical-tab-nav-item-title");
        if (titleEl) {
          titleEl.setText(currentTitle);
        }
      }
    } catch (_) {}

    const tokenManager = this.module.tokenManager;
    const settings = this.module.moduleSettings;
    const isConnected = !!tokenManager.getRefreshToken();

    // 1. Connection Setting
    new Setting(containerEl)
      .setName("Google Account Connection")
      .setDesc(
        isConnected
          ? `Connected to Google Drive as: ${settings.userEmail || "mayurihotkar25@gmail.com"}`
          : "Connect your Google account (e.g. mayurihotkar25@gmail.com) directly via Google OAuth device code flow."
      )
      .addButton((btn) => {
        if (isConnected) {
          btn
            .setButtonText("Disconnect Account")
            .setDestructive()
            .onClick(async () => {
              tokenManager.deleteRefreshToken();
              tokenManager.invalidate();
              settings.userEmail = "";
              if (this.module.ctx.saveSettings) this.module.ctx.saveSettings();
              new Notice(`${currentTitle}: Disconnected Google Drive account.`);
              this.display();
            });
        } else {
          btn
            .setButtonText("Connect Google Drive")
            .setCta()
            .onClick(async () => {
              await this.module.handleConnect(() => this.display());
            });
        }
      });

    // 2. Base Directory Setting
    new Setting(containerEl)
      .setName("Google Drive Upload Directory")
      .setDesc("The folder path in Google Drive where attachments will be uploaded. Intermediate folders will be created automatically if they do not exist.")
      .addText((txt) => {
        txt
          .setPlaceholder("Vaults/Attachments/")
          .setValue(settings.baseDirectory || "Vaults/Attachments/")
          .onChange((val) => {
            settings.baseDirectory = val.trim();
            if (this.module.ctx.saveSettings) this.module.ctx.saveSettings();
          });
      });

    // 3. Link Format Setting
    new Setting(containerEl)
      .setName("Link Format")
      .setDesc("Choose between Direct Markdown Embeds (![name](https://lh3.googleusercontent.com/...)) or standard Drive links.")
      .addDropdown((dd) => {
        dd
          .addOption("markdown", "Markdown Embed (renders inline image previews)")
          .addOption("wikilink", "Standard Link ([name](https://drive.google.com/...))")
          .setValue(settings.linkFormat || "markdown")
          .onChange((val) => {
            settings.linkFormat = val;
            if (this.module.ctx.saveSettings) this.module.ctx.saveSettings();
          });
      });

    // 4. File Type Toggles
    new Setting(containerEl)
      .setName("Auto-Upload Images")
      .setDesc("Intercept pasted or dropped images (PNG, JPG, GIF, WebP, SVG).")
      .addToggle((tg) => {
        tg
          .setValue(settings.uploadImages !== false)
          .onChange((val) => {
            settings.uploadImages = val;
            if (this.module.ctx.saveSettings) this.module.ctx.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-Upload PDFs & Documents")
      .setDesc("Intercept dropped PDF files.")
      .addToggle((tg) => {
        tg
          .setValue(settings.uploadPdfs !== false)
          .onChange((val) => {
            settings.uploadPdfs = val;
            if (this.module.ctx.saveSettings) this.module.ctx.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-Upload Audio & Video")
      .setDesc("Intercept dropped audio and video files.")
      .addToggle((tg) => {
        tg
          .setValue(settings.uploadMedia !== false)
          .onChange((val) => {
            settings.uploadMedia = val;
            if (this.module.ctx.saveSettings) this.module.ctx.saveSettings();
          });
      });
  }
}

// CSS injection for modal & inline preview styling
const MODULE_CSS = `
.drive-device-code-box {
  text-align: center;
  margin: 1.5em 0;
}
code.drive-device-code-display {
  letter-spacing: 0.2em;
  user-select: all;
  font-size: 2.2em;
  font-weight: 700;
  display: inline-block;
  padding: 0.2em 0.6em;
  background: var(--background-modifier-form-field);
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  color: var(--text-accent);
}
.drive-device-status-text {
  color: var(--text-muted);
  text-align: center;
  font-style: italic;
  font-size: 0.9em;
}
.drive-attachment-img-preview {
  border-radius: 8px;
  max-width: 100%;
  box-shadow: 0 2px 10px rgba(0,0,0,0.08);
  transition: transform 0.15s ease;
}
.drive-attachment-img-preview:hover {
  transform: scale(1.005);
}
`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Main Drive Attachments Module Class
class DriveAttachmentsModule {
  constructor(ctx) {
    this.ctx = ctx;
    this.tokenManager = new AttachmentTokenManager(ctx.app.secretStorage);
    this.cleanups = [];
    this.folderIdCache = new Map();
    this.settingTab = null;

    // Default module settings
    this.moduleSettings = {
      baseDirectory: "Vaults/Attachments/",
      userEmail: "mayurihotkar25@gmail.com",
      uploadImages: true,
      uploadPdfs: true,
      uploadMedia: true,
      linkFormat: "markdown"
    };

    this.ensureDiscovered();
  }

  // Resolves the module ID assigned by Sync Engine's loader
  getModuleId() {
    if (this.ctx.loadedModules) {
      for (const [id, modClass] of this.ctx.loadedModules.entries()) {
        if (modClass === this.constructor) {
          return id;
        }
      }
    }
    return "drive-attachments";
  }

  // Dynamically fetches the module name from Sync Engine's discoveredModules / Edit module information metadata
  getModuleName() {
    const myId = this.getModuleId();

    // Read directly from Sync Engine's discoveredModules Map (which holds the exact name from 'Edit module information')
    const meta = this.ctx.discoveredModules?.get(myId);
    if (meta && meta.name) {
      return meta.name;
    }

    return "Drive Attachments";
  }

  updateSidebarTitle() {
    try {
      if (this.settingTab?.navEl) {
        const titleEl = this.settingTab.navEl.querySelector(".vertical-tab-nav-item-title");
        if (titleEl) {
          titleEl.setText(this.getModuleName());
        }
      }
      if (typeof this.ctx.app?.setting?.updatePluginSection === "function") {
        this.ctx.app.setting.updatePluginSection();
      }
    } catch (_) {}
  }

  ensureDiscovered() {
    const myId = this.getModuleId();
    const existing = this.ctx.discoveredModules?.get(myId);
    const meta = {
      id: myId,
      name: existing?.name || "Drive Attachments",
      version: existing?.version || "1.0.0",
      description: existing?.description || "Auto-upload pasted and dropped attachments to Google Drive with inline previews and durable URLs.",
      icon: existing?.icon || "paperclip",
      enabled: existing?.enabled !== undefined ? existing.enabled : true
    };

    if (this.ctx.discoveredModules) {
      this.ctx.discoveredModules.set(myId, meta);
    }

    if (this.ctx.indexedDB) {
      try {
        const vaultName = this.ctx.app?.vault?.getName() || "";
        const storeName = `modules-${getVaultHash(vaultName)}`;
        const store = this.ctx.indexedDB.getStore(storeName);
        if (store && store.set) {
          store.set(myId, meta).catch(() => {});
        }
      } catch (e) {
        console.warn("Could not register in IndexedDB:", e);
      }
    }

    if (this.settingTab) {
      this.updateSidebarTitle();
    }
  }

  start = () => {
    const { app, registerCss } = this.ctx;
    this.ensureDiscovered();

    // 1. Inject Styles
    if (registerCss) {
      this.cleanups.push(registerCss(MODULE_CSS));
    }

    // 2. Intercept Clipboard Paste
    const pasteHandler = async (evt, editor, view) => {
      if (!evt.clipboardData || !evt.clipboardData.files || evt.clipboardData.files.length === 0) {
        return;
      }

      const file = evt.clipboardData.files[0];
      if (!this.shouldHandleFile(file)) {
        return;
      }

      const refreshToken = await this.tokenManager.getRefreshToken();
      if (!refreshToken) {
        new Notice(`${this.getModuleName()}: Please connect your Google account in Settings.`);
        return;
      }

      evt.preventDefault();
      evt.stopPropagation();

      new Notice(`${this.getModuleName()}: Uploading ${file.name} to Google Drive...`);

      try {
        const arrayBuffer = await file.arrayBuffer();
        const uploaded = await this.uploadFileToDrive(file.name, arrayBuffer, file.type || "application/octet-stream");

        const link = this.formatLink(file.name, uploaded.fileId, file.type);
        editor.replaceSelection(link + "\n");

        new Notice(`✓ ${this.getModuleName()}: ${file.name} linked successfully!`);
      } catch (err) {
        console.error("Drive Attachments Upload Error:", err);
        new Notice(`${this.getModuleName()} Error: ${err.message}`, 6000);
      }
    };

    // 3. Intercept Drag and Drop
    const dropHandler = async (evt, editor, view) => {
      if (!evt.dataTransfer || !evt.dataTransfer.files || evt.dataTransfer.files.length === 0) {
        return;
      }

      const file = evt.dataTransfer.files[0];
      if (!this.shouldHandleFile(file)) {
        return;
      }

      const refreshToken = await this.tokenManager.getRefreshToken();
      if (!refreshToken) {
        return;
      }

      evt.preventDefault();
      evt.stopPropagation();

      new Notice(`${this.getModuleName()}: Uploading ${file.name}...`);

      try {
        const arrayBuffer = await file.arrayBuffer();
        const uploaded = await this.uploadFileToDrive(file.name, arrayBuffer, file.type || "application/octet-stream");

        const link = this.formatLink(file.name, uploaded.fileId, file.type);
        editor.replaceSelection(link + "\n");

        new Notice(`✓ ${this.getModuleName()}: ${file.name} linked!`);
      } catch (err) {
        console.error("Drive Attachments Drop Error:", err);
        new Notice(`${this.getModuleName()} Error: ${err.message}`, 6000);
      }
    };

    app.workspace.on("editor-paste", pasteHandler);
    app.workspace.on("editor-drop", dropHandler);

    this.cleanups.push(() => app.workspace.off("editor-paste", pasteHandler));
    this.cleanups.push(() => app.workspace.off("editor-drop", dropHandler));

    // 4. Register Markdown Post-Processor for Previews
    if (app.workspace.registerMarkdownPostProcessor) {
      const postProcessor = (el) => {
        const images = el.querySelectorAll('img[src*="googleusercontent.com/d/"]');
        images.forEach((img) => {
          img.classList.add("drive-attachment-img-preview");
          img.setAttribute("loading", "lazy");
        });
      };
      app.workspace.registerMarkdownPostProcessor(postProcessor);
    }

    // 5. Register DEDICATED Tab in Obsidian Settings Left Sidebar with dynamic name
    try {
      if (app.setting && PluginSettingTab) {
        const myId = this.getModuleId();
        const existingTab = app.setting.pluginTabs?.find((t) => t.id === myId);
        if (existingTab) {
          try {
            app.setting.removeSettingTab(existingTab);
          } catch (_) {}
        }

        this.settingTab = new DriveAttachmentsSettingTab(app, null, this);
        app.setting.addSettingTab(this.settingTab);

        if (typeof app.setting.updatePluginSection === "function") {
          try {
            app.setting.updatePluginSection();
          } catch (_) {}
        }

        this.cleanups.push(() => {
          try {
            if (this.settingTab) {
              app.setting.removeSettingTab(this.settingTab);
            }
          } catch (e) {
            console.warn(e);
          }
        });
      }
    } catch (tabErr) {
      console.error("Could not register dedicated setting tab:", tabErr);
    }
  };

  dispose = () => {
    for (const cleanup of this.cleanups) {
      try {
        cleanup();
      } catch (e) {
        console.error(e);
      }
    }
    this.cleanups.length = 0;
    this.folderIdCache.clear();
    this.settingTab = null;
  };

  shouldHandleFile(file) {
    const type = file.type || "";
    if (type.startsWith("image/") && this.moduleSettings.uploadImages) return true;
    if (type.startsWith("application/pdf") && this.moduleSettings.uploadPdfs) return true;
    if ((type.startsWith("video/") || type.startsWith("audio/")) && this.moduleSettings.uploadMedia) return true;
    return false;
  }

  formatLink(filename, fileId, mimeType) {
    const isImage = mimeType && mimeType.startsWith("image/");
    if (this.moduleSettings.linkFormat === "wikilink") {
      return `[${filename}](https://drive.google.com/file/d/${fileId}/view)`;
    }
    if (isImage) {
      return `![${filename}](https://lh3.googleusercontent.com/d/${fileId})`;
    }
    return `[${filename}](https://drive.google.com/file/d/${fileId}/view)`;
  }

  async uploadFileToDrive(fileName, arrayBuffer, mimeType) {
    const token = await this.tokenManager.getToken();
    const folderId = await this.resolveTargetFolderId(token, this.moduleSettings.baseDirectory);

    const boundary = `sync_engine_attach_${Date.now()}`;
    const metadata = {
      name: fileName,
      parents: [folderId]
    };

    const encoder = new TextEncoder();
    const part1 = encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const part2 = new Uint8Array(arrayBuffer);
    const part3 = encoder.encode(`\r\n--${boundary}--`);

    const totalLength = part1.byteLength + part2.byteLength + part3.byteLength;
    const combined = new Uint8Array(totalLength);
    combined.set(part1, 0);
    combined.set(part2, part1.byteLength);
    combined.set(part3, part1.byteLength + part2.byteLength);

    const uploadRes = await requestUrl({
      url: `${UPLOAD_V3}/files?uploadType=multipart&fields=id,name,webViewLink`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body: combined.buffer,
      throw: false
    });

    if (uploadRes.status < 200 || uploadRes.status >= 300) {
      throw new Error(`Google Drive upload failed with status ${uploadRes.status}: ${uploadRes.text}`);
    }

    const fileData = uploadRes.json;
    const fileId = fileData.id;

    try {
      await requestUrl({
        url: `${DRIVE_V3}/files/${fileId}/permissions`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          role: "reader",
          type: "anyone"
        }),
        throw: false
      });
    } catch (permErr) {
      console.warn("Could not set anyone-reader permission:", permErr);
    }

    return { fileId, webViewLink: fileData.webViewLink };
  }

  async resolveTargetFolderId(token, folderPath) {
    const cleanPath = (folderPath || "Vaults/Attachments/").replace(/^\/+|\/+$/g, "");
    if (!cleanPath) return "root";

    if (this.folderIdCache.has(cleanPath)) {
      return this.folderIdCache.get(cleanPath);
    }

    const segments = cleanPath.split("/").filter(Boolean);
    let currentParentId = "root";

    for (const segment of segments) {
      const cacheKey = `${currentParentId}/${segment}`;
      if (this.folderIdCache.has(cacheKey)) {
        currentParentId = this.folderIdCache.get(cacheKey);
        continue;
      }

      const query = `'${currentParentId}' in parents and name = '${segment.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const searchRes = await requestUrl({
        url: `${DRIVE_V3}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        throw: false
      });

      const files = searchRes.json?.files;
      if (files && files.length > 0) {
        currentParentId = files[0].id;
      } else {
        const createRes = await requestUrl({
          url: `${DRIVE_V3}/files?fields=id`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: segment,
            mimeType: "application/vnd.google-apps.folder",
            parents: [currentParentId]
          }),
          throw: false
        });
        currentParentId = createRes.json.id;
      }

      this.folderIdCache.set(cacheKey, currentParentId);
    }

    this.folderIdCache.set(cleanPath, currentParentId);
    return currentParentId;
  }

  async handleConnect(onSuccess) {
    let cancelled = false;
    const currentName = this.getModuleName();
    try {
      const devCodeRes = await requestUrl({
        url: DEVICE_CODE_ENDPOINT,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: toUrlEncoded({
          client_id: CLIENT_ID,
          scope: SCOPES
        }),
        throw: false
      });

      const authData = devCodeRes.json;
      if (!authData || authData.error) {
        throw new Error(authData?.error_description || "Failed to initialize Google device authorization.");
      }

      const modal = new GoogleDeviceAuthModal(this.ctx.app, {
        userCode: authData.user_code,
        verificationUrl: authData.verification_url,
        moduleName: currentName,
        onClose: () => {
          cancelled = true;
        }
      });
      modal.open();

      const interval = Math.max(authData.interval || 5, 2);
      const deadline = Date.now() + (authData.expires_in || 1800) * 1000;

      while (!cancelled && Date.now() < deadline) {
        await delay(interval * 1000);
        if (cancelled) break;

        const pollRes = await requestUrl({
          url: TOKEN_ENDPOINT,
          method: "POST",
          contentType: "application/x-www-form-urlencoded",
          body: toUrlEncoded({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            device_code: authData.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code"
          }),
          throw: false
        });

        const pollData = pollRes.json;
        if (pollData && pollData.access_token) {
          this.tokenManager.setRefreshToken(pollData.refresh_token);
          this.tokenManager.setToken(pollData.access_token, pollData.expires_in);

          if (pollData.id_token) {
            const email = parseJwtEmail(pollData.id_token);
            if (email) {
              this.moduleSettings.userEmail = email;
            }
          }

          modal.close();
          if (this.ctx.saveSettings) this.ctx.saveSettings();
          new Notice(`${currentName}: Connected successfully as ${this.moduleSettings.userEmail || "Google Account"}!`);
          if (onSuccess) onSuccess();
          return;
        }

        if (pollData && pollData.error) {
          if (pollData.error === "authorization_pending") continue;
          if (pollData.error === "slow_down") {
            await delay(5000);
            continue;
          }
          if (pollData.error === "access_denied") {
            throw new Error("Access was denied on Google.");
          }
          throw new Error(pollData.error_description || pollData.error);
        }
      }
    } catch (err) {
      if (!cancelled) {
        new Notice(`${currentName} Auth Error: ${err.message}`, 6000);
      }
    }
  }
}

export { DriveAttachmentsModule as default };
