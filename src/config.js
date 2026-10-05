const fs   = require('fs');
const path = require('path');

/**
 * Reads screencast.config.json from `dir`. Returns {} if missing or invalid.
 * Windows PowerShell 5.1 writes UTF-8 files with a BOM, which JSON.parse rejects,
 * so strip it before parsing.
 */
function loadConfig(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'screencast.config.json'), 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

module.exports = { loadConfig };
