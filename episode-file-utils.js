const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.m4v', '.ts', '.m2ts', '.webm', '.flv', '.mpg', '.mpeg'];

const SIDECAR_EXTENSIONS = [
  '.nfo', '.txt', '.jpg', '.jpeg', '.png', '.gif', '.bmp',
  '.srt', '.sub', '.ass', '.ssa', '.sup', '.idx', '.url', '.sfv', '.md5'
];

function getFileExtension(filename) {
  if (!filename) return '';
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

function isPlayableVideoFile(filename) {
  return VIDEO_EXTENSIONS.includes(getFileExtension(filename));
}

function isSidecarFile(filename) {
  return SIDECAR_EXTENSIONS.includes(getFileExtension(filename));
}

function getFileEntry(file) {
  const fileLink = file.link || file.id;
  if (!fileLink) return null;

  let fileId = fileLink;
  if (fileLink.includes('/f/')) {
    fileId = fileLink.split('/f/').pop() || fileLink;
  }

  const filename = file.filename || file.name || '';
  return {
    fileId,
    filename,
    size: file.size || 0
  };
}

function getFilePriority(entry) {
  if (!entry) return { rank: -1, size: 0 };
  if (isPlayableVideoFile(entry.filename)) return { rank: 2, size: entry.size || 0 };
  if (isSidecarFile(entry.filename)) return { rank: 0, size: entry.size || 0 };
  return { rank: 1, size: entry.size || 0 };
}

function isBetterEpisodeFile(candidate, current) {
  if (!current) return true;
  const candidatePriority = getFilePriority(candidate);
  const currentPriority = getFilePriority(current);
  if (candidatePriority.rank !== currentPriority.rank) {
    return candidatePriority.rank > currentPriority.rank;
  }
  return candidatePriority.size > currentPriority.size;
}

function shouldSkipEpisodeFile(filename) {
  return isSidecarFile(filename);
}

function selectBestVideoFile(files) {
  const entries = (files || [])
    .map(getFileEntry)
    .filter(Boolean)
    .filter(entry => !shouldSkipEpisodeFile(entry.filename));

  if (entries.length === 0) {
    return (files || []).map(getFileEntry).find(Boolean) || null;
  }

  return entries.reduce((best, entry) => (
    isBetterEpisodeFile(entry, best) ? entry : best
  ), null);
}

function assignEpisodeFile(seasons, episodeMeta, seasonKey, episodeKey, entry) {
  if (!entry) return false;
  if (shouldSkipEpisodeFile(entry.filename)) return false;

  if (!seasons[seasonKey]) {
    seasons[seasonKey] = {};
  }

  const metaKey = `${seasonKey}:${episodeKey}`;
  const current = episodeMeta[metaKey];
  if (!current || isBetterEpisodeFile(entry, current)) {
    seasons[seasonKey][episodeKey] = entry.fileId;
    episodeMeta[metaKey] = entry;
    return true;
  }

  return false;
}

module.exports = {
  shouldSkipEpisodeFile,
  selectBestVideoFile,
  getFileEntry,
  assignEpisodeFile
};
