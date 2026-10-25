const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration: Replace with your actual GitHub username/repo when publishing
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || "amarjt/sync-engine-modules";
const GITHUB_BRANCH = process.env.GITHUB_REF_NAME || "main";
const BASE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/modules`;

const rootDir = path.join(__dirname, '..');
const modulesDir = path.join(rootDir, 'modules');
const catalogFile = path.join(rootDir, 'modules.json');

if (!fs.existsSync(modulesDir)) {
  console.error("Modules directory does not exist:", modulesDir);
  process.exit(1);
}

const catalog = [];
const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));

console.log(`Found ${files.length} module(s) in ${modulesDir}`);

for (const file of files) {
  const filePath = path.join(modulesDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const id = path.basename(file, '.js');

  // Parse header metadata
  const meta = {
    id,
    name: id,
    version: "1.0.0",
    description: "",
    icon: "puzzle",
    minPluginVersion: "3.3.0"
  };

  const headerMatch = content.match(/\/\*!([\s\S]*?)\*\//);
  if (headerMatch) {
    const lines = headerMatch[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
        const val = trimmed.slice(colonIdx + 1).trim();
        if (key && val) {
          meta[key] = val;
        }
      }
    }
  }

  // Normalize line endings to LF before hashing so hash matches Git raw endpoints exactly
  const normalizedContent = content.replace(/\r\n/g, '\n');

  // Calculate SHA-256 integrity hash (exact format expected by Sync Engine)
  const hash = crypto.createHash('sha256').update(normalizedContent, 'utf8').digest('hex');

  const entry = {
    id: meta.id || id,
    name: meta.name || id,
    version: meta.version || "1.0.0",
    description: meta.description || "",
    icon: meta.icon || "puzzle",
    main: `${BASE_URL}/${file}`,
    minPluginVersion: meta.minpluginversion || "3.3.0",
    integrity: hash
  };

  if (meta.readme) {
    entry.readme = meta.readme;
  }

  catalog.push(entry);
  console.log(`✓ Processed ${entry.name} (${entry.id} v${entry.version}) -> SHA256: ${hash.slice(0, 12)}...`);
}

fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2), 'utf8');
console.log(`\nCatalog successfully generated with ${catalog.length} module(s) -> ${catalogFile}`);
