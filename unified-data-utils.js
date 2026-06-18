function isCustomContentEntry(entry) {
  return entry.groups && Array.isArray(entry.groups) && entry.groups.includes('Contenu personnalisé');
}

function extractCustomContent(data = {}) {
  return {
    films: (data.films || []).filter(isCustomContentEntry),
    series: (data.series || []).filter(isCustomContentEntry)
  };
}

function countCustomContent(films = [], series = []) {
  const customFilms = films.filter(isCustomContentEntry);
  const customSeries = series.filter(isCustomContentEntry);
  const episodes = customSeries.reduce((sum, s) => {
    return sum + Object.values(s.seasons || {}).reduce((sSum, episodesMap) => {
      return sSum + Object.keys(episodesMap || {}).length;
    }, 0);
  }, 0);
  return {
    films: customFilms.length,
    series: customSeries.length,
    episodes
  };
}

function mergeUniqueList(primary = [], secondary = []) {
  return [...new Set([...primary, ...secondary])];
}

function mergeEpisodeMaps(preferred, other) {
  return { ...(other || {}), ...(preferred || {}) };
}

function mergeSeriesEntries(a, b) {
  const primary = isCustomContentEntry(a) && !isCustomContentEntry(b) ? a
    : isCustomContentEntry(b) && !isCustomContentEntry(a) ? b
    : a;
  const secondary = primary === a ? b : a;

  const mergedSeasons = {};
  const seasonKeys = new Set([
    ...Object.keys(primary.seasons || {}),
    ...Object.keys(secondary.seasons || {})
  ]);

  for (const seasonNum of seasonKeys) {
    mergedSeasons[seasonNum] = mergeEpisodeMaps(
      primary.seasons?.[seasonNum],
      secondary.seasons?.[seasonNum]
    );
  }

  return {
    ...secondary,
    ...primary,
    tmdbId: primary.tmdbId,
    name: primary.name || secondary.name,
    year: primary.year || secondary.year,
    diffuser: primary.diffuser || secondary.diffuser || '[]',
    groups: mergeUniqueList(primary.groups || [], secondary.groups || []),
    seasons: mergedSeasons
  };
}

function mergeFilmEntries(a, b) {
  const primary = isCustomContentEntry(a) && !isCustomContentEntry(b) ? a
    : isCustomContentEntry(b) && !isCustomContentEntry(a) ? b
    : a;
  const secondary = primary === a ? b : a;

  return {
    ...secondary,
    ...primary,
    tmdbId: primary.tmdbId,
    name: primary.name || secondary.name,
    year: primary.year || secondary.year,
    diffuser: primary.diffuser || secondary.diffuser || '[]',
    groups: mergeUniqueList(primary.groups || [], secondary.groups || []),
    qualities: mergeUniqueList(primary.qualities || [], secondary.qualities || []),
    allDebridIds: mergeUniqueList(primary.allDebridIds || [], secondary.allDebridIds || [])
  };
}

function dedupeSeriesList(seriesList) {
  const byId = new Map();
  for (const series of seriesList) {
    const key = String(series.tmdbId);
    if (!byId.has(key)) {
      byId.set(key, series);
    } else {
      byId.set(key, mergeSeriesEntries(byId.get(key), series));
    }
  }
  return [...byId.values()];
}

function dedupeFilmsList(filmsList) {
  const byId = new Map();
  for (const film of filmsList) {
    const key = String(film.tmdbId);
    if (!byId.has(key)) {
      byId.set(key, film);
    } else {
      byId.set(key, mergeFilmEntries(byId.get(key), film));
    }
  }
  return [...byId.values()];
}

function dedupeUnifiedData(data) {
  return {
    films: dedupeFilmsList(data.films || []),
    series: dedupeSeriesList(data.series || [])
  };
}

function buildSeriesIndex(seriesList) {
  return new Map(dedupeSeriesList(seriesList).map(s => [String(s.tmdbId), s]));
}

function buildFilmIndex(filmsList) {
  return new Map(dedupeFilmsList(filmsList).map(f => [String(f.tmdbId), f]));
}

module.exports = {
  extractCustomContent,
  countCustomContent,
  dedupeUnifiedData,
  buildSeriesIndex,
  buildFilmIndex
};
