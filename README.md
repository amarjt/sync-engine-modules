# Sync Engine Modules Catalog & Distribution

A curated, modular collection of high-performance modules for the Obsidian [Sync Engine](https://github.com/hesprs/sync-engine) plugin (`hesprs/sync-engine`).

---

## 📦 Available Modules

| Module | Description | Icon |
| :--- | :--- | :--- |
| **[Drive Attachments](modules/drive-attachments.js)** | Offload pasted and dropped image, video, and audio attachments directly to Google Drive via official Google OAuth device code authorization, with markdown link insertion and inline previews. | `paperclip` |
| **[Workflow & Plugin Manager](modules/workflow-manager.js)** | Dynamic workflow-based plugin & module control inspired by [Better Add-on Manager (BPM)](https://github.com/eondrcode/obsidian-manager). Synchronizes plugin states with Obsidian workspaces, enables delayed startup acceleration, and converts installed plugins to Sync Engine modules. | `layout-grid` |
| **[Bases Visuals & Pagination](modules/bases-visuals.js)** | All-in-one enhancement for Obsidian Bases: community Bases Visuals (Notion pill colors & conditional formatting), universal View Tabs for standalone & transcluded bases, right-tools collapse toggle, and immediate record pagination. | `layout-grid` |

---

## 🚀 How to Install

### Option A: 1-Click GUI Install (Recommended)
Sync Engine has native support for external module catalogs:

1. Open Obsidian **Settings (`Ctrl + ,`) → Sync Engine → Module Sources**.
2. Add the following raw catalog URL:
   ```
   https://raw.githubusercontent.com/amarjt/sync-engine-modules/main/modules.json
   ```
3. Navigate to **Sync Engine → Module Management**:
   - The modules will appear as visual cards in your catalog.
   - Click **Install** on any module to download and activate it with zero command-line setup.

---

### Option B: Install From Local File (Offline)
1. Download or copy any `.js` file from the [`modules/`](modules/) folder.
2. In Obsidian, go to **Settings → Sync Engine → Module Management**.
3. Click the top-right **Gear / Options** icon and select **Install module from file**.
4. Select the `.js` file (e.g. `drive-attachments.js` or `workflow-manager.js`), toggle **Enable** ON, and click **Save**.

---

### Option C: Git Submodule / Clone
For developers managing vaults via Git:
```bash
cd "<your-vault>/.obsidian/plugins/sync-engine/modules"
git clone https://github.com/amarjt/sync-engine-modules.git .
```

---

## 🛠️ Developer & Publishing Guide

### Adding or Updating a Module
1. Place or edit your module in `modules/<module-id>.js`. Ensure it begins with the standard metadata comment block:
   ```javascript
   /*!
   name: Your Module Name
   icon: icon-name
   description: Brief description of features.
   version: 1.0.0
   readme: https://github.com/...
   */
   ```
2. Run the catalog builder to recalculate SHA-256 integrity hashes:
   ```bash
   node scripts/build-catalog.js
   ```
3. Commit and push your changes to GitHub:
   ```bash
   git add .
   git commit -m "feat: add new module"
   git push origin main
   ```
