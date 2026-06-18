const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const PASTEBIN_CODES_PATH = path.join(__dirname, 'pastebin_codes.json');

const DEFAULT_SETTINGS = {
  alldebridApiKey: '',
  pastebinBaseUrl: ''
};

function normalizeBaseUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function loadSettingsFromDisk() {
  let settings = { ...DEFAULT_SETTINGS };
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      settings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        pastebinBaseUrl: normalizeBaseUrl(parsed.pastebinBaseUrl || '')
      };
    }
  } catch (error) {
    console.error('Erreur lors du chargement de settings.json:', error.message);
  }

  if (!settings.alldebridApiKey && process.env.ALLDEBRID_API_KEY) {
    settings.alldebridApiKey = String(process.env.ALLDEBRID_API_KEY).trim();
  }
  if (!settings.pastebinBaseUrl && process.env.PASTEBIN_BASE_URL) {
    settings.pastebinBaseUrl = normalizeBaseUrl(process.env.PASTEBIN_BASE_URL);
  }

  return settings;
}

let runtimeSettings = loadSettingsFromDisk();

function getAllDebridApiKey() {
  return String(runtimeSettings.alldebridApiKey || process.env.ALLDEBRID_API_KEY || '').trim();
}

function getPastebinBaseUrl() {
  const fromSettings = runtimeSettings.pastebinBaseUrl;
  if (fromSettings) return fromSettings;
  return normalizeBaseUrl(process.env.PASTEBIN_BASE_URL || '');
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

function getPublicSettings() {
  const key = getAllDebridApiKey();
  return {
    alldebridApiKeyConfigured: !!key,
    alldebridApiKeyMasked: maskSecret(key),
    pastebinBaseUrl: runtimeSettings.pastebinBaseUrl || ''
  };
}

function saveSettings(partial = {}) {
  if (partial.alldebridApiKey !== undefined) {
    runtimeSettings.alldebridApiKey = String(partial.alldebridApiKey).trim();
  }
  if (partial.pastebinBaseUrl !== undefined) {
    runtimeSettings.pastebinBaseUrl = normalizeBaseUrl(partial.pastebinBaseUrl);
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(runtimeSettings, null, 2), 'utf-8');
  return getPublicSettings();
}

function loadPastebinCodes() {
  try {
    if (fs.existsSync(PASTEBIN_CODES_PATH)) {
      const codes = JSON.parse(fs.readFileSync(PASTEBIN_CODES_PATH, 'utf-8'));
      return Array.isArray(codes) ? codes : [];
    }
  } catch (error) {
    console.error('Erreur lors du chargement des codes pastebin:', error.message);
  }
  return [];
}

function savePastebinCodes(codes) {
  const normalized = Array.isArray(codes) ? codes : [];
  fs.writeFileSync(PASTEBIN_CODES_PATH, JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

function resetSettings() {
  runtimeSettings = { ...DEFAULT_SETTINGS };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(runtimeSettings, null, 2), 'utf-8');
  return getPublicSettings();
}

module.exports = {
  getAllDebridApiKey,
  getPastebinBaseUrl,
  getPublicSettings,
  saveSettings,
  resetSettings,
  loadPastebinCodes,
  savePastebinCodes
};
