// Utilitaires de parsing des pastes catalogue (films / séries)

function parsePasteColumnHeader(headerLine) {
  const defaults = {
    resIndex: 10,
    urlsIndex: 11,
    networkIndex: 7,
    hasSizeColumn: false
  };

  if (!headerLine || !headerLine.toUpperCase().startsWith('CAT')) {
    return defaults;
  }

  const columns = headerLine.split(';').map(col => col.split('=')[0].trim().toUpperCase());
  const resIndex = columns.indexOf('RES');
  const sizeIndex = columns.indexOf('SIZE');
  const urlsIndex = columns.findIndex(col => col === 'URLS');
  const networkIndex = columns.indexOf('NETWORK');

  return {
    resIndex: resIndex >= 0 ? resIndex : defaults.resIndex,
    urlsIndex: urlsIndex >= 0 ? urlsIndex : (sizeIndex >= 0 ? 12 : defaults.urlsIndex),
    networkIndex: networkIndex >= 0 ? networkIndex : defaults.networkIndex,
    hasSizeColumn: sizeIndex >= 0
  };
}

function isValidAllDebridFileId(id) {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed) return false;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return false;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return true;
  return /^[a-zA-Z0-9_-]{10,}$/.test(trimmed);
}

function parseBracketListField(value) {
  if (!value || value === '[]') return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    try {
      const parsed = JSON.parse(value.replace(/'/g, '"'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (e2) {
      const match = value.match(/\[(.*)\]/s);
      if (!match) return [];
      return match[1]
        .split(',')
        .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    }
  }
}

function filterValidAllDebridIds(ids) {
  return ids.filter(isValidAllDebridFileId);
}

function hasValidAllDebridIds(ids) {
  return Array.isArray(ids) && ids.some(isValidAllDebridFileId);
}

function isPermanentDebridError(message) {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes('not supported')
    || normalized.includes('invalid link')
    || normalized.includes('invalid host')
    || normalized.includes('link not found')
    || normalized.includes('no link')
    || normalized.includes('fichier invalide');
}

module.exports = {
  parsePasteColumnHeader,
  isValidAllDebridFileId,
  parseBracketListField,
  filterValidAllDebridIds,
  hasValidAllDebridIds,
  isPermanentDebridError
};
