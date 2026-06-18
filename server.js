require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const dbCacheVod = require('./db-cache-vod');
const userManager = require('./user-manager');
const settingsManager = require('./settings-manager');
const { dedupeUnifiedData, buildSeriesIndex, buildFilmIndex, countCustomContent } = require('./unified-data-utils');
const { isValidPasteCode } = require('./pastebin-code-utils');
const { isValidAllDebridFileId, isPermanentDebridError } = require('./paste-parse-utils');
const { getFileEntry, assignEpisodeFile, selectBestVideoFile, shouldSkipEpisodeFile } = require('./episode-file-utils');
const app = express();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Derrière un reverse proxy (Caddy, nginx) : nombre de sauts à faire confiance (pas `true`).
function resolveTrustProxy() {
  if (process.env.TRUST_PROXY !== undefined && String(process.env.TRUST_PROXY).trim() !== '') {
    const val = String(process.env.TRUST_PROXY).trim().toLowerCase();
    if (val === 'false') return false;
    if (val === 'true') return 1;
    const hops = parseInt(val, 10);
    return Number.isFinite(hops) && hops >= 0 ? hops : 1;
  }
  return IS_PRODUCTION ? 1 : false;
}

app.set('trust proxy', resolveTrustProxy());

// En production, il faut un secret de session fort (pas de fallback)
if (IS_PRODUCTION && (!process.env.SESSION_SECRET || String(process.env.SESSION_SECRET).length < 32)) {
  console.error('❌ ERREUR: SESSION_SECRET manquant ou trop court (min 32 caractères) en production.');
  console.error('   Exemple: SESSION_SECRET=$(openssl rand -hex 32)');
  process.exit(1);
}

// Headers de sécurité (CSP désactivée car les pages utilisent des scripts inline)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Configuration CORS permissive pour Stremio
app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: false
}));

// Gestion des requêtes OPTIONS (preflight)
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.sendStatus(204);
});

// Configuration de session
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-insecure-session-secret-change-me',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    // En prod derrière HTTPS/proxy: 'auto' se base sur req.secure (avec trust proxy)
    secure: IS_PRODUCTION ? 'auto' : false,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 heures
  }
}));

// Middleware pour parser les données de formulaire
app.use(express.urlencoded({ extended: true }));

// Middleware pour logger les requêtes (on ignore /debrid/ pour éviter un log par requête Range)
app.use((req, res, next) => {
  if (!req.path.startsWith('/debrid')) {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  }
  next();
});

// Configuration - variables d'environnement et settings.json (interface web)
const ALLDEBRID_API_BASE = 'https://api.alldebrid.com/v4';
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'b7cf9324cbeb6f4fb811144aa9397093'; // Clé API TMDb publique gratuite
const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const BASE_URL = process.env.BASE_URL; // URL de base du serveur (optionnel, auto-détecté si non fourni)

function getAllDebridApiKey() {
  return settingsManager.getAllDebridApiKey();
}

if (!getAllDebridApiKey()) {
  console.warn('⚠️  Clé API AllDebrid non configurée.');
  console.warn('   Configurez-la via l\'interface web (Gestion Pastebin) ou via ALLDEBRID_API_KEY dans .env');
} else {
  const key = getAllDebridApiKey();
  console.log('✅ Clé API AllDebrid chargée');
  console.log(`   Longueur: ${key.length} caractères (masquée)`);
}

// Données unifiées (films + séries)
// Fonction pour charger/recharger les données depuis la base unifiée
function loadUnifiedData() {
  // Essayer d'abord la base unifiée, sinon fallback sur les fichiers séparés
  try {
    delete require.cache[require.resolve('./unified_data')];
    const unified = require('./unified_data');
    return {
      films: unified.films || [],
      series: unified.series || []
    };
  } catch (e) {
    // Fallback sur fichiers séparés pour compatibilité
    delete require.cache[require.resolve('./films_data')];
    delete require.cache[require.resolve('./series_data')];
    const filmsData = require('./films_data');
    const seriesData = require('./series_data');
    return {
      films: filmsData.FILMS_DATA || [],
      series: seriesData.SERIES_DATA || []
    };
  }
}

const CUSTOM_CONTENT_MOVIE_CATALOG_ID = 'category_contenu_personnalise';
const CUSTOM_CONTENT_SERIES_CATALOG_ID = 'category_contenu_personnalise_series';

function invalidateCustomContentCatalogCache() {
  Promise.all([
    dbCacheVod.clearCatalog(CUSTOM_CONTENT_MOVIE_CATALOG_ID, 'movie'),
    dbCacheVod.clearCatalog(CUSTOM_CONTENT_SERIES_CATALOG_ID, 'series')
  ]).then(() => {
    console.log('🗑️ Cache VOD du contenu personnalisé invalidé');
  }).catch((err) => {
    console.warn(`⚠ Erreur invalidation cache contenu personnalisé: ${err.message}`);
  });
}

// Sauvegarder unified_data.js, recharger les données et reconstruire les index
function saveUnifiedDataAndReload(unifiedDataCopy) {
  const dedupedData = dedupeUnifiedData(unifiedDataCopy);
  const unifiedDataPath = path.join(__dirname, 'unified_data.js');
  const newContent = `// Base de données unifiée (films + séries)
// Généré le: ${new Date().toISOString()}
module.exports = ${JSON.stringify(dedupedData, null, 2)};
`;
  fs.writeFileSync(unifiedDataPath, newContent, 'utf-8');
  const { films: newFilms, series: newSeries } = loadUnifiedData();
  FILMS_DATA = newFilms;
  SERIES_DATA = newSeries;
  const { newTmdbToFilmIndex, newTmdbToSeriesIndex, newCatalogs } = rebuildIndexes();
  tmdbToFilmIndex = newTmdbToFilmIndex;
  tmdbToSeriesIndex = newTmdbToSeriesIndex;
  catalogs = newCatalogs;
  invalidateCustomContentCatalogCache();
}

function logCustomContentStats(contextLabel = 'Démarrage') {
  const stats = countCustomContent(FILMS_DATA, SERIES_DATA);
  if (stats.films > 0 || stats.series > 0) {
    console.log(`📌 ${contextLabel} — contenu personnalisé: ${stats.films} film(s), ${stats.series} série(s), ${stats.episodes} épisode(s)`);
  } else {
    console.log(`📌 ${contextLabel} — aucun contenu personnalisé`);
  }
  return stats;
}

// Chargement initial des données
let { films: FILMS_DATA, series: SERIES_DATA } = loadUnifiedData();

// Cache pour les IDs IMDB
const imdbIdCache = new Map();
const stremioIdCache = new Map();

async function resolveStremioId(tmdbId, contentType = 'movie') {
  const tmdbIdStr = String(tmdbId);
  const cacheKey = `${contentType}:${tmdbIdStr}`;
  if (stremioIdCache.has(cacheKey)) {
    return stremioIdCache.get(cacheKey);
  }

  const endpoint = contentType === 'series' ? 'tv' : 'movie';
  try {
    const response = await axios.get(`${TMDB_API_BASE}/${endpoint}/${tmdbIdStr}/external_ids`, {
      params: { api_key: TMDB_API_KEY },
      timeout: 5000
    });
    const stremioId = response.data.imdb_id || `tmdb_${tmdbIdStr}`;
    stremioIdCache.set(cacheKey, stremioId);
    return stremioId;
  } catch (error) {
    const fallback = `tmdb_${tmdbIdStr}`;
    stremioIdCache.set(cacheKey, fallback);
    return fallback;
  }
}

// Cache des liens débridés AllDebrid.
// Les URLs directes expirent côté hébergeur ; on garde un cache court pour le buffering rapide
// et on force un redébridage lors des reprises/seek (Range) ou en cas d'erreur.
const debridedUrlCache = new Map(); // clé: allDebridId, valeur: { url, expiresAt, createdAt }
const DEBRIDED_URL_MAX_AGE = 30 * 60 * 1000; // durée max en cache
const DEBRIDED_URL_RANGE_MAX_AGE = 30 * 1000; // au-delà, une requête Range force un nouveau débridage
const debridLocks = new Map();
const RETRYABLE_STREAM_STATUS = new Set([403, 404, 410, 416, 502, 503]);

function invalidateDebridCache(allDebridId) {
  debridedUrlCache.delete(allDebridId);
}

function shouldForceDebridRefresh(allDebridId, req, forceRetry) {
  if (forceRetry) return true;
  const cached = debridedUrlCache.get(allDebridId);
  if (!cached || cached.expiresAt <= Date.now()) return true;
  const age = Date.now() - (cached.createdAt || 0);
  if (req.headers['range'] && age > DEBRIDED_URL_RANGE_MAX_AGE) return true;
  return false;
}

function buildUpstreamRequestOptions(req, debridedUrl, stripConditionalHeaders = false) {
  const parsedUrl = new URL(debridedUrl);
  const httpModule = parsedUrl.protocol === 'https:' ? https : http;
  const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`;

  const requestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || undefined,
    path: pathWithQuery,
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Encoding': 'identity',
      'Connection': 'close'
    }
  };

  if (req.headers['range']) {
    requestOptions.headers['Range'] = req.headers['range'];
  }
  if (!stripConditionalHeaders) {
    if (req.headers['if-range']) {
      requestOptions.headers['If-Range'] = req.headers['if-range'];
    }
    if (req.headers['if-modified-since']) {
      requestOptions.headers['If-Modified-Since'] = req.headers['if-modified-since'];
    }
  }

  return { requestOptions, httpModule };
}

// Fonction pour convertir un ID TMDB en ID IMDB
async function getImdbIdFromTmdb(tmdbId) {
  // Vérifier le cache
  if (imdbIdCache.has(tmdbId)) {
    return imdbIdCache.get(tmdbId);
  }

  try {
    const response = await axios.get(`${TMDB_API_BASE}/movie/${tmdbId}`, {
      params: {
        api_key: TMDB_API_KEY,
        external_source: 'imdb_id'
      }
    });

    const imdbId = response.data.imdb_id;
    if (imdbId) {
      imdbIdCache.set(tmdbId, imdbId);
      console.log(`✅ ID IMDB trouvé pour TMDB ${tmdbId}: ${imdbId}`);
      return imdbId;
    }
    throw new Error('ID IMDB non trouvé');
  } catch (error) {
    console.error(`❌ Erreur lors de la conversion TMDB->IMDB: ${error.message}`);
    throw error;
  }
}

// Fonction pour convertir un ID IMDB en ID TMDB
async function getTmdbIdFromImdb(imdbId) {
  // Vérifier d'abord dans le cache inverse
  for (const [tmdb, imdb] of imdbIdCache.entries()) {
    if (imdb === imdbId) {
      return tmdb;
    }
  }

  try {
    const response = await axios.get(`${TMDB_API_BASE}/find/${imdbId}`, {
      params: {
        api_key: TMDB_API_KEY,
        external_source: 'imdb_id'
      }
    });

    if (response.data.movie_results && response.data.movie_results.length > 0) {
      const tmdbId = response.data.movie_results[0].id.toString();
      return tmdbId;
    }
    throw new Error('ID TMDB non trouvé');
  } catch (error) {
    throw error;
  }
}

// Fonction pour construire l'URL AllDebrid complète
function buildAllDebridUrl(allDebridId) {
  const id = String(allDebridId).trim();
  if (id.startsWith('http://') || id.startsWith('https://')) {
    return id;
  }
  if (!isValidAllDebridFileId(id)) {
    throw new Error(`ID AllDebrid invalide: ${id}`);
  }
  return `https://alldebrid.com/f/${id}`;
}

// Fonction helper pour streamer avec redébridage automatique en cas d'expiration
async function streamWithAutoRefresh(req, res, allDebridId, context, maxRetries = 5) {
  let retryCount = 0;
  let stripConditionalHeaders = false;
  let currentProxyReq = null;

  const scheduleRetry = (reason, statusCode) => {
    invalidateDebridCache(allDebridId);
    if (currentProxyReq) {
      currentProxyReq.destroy();
      currentProxyReq = null;
    }
    if (statusCode === 416 || statusCode === 412) {
      stripConditionalHeaders = true;
    }
    if (retryCount < maxRetries && !res.destroyed && !res.headersSent) {
      retryCount++;
      console.log(`🔄 Redébridage stream (${reason}, tentative ${retryCount}/${maxRetries})...`);
      setTimeout(() => attemptStream(), 400);
      return true;
    }
    return false;
  };

  const attemptStream = async () => {
    try {
      const forceRefresh = shouldForceDebridRefresh(allDebridId, req, retryCount > 0);
      const debridedUrl = await debridLink(allDebridId, context, forceRefresh);
      const stripCond = stripConditionalHeaders || (forceRefresh && !!req.headers['range']);
      const { requestOptions, httpModule } = buildUpstreamRequestOptions(req, debridedUrl, stripCond);

      await new Promise((resolve, reject) => {
        currentProxyReq = httpModule.request(requestOptions, (proxyRes) => {
          if (RETRYABLE_STREAM_STATUS.has(proxyRes.statusCode) && !res.headersSent) {
            proxyRes.resume();
            if (scheduleRetry(`HTTP ${proxyRes.statusCode}`, proxyRes.statusCode)) {
              resolve();
              return;
            }
            if (!res.headersSent) {
              res.status(502).send(`Erreur stream upstream (${proxyRes.statusCode})`);
            }
            resolve();
            return;
          }

          const headers = { ...proxyRes.headers };
          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          delete headers['connection'];
          delete headers['keep-alive'];
          headers['Access-Control-Allow-Origin'] = '*';
          headers['Access-Control-Allow-Headers'] = 'Range, Content-Range, Accept-Ranges, If-Range';
          headers['Access-Control-Expose-Headers'] = 'Content-Range, Accept-Ranges, Content-Length';

          let statusCode = proxyRes.statusCode || 200;
          if (req.headers['range'] && statusCode === 200) {
            statusCode = 206;
            headers['Accept-Ranges'] = headers['accept-ranges'] || 'bytes';
          }

          if (!res.headersSent) {
            res.writeHead(statusCode, headers);
          }

          if (req.method === 'HEAD') {
            proxyRes.resume();
            res.end();
            resolve();
            return;
          }

          proxyRes.pipe(res);

          proxyRes.on('error', (err) => {
            invalidateDebridCache(allDebridId);
            if (err.code !== 'ECONNRESET' && err.message !== 'aborted') {
              console.log(`⚠️ Erreur pendant le streaming: ${err.message}`);
            }
            if (!res.headersSent && scheduleRetry(`stream error ${err.code || err.message}`)) {
              resolve();
              return;
            }
            reject(err);
          });

          res.on('close', () => {
            if (!proxyRes.destroyed) {
              proxyRes.destroy();
            }
          });

          proxyRes.on('end', resolve);
        });

        currentProxyReq.on('error', (err) => {
          invalidateDebridCache(allDebridId);
          if (err.code !== 'ECONNRESET' && err.message !== 'aborted') {
            console.log(`⚠️ Erreur de connexion upstream: ${err.message}`);
          }
          if (scheduleRetry(`connexion ${err.code || err.message}`)) {
            resolve();
            return;
          }
          reject(err);
        });

        req.on('close', () => {
          if (currentProxyReq) {
            currentProxyReq.destroy();
          }
        });

        currentProxyReq.end();
      });
    } catch (error) {
      invalidateDebridCache(allDebridId);
      if (!isPermanentDebridError(error.message) && scheduleRetry(error.message)) {
        return;
      }
      if (!res.headersSent) {
        res.status(500).send(`Erreur: ${error.message}`);
      }
    }
  };

  await attemptStream();
}

// Fonction pour débrider un lien AllDebrid
async function debridLink(allDebridId, context = '', forceRefresh = false) {
  try {
    const apiKey = getAllDebridApiKey();
    if (!apiKey) {
      throw new Error('Clé API AllDebrid non configurée');
    }

    if (forceRefresh) {
      debridedUrlCache.delete(allDebridId);
    }
    const cached = debridedUrlCache.get(allDebridId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }

    if (debridLocks.has(allDebridId)) {
      const lockPromise = debridLocks.get(allDebridId);
      return await lockPromise;
    }

    const debridPromise = (async () => {
      try {
        const allDebridUrl = buildAllDebridUrl(allDebridId);
        if (context) {
          const title = context.split('\n')[0].replace(/^🎬 DÉBRIDAGE FILM - |^📺 DÉBRIDAGE SÉRIE - /, '').trim();
          console.log(`🔗 Débridage: ${title}`);
        }

        const unlockResponse = await axios.get(`${ALLDEBRID_API_BASE}/link/unlock`, {
          params: {
            agent: 'stremio-addon',
            apikey: getAllDebridApiKey(),
            link: allDebridUrl
          },
          timeout: 30000
        });

        if (unlockResponse.data.status === 'success') {
          const debridedUrl = unlockResponse.data.data.link || unlockResponse.data.data.infos?.link;
          if (!debridedUrl) {
            throw new Error('Aucun lien débridé retourné par l\'API');
          }
          debridedUrlCache.set(allDebridId, {
            url: debridedUrl,
            expiresAt: Date.now() + DEBRIDED_URL_MAX_AGE,
            createdAt: Date.now()
          });
          if (context) {
            console.log(`   → OK`);
          }
          return debridedUrl;
        } else {
          throw new Error(unlockResponse.data.error?.message || 'Erreur lors du débridage');
        }
      } finally {
        debridLocks.delete(allDebridId);
      }
    })();

    debridLocks.set(allDebridId, debridPromise);
    return await debridPromise;
  } catch (error) {
    debridLocks.delete(allDebridId);
    debridedUrlCache.delete(allDebridId);
    console.error('Erreur lors du débridage:', error.message);
    throw error;
  }
}

// Fonction pour parser le champ diffuser
function parseDiffuser(diffuserStr) {
  if (!diffuserStr || diffuserStr === '[]' || diffuserStr.trim() === '') {
    return [];
  }
  try {
    // Parser comme JSON
    const parsed = JSON.parse(diffuserStr);
    if (Array.isArray(parsed)) {
      return parsed.map(d => {
        if (typeof d === 'string' && d.includes(':')) {
          const [id, name] = d.split(':');
          return { id: parseInt(id), name: name.trim() };
        }
        return null;
      }).filter(d => d !== null);
    }
    return [];
  } catch (e) {
    // Essayer avec guillemets simples
    try {
      const parsed = JSON.parse(diffuserStr.replace(/'/g, '"'));
      if (Array.isArray(parsed)) {
        return parsed.map(d => {
          if (typeof d === 'string' && d.includes(':')) {
            const [id, name] = d.split(':');
            return { id: parseInt(id), name: name.trim() };
          }
          return null;
        }).filter(d => d !== null);
      }
    } catch (e2) {
      // Ignorer les erreurs de parsing
    }
    return [];
  }
}

// Mapping des catégories autorisées avec leurs nouveaux noms
const categoryMapping = {
  // Films
  'Listes TMDb:Tendances de la semaine': 'Films tendances de la semaine',
  'Les TOP - par diffuseurs:Netflix': 'Top Films: Netflix',
  'Les TOP - par diffuseurs:Amazon Prime': 'Top Films: Amazon Prime', // Note: "Amazon" (pas "Amanzon")
  'Les TOP - par diffuseurs:Apple TV+': 'Top Films: Apple TV +',
  'Les TOP - par diffuseurs:Disney+': 'Top Films: Disney +',
  'Disney Classiques': 'Les Disney classiques',
  'Collection Pixar': 'Films Pixar',
  'Studio Ghibli': 'Films Studio Ghibli',
  // Séries
  'Listes TMDb:Séries tendances cette semaine': 'Séries tendances de la semaine'
};

// Mapping des IDs diffuser vers les noms de catalogues pour séries
const diffuserSeriesMapping = {
  213: 'Séries Netflix',
  1024: 'Séries Prime Vidéo',
  2552: 'Séries Apple TV +',
  2739: 'Séries Disney +'
};

// Extraire les groupes/catégories autorisées uniquement
const tmdbCategoriesMovies = new Map(); // Map<originalCategoryName, newCategoryName>
const tmdbCategoriesSeries = new Map(); // Map<originalCategoryName, newCategoryName>

FILMS_DATA.forEach(film => {
  if (film.groups && Array.isArray(film.groups)) {
    film.groups.forEach(group => {
      if (group && categoryMapping[group]) {
        tmdbCategoriesMovies.set(group, categoryMapping[group]);
      } else if (group === 'Contenu personnalisé') {
        // Gérer le catalogue personnalisé
        tmdbCategoriesMovies.set(group, 'Contenu personnalisé');
      }
    });
  }
});

SERIES_DATA.forEach(series => {
  if (series.groups && Array.isArray(series.groups)) {
    series.groups.forEach(group => {
      if (group && categoryMapping[group]) {
        tmdbCategoriesSeries.set(group, categoryMapping[group]);
      } else if (group === 'Contenu personnalisé') {
        // Gérer le catalogue personnalisé
        tmdbCategoriesSeries.set(group, 'Contenu personnalisé');
      }
    });
  }
  // Ajouter les séries basées sur diffuser
  if (series.diffuser) {
    const diffusers = parseDiffuser(series.diffuser);
    diffusers.forEach(d => {
      if (diffuserSeriesMapping[d.id]) {
        // Utiliser un identifiant unique pour les catalogues basés sur diffuser
        const catalogKey = `diffuser_${d.id}`;
        if (!tmdbCategoriesSeries.has(catalogKey)) {
          tmdbCategoriesSeries.set(catalogKey, diffuserSeriesMapping[d.id]);
        }
      }
    });
  }
});

// Créer un map pour associer l'ID de catalogue au nom de catégorie et au type
const catalogIdToCategoryMap = new Map(); // Map<catalogId, {category, type}>
const categoryIdToNameMap = new Map();

// Cache pour les posters (clé: tmdbId, valeur: {poster, backdrop})
const posterCache = new Map();

async function fetchPosterGlobal(tmdbId, isSeries = false, retryWithEn = false) {
  const cacheKey = `${isSeries ? 'series' : 'movie'}_${tmdbId}`;
  if (!retryWithEn && posterCache.has(cacheKey)) {
    const cached = posterCache.get(cacheKey);
    if (cached?.poster) return cached;
  }
  const lang = retryWithEn ? 'en-US' : 'fr-FR';
  try {
    const endpoint = isSeries ? 'tv' : 'movie';
    const response = await axios.get(`${TMDB_API_BASE}/${endpoint}/${tmdbId}`, {
      params: { api_key: TMDB_API_KEY, language: lang },
      timeout: 8000
    });
    const data = response.data || {};
    const poster = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined;
    const backdrop = data.backdrop_path ? `https://image.tmdb.org/t/p/w300${data.backdrop_path}` : undefined;
    if (!poster && !retryWithEn) {
      return fetchPosterGlobal(tmdbId, isSeries, true);
    }
    const info = { tmdbId, poster, backdrop };
    posterCache.set(cacheKey, info);
    return info;
  } catch (e) {
    if (!retryWithEn) {
      await new Promise(r => setTimeout(r, 800));
      return fetchPosterGlobal(tmdbId, isSeries, true);
    }
    return { tmdbId, poster: undefined, backdrop: undefined };
  }
}

// Cache "tendances" (évite de recalculer dailyViews à chaque ouverture Stremio)
const TRENDING_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const trendingCache = {
  movies: { generatedAt: 0, metas: [] },
  series: { generatedAt: 0, metas: [] }
};

function isTrendingCacheFresh(kind) {
  const entry = trendingCache[kind];
  return entry && entry.generatedAt && (Date.now() - entry.generatedAt) < TRENDING_CACHE_TTL_MS && Array.isArray(entry.metas);
}

async function rebuildTrendingCache(kind) {
  const isSeries = kind === 'series';
  const db = userManager.getDB();
  const users = Object.keys(db.users || {});
  const days = getLastNDaysKeys(31);

  const viewersMap = new Map(); // Map<tmdbId, Set<username>>
  for (const u of users) {
    const dv = db.users?.[u]?.dailyViews && typeof db.users[u].dailyViews === 'object' ? db.users[u].dailyViews : {};
    for (const day of days) {
      const list = dv[day];
      if (!Array.isArray(list)) continue;
      for (const cid of list) {
        const parsed = parseContentId(cid);
        if (!parsed) continue;
        if (isSeries && parsed.type !== 'series') continue;
        if (!isSeries && parsed.type !== 'movie') continue;
        const tmdbId = String(parsed.tmdbId);
        if (!viewersMap.has(tmdbId)) viewersMap.set(tmdbId, new Set());
        viewersMap.get(tmdbId).add(u);
      }
    }
  }

  const ranked = [...viewersMap.entries()]
    .map(([tmdbId, set]) => ({ tmdbId, viewers: set.size }))
    .sort((a, b) => b.viewers - a.viewers);

  const BATCH_SIZE = 10;
  const cachePrefix = isSeries ? 'series_' : 'movie_';
  const toFetch = ranked.filter(x => !posterCache.has(`${cachePrefix}${x.tmdbId}`));
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(x => fetchPosterGlobal(x.tmdbId, isSeries)));
    if (i + BATCH_SIZE < toFetch.length) {
      await new Promise(resolve => setTimeout(resolve, 450));
    }
  }

  const metas = ranked
    .map(x => {
      if (!isSeries) {
        const film = tmdbToFilmIndex.get(String(x.tmdbId));
        if (!film) return null;
        const posterInfo = posterCache.get(`movie_${x.tmdbId}`) || { poster: undefined, backdrop: undefined };
        return { type: 'movie', id: `tmdb_${x.tmdbId}`, name: film.name, poster: posterInfo.poster, posterShape: 'regular', background: posterInfo.backdrop };
      }
      const serie = tmdbToSeriesIndex.get(String(x.tmdbId));
      if (!serie) return null;
      const posterInfo = posterCache.get(`series_${x.tmdbId}`) || { poster: undefined, backdrop: undefined };
      return { type: 'series', id: `tmdb_${x.tmdbId}`, name: serie.name, poster: posterInfo.poster, posterShape: 'regular', background: posterInfo.backdrop };
    })
    .filter(Boolean);

  trendingCache[kind] = { generatedAt: Date.now(), metas };
  return trendingCache[kind];
}

async function ensureTrendingCache(kind) {
  if (isTrendingCacheFresh(kind)) return trendingCache[kind];
  return rebuildTrendingCache(kind);
}

// Créer les catalogues pour les listes TMDb (films et séries)
let catalogs = [];

// Créer les catalogues pour les films (dans l'ordre spécifié)
const moviesOrder = [
  'Films tendances de la semaine',
  'Top Films: Netflix',
  'Top Films: Amazon Prime',
  'Top Films: Apple TV +',
  'Top Films: Disney +',
  'Les Disney classiques',
  'Films Pixar',
  'Films Studio Ghibli'
];

moviesOrder.forEach(newCategoryName => {
  // Trouver la catégorie originale
  let originalCategory = null;
  for (const [orig, newName] of tmdbCategoriesMovies.entries()) {
    if (newName === newCategoryName) {
      originalCategory = orig;
      break;
    }
  }
  
  if (originalCategory) {
    const catalogId = `category_${newCategoryName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
    catalogIdToCategoryMap.set(catalogId, { category: originalCategory, type: 'movie', displayName: newCategoryName });
    categoryIdToNameMap.set(catalogId, newCategoryName);
    
    catalogs.push({
      type: 'movie',
      id: catalogId,
      name: newCategoryName,
      extra: [{ name: 'skip', isRequired: false }]
    });
  }
});

// Créer les catalogues pour les séries (dans l'ordre spécifié)
const seriesOrder = [
  'Séries tendances de la semaine',
  'Séries Netflix',
  'Séries Prime Vidéo',
  'Séries Apple TV +',
  'Séries Disney +'
];

seriesOrder.forEach(newCategoryName => {
  // Chercher dans les groupes
  let originalCategory = null;
  for (const [orig, newName] of tmdbCategoriesSeries.entries()) {
    if (newName === newCategoryName) {
      originalCategory = orig;
      break;
    }
  }
  
  if (originalCategory) {
    const catalogId = `category_${newCategoryName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
    const isDiffuserBased = originalCategory.startsWith('diffuser_');
    catalogIdToCategoryMap.set(catalogId, { 
      category: originalCategory, 
      type: 'series', 
      displayName: newCategoryName,
      isDiffuserBased: isDiffuserBased,
      diffuserId: isDiffuserBased ? parseInt(originalCategory.replace('diffuser_', '')) : null
    });
    categoryIdToNameMap.set(catalogId, newCategoryName);
    
    catalogs.push({
      type: 'series',
      id: catalogId,
      name: newCategoryName,
      extra: [{ name: 'skip', isRequired: false }]
    });
  }
});

// Ajouter le catalogue "Contenu personnalisé" pour les films s'il y a du contenu
if (tmdbCategoriesMovies.has('Contenu personnalisé')) {
  catalogIdToCategoryMap.set(CUSTOM_CONTENT_MOVIE_CATALOG_ID, { 
    category: 'Contenu personnalisé', 
    type: 'movie', 
    displayName: 'Contenu personnalisé' 
  });
  catalogs.push({
    type: 'movie',
    id: CUSTOM_CONTENT_MOVIE_CATALOG_ID,
    name: 'Contenu personnalisé',
    extra: [{ name: 'skip', isRequired: false }]
  });
}

// Ajouter le catalogue "Contenu personnalisé" pour les séries s'il y a du contenu
if (tmdbCategoriesSeries.has('Contenu personnalisé')) {
  catalogIdToCategoryMap.set(CUSTOM_CONTENT_SERIES_CATALOG_ID, { 
    category: 'Contenu personnalisé', 
    type: 'series', 
    displayName: 'Contenu personnalisé' 
  });
  catalogs.push({
    type: 'series',
    id: CUSTOM_CONTENT_SERIES_CATALOG_ID,
    name: 'Contenu personnalisé',
    extra: [{ name: 'skip', isRequired: false }]
  });
}

// Catalogue "tendances" basé sur les vues des utilisateurs (dailyViews)
const FUNK_TRENDING_MOVIES_CATALOG_ID = 'stremiopastebin_trending_movies';
const FUNK_TRENDING_SERIES_CATALOG_ID = 'stremiopastebin_trending_series';
// Mettre en haut de la liste (unshift). Ordre souhaité: Films puis Séries.
catalogs.unshift({
  type: 'series',
  id: FUNK_TRENDING_SERIES_CATALOG_ID,
  name: 'Séries tendances StremioPasteBin',
  extra: [{ name: 'skip', isRequired: false }]
});
catalogs.unshift({
  type: 'movie',
  id: FUNK_TRENDING_MOVIES_CATALOG_ID,
  name: 'Films tendances StremioPasteBin',
  extra: [{ name: 'skip', isRequired: false }]
});

// Middleware pour protéger les pages admin
app.use((req, res, next) => {
  const adminPages = ['/index.html', '/add-content.html', '/manage-content.html', '/refresh.html', '/pastebin-manager.html', '/admin-users.html', '/admin-account.html', '/admin-analytics.html', '/admin-reset.html'];
  
  if (adminPages.includes(req.path)) {
    if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
      return res.redirect('/');
    }
  }
  
  next();
});

// Forcer le changement du compte admin si nécessaire
app.use((req, res, next) => {
  if (!req.session?.user || req.session.user.role !== 'admin') return next();

  const { mustChangePassword } = userManager.getAdminInfo();
  if (!mustChangePassword) return next();

  const allowedPaths = new Set([
    '/admin-account.html',
    '/api/admin/account',
    '/api/logout',
    '/api/me',
    '/',
    '/login.html'
  ]);

  if (allowedPaths.has(req.path)) return next();

  // Autoriser les assets statiques
  if (req.path.startsWith('/css') || req.path.startsWith('/js') || req.path.startsWith('/assets') || req.path.startsWith('/favicon')) {
    return next();
  }

  return res.redirect('/admin-account.html');
});

// Route racine AVANT express.static : afficher la page de connexion par défaut
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    if (req.session.user.role === 'admin') {
      return res.redirect('/index.html');
    }
    return res.redirect('/devices.html');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Servir les fichiers statiques (index.html, login.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware pour parser JSON
app.use(express.json());

// Middleware pour vérifier l'authentification (utilisateur ou admin)
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  // Pour les endpoints API, répondre en JSON plutôt qu'en redirection HTML
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Authentification requise' });
  }
  return res.redirect('/');
}

// Middleware pour vérifier que l'utilisateur est admin
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  // Pour les endpoints API, répondre en JSON (sinon le front qui fait response.json() casse)
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(403).json({ success: false, error: 'Accès refusé. Administrateur requis.' });
  }
  return res.status(403).send('Accès refusé. Administrateur requis.');
}

// Fonction pour extraire le token Stremio depuis les requêtes
function getStremioToken(req) {
  // Priorité 1: Token dans les paramètres de requête (depuis l'URL)
  const tokenFromQuery = req.query.token || req.query.stremio_token;
  if (tokenFromQuery) {
    // Stocker dans la session pour les requêtes suivantes
    if (req.session) {
      req.session.stremioToken = tokenFromQuery;
      const authCheck = isStremioTokenAuthorized(tokenFromQuery);
      if (authCheck.authorized) {
        req.session.stremioUsername = authCheck.username;
      }
    }
    return tokenFromQuery;
  }
  
  // Priorité 2: Token depuis la session (si déjà stocké)
  if (req.session && req.session.stremioToken) {
    return req.session.stremioToken;
  }
  
  // Priorité 3: Token dans les headers
  const tokenFromHeader = req.headers['x-stremio-token'] || req.headers['stremio-token'];
  if (tokenFromHeader) {
    if (req.session) {
      req.session.stremioToken = tokenFromHeader;
    }
    return tokenFromHeader;
  }
  
  // Priorité 4: Token dans le referer ou origin (important pour Stremio mobile)
  const referer = req.headers.referer || req.headers.origin || '';
  const refererMatch = referer.match(/[?&](?:token|stremio_token)=([^&]+)/);
  if (refererMatch) {
    const token = refererMatch[1];
    if (req.session) {
      req.session.stremioToken = token;
      const authCheck = isStremioTokenAuthorized(token);
      if (authCheck.authorized) {
        req.session.stremioUsername = authCheck.username;
      }
    }
    return token;
  }
  
  return null;
}

// Fonction helper pour obtenir l'IP du client
function getClientIp(req) {
  if (!req) return 'unknown';
  return req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

// Fonction helper pour construire l'URL de base du serveur (proxy, manifest, etc.)
// En production derrière un reverse proxy, les URLs doivent pointer vers le domaine public, pas localhost.
function getBaseUrl(req, defaultPort = 7011) {
  const serverPort = (typeof process.env.PORT !== 'undefined' && process.env.PORT !== '') ? process.env.PORT : defaultPort;
  const protocol = req ? (req.protocol || (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()) : 'http';
  const requestHost = req ? (req.get('host') || req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';

  if (BASE_URL) {
    try {
      const parsed = new URL(BASE_URL);
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      // Si BASE_URL est localhost mais qu'on reçoit une requête avec un autre Host (reverse proxy), utiliser le Host public
      if (isLocal && requestHost && requestHost !== 'localhost' && !requestHost.startsWith('127.0.0.1')) {
        return `${protocol}://${requestHost}`;
      }
      if (isLocal && parsed.port && String(parsed.port) !== String(serverPort)) {
        return `${parsed.protocol}//${parsed.hostname}:${serverPort}`;
      }
      if (!isLocal) return BASE_URL;
    } catch (e) { /* ignorer */ }
    return BASE_URL;
  }
  if (!req) return `http://localhost:${serverPort}`;
  const host = requestHost || `localhost:${serverPort}`;
  return `${protocol}://${host}`;
}

// Fonction pour vérifier si un token Stremio est autorisé
function isStremioTokenAuthorized(token) {
  if (!token) {
    return { authorized: false };
  }
  
  const userInfo = userManager.getUserByStremioToken(token);
  if (userInfo) {
    return { authorized: true, username: userInfo.username };
  }
  
  return { authorized: false };
}

// Middleware pour extraire et stocker le token depuis le referer pour Stremio mobile
// Doit être placé après la définition de isStremioTokenAuthorized
app.use((req, res, next) => {
  // Si on n'a pas de token dans la session mais qu'on a un referer avec token
  if (!req.session?.stremioToken) {
    const referer = req.headers.referer || req.headers.origin || '';
    const refererMatch = referer.match(/[?&](?:token|stremio_token)=([^&]+)/);
    if (refererMatch) {
      const token = refererMatch[1];
      if (req.session) {
        req.session.stremioToken = token;
        const authCheck = isStremioTokenAuthorized(token);
        if (authCheck.authorized) {
          req.session.stremioUsername = authCheck.username;
          console.log(`🔑 Token extrait depuis referer pour ${authCheck.username}`);
        }
      }
    }
  }
  next();
});

// Routes d'authentification
app.get('/login.html', (req, res) => {
  if (req.session && req.session.user) {
    if (req.session.user.role === 'admin') {
      return res.redirect('/index.html');
    } else {
      return res.redirect('/devices.html');
    }
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Trop de tentatives. Réessayez dans 15 minutes.' }
});

const adminSensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Trop de requêtes. Réessayez plus tard.' }
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.json({ success: false, error: 'Nom d\'utilisateur et mot de passe requis' });
  }
  
  // Récupérer l'IP du client
  const clientIp = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  
  const result = userManager.authenticate(username, password, clientIp);
  
  if (result.success) {
    req.session.user = result.user;
    res.json({ success: true, role: result.user.role, mustChangePassword: !!result.mustChangePassword });
  } else {
    res.json({ success: false, error: result.error });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.json({ success: false, error: 'Erreur lors de la déconnexion' });
    }
    res.json({ success: true });
  });
});

// Route pour obtenir les informations de l'utilisateur connecté
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// Route pour obtenir le token Stremio de l'utilisateur
app.get('/api/stremio-token', requireAuth, (req, res) => {
  if (req.session.user.role === 'admin') {
    return res.status(403).json({ error: 'Cette route est réservée aux utilisateurs' });
  }
  
  const db = userManager.getDB();
  const user = db.users[req.session.user.username];
  
  if (!user || !user.stremioToken) {
    // Générer un token si l'utilisateur n'en a pas
    const result = userManager.regenerateStremioToken(req.session.user.username);
    if (result.success) {
      return res.json({ success: true, token: result.token });
    }
    return res.json({ success: false, error: 'Erreur lors de la génération du token' });
  }
  
  res.json({ success: true, token: user.stremioToken });
});

// Route pour régénérer le token Stremio
app.post('/api/stremio-token/regenerate', requireAuth, (req, res) => {
  if (req.session.user.role === 'admin') {
    return res.status(403).json({ error: 'Cette route est réservée aux utilisateurs' });
  }
  
  const result = userManager.regenerateStremioToken(req.session.user.username);
  res.json(result);
});

// Page de configuration Stremio pour les utilisateurs (token)
app.get('/devices.html', requireAuth, (req, res) => {
  if (req.session.user.role === 'admin') {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'devices.html'));
});

// Routes admin pour gérer les utilisateurs
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = userManager.getAllUsers();
  res.json({ success: true, users });
});

app.get('/api/admin/users/:username', requireAdmin, (req, res) => {
  const user = userManager.getUserDetails(req.params.username);
  if (user) {
    res.json({ success: true, user });
  } else {
    res.json({ success: false, error: 'Utilisateur non trouvé' });
  }
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.json({ success: false, error: 'Nom d\'utilisateur et mot de passe requis' });
  }
  
  const result = userManager.createUser(username, password);
  res.json(result);
});

app.put('/api/admin/users/:username', requireAdmin, (req, res) => {
  const { password } = req.body;
  const result = userManager.updateUser(req.params.username, password);
  res.json(result);
});

app.delete('/api/admin/users/:username', requireAdmin, (req, res) => {
  const result = userManager.deleteUser(req.params.username);
  res.json(result);
});

// Routes admin pour gérer le compte admin (login + mot de passe)
app.get('/api/admin/account', requireAdmin, (req, res) => {
  const info = userManager.getAdminInfo();
  res.json({ success: true, admin: info });
});

app.put('/api/admin/account', requireAdmin, adminSensitiveLimiter, (req, res) => {
  const { currentPassword, username, newPassword } = req.body || {};

  if (!currentPassword) {
    return res.json({ success: false, error: 'Mot de passe actuel requis' });
  }

  const result = userManager.updateAdminAccount({
    currentPassword,
    newUsername: username,
    newPassword
  });

  if (result.success && req.session?.user) {
    // Synchroniser la session si le login admin a changé
    req.session.user.username = result.admin.username;
  }

  return res.json(result);
});

function getLastNDaysKeys(n) {
  const days = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(x.getDate() - i);
    days.push(x.toISOString().slice(0, 10));
  }
  return days;
}

function parseContentId(contentId) {
  const parts = String(contentId || '').split(':');
  const type = parts[0];
  if (type !== 'movie' && type !== 'series') return null;
  const tmdbId = parts[1];
  if (!tmdbId) return null;
  return { type, tmdbId, parts };
}

function normalizeContentId(contentId) {
  // dailyViews peut contenir:
  // - movie:<tmdbId>
  // - series:<tmdbId>:<season>:<episode>
  // Pour le "top contenus", on veut dédupliquer par contenu racine:
  // - movie:<tmdbId>
  // - series:<tmdbId>
  const parsed = parseContentId(contentId);
  if (!parsed) return String(contentId || '');
  if (parsed.type === 'movie') return `movie:${parsed.tmdbId}`;
  return `series:${parsed.tmdbId}`;
}

async function resolveContentMeta(contentId) {
  const parsed = parseContentId(contentId);
  if (!parsed) return { contentId, title: contentId, poster: undefined };

  let title = contentId;
  if (parsed.type === 'movie') {
    const film = tmdbToFilmIndex?.get?.(String(parsed.tmdbId));
    if (film?.name) title = film.name;
  } else {
    const serie = tmdbToSeriesIndex?.get?.(String(parsed.tmdbId));
    if (serie?.name) title = serie.name;
  }

  // Poster via cache TMDB déjà présent (et récupérable si manquant)
  try {
    const info = await fetchPosterForAnalytics(String(parsed.tmdbId), parsed.type === 'series');
    return { contentId, type: parsed.type, tmdbId: String(parsed.tmdbId), title, poster: info?.poster };
  } catch (e) {
    return { contentId, type: parsed.type, tmdbId: String(parsed.tmdbId), title, poster: undefined };
  }
}

async function fetchPosterForAnalytics(tmdbId, isSeries = false, retryWithEn = false) {
  const contentType = isSeries ? 'tv' : 'movie';
  const cacheKey = `${tmdbId}_${contentType}`;

  if (!retryWithEn && posterCache.has(cacheKey)) {
    return posterCache.get(cacheKey);
  }

  try {
    const lang = retryWithEn ? 'en-US' : 'fr-FR';
    const response = await axios.get(`${TMDB_API_BASE}/${contentType}/${tmdbId}`, {
      params: { api_key: TMDB_API_KEY, language: lang }
    });
    const data = response.data || {};
    const poster = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined;
    const backdrop = data.backdrop_path ? `https://image.tmdb.org/t/p/w300${data.backdrop_path}` : undefined;

    if (!poster && !retryWithEn) {
      return fetchPosterForAnalytics(tmdbId, isSeries, true);
    }

    const posterInfo = { tmdbId, poster, backdrop };
    posterCache.set(cacheKey, posterInfo);
    return posterInfo;
  } catch (e) {
    if (!retryWithEn) {
      return fetchPosterForAnalytics(tmdbId, isSeries, true);
    }
    const posterInfo = { tmdbId, poster: undefined, backdrop: undefined };
    posterCache.set(cacheKey, posterInfo);
    return posterInfo;
  }
}

// Analytics admin: streams/jour/user + top contenus (sur la fenêtre de rétention dailyViews)
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
  const daysWindow = Math.min(Math.max(parseInt(req.query.days || '31', 10) || 31, 7), 31);
  const topN = Math.min(Math.max(parseInt(req.query.top || '24', 10) || 24, 5), 60);

  const db = userManager.getDB();
  const days = getLastNDaysKeys(daysWindow);
  const users = Object.keys(db.users || {}).sort((a, b) => a.localeCompare(b, 'fr'));

  const perUserPerDay = {};
  for (const u of users) perUserPerDay[u] = {};

  // Pour le "top contenus", on compte 1 fois par utilisateur sur la fenêtre
  // (peu importe le nombre de jours/relectures pour un même user).
  const contentViewers = new Map(); // Map<normalizedContentId, Set<username>>
  const lastLogins = users.map(u => ({ username: u, lastLogin: db.users?.[u]?.lastLogin || null }));

  for (const u of users) {
    const user = db.users[u];
    const dv = user?.dailyViews && typeof user.dailyViews === 'object' ? user.dailyViews : {};
    for (const day of days) {
      const list = dv[day];
      const count = Array.isArray(list) ? list.length : 0;
      perUserPerDay[u][day] = count;
      if (Array.isArray(list)) {
        for (const cid of list) {
          const key = normalizeContentId(cid);
          if (!contentViewers.has(key)) contentViewers.set(key, new Set());
          contentViewers.get(key).add(u);
        }
      }
    }
  }

  const datasets = users.map((u, idx) => {
    const hue = (idx * 47) % 360;
    return {
      label: u,
      data: days.map(d => perUserPerDay[u][d] || 0),
      backgroundColor: `hsla(${hue}, 70%, 55%, 0.75)`,
      borderColor: `hsla(${hue}, 70%, 40%, 1)`,
      borderWidth: 1
    };
  });

  const topContentIds = [...contentViewers.entries()]
    .map(([contentId, viewers]) => [contentId, viewers.size])
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  const topContents = await Promise.all(
    topContentIds.map(async ([contentId, count]) => {
      const meta = await resolveContentMeta(contentId);
      return { ...meta, count };
    })
  );

  res.json({
    success: true,
    windowDays: daysWindow,
    days,
    users,
    streamsPerDay: { labels: days, datasets },
    topContents,
    lastLogins
  });
});

// Endpoint manifest - générer dynamiquement avec tous les catalogues
app.get('/manifest.json', (req, res) => {
  // Headers spécifiques pour Stremio
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  
  // Vérifier le token Stremio (optionnel pour compatibilité, mais recommandé)
  const token = getStremioToken(req);
  if (token) {
    const authCheck = isStremioTokenAuthorized(token);
    if (!authCheck.authorized) {
      return res.status(403).json({ error: 'Token Stremio invalide' });
    }
    // Stocker le token dans la session pour les requêtes suivantes (important pour Stremio mobile)
    if (req.session) {
      req.session.stremioToken = token;
      req.session.stremioUsername = authCheck.username;
      // Définir un cookie avec le token pour Stremio mobile (fallback)
      res.cookie('stremio_token', token, {
        httpOnly: false, // Doit être accessible en JS pour certains cas
        secure: false, // Mettre à true si HTTPS
        maxAge: 365 * 24 * 60 * 60 * 1000, // 1 an
        sameSite: 'lax'
      });
    }
  }
  
  const fullManifest = {
    id: 'com.stremio.stremiopastebin',
    version: '1.0.0',
    name: 'StremioPasteBin',
    description: 'VOD (Films et Séries)',
    resources: ['stream', 'catalog', 'meta'],
    types: ['movie', 'series'],
    catalogs: catalogs,
    idPrefixes: ['tt', 'tmdb']
  };
  
  res.json(fullManifest);
});

// Index inverse : IMDB ID -> Film pour une recherche rapide (construit progressivement)
const imdbToFilmIndex = new Map();

// Fonction pour recréer les index et catalogues
function rebuildIndexes() {
  catalogIdToCategoryMap.clear();
  categoryIdToNameMap.clear();

  // Recharger les données depuis la base unifiée
  const data = loadUnifiedData();
  FILMS_DATA = data.films;
  SERIES_DATA = data.series;
  
  // Recréer l'index TMDB pour les films
  const newTmdbToFilmIndex = buildFilmIndex(FILMS_DATA);

  // Recréer l'index TMDB pour les séries (fusionne les doublons TMDB)
  const newTmdbToSeriesIndex = buildSeriesIndex(SERIES_DATA);
  
  // Extraire les groupes/catégories autorisées uniquement (même logique que l'initialisation)
  const newTmdbCategoriesMovies = new Map(); // Map<originalCategoryName, newCategoryName>
  const newTmdbCategoriesSeries = new Map(); // Map<originalCategoryName, newCategoryName>
  
  FILMS_DATA.forEach(film => {
    if (film.groups && Array.isArray(film.groups)) {
      film.groups.forEach(group => {
        if (group && categoryMapping[group]) {
          newTmdbCategoriesMovies.set(group, categoryMapping[group]);
        } else if (group === 'Contenu personnalisé') {
          // Gérer le catalogue personnalisé
          newTmdbCategoriesMovies.set(group, 'Contenu personnalisé');
        }
      });
    }
  });
  
  SERIES_DATA.forEach(series => {
    if (series.groups && Array.isArray(series.groups)) {
      series.groups.forEach(group => {
        if (group && categoryMapping[group]) {
          newTmdbCategoriesSeries.set(group, categoryMapping[group]);
        } else if (group === 'Contenu personnalisé') {
          // Gérer le catalogue personnalisé
          newTmdbCategoriesSeries.set(group, 'Contenu personnalisé');
        }
      });
    }
    // Ajouter les séries basées sur diffuser
    if (series.diffuser) {
      const diffusers = parseDiffuser(series.diffuser);
      diffusers.forEach(d => {
        if (diffuserSeriesMapping[d.id]) {
          const catalogKey = `diffuser_${d.id}`;
          if (!newTmdbCategoriesSeries.has(catalogKey)) {
            newTmdbCategoriesSeries.set(catalogKey, diffuserSeriesMapping[d.id]);
          }
        }
      });
    }
  });
  
  // Créer les catalogues TMDb (dans l'ordre spécifié)
  const newCatalogs = [];
  
  // Catalogues pour les films (dans l'ordre spécifié)
  moviesOrder.forEach(newCategoryName => {
    let originalCategory = null;
    for (const [orig, newName] of newTmdbCategoriesMovies.entries()) {
      if (newName === newCategoryName) {
        originalCategory = orig;
        break;
      }
    }
    
    if (originalCategory) {
      const catalogId = `category_${newCategoryName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
      catalogIdToCategoryMap.set(catalogId, { category: originalCategory, type: 'movie', displayName: newCategoryName });
      categoryIdToNameMap.set(catalogId, newCategoryName);
      
      newCatalogs.push({
        type: 'movie',
        id: catalogId,
        name: newCategoryName,
        extra: [{ name: 'skip', isRequired: false }]
      });
    }
  });
  
  // Ajouter le catalogue "Contenu personnalisé" pour les films s'il y a du contenu
  if (newTmdbCategoriesMovies.has('Contenu personnalisé')) {
    catalogIdToCategoryMap.set(CUSTOM_CONTENT_MOVIE_CATALOG_ID, { 
      category: 'Contenu personnalisé', 
      type: 'movie', 
      displayName: 'Contenu personnalisé' 
    });
    newCatalogs.push({
      type: 'movie',
      id: CUSTOM_CONTENT_MOVIE_CATALOG_ID,
      name: 'Contenu personnalisé',
      extra: [{ name: 'skip', isRequired: false }]
    });
  }
  
  // Catalogues pour les séries (dans l'ordre spécifié)
  seriesOrder.forEach(newCategoryName => {
    let originalCategory = null;
    for (const [orig, newName] of newTmdbCategoriesSeries.entries()) {
      if (newName === newCategoryName) {
        originalCategory = orig;
        break;
      }
    }
    
    if (originalCategory) {
      const catalogId = `category_${newCategoryName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
      const isDiffuserBased = originalCategory.startsWith('diffuser_');
      catalogIdToCategoryMap.set(catalogId, { 
        category: originalCategory, 
        type: 'series', 
        displayName: newCategoryName,
        isDiffuserBased: isDiffuserBased,
        diffuserId: isDiffuserBased ? parseInt(originalCategory.replace('diffuser_', '')) : null
      });
      categoryIdToNameMap.set(catalogId, newCategoryName);
      
      newCatalogs.push({
        type: 'series',
        id: catalogId,
        name: newCategoryName,
        extra: [{ name: 'skip', isRequired: false }]
      });
    }
  });
  
  // Ajouter le catalogue "Contenu personnalisé" pour les séries s'il y a du contenu
  if (newTmdbCategoriesSeries.has('Contenu personnalisé')) {
    catalogIdToCategoryMap.set(CUSTOM_CONTENT_SERIES_CATALOG_ID, { 
      category: 'Contenu personnalisé', 
      type: 'series', 
      displayName: 'Contenu personnalisé' 
    });
    newCatalogs.push({
      type: 'series',
      id: CUSTOM_CONTENT_SERIES_CATALOG_ID,
      name: 'Contenu personnalisé',
      extra: [{ name: 'skip', isRequired: false }]
    });
  }
  
  // Ajouter les catalogues tendances StremioPasteBin en tête
  // Ordre souhaité: Films puis Séries
  newCatalogs.unshift({
    type: 'series',
    id: FUNK_TRENDING_SERIES_CATALOG_ID,
    name: 'Séries tendances StremioPasteBin',
    extra: [{ name: 'skip', isRequired: false }]
  });
  newCatalogs.unshift({
    type: 'movie',
    id: FUNK_TRENDING_MOVIES_CATALOG_ID,
    name: 'Films tendances StremioPasteBin',
    extra: [{ name: 'skip', isRequired: false }]
  });
  
  return { newTmdbToFilmIndex, newTmdbToSeriesIndex, newCatalogs };
}

// Index TMDB -> Film pour recherche rapide
let tmdbToFilmIndex = buildFilmIndex(FILMS_DATA);

// Index TMDB -> Series pour recherche rapide
let tmdbToSeriesIndex = buildSeriesIndex(SERIES_DATA);

// Log de debug au démarrage
console.log(`📊 Index TMDB créé avec ${tmdbToFilmIndex.size} films`);
console.log(`📺 Index TMDB créé avec ${tmdbToSeriesIndex.size} séries`);
if (tmdbToFilmIndex.size > 0) {
  const sampleEntries = Array.from(tmdbToFilmIndex.entries()).slice(0, 3);
  console.log(`📝 Exemples d'entrées: ${sampleEntries.map(([id, f]) => `TMDB ${id} -> ${f.name}`).join(', ')}`);
}

// ============================================================================
// HANDLERS UNIFIÉS
// ============================================================================

// Les handlers seront utilisés directement dans les routes Express
// Le SDK builder est utilisé pour la validation et la structure

// Définir la fonction handler de catalog directement (réutiliser celle déjà définie)
async function catalogHandler({ type, id, extra, req }) {
  console.log(`📚 Catalog request: type=${type}, id=${id}`);
  
  // Vérifier le token pour tous les catalogues
  const stremioToken = req ? (getStremioToken(req) || (req.session && req.session.stremioToken)) : null;
  
  if (!stremioToken) {
    console.log(`❌ Catalog ${type}/${id}: Aucun token fourni - Catalogue vide`);
    return { metas: [] };
  }
  
  const authCheck = isStremioTokenAuthorized(stremioToken);
  if (!authCheck.authorized) {
    console.log(`❌ Catalog ${type}/${id}: Token invalide (${authCheck.username || 'INCONNU'}) - Catalogue vide`);
    return { metas: [] };
  }
  
  // Enregistrer l'activité Stremio (seulement si pas déjà enregistré dans cette session)
  if (req && (!req.session?.stremioActivityRecorded || req.session.stremioActivityRecorded !== authCheck.username)) {
    const clientIp = getClientIp(req);
    userManager.recordStremioActivity(authCheck.username, clientIp);
    if (req.session) {
      req.session.stremioActivityRecorded = authCheck.username;
    }
  }
  
  console.log(`✅ Catalog ${type}/${id}: Token valide (Utilisateur: ${authCheck.username})`);

  // Catalogue tendances StremioPasteBin (basé sur dailyViews)
  if (id === FUNK_TRENDING_MOVIES_CATALOG_ID && type === 'movie') {
    const PAGE_SIZE = 100;
    const skip = Math.max(parseInt((extra && extra.skip) || '0', 10) || 0, 0);
    const entry = await ensureTrendingCache('movies');
    return { metas: (entry.metas || []).slice(skip, skip + PAGE_SIZE) };
  }

  // Catalogue tendances StremioPasteBin (séries) basé sur dailyViews
  if (id === FUNK_TRENDING_SERIES_CATALOG_ID && type === 'series') {
    const PAGE_SIZE = 100;
    const skip = Math.max(parseInt((extra && extra.skip) || '0', 10) || 0, 0);
    const entry = await ensureTrendingCache('series');
    return { metas: (entry.metas || []).slice(skip, skip + PAGE_SIZE) };
  }
  
  // Gérer les catalogues VOD (films et séries)
  const catalogInfo = catalogIdToCategoryMap.get(id);
  
  // Si catalogId n'existe pas dans le map, retourner vide
  if (!catalogInfo) {
    console.log(`Catégorie non trouvée: ${id}`);
    return { metas: [] };
  }
  
  const { category: matchingCategory, type: catalogType } = catalogInfo;
  const contentType = catalogType;

  // Fonction pour récupérer le poster (avec cache) - utilisée par le cache VOD et la méthode classique
  async function fetchPoster(tmdbId, isSeries = false, retryWithEn = false) {
    const cacheKey = `${isSeries ? 'series' : 'movie'}_${tmdbId}`;
    if (!retryWithEn && posterCache.has(cacheKey)) {
      const cached = posterCache.get(cacheKey);
      if (cached.poster) return cached;
    }
    const lang = retryWithEn ? 'en-US' : 'fr-FR';
    try {
      const endpoint = isSeries ? 'tv' : 'movie';
      const response = await axios.get(`${TMDB_API_BASE}/${endpoint}/${tmdbId}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: lang
        },
        timeout: 8000
      });
      const data = response.data;
      const poster = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined;
      const backdrop = data.backdrop_path ? `https://image.tmdb.org/t/p/w300${data.backdrop_path}` : undefined;
      // Si pas de poster en français, réessayer une fois en anglais avant de mettre en cache
      if (!poster && !retryWithEn) {
        return fetchPoster(tmdbId, isSeries, true);
      }
      const posterInfo = { tmdbId, poster, backdrop };
      posterCache.set(cacheKey, posterInfo);
      return posterInfo;
    } catch (error) {
      if (!retryWithEn) {
        await new Promise(r => setTimeout(r, 800));
        return fetchPoster(tmdbId, isSeries, true);
      }
      const posterInfo = { tmdbId, poster: undefined, backdrop: undefined };
      // Ne pas mettre en cache les échecs : on réessaiera au prochain chargement
      return posterInfo;
    }
  }

  // Essayer d'abord de récupérer depuis le cache VOD (plus rapide)
  // Le contenu personnalisé change souvent : toujours lire les données live
  const isCustomContentCatalog = id === CUSTOM_CONTENT_MOVIE_CATALOG_ID || id === CUSTOM_CONTENT_SERIES_CATALOG_ID;
  try {
    const cachedItems = !isCustomContentCatalog
      ? await dbCacheVod.getCatalogItems(id, catalogType)
      : [];
    
    if (cachedItems && cachedItems.length > 0) {
      console.log(`📦 ${id}: Utilisation du cache VOD (${cachedItems.length} item(s))`);
      
      let metas = await Promise.all(cachedItems.map(async (item) => {
        const stremioId = await resolveStremioId(item.tmdbId, catalogType);
        return {
          type: catalogType,
          id: stremioId,
          name: item.name,
          poster: item.poster,
          posterShape: 'regular',
          background: item.backdrop
        };
      }));

      // Compléter les posters manquants depuis TMDB
      const missingPosterIndices = metas
        .map((m, i) => (m.poster ? -1 : i))
        .filter(i => i >= 0);
      if (missingPosterIndices.length > 0) {
        const BATCH_SIZE = 10;
        const isSeries = catalogType === 'series';
        for (let b = 0; b < missingPosterIndices.length; b += BATCH_SIZE) {
          const batch = missingPosterIndices.slice(b, b + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(idx => fetchPoster(cachedItems[idx].tmdbId, isSeries))
          );
          batch.forEach((idx, j) => {
            if (results[j].poster) metas[idx].poster = results[j].poster;
            if (results[j].backdrop) metas[idx].background = results[j].backdrop;
          });
          if (b + BATCH_SIZE < missingPosterIndices.length) {
            await new Promise(resolve => setTimeout(resolve, 450));
          }
        }
      }

      // Mode paresseux : mettre à jour le cache DB en arrière-plan pour les posters qu'on vient de récupérer
      if (missingPosterIndices.length > 0) {
        (async () => {
          try {
            for (const idx of missingPosterIndices) {
              await dbCacheVod.saveCatalogItem(id, catalogType, cachedItems[idx].tmdbId, cachedItems[idx].name, metas[idx].poster, metas[idx].background, cachedItems[idx].year);
            }
            console.log(`📦 Cache VOD mis à jour en arrière-plan pour ${id} (${missingPosterIndices.length} poster(s))`);
          } catch (e) {
            console.warn(`⚠ Cache VOD (background): ${e.message}`);
          }
        })();
      }
      
      return { metas };
    }
  } catch (error) {
    console.warn(`⚠ Erreur lors de la lecture du cache VOD pour ${id}: ${error.message}`);
    // Continuer avec la méthode classique en cas d'erreur
  }
  
  // Fallback: méthode classique (chargement en temps réel)
  console.log(`🔄 ${id}: Chargement en temps réel (cache non disponible)`);
  
  let itemsInCategory = [];
  
  // Filtrer selon le type (movie ou series)
  if (contentType === 'movie') {
    itemsInCategory = FILMS_DATA.filter(film => 
      film.groups && film.groups.includes(matchingCategory)
    );
  } else if (contentType === 'series') {
    const { isDiffuserBased, diffuserId } = catalogInfo;
    if (isDiffuserBased && diffuserId) {
      // Filtrer par diffuser ID
      itemsInCategory = SERIES_DATA.filter(series => {
        if (!series.diffuser) return false;
        const diffusers = parseDiffuser(series.diffuser);
        return diffusers.some(d => d.id === diffuserId);
      });
      // Trier par Year descending
      itemsInCategory.sort((a, b) => {
        const yearA = parseInt(a.year) || 0;
        const yearB = parseInt(b.year) || 0;
        return yearB - yearA;
      });
    } else {
      itemsInCategory = SERIES_DATA.filter(series => 
        series.groups && series.groups.includes(matchingCategory)
      );
    }
  }
  
  const categoryName = matchingCategory || 'Tous';
  console.log(`${contentType === 'movie' ? 'Films' : 'Séries'} trouvés pour "${categoryName}": ${itemsInCategory.length}`);
  
  // Traiter par batches avec un petit délai entre chaque batch
  const BATCH_SIZE = 10;
  const itemsToFetch = itemsInCategory.filter(item => {
    const cacheKey = `${contentType === 'series' ? 'series' : 'movie'}_${item.tmdbId}`;
    return !posterCache.has(cacheKey);
  });
  
  for (let i = 0; i < itemsToFetch.length; i += BATCH_SIZE) {
    const batch = itemsToFetch.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(item => fetchPoster(item.tmdbId, contentType === 'series'));
    await Promise.all(batchPromises);
    
    if (i + BATCH_SIZE < itemsToFetch.length) {
      await new Promise(resolve => setTimeout(resolve, 450));
    }
  }
  
  // Construire les metas
  const metas = await Promise.all(itemsInCategory.map(async (item) => {
    const stremioId = await resolveStremioId(item.tmdbId, contentType);
    const cacheKey = `${contentType === 'series' ? 'series' : 'movie'}_${item.tmdbId}`;
    const posterInfo = posterCache.get(cacheKey) || { poster: undefined, backdrop: undefined };
    
    return {
      type: contentType,
      id: stremioId,
      name: item.name,
      poster: posterInfo.poster,
      posterShape: 'regular',
      background: posterInfo.backdrop
    };
  }));

  // Mode paresseux : remplir le cache VOD en arrière-plan pour ce catalogue (réponse déjà prête)
  (async () => {
    try {
      for (const item of itemsInCategory) {
        const cacheKey = `${contentType === 'series' ? 'series' : 'movie'}_${item.tmdbId}`;
        const info = posterCache.get(cacheKey) || {};
        await dbCacheVod.saveCatalogItem(id, contentType, item.tmdbId, item.name, info.poster, info.backdrop, item.year);
      }
      console.log(`📦 Cache VOD rempli en arrière-plan pour ${id} (${itemsInCategory.length} item(s))`);
    } catch (e) {
      console.warn(`⚠ Cache VOD (background): ${e.message}`);
    }
  })();
  
  return { metas };
}

// Route pour les catalogues (format: /catalog/movie/category_xxx.json)
app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  
  try {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    
    // Appeler directement le handler avec la requête pour vérifier le token
    const result = await catalogHandler({ type, id, extra: {}, req });
    res.json(result);
  } catch (error) {
    console.error('Error in catalog handler:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Définir les handlers pour meta et stream
async function metaHandler({ type, id }) {
  // Gérer les métadonnées VOD (films et séries)
  let tmdbId = id;
  let isImdbId = false;
  
  // Gérer les IDs tmdb_XXX
  if (id.startsWith('tmdb_')) {
    tmdbId = id.replace('tmdb_', '');
  } 
  // Gérer les IDs IMDB (tt123456)
  else if (id.startsWith('tt')) {
    isImdbId = true;
    try {
      // Convertir IMDB en TMDB
      const response = await axios.get(`${TMDB_API_BASE}/find/${id}`, {
        params: {
          api_key: TMDB_API_KEY,
          external_source: 'imdb_id'
        }
      });
      
      if (type === 'series' || type === 'tv') {
        if (response.data.tv_results && response.data.tv_results.length > 0) {
          tmdbId = response.data.tv_results[0].id.toString();
        } else {
          throw new Error('Série non trouvée dans TMDb');
        }
      } else {
        if (response.data.movie_results && response.data.movie_results.length > 0) {
          tmdbId = response.data.movie_results[0].id.toString();
        } else {
          throw new Error('Film non trouvé dans TMDb');
        }
      }
    } catch (error) {
      console.error(`Erreur conversion IMDB->TMDB: ${error.message}`);
      throw new Error(`ID non trouvé: ${error.message}`);
    }
  }
  
  try {
    // Détecter le type depuis notre base de données
    const film = tmdbToFilmIndex.get(String(tmdbId));
    const series = tmdbToSeriesIndex.get(String(tmdbId));
    
    let contentType = type;
    if (!film && series) {
      contentType = 'series';
    } else if (film && !series) {
      contentType = 'movie';
    } else {
      contentType = type || (film ? 'movie' : 'series');
    }
    
    // Appel API TMDb
    const endpoint = contentType === 'series' ? 'tv' : 'movie';
    const response = await axios.get(`${TMDB_API_BASE}/${endpoint}/${tmdbId}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR',
        append_to_response: 'credits'
      }
    });
    
    const data = response.data;
    
    // Construire l'ID de retour (IMDB prioritaire, identique au catalogue Stremio)
    let returnId = id;
    if (isImdbId) {
      returnId = id;
    } else {
      returnId = await resolveStremioId(tmdbId, contentType === 'series' ? 'series' : 'movie');
    }
    
    if (contentType === 'series') {
      // Construire les vidéos (épisodes) pour les séries
      const videos = [];
      if (series && series.seasons) {
        // Fonction pour récupérer les détails d'une saison complète
        async function getSeasonDetails(seasonNum) {
          try {
            const seasonResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbId}/season/${seasonNum}`, {
              params: {
                api_key: TMDB_API_KEY,
                language: 'fr-FR'
              },
              timeout: 5000
            });
            return seasonResponse.data;
          } catch (error) {
            return null;
          }
        }
        
        const hasLocalSeason = (seasonNum) => {
          const local = series.seasons[String(seasonNum)];
          return local && Object.keys(local).length > 0;
        };
        
        // Saisons locales uniquement (pas la saison 0 TMDB qui décale Stremio)
        const tmdbSeasonNumbers = (data.seasons || []).map(s => s.season_number);
        let seasonsToFetch = [...new Set(
          tmdbSeasonNumbers.filter(n => n > 0 && hasLocalSeason(n))
        )].sort((a, b) => a - b);
        if (seasonsToFetch.length === 0) {
          seasonsToFetch = Object.keys(series.seasons)
            .map(n => parseInt(n, 10))
            .sort((a, b) => a - b);
        }
        
        const seasonMap = new Map();
        const BATCH_SIZE = 5;
        for (let i = 0; i < seasonsToFetch.length; i += BATCH_SIZE) {
          const batch = seasonsToFetch.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(seasonNum =>
            getSeasonDetails(seasonNum).then(seasonData => {
              if (seasonData?.episodes?.length) {
                seasonMap.set(String(seasonNum), seasonData.episodes);
              }
            })
          ));
          if (i + BATCH_SIZE < seasonsToFetch.length) {
            await new Promise(resolve => setTimeout(resolve, 450));
          }
        }
        
        // S'appuyer sur la numérotation TMDB (alignée avec Cinemeta) pour chaque épisode
        for (const seasonNum of seasonsToFetch) {
          const seasonKey = String(seasonNum);
          const tmdbEpisodes = seasonMap.get(seasonKey) || [];
          const localEpisodes = series.seasons[seasonKey] || {};
          const isCustomContent = series.groups && series.groups.includes('Contenu personnalisé');
          
          if (tmdbEpisodes.length > 0) {
            for (const tmEp of tmdbEpisodes) {
              const episodeNum = String(tmEp.episode_number);
              const hasStream = localEpisodes[episodeNum] !== undefined && localEpisodes[episodeNum] !== null;
              if (isCustomContent && !hasStream) continue;
              const video = {
                id: `${returnId}:${seasonKey}:${episodeNum}`,
                title: tmEp.name || `Saison ${seasonKey} Épisode ${episodeNum}`,
                season: parseInt(seasonKey, 10),
                episode: tmEp.episode_number,
                streamsAvailable: hasStream ? 1 : 0
              };
              if (tmEp.still_path) {
                video.thumbnail = `https://image.tmdb.org/t/p/w300${tmEp.still_path}`;
              } else if (data.poster_path) {
                video.thumbnail = `https://image.tmdb.org/t/p/w500${data.poster_path}`;
              }
              videos.push(video);
            }
          } else {
            // Fallback si TMDB indisponible : épisodes locaux uniquement
            for (const episodeNum of Object.keys(localEpisodes).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
              videos.push({
                id: `${returnId}:${seasonKey}:${episodeNum}`,
                title: `Saison ${seasonKey} Épisode ${episodeNum}`,
                season: parseInt(seasonKey, 10),
                episode: parseInt(episodeNum, 10),
                streamsAvailable: 1,
                thumbnail: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined
              });
            }
          }
        }
        
        videos.sort((a, b) => (a.season !== b.season ? a.season - b.season : a.episode - b.episode));
      }
      
      return {
        meta: {
          type: 'series',
          id: returnId,
          name: data.name || data.original_name,
          poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined,
          posterShape: 'regular',
          background: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : undefined,
          logo: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined,
          description: data.overview || '',
          releaseInfo: data.first_air_date || '',
          director: [], // Pas de directeur pour les séries
          cast: data.credits?.cast?.slice(0, 10).map(actor => actor.name) || [],
          genres: data.genres?.map(g => g.name) || [],
          website: data.homepage || undefined,
          reviews: [],
          runtime: undefined, // Pas de runtime pour les séries
          rating: data.vote_average ? data.vote_average.toFixed(1) : undefined,
          videos: videos
        }
      };
    } else {
      // Film
      return {
        meta: {
          type: 'movie',
          id: returnId,
          name: data.title || data.original_title,
          poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined,
          posterShape: 'regular',
          background: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : undefined,
          logo: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined,
          description: data.overview || '',
          releaseInfo: data.release_date || '',
          director: data.credits?.crew?.filter(c => c.job === 'Director').map(d => d.name) || [],
          cast: data.credits?.cast?.slice(0, 10).map(actor => actor.name) || [],
          genres: data.genres?.map(g => g.name) || [],
          website: data.homepage || undefined,
          reviews: [],
          runtime: data.runtime ? `${data.runtime} min` : undefined,
          rating: data.vote_average ? data.vote_average.toFixed(1) : undefined
        }
      };
    }
  } catch (error) {
    console.error(`Erreur meta ${type}:`, error.message);
    throw new Error(`${type === 'series' ? 'Série' : 'Film'} non trouvé: ${error.message}`);
  }
}

async function streamHandler({ type, id, req }) {
  // Log immédiat pour confirmer que le streamHandler est appelé
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎬 STREAMHANDLER APPELÉ - ${type}/${id}`);
  console.log(`   Timestamp: ${new Date().toISOString()}`);
  if (req) {
    console.log(`   URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
    console.log(`   Referer: ${req.headers.referer || 'N/A'}`);
    console.log(`   Origin: ${req.headers.origin || 'N/A'}`);
    console.log(`   Query: ${JSON.stringify(req.query)}`);
  }
  console.log(`${'='.repeat(60)}\n`);
  
  // Extraire le token Stremio depuis la requête (depuis l'URL du manifest)
  const stremioToken = req ? (getStremioToken(req) || (req.session && req.session.stremioToken)) : null;
  
  // Log pour déboguer
  if (stremioToken) {
    const authCheck = isStremioTokenAuthorized(stremioToken);
    console.log(`🔑 StreamHandler ${type}/${id} - Token trouvé pour: ${authCheck.authorized ? authCheck.username : 'INVALIDE'}`);
  } else {
    console.log(`⚠️ StreamHandler ${type}/${id} - Aucun token trouvé`);
    if (req) {
      console.log(`   Referer: ${req.headers.referer || 'N/A'}`);
      console.log(`   Session token: ${req.session?.stremioToken || 'N/A'}`);
    }
  }
  
  // Gérer les séries VOD (format: tt123456:1:2 ou tmdb_123456:1:2)
  if (type === 'series') {
    // Vérifier que le token est valide pour les séries
    if (!stremioToken) {
      console.log(`❌ ${id}: Aucun token fourni - Pas de streams pour la série`);
      return { streams: [] };
    }
    
    const authCheck = isStremioTokenAuthorized(stremioToken);
    if (!authCheck.authorized) {
      console.log(`❌ ${id}: Token invalide (${authCheck.username || 'INCONNU'}) - Pas de streams pour la série`);
      return { streams: [] };
    }
    
    // Enregistrer l'activité Stremio (seulement si pas déjà enregistré dans cette session)
    if (req && (!req.session?.stremioActivityRecorded || req.session.stremioActivityRecorded !== authCheck.username)) {
      const clientIp = getClientIp(req);
      userManager.recordStremioActivity(authCheck.username, clientIp);
      if (req.session) {
        req.session.stremioActivityRecorded = authCheck.username;
      }
    }
    
    const parts = id.split(':');
    if (parts.length === 3) {
      const seriesId = parts[0]; // ID série (IMDB ou TMDB)
      const seasonNum = parts[1];
      const episodeNum = parts[2];
      
      let tmdbId = seriesId;
      if (seriesId.startsWith('tmdb_')) {
        tmdbId = seriesId.replace('tmdb_', '');
      } else if (seriesId.startsWith('tt')) {
        // Convertir IMDB en TMDB pour les séries
        try {
          const response = await axios.get(`${TMDB_API_BASE}/find/${seriesId}`, {
            params: {
              api_key: TMDB_API_KEY,
              external_source: 'imdb_id'
            }
          });
          
          if (response.data.tv_results && response.data.tv_results.length > 0) {
            tmdbId = response.data.tv_results[0].id.toString();
          } else {
            console.log(`Série non trouvée dans TMDb pour ${seriesId}`);
            return { streams: [] };
          }
        } catch (error) {
          console.log(`Erreur conversion IMDB->TMDB pour série: ${error.message}`);
          return { streams: [] };
        }
      }
      
      const series = tmdbToSeriesIndex.get(String(tmdbId));
      if (!series || !series.seasons || !series.seasons[seasonNum] || !series.seasons[seasonNum][episodeNum]) {
        console.log(`Épisode non trouvé: Saison ${seasonNum}, Épisode ${episodeNum}`);
        return { streams: [] };
      }
      
      // Support pour plusieurs liens par épisode (comme pour les films)
      // Compatible avec plusieurs structures :
      // - Ancienne: string simple "id123"
      // - Nouvelle simple: ["id1", "id2"]
      // - Nouvelle avec qualité: [{id: "id1", quality: "1080p"}, {id: "id2", quality: "720p"}]
      // - Nouvelle mixte: "id1" ou [{id: "id1", quality: "1080p"}]
      const episodeLinks = series.seasons[seasonNum][episodeNum];
      
      // Normaliser en tableau d'objets {id, quality}
      let episodeData = [];
      if (Array.isArray(episodeLinks)) {
        episodeData = episodeLinks.map(link => {
          if (typeof link === 'string') {
            return { id: link, quality: null };
          } else if (link && typeof link === 'object' && link.id) {
            return { id: link.id, quality: link.quality || null };
          }
          return { id: String(link), quality: null };
        });
      } else if (episodeLinks && typeof episodeLinks === 'object' && episodeLinks.id) {
        episodeData = [{ id: episodeLinks.id, quality: episodeLinks.quality || null }];
      } else {
        episodeData = [{ id: String(episodeLinks), quality: null }];
      }
      
      // Fonction pour extraire la qualité depuis un nom de fichier ou ID
      function extractQualityFromId(id) {
        // Essayer d'extraire la qualité depuis l'ID (peut contenir des indices)
        // Pour l'instant, on retourne null car on n'a pas le nom de fichier
        return null;
      }
      
      // Utiliser un proxy au lieu de retourner l'URL AllDebrid directement
      // Cela garantit que toutes les requêtes passent par le serveur (même IP)
      // et évite que AllDebrid détecte plusieurs IP différentes
      try {
        const baseUrl = getBaseUrl(req);
        
        // Créer un stream pour chaque lien disponible
        const streams = episodeData.map((epData, index) => {
          const allDebridId = epData.id;
          const quality = epData.quality || extractQualityFromId(allDebridId);
          
          // Inclure le token dans l'URL
          let proxyUrl = `${baseUrl}/debrid/series/${tmdbId}/${seasonNum}/${episodeNum}`;
          // Si plusieurs liens, ajouter l'index dans l'URL
          if (episodeData.length > 1) {
            proxyUrl += `/${index}`;
          }
          proxyUrl += `?token=${stremioToken}`;
          
          // Formater le titre avec la qualité comme pour les films
          let title = `Saison ${seasonNum} Épisode ${episodeNum}`;
          if (quality) {
            // Formater la qualité comme pour les films (remplacer " - " par des retours à la ligne)
            const formattedQuality = quality.replace(/ - /g, '\n');
            title = formattedQuality;
          } else if (episodeData.length > 1) {
            title = `${title} - Lien ${index + 1}`;
          }
          
          return {
            title: title,
            url: proxyUrl,
            behaviorHints: {
              notWebReady: false,
              bingeGroup: `series-${tmdbId}-s${seasonNum}e${episodeNum}`
            }
          };
        });
        
        console.log(`📺 StreamHandler série: ${streams.length} stream(s) - Saison ${seasonNum} Épisode ${episodeNum} (Utilisateur: ${authCheck.username})`);
        
        return { streams };
      } catch (error) {
        console.error(`Erreur débridage épisode: ${error.message}`);
        return { streams: [] };
      }
    } else {
      console.log(`Format d'ID série invalide: ${id}`);
      return { streams: [] };
    }
  }
  
  // Gérer les films
  // Vérifier que le token est valide pour les films
  if (!stremioToken) {
    console.log(`❌ ${id}: Aucun token fourni - Pas de streams pour le film`);
    return { streams: [] };
  }
  
  const authCheck = isStremioTokenAuthorized(stremioToken);
  if (!authCheck.authorized) {
    console.log(`❌ ${id}: Token invalide (${authCheck.username || 'INCONNU'}) - Pas de streams pour le film`);
    return { streams: [] };
  }
  
  // Enregistrer l'activité Stremio (seulement si pas déjà enregistré dans cette session)
  if (req && (!req.session?.stremioActivityRecorded || req.session.stremioActivityRecorded !== authCheck.username)) {
    const clientIp = getClientIp(req);
    userManager.recordStremioActivity(authCheck.username, clientIp);
    if (req.session) {
      req.session.stremioActivityRecorded = authCheck.username;
    }
  }
  
  let film = null;
  let actualImdbId = id;
  
  if (id.startsWith('tmdb_')) {
    const tmdbId = id.replace('tmdb_', '');
    film = tmdbToFilmIndex.get(tmdbId);
    if (film) {
      try {
        actualImdbId = await getImdbIdFromTmdb(tmdbId);
      } catch (e) {
        actualImdbId = id;
      }
    }
  } else {
    film = imdbToFilmIndex.get(id);
    actualImdbId = id;
    
    if (!film) {
      try {
        const tmdbId = await getTmdbIdFromImdb(id);
        film = tmdbToFilmIndex.get(tmdbId) || tmdbToFilmIndex.get(tmdbId.toString()) || tmdbToFilmIndex.get(String(tmdbId));
        
        if (film) {
          imdbToFilmIndex.set(id, film);
          imdbIdCache.set(tmdbId.toString(), id);
        }
      } catch (error) {
        console.log(`Erreur de conversion: ${error.message}`);
      }
    }
  }
  
  if (!film) {
    return { streams: [] };
  }
  
  // Retourner des URLs proxy pour débrider uniquement au moment de la lecture
  const baseUrl = getBaseUrl(req);
  
    const streams = film.qualities.map((quality, index) => {
      if (!film.allDebridIds || !film.allDebridIds[index]) {
        return null;
      }
      
      // Inclure le token dans l'URL
      let proxyUrl = `${baseUrl}/debrid/movie/${actualImdbId}/${index}`;
      proxyUrl += `?token=${stremioToken}`;
      console.log(`🎬 StreamHandler film: URL proxy pour "${film.name}" - ${quality} (Utilisateur: ${authCheck.username})`);
      
      const formattedQuality = quality ? quality.replace(/ - /g, '\n') : 'Quality unknown';
      
      return {
        title: formattedQuality,
        url: proxyUrl,
        behaviorHints: {
          notWebReady: false, // Les films débridés sont généralement compatibles web
          bingeGroup: `movie-${actualImdbId}`
        }
      };
    }).filter(stream => stream !== null);
  
  // Log désactivé pour réduire la verbosité
  // console.log(`🎬 StreamHandler film: ${streams.length} stream(s) retourné(s) pour "${film.name}"`);
  
  return { streams };
}

// Routes Express utilisant directement les handlers
app.get('/meta/:type/:id.json', async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    
    const result = await metaHandler({ type: req.params.type, id: req.params.id });
    res.json(result);
  } catch (error) {
    console.error('Error in meta handler:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Middleware pour extraire et stocker le token depuis le referer pour Stremio mobile
app.use((req, res, next) => {
  // Si on n'a pas de token dans la session mais qu'on a un referer avec token
  if (!req.session?.stremioToken) {
    const referer = req.headers.referer || req.headers.origin || '';
    const refererMatch = referer.match(/[?&](?:token|stremio_token)=([^&]+)/);
    if (refererMatch) {
      const token = refererMatch[1];
      if (req.session) {
        req.session.stremioToken = token;
        const authCheck = isStremioTokenAuthorized(token);
        if (authCheck.authorized) {
          req.session.stremioUsername = authCheck.username;
        }
      }
    }
  }
  next();
});

// Endpoint pour obtenir les streams
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  
  try {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    
    // S'assurer que le token est disponible dans la requête
    const token = getStremioToken(req);
    if (token && req.session) {
      req.session.stremioToken = token;
      const authCheck = isStremioTokenAuthorized(token);
      if (authCheck.authorized) {
        req.session.stremioUsername = authCheck.username;
        console.log(`🔑 Token trouvé pour stream ${type}/${id} - Utilisateur: ${authCheck.username}`);
      }
    } else {
      console.log(`⚠️ Aucun token trouvé pour stream ${type}/${id}`);
      console.log(`   Referer: ${req.headers.referer || 'N/A'}`);
      console.log(`   Origin: ${req.headers.origin || 'N/A'}`);
      console.log(`   Query: ${JSON.stringify(req.query)}`);
      console.log(`   Session token: ${req.session?.stremioToken || 'N/A'}`);
    }
    
    const result = await streamHandler({ type: req.params.type, id: req.params.id, req: req });
    
    // Log de la réponse pour déboguer
    if (result && result.streams && result.streams.length > 0) {
      console.log(`✅ StreamHandler retourne ${result.streams.length} stream(s) pour ${type}/${id}`);
      result.streams.forEach((stream, idx) => {
        console.log(`   Stream ${idx + 1}: ${stream.url} (token: ${stream.url.includes('token=') ? 'OUI' : 'NON'})`);
      });
    } else {
      console.log(`⚠️ StreamHandler retourne 0 stream pour ${type}/${id}`);
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error in stream handler:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint pour débrider les séries au moment de la lecture (utilisé par le streamHandler)
// Support pour plusieurs liens: /debrid/series/:seriesId/:seasonNum/:episodeNum/:linkIndex?
app.get('/debrid/series/:seriesId/:seasonNum/:episodeNum/:linkIndex?', async (req, res) => {
  const { seriesId, seasonNum, episodeNum, linkIndex } = req.params;
  
  // Vérifier l'autorisation via token Stremio
  const token = getStremioToken(req) || (req.session && req.session.stremioToken);
  const authCheck = token ? isStremioTokenAuthorized(token) : { authorized: false };
  
  if (!authCheck.authorized) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`❌ ACCÈS REFUSÉ - Token Stremio invalide ou manquant`);
    console.log(`   📍 URL Proxy: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
    console.log(`   📺 Série ID: ${seriesId} - Saison ${seasonNum} Épisode ${episodeNum}`);
    console.log(`${'='.repeat(60)}\n`);
    return res.status(403).send('Accès refusé. Token Stremio invalide. Veuillez utiliser l\'URL du manifest avec votre token depuis l\'interface de gestion.');
  }
  
  if (!req.headers['range']) {
    console.log(`📺 Stream série ${seriesId} S${seasonNum}E${episodeNum} (${authCheck.username})`);
  }
  
  try {
    let tmdbId = seriesId;
    
    // Convertir IMDB en TMDB si nécessaire
    if (seriesId.startsWith('tmdb_')) {
      tmdbId = seriesId.replace('tmdb_', '');
    } else if (seriesId.startsWith('tt')) {
      try {
        const response = await axios.get(`${TMDB_API_BASE}/find/${seriesId}`, {
          params: {
            api_key: TMDB_API_KEY,
            external_source: 'imdb_id'
          }
        });
        
        if (response.data.tv_results && response.data.tv_results.length > 0) {
          tmdbId = response.data.tv_results[0].id.toString();
        } else {
          return res.status(404).send('Série non trouvée');
        }
      } catch (error) {
        console.error(`Erreur conversion IMDB->TMDB: ${error.message}`);
        return res.status(500).send('Erreur de conversion');
      }
    }
    
    const series = tmdbToSeriesIndex.get(String(tmdbId));
    if (!series || !series.seasons || !series.seasons[seasonNum] || !series.seasons[seasonNum][episodeNum]) {
      return res.status(404).send('Épisode non trouvé');
    }
    
    // Support pour plusieurs liens par épisode (compatible avec plusieurs structures)
    const episodeLinks = series.seasons[seasonNum][episodeNum];
    
    // Normaliser en tableau d'objets {id, quality}
    let episodeData = [];
    if (Array.isArray(episodeLinks)) {
      episodeData = episodeLinks.map(link => {
        if (typeof link === 'string') {
          return { id: link, quality: null };
        } else if (link && typeof link === 'object' && link.id) {
          return { id: link.id, quality: link.quality || null };
        }
        return { id: String(link), quality: null };
      });
    } else if (episodeLinks && typeof episodeLinks === 'object' && episodeLinks.id) {
      episodeData = [{ id: episodeLinks.id, quality: episodeLinks.quality || null }];
    } else {
      episodeData = [{ id: String(episodeLinks), quality: null }];
    }
    
    // Déterminer quel lien utiliser
    let linkIndexToUse = 0;
    if (linkIndex !== undefined) {
      linkIndexToUse = parseInt(linkIndex, 10);
      if (isNaN(linkIndexToUse) || linkIndexToUse < 0 || linkIndexToUse >= episodeData.length) {
        return res.status(404).send(`Lien ${linkIndex} non trouvé pour cet épisode`);
      }
    }
    
    const allDebridId = episodeData[linkIndexToUse].id;
    const qualityInfo = episodeData[linkIndexToUse].quality ? ` [${episodeData[linkIndexToUse].quality}]` : '';
    const linkInfo = episodeData.length > 1 ? ` (Lien ${linkIndexToUse + 1}/${episodeData.length})` : '';
    userManager.recordContentView(authCheck.username, `series:${tmdbId}:${seasonNum}:${episodeNum}`);
    const context = `📺 DÉBRIDAGE SÉRIE - ${series.name}\n📹 Saison ${seasonNum} Épisode ${episodeNum}${qualityInfo}${linkInfo}\n👤 Utilisateur: ${authCheck.username}`;
    await streamWithAutoRefresh(req, res, allDebridId, context);
    
  } catch (error) {
    console.error(`❌ Erreur lors du débridage série: ${error.message}`);
    res.status(500).send(`Erreur lors du débridage: ${error.message}`);
  }
});

// Endpoint pour débrider les films au moment de la lecture
app.get('/debrid/movie/:imdbId/:qualityIndex', async (req, res) => {
  const { imdbId, qualityIndex } = req.params;
  const index = parseInt(qualityIndex);
  
  // Vérifier l'autorisation via token Stremio
  const token = getStremioToken(req) || (req.session && req.session.stremioToken);
  const authCheck = token ? isStremioTokenAuthorized(token) : { authorized: false };
  
  if (!authCheck.authorized) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`❌ ACCÈS REFUSÉ - Token Stremio invalide ou manquant`);
    console.log(`   📍 URL Proxy: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
    console.log(`   🎬 Film ID: ${imdbId} - Qualité Index: ${qualityIndex}`);
    console.log(`${'='.repeat(60)}\n`);
    return res.status(403).send('Accès refusé. Token Stremio invalide. Veuillez utiliser l\'URL du manifest avec votre token depuis l\'interface de gestion.');
  }
  
  if (!req.headers['range']) {
    console.log(`🎬 Stream film ${imdbId}/${qualityIndex} (${authCheck.username})`);
  }
  
  // Gérer les requêtes HEAD (utilisées par Stremio mobile pour vérifier la disponibilité)
  if (req.method === 'HEAD') {
    try {
      let film = null;
      let actualImdbId = imdbId;
      
      if (!imdbId.startsWith('tt')) {
        film = tmdbToFilmIndex.get(imdbId);
        if (film) {
          actualImdbId = await getImdbIdFromTmdb(imdbId);
        }
      } else {
        film = imdbToFilmIndex.get(imdbId);
        actualImdbId = imdbId;
      }
      
      if (!film || !film.allDebridIds || !film.allDebridIds[index]) {
        return res.status(404).end();
      }
      
      const allDebridId = film.allDebridIds[index];
      let debridedUrl;
      
      // Utiliser debridLink qui gère automatiquement l'expiration
      const context = `🎬 DÉBRIDAGE FILM (HEAD) - ${film.name}\n📹 Qualité: ${film.qualities[index] || 'Unknown'}\n👤 Utilisateur: ${authCheck.username}`;
      debridedUrl = await debridLink(allDebridId, context);
      
      // Vérifier que le lien est toujours valide en faisant une requête HEAD
      // Note: Le cache étant désactivé, le lien vient toujours d'être débridé
      try {
        const headResponse = await axios.head(debridedUrl, { 
          timeout: 5000,
          validateStatus: (status) => status < 500 // Accepter 2xx, 3xx, 4xx mais pas 5xx
        });
        
        // Si le lien retourne une erreur 403/404, il est probablement expiré
        // Redébrider immédiatement (cache désactivé, donc toujours frais)
        if (headResponse.status === 403 || headResponse.status === 404) {
          console.log(`⚠️ Lien expiré détecté (${headResponse.status}), redébridage immédiat...`);
          debridedUrl = await debridLink(allDebridId, context, true); // Force refresh
        }
      } catch (error) {
        // Si la requête HEAD échoue, redébrider si c'est une erreur 403/404
        if (error.response && (error.response.status === 403 || error.response.status === 404)) {
          console.log(`⚠️ Lien expiré détecté (${error.response.status}), redébridage immédiat...`);
          debridedUrl = await debridLink(allDebridId, context, true); // Force refresh
        }
        // Pour les autres erreurs (timeout, etc.), on continue avec le lien actuel
      }
      
      // Retourner les headers sans le corps pour HEAD
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(200).end();
      return;
    } catch (error) {
      return res.status(500).end();
    }
  }
  
  try {
    // Trouver le film
    let film = null;
    let actualImdbId = imdbId;
    
    if (!imdbId.startsWith('tt')) {
      film = tmdbToFilmIndex.get(imdbId);
      if (film) {
        actualImdbId = await getImdbIdFromTmdb(imdbId);
        imdbToFilmIndex.set(actualImdbId, film);
      }
    } else {
      // Chercher dans l'index
      film = imdbToFilmIndex.get(imdbId);
      actualImdbId = imdbId;
    }
    
    if (!film || !film.allDebridIds || !film.allDebridIds[index]) {
      return res.status(404).send('Stream non trouvé');
    }
    
    const allDebridId = film.allDebridIds[index];
    const quality = film.qualities[index] || 'Quality unknown';
    userManager.recordContentView(authCheck.username, 'movie:' + film.tmdbId);
    const context = `🎬 DÉBRIDAGE FILM - ${film.name}\n📹 Qualité: ${quality}\n👤 Utilisateur: ${authCheck.username}`;
    await streamWithAutoRefresh(req, res, allDebridId, context);
    
  } catch (error) {
    console.error(`❌ Erreur lors du débridage film: ${error.message}`);
    res.status(500).send(`Erreur lors du débridage: ${error.message}`);
  }
});

// Import de la fonction de parsing
const { parseAllRecursively } = require('./refresh_parser');

// Variable pour suivre si un refresh est en cours
let refreshInProgress = false;
let lastRefreshResult = null;

function getCatalogContentItems(catalogId) {
  if (
    catalogId === FUNK_TRENDING_MOVIES_CATALOG_ID ||
    catalogId === FUNK_TRENDING_SERIES_CATALOG_ID ||
    catalogId === CUSTOM_CONTENT_MOVIE_CATALOG_ID ||
    catalogId === CUSTOM_CONTENT_SERIES_CATALOG_ID
  ) {
    return [];
  }

  const catalogInfo = catalogIdToCategoryMap.get(catalogId);
  if (!catalogInfo) return [];

  const { category: matchingCategory, type: catalogType } = catalogInfo;

  if (catalogType === 'movie') {
    return FILMS_DATA.filter(film =>
      film.groups && film.groups.includes(matchingCategory)
    );
  }

  if (catalogInfo.isDiffuserBased && catalogInfo.diffuserId) {
    return SERIES_DATA.filter(series => {
      if (!series.diffuser) return false;
      const diffusers = parseDiffuser(series.diffuser);
      return diffusers.some(d => d.id === catalogInfo.diffuserId);
    }).sort((a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0));
  }

  return SERIES_DATA.filter(series =>
    series.groups && series.groups.includes(matchingCategory)
  );
}

async function populateVodCache() {
  const entries = [];
  for (const catalog of catalogs) {
    const items = getCatalogContentItems(catalog.id);
    for (const item of items) {
      entries.push({
        catalogId: catalog.id,
        type: catalog.type,
        tmdbId: item.tmdbId,
        name: item.name,
        posterUrl: undefined,
        backdropUrl: undefined,
        year: item.year
      });
    }
  }

  await dbCacheVod.clearAllCatalogs();

  if (entries.length === 0) {
    console.log('📦 Cache VOD vidé (aucune entrée à pré-remplir)');
    return;
  }

  const BATCH_SIZE = 2000;
  let saved = 0;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const chunk = entries.slice(i, i + BATCH_SIZE);
    saved += await dbCacheVod.saveCatalogItemsBulk(chunk);
  }

  console.log(`📦 Cache VOD pré-rempli (${saved} entrées, posters récupérés à la demande)`);
}

function runPostRefreshBackgroundTasks() {
  void populateVodCache().catch(error => {
    console.error('✗ Erreur lors du remplissage du cache VOD:', error.message);
  });

  void Promise.all([
    rebuildTrendingCache('movies'),
    rebuildTrendingCache('series')
  ]).then(() => {
    console.log('✅ Cache tendances StremioPasteBin recalculé');
  }).catch((e) => {
    console.warn(`⚠ Cache tendances: ${e.message}`);
  });
}

// Fonction pour exécuter le refresh en arrière-plan
async function executeRefresh() {
  if (refreshInProgress) {
    return { status: 'in_progress', message: 'Un refresh est déjà en cours...' };
  }
  
  refreshInProgress = true;
  lastRefreshResult = null;

  let result;
  try {
    console.log('\n🔄 Démarrage du refresh du catalogue...');
    
    // Lancer le parsing récursif (base unifiée)
    const stats = await parseAllRecursively();
    
    console.log(`✅ Refresh terminé: ${stats.filmsCount} films, ${stats.seriesCount} séries, ${stats.episodesCount} épisodes`);
    
    // Reconstruire les index
    const { newTmdbToFilmIndex, newTmdbToSeriesIndex, newCatalogs } = rebuildIndexes();
    tmdbToFilmIndex = newTmdbToFilmIndex;
    tmdbToSeriesIndex = newTmdbToSeriesIndex;
    catalogs = newCatalogs;
    
    // Vider les caches
    imdbToFilmIndex.clear();
    posterCache.clear();
    trendingCache.movies = { generatedAt: 0, metas: [] };
    trendingCache.series = { generatedAt: 0, metas: [] };
    
    console.log('✅ Index et catalogues reconstruits');
    logCustomContentStats('Après refresh');
    
    result = { 
      status: 'success',
      message: 'Catalogue mis à jour avec succès',
      stats: {
        films: stats.filmsCount,
        series: stats.seriesCount,
        episodes: stats.episodesCount,
        codesVisited: stats.codesVisited
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('❌ Erreur lors du refresh:', error.message);
    result = { 
      status: 'error', 
      message: error.message 
    };
  } finally {
    refreshInProgress = false;
    lastRefreshResult = result || null;
  }

  if (result?.status === 'success') {
    runPostRefreshBackgroundTasks();
  }

  return result;
}

// Endpoint de refresh - déclenche le parsing récursif en arrière-plan
app.get('/refresh', async (req, res) => {
  if (refreshInProgress) {
    return res.json({ 
      status: 'in_progress', 
      message: 'Un refresh est déjà en cours...' 
    });
  }
  
  // Répondre immédiatement et lancer le refresh en arrière-plan
  res.json({ 
    status: 'started',
    message: 'Refresh démarré en arrière-plan. Utilisez /refresh/status pour suivre la progression.'
  });
  
  // Lancer le refresh en arrière-plan (ne pas attendre)
  executeRefresh().catch(error => {
    console.error('❌ Erreur lors du refresh en arrière-plan:', error);
  });
});

// Endpoint de status du refresh
app.get('/refresh/status', (req, res) => {
  const seriesCount = SERIES_DATA.length;
  const episodesCount = SERIES_DATA.reduce((sum, s) => {
    return sum + Object.values(s.seasons || {}).reduce((sSum, episodes) => {
      return sSum + Object.keys(episodes || {}).length;
    }, 0);
  }, 0);
  
  res.json({
    inProgress: refreshInProgress,
    lastResult: lastRefreshResult,
    filmsCount: FILMS_DATA.length,
    seriesCount: seriesCount,
    episodesCount: episodesCount,
    catalogsCount: catalogs.length
  });
});

function writeEmptyCatalogFiles() {
  const timestamp = new Date().toISOString();
  const emptyUnified = { films: [], series: [] };
  const unifiedDataPath = path.join(__dirname, 'unified_data.js');
  fs.writeFileSync(
    unifiedDataPath,
    `// Base de données unifiée (films + séries)\n// Généré le: ${timestamp}\nmodule.exports = ${JSON.stringify(emptyUnified, null, 2)};\n`,
    'utf-8'
  );
  fs.writeFileSync(path.join(__dirname, 'films_data.js'), 'exports.FILMS_DATA = [];\n', 'utf-8');
  fs.writeFileSync(path.join(__dirname, 'series_data.js'), 'exports.SERIES_DATA = [];\n', 'utf-8');
}

async function resetAllAddonData() {
  if (refreshInProgress) {
    throw new Error('Un refresh est en cours. Réessayez lorsqu\'il sera terminé.');
  }

  writeEmptyCatalogFiles();
  await dbCacheVod.clearAllCatalogs();
  settingsManager.resetSettings();
  settingsManager.savePastebinCodes([]);
  userManager.resetToDefaultAdmin();

  imdbToFilmIndex.clear();
  posterCache.clear();
  debridedUrlCache.clear();
  trendingCache.movies = { generatedAt: 0, metas: [] };
  trendingCache.series = { generatedAt: 0, metas: [] };

  const { newTmdbToFilmIndex, newTmdbToSeriesIndex, newCatalogs } = rebuildIndexes();
  tmdbToFilmIndex = newTmdbToFilmIndex;
  tmdbToSeriesIndex = newTmdbToSeriesIndex;
  catalogs = newCatalogs;

  invalidateCustomContentCatalogCache();

  return {
    filmsCount: 0,
    seriesCount: 0,
    usersCount: 0,
    pastebinCodesCount: 0,
    settingsCleared: true
  };
}

// API pour gérer les paramètres (AllDebrid, URL pastebin)
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    res.json({
      success: true,
      settings: settingsManager.getPublicSettings(),
      codes: settingsManager.loadPastebinCodes()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const { alldebridApiKey, pastebinBaseUrl } = req.body || {};
    const partial = {};

    if (alldebridApiKey !== undefined) {
      partial.alldebridApiKey = alldebridApiKey;
    }
    if (pastebinBaseUrl !== undefined) {
      partial.pastebinBaseUrl = pastebinBaseUrl;
    }

    const settings = settingsManager.saveSettings(partial);
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/reset-all', requireAdmin, adminSensitiveLimiter, async (req, res) => {
  try {
    const { confirmText, adminPassword } = req.body || {};

    if (confirmText !== 'RESET') {
      return res.status(400).json({
        success: false,
        error: 'Tapez RESET dans le champ de confirmation pour valider.'
      });
    }

    if (!adminPassword) {
      return res.status(400).json({ success: false, error: 'Mot de passe administrateur requis.' });
    }

    const adminInfo = userManager.getAdminInfo();
    const auth = userManager.authenticate(adminInfo.username, adminPassword);
    if (!auth.success) {
      return res.status(403).json({ success: false, error: 'Mot de passe administrateur incorrect.' });
    }

    const summary = await resetAllAddonData();
    console.log('🗑️ Réinitialisation complète effectuée par l\'administrateur');

    res.json({
      success: true,
      message: 'Réinitialisation complète effectuée. Seul le compte admin/admin est conservé.',
      summary
    });
  } catch (error) {
    console.error('Erreur lors de la réinitialisation:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API pour gérer les codes pastebin
app.get('/api/pastebin-codes', requireAdmin, (req, res) => {
  try {
    res.json({ codes: settingsManager.loadPastebinCodes() });
  } catch (error) {
    console.error('Erreur lors du chargement des codes:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/pastebin-codes', requireAdmin, (req, res) => {
  try {
    const { codes } = req.body;
    
    if (!Array.isArray(codes)) {
      return res.status(400).json({ success: false, message: 'Les codes doivent être un tableau' });
    }
    
    const validCodes = codes.filter(code => {
      if (typeof code !== 'string') return false;
      return isValidPasteCode(code);
    }).map(code => code.trim());
    
    const uniqueCodes = [...new Set(validCodes)];
    settingsManager.savePastebinCodes(uniqueCodes);
    
    console.log(`✅ ${uniqueCodes.length} codes pastebin sauvegardés`);
    
    res.json({ 
      success: true, 
      message: `${uniqueCodes.length} code(s) sauvegardé(s)`,
      codes: uniqueCodes
    });
  } catch (error) {
    console.error('Erreur lors de la sauvegarde des codes:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Fonction pour récupérer les fichiers d'un magnet AllDebrid
// Documentation: https://docs.alldebrid.com/#get-files-and-links
async function getAllDebridMagnetFiles(allDebridId) {
  try {
    const apiKey = getAllDebridApiKey();
    if (!apiKey) {
      throw new Error('Clé API AllDebrid non configurée');
    }

    const FormData = require('form-data');
    const form = new FormData();
    form.append('id[]', allDebridId);
    
    console.log('🔑 Utilisation de la clé API:', apiKey.substring(0, 10) + '... (longueur: ' + apiKey.length + ')');
    
    const response = await axios.post('https://api.alldebrid.com/v4.1/magnet/files', form, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...form.getHeaders()
      },
      timeout: 30000
    });
    
    // Vérifier la réponse
    if (!response || !response.data) {
      throw new Error('Réponse invalide de l\'API AllDebrid');
    }
    
    // Log détaillé de la réponse complète
    console.log('\n' + '='.repeat(60));
    console.log('📥 RÉPONSE API ALLDEBRID - /v4.1/magnet/files');
    console.log('='.repeat(60));
    console.log('Magnet ID:', allDebridId);
    console.log('Status:', response.data.status);
    console.log('Réponse complète:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('='.repeat(60) + '\n');
    
    if (response.data.status === 'success') {
      const data = response.data.data;
      
      // Structure de réponse attendue :
      // { status: "success", data: { magnets: [{ id: "...", files: [...] }, ...] } }
      if (data && typeof data === 'object' && data.magnets && Array.isArray(data.magnets)) {
        console.log('🔍 Analyse de la structure de données:');
        console.log(`  - Nombre de magnets dans la réponse: ${data.magnets.length}`);
        
        // Chercher le magnet correspondant à l'ID fourni
        const magnetData = data.magnets.find(m => m.id === allDebridId || String(m.id) === String(allDebridId));
        
        if (!magnetData) {
          console.warn(`⚠️ Magnet avec l'ID ${allDebridId} non trouvé dans la réponse`);
          console.warn('  IDs disponibles:', data.magnets.map(m => m.id).join(', '));
          throw new Error(`Magnet ID ${allDebridId} non trouvé dans la réponse`);
        }
        
        console.log(`  - Magnet trouvé: ID ${magnetData.id}`);
        
        // Vérifier s'il y a une erreur
        if (magnetData.error) {
          const errorMsg = magnetData.error.message || magnetData.error.code || 'Erreur inconnue';
          console.error(`❌ Erreur pour le magnet ${magnetData.id}:`, errorMsg);
          throw new Error(`Erreur AllDebrid: ${errorMsg}`);
        }
        
        // Vérifier s'il y a des fichiers
        if (!magnetData.files || !Array.isArray(magnetData.files)) {
          console.warn('⚠️ Aucun fichier trouvé pour ce magnet');
          throw new Error('Aucun fichier trouvé pour ce magnet');
        }
        
        // Fonction récursive pour extraire tous les fichiers (y compris dans les dossiers)
        function extractFiles(files, basePath = '') {
          const allFiles = [];
          
          for (const file of files) {
            if (file.l) {
              // C'est un fichier avec un lien
              // Le lien est au format https://alldebrid.com/f/xxxxxx
              // Extraire l'ID (xxxxxx) après /f/
              let fileId = file.l;
              if (file.l.includes('/f/')) {
                fileId = file.l.split('/f/').pop() || file.l;
              } else {
                // Si c'est déjà juste l'ID, l'utiliser tel quel
                fileId = file.l;
              }
              
              allFiles.push({
                id: fileId,
                link: file.l,
                filename: basePath + file.n,
                name: file.n,
                size: file.s
              });
            } else if (file.e && Array.isArray(file.e)) {
              // C'est un dossier, extraire récursivement
              const subFiles = extractFiles(file.e, basePath + file.n + '/');
              allFiles.push(...subFiles);
            }
          }
          
          return allFiles;
        }
        
        const allFiles = extractFiles(magnetData.files);
        console.log(`✅ ${allFiles.length} fichier(s) extrait(s) du magnet`);
        
        if (allFiles.length === 0) {
          throw new Error('Aucun fichier valide trouvé dans le magnet');
        }
        
        return { files: allFiles };
      }
      
      // Si on arrive ici, la structure n'est pas celle attendue
      console.warn('⚠️ Structure de réponse AllDebrid inattendue');
      console.warn('Données reçues:', JSON.stringify(data, null, 2));
      throw new Error('Structure de réponse AllDebrid inattendue');
    } else {
      const errorMsg = response.data.error?.message || response.data.error || 'Erreur lors de la récupération des fichiers';
      console.error('❌ Erreur API AllDebrid:', errorMsg);
      console.error('Réponse complète:', JSON.stringify(response.data, null, 2));
      throw new Error(errorMsg);
    }
  } catch (error) {
    console.error('Erreur lors de la récupération des fichiers AllDebrid:', error.message);
    if (error.response && error.response.data) {
      console.error('Réponse API AllDebrid:', JSON.stringify(error.response.data, null, 2));
      const apiError = error.response.data.error?.message || error.response.data.error || error.message;
      throw new Error(`Erreur AllDebrid: ${apiError}`);
    }
    throw error;
  }
}

// Fonction pour récupérer les métadonnées TMDB et déterminer le type
async function getTmdbMetadata(tmdbId) {
  try {
    // Essayer d'abord comme film
    try {
      const movieResponse = await axios.get(`${TMDB_API_BASE}/movie/${tmdbId}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR'
        },
        timeout: 5000
      });
      
      return {
        type: 'movie',
        data: movieResponse.data,
        name: movieResponse.data.title || movieResponse.data.original_title,
        year: movieResponse.data.release_date ? movieResponse.data.release_date.split('-')[0] : undefined
      };
    } catch (movieError) {
      // Si ce n'est pas un film, essayer comme série
      const tvResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbId}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR'
        },
        timeout: 5000
      });
      
      return {
        type: 'series',
        data: tvResponse.data,
        name: tvResponse.data.name || tvResponse.data.original_name,
        year: tvResponse.data.first_air_date ? tvResponse.data.first_air_date.split('-')[0] : undefined
      };
    }
  } catch (error) {
    console.error(`Erreur lors de la récupération des métadonnées TMDB: ${error.message}`);
    throw new Error(`Contenu TMDB non trouvé: ${error.message}`);
  }
}

// Endpoint pour ajouter du contenu manuellement
app.post('/api/add-content', async (req, res) => {
  try {
    const { allDebridId, tmdbId, contentType, seasonNumber } = req.body;
    
    // Validation
    if (!allDebridId || typeof allDebridId !== 'string') {
      return res.status(400).json({ 
        success: false, 
        message: 'allDebridId est requis et doit être une chaîne de caractères' 
      });
    }
    
    if (!tmdbId || (typeof tmdbId !== 'string' && typeof tmdbId !== 'number')) {
      return res.status(400).json({ 
        success: false, 
        message: 'tmdbId est requis et doit être une chaîne de caractères ou un nombre' 
      });
    }
    
    // Validation du type de contenu (maintenant obligatoire)
    if (!contentType || (contentType !== 'movie' && contentType !== 'series')) {
      return res.status(400).json({ 
        success: false, 
        message: 'contentType est requis et doit être "movie" ou "series"' 
      });
    }
    
    // Validation du numéro de saison
    if (seasonNumber !== undefined && seasonNumber !== null) {
      const seasonNum = parseInt(seasonNumber);
      if (isNaN(seasonNum) || seasonNum < 1) {
        return res.status(400).json({ 
          success: false, 
          message: 'seasonNumber doit être un nombre positif' 
        });
      }
    }
    
    const tmdbIdStr = String(tmdbId);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`➕ Ajout de contenu manuel`);
    console.log(`📋 AllDebrid ID: ${allDebridId}`);
    console.log(`🎬 TMDB ID: ${tmdbIdStr}`);
    if (contentType && contentType !== 'auto') {
      console.log(`📺 Type forcé: ${contentType === 'movie' ? 'Film' : 'Série'}`);
    }
    if (seasonNumber !== undefined && seasonNumber !== null) {
      console.log(`📌 Saison forcée: ${seasonNumber}`);
    }
    console.log(`${'='.repeat(60)}`);
    
    // Déterminer le type de contenu attendu
    const expectedType = contentType && contentType !== 'auto' ? contentType : null;
    
    // Vérifier si le contenu existe déjà
    const existingFilm = tmdbToFilmIndex.get(tmdbIdStr);
    const existingSeries = tmdbToSeriesIndex.get(tmdbIdStr);
    
    // Vérifier les conflits de type si un type est spécifié
    if (expectedType === 'movie' && existingSeries && existingSeries.groups && existingSeries.groups.includes('Contenu personnalisé')) {
      return res.status(400).json({ 
        success: false, 
        message: `L'ID TMDB ${tmdbIdStr} est déjà utilisé pour une série dans "Contenu personnalisé". Vérifiez que vous ajoutez bien un film.` 
      });
    }
    
    if (expectedType === 'series' && existingFilm && existingFilm.groups && existingFilm.groups.includes('Contenu personnalisé')) {
      return res.status(400).json({ 
        success: false, 
        message: `L'ID TMDB ${tmdbIdStr} est déjà utilisé pour un film dans "Contenu personnalisé". Vérifiez que vous ajoutez bien une série.` 
      });
    }
    
    // Si le contenu existe déjà et qu'il est dans "Contenu personnalisé", on peut le mettre à jour
    const isCustomContent = (existingFilm && existingFilm.groups && existingFilm.groups.includes('Contenu personnalisé')) ||
                            (existingSeries && existingSeries.groups && existingSeries.groups.includes('Contenu personnalisé'));
    
    if ((existingFilm || existingSeries) && !isCustomContent) {
      return res.status(400).json({ 
        success: false, 
        message: `Le contenu avec l'ID TMDB ${tmdbIdStr} existe déjà dans la base de données (contenu parsé, non personnalisé)` 
      });
    }
    
    if (isCustomContent) {
      console.log(`⚠️  Le contenu existe déjà dans "Contenu personnalisé" - mise à jour...`);
    }
    
    // Récupérer les fichiers AllDebrid
    console.log('📥 Récupération des fichiers depuis AllDebrid...');
    const allDebridData = await getAllDebridMagnetFiles(allDebridId);
    
    if (!allDebridData || !allDebridData.files || allDebridData.files.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Aucun fichier trouvé pour ce magnet AllDebrid' 
      });
    }
    
    // Récupérer les métadonnées TMDB avec le type spécifié
    console.log('📥 Récupération des métadonnées TMDB...');
    let tmdbMetadata;
    
    // Utiliser le type spécifié pour récupérer les métadonnées
    if (contentType === 'movie') {
      try {
        const movieResponse = await axios.get(`${TMDB_API_BASE}/movie/${tmdbIdStr}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: 'fr-FR'
          },
          timeout: 5000
        });
        tmdbMetadata = {
          type: 'movie',
          data: movieResponse.data,
          name: movieResponse.data.title || movieResponse.data.original_title,
          year: movieResponse.data.release_date ? movieResponse.data.release_date.split('-')[0] : undefined
        };
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: `L'ID TMDB ${tmdbIdStr} ne correspond pas à un film`
        });
      }
    } else if (contentType === 'series') {
      try {
        const tvResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbIdStr}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: 'fr-FR'
          },
          timeout: 5000
        });
        tmdbMetadata = {
          type: 'series',
          data: tvResponse.data,
          name: tvResponse.data.name || tvResponse.data.original_name,
          year: tvResponse.data.first_air_date ? tvResponse.data.first_air_date.split('-')[0] : undefined
        };
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: `L'ID TMDB ${tmdbIdStr} ne correspond pas à une série`
        });
      }
    } else {
      // Auto-détection (ne devrait plus arriver car le type est maintenant obligatoire)
      tmdbMetadata = await getTmdbMetadata(tmdbIdStr);
    }
    
    // Vérifier que le type correspond
    if (contentType && contentType !== tmdbMetadata.type) {
      return res.status(400).json({
        success: false,
        message: `Le type spécifié (${contentType === 'movie' ? 'film' : 'série'}) ne correspond pas au type réel du contenu TMDB (${tmdbMetadata.type === 'movie' ? 'film' : 'série'})`
      });
    }
    
    // Charger la base unifiée
    // Utiliser require pour charger les données (plus sûr que eval)
    delete require.cache[require.resolve('./unified_data')];
    const unifiedData = require('./unified_data');
    
    // Créer une copie profonde pour éviter de modifier l'objet original
    const unifiedDataCopy = JSON.parse(JSON.stringify(unifiedData));
    
    // Créer l'entrée selon le type
    if (tmdbMetadata.type === 'movie') {
      // Pour les films, on prend tous les fichiers comme différentes qualités
      const qualities = [];
      const allDebridIds = [];
      
      // Les fichiers sont maintenant dans allDebridData.files (structure extraite)
      const filesList = allDebridData.files || [];
      
      filesList.forEach((file, index) => {
        // Extraire la qualité depuis le nom du fichier ou utiliser un nom générique
        const fileName = file.filename || file.name || `Fichier ${index + 1}`;
        const quality = fileName.match(/(\d+p|1080p|720p|480p|2160p|4K)/i)?.[0] || 'Qualité inconnue';
        qualities.push(quality);
        // Utiliser l'ID extrait du lien (format: https://alldebrid.com/f/xxxxxx)
        // L'ID est la partie après /f/
        const fileId = file.id || (file.link ? file.link.split('/').pop() : allDebridId);
        allDebridIds.push(fileId);
      });
      
      const newFilm = {
        tmdbId: tmdbIdStr,
        name: tmdbMetadata.name,
        year: tmdbMetadata.year || new Date().getFullYear().toString(),
        diffuser: '[]',
        groups: ['Contenu personnalisé'],
        qualities: qualities.length > 0 ? qualities : ['Qualité par défaut'],
        allDebridIds: allDebridIds.length > 0 ? allDebridIds : [allDebridId]
      };
      
      // Si le film existe déjà, le remplacer, sinon l'ajouter
      const filmIndex = unifiedDataCopy.films.findIndex(f => String(f.tmdbId) === tmdbIdStr && 
                                                              f.groups && f.groups.includes('Contenu personnalisé'));
      if (filmIndex >= 0) {
        unifiedDataCopy.films[filmIndex] = newFilm;
        console.log(`✅ Film mis à jour: ${newFilm.name}`);
      } else {
        unifiedDataCopy.films.push(newFilm);
        console.log(`✅ Film ajouté: ${newFilm.name}`);
      }
    } else {
      // Pour les séries, parser les noms de fichiers pour extraire saisons/épisodes
      const filesList = allDebridData.files || [];
      
      if (filesList.length === 0) {
        throw new Error('Aucun fichier trouvé pour cette série');
      }
      
      // Fonction pour parser le nom de fichier et extraire saison/épisode
      function parseEpisodeInfo(filename) {
        if (!filename) return null;
        
        // Patterns courants pour saison/épisode :
        // S01E01, S1E1, S01.E01, S01xE01, 1x01, 01x01, [01x01], (01x01)
        // Episode 01, Ep 01, E01, etc.
        const patterns = [
          /[Ss](\d+)[Ee](\d+)/,                    // S01E01, s1e1
          /(\d+)[xX](\d+)/,                         // 1x01, 01x01
          /\[(\d+)[xX](\d+)\]/,                     // [01x01]
          /\((\d+)[xX](\d+)\)/,                     // (01x01)
          /[Ee]pisode\s*(\d+)/i,                    // Episode 01
          /[Ee]p\s*(\d+)/i,                         // Ep 01
          /[Ee](\d+)/,                              // E01
        ];
        
        for (const pattern of patterns) {
          const match = filename.match(pattern);
          if (match) {
            // Si le pattern a 2 groupes (saison et épisode)
            if (match.length === 3) {
              const season = parseInt(match[1], 10);
              const episode = parseInt(match[2], 10);
              if (season > 0 && episode > 0) {
                return { season, episode };
              }
            }
            // Si le pattern a 1 groupe (juste l'épisode, on assume saison 1)
            else if (match.length === 2) {
              const episode = parseInt(match[1], 10);
              if (episode > 0) {
                return { season: 1, episode };
              }
            }
          }
        }
        
        return null;
      }
      
      // Organiser les fichiers par saison et épisode
      const seasons = {};
      const episodeMeta = {};
      let filesProcessed = 0;
      let filesSkipped = 0;
      
      filesList.forEach((file) => {
        const entry = getFileEntry(file);
        if (!entry) {
          filesSkipped++;
          return;
        }

        const { filename } = entry;
        if (shouldSkipEpisodeFile(filename)) {
          filesSkipped++;
          return;
        }
        
        let episodeInfo = parseEpisodeInfo(filename);
        
        // Si un numéro de saison est spécifié, forcer toutes les épisodes à être dans cette saison
        if (seasonNumber !== undefined && seasonNumber !== null) {
          const forcedSeason = parseInt(seasonNumber);
          if (episodeInfo) {
            // Garder le numéro d'épisode mais forcer la saison
            episodeInfo.season = forcedSeason;
          } else {
            // Si on ne peut pas parser l'épisode, utiliser l'index + 1
            const episodeNum = Object.values(seasons).reduce((sum, s) => sum + Object.keys(s).length, 0) + 1;
            episodeInfo = { season: forcedSeason, episode: episodeNum };
          }
        }
        
        if (episodeInfo) {
          const { season, episode } = episodeInfo;
          const seasonKey = String(season);
          const episodeKey = String(episode);
          
          if (assignEpisodeFile(seasons, episodeMeta, seasonKey, episodeKey, entry)) {
            filesProcessed++;
          } else {
            filesSkipped++;
          }
        } else {
          // Si on ne peut pas parser, mettre dans la saison 1 (ou saison forcée) avec un numéro d'ordre
          const seasonKey = seasonNumber ? String(seasonNumber) : '1';
          const episodeKey = String(Object.keys(seasons[seasonKey] || {}).length + 1);
          if (assignEpisodeFile(seasons, episodeMeta, seasonKey, episodeKey, entry)) {
            filesProcessed++;
          } else {
            filesSkipped++;
          }
        }
      });
      
      // Si aucun fichier n'a été parsé, mettre tous les fichiers dans la saison spécifiée (ou saison 1)
      if (filesProcessed === 0 && filesSkipped > 0) {
        const seasonKey = seasonNumber ? String(seasonNumber) : '1';
        console.log(`⚠️  Aucun pattern saison/épisode trouvé, organisation séquentielle dans la saison ${seasonKey}...`);
        seasons[seasonKey] = {};
        const playableFiles = filesList
          .map(getFileEntry)
          .filter(Boolean)
          .filter(entry => !shouldSkipEpisodeFile(entry.filename));
        const filesToAssign = playableFiles.length > 0 ? playableFiles : filesList.map(getFileEntry).filter(Boolean);
        filesToAssign.forEach((entry, index) => {
          assignEpisodeFile(seasons, episodeMeta, seasonKey, String(index + 1), entry);
        });
      }
      
      // Si un numéro de saison est spécifié, afficher un message
      if (seasonNumber !== undefined && seasonNumber !== null) {
        console.log(`📌 Saison forcée: tous les fichiers seront dans la saison ${seasonNumber}`);
      }
      
      const totalEpisodes = Object.values(seasons).reduce((sum, season) => sum + Object.keys(season).length, 0);
      const totalSeasons = Object.keys(seasons).length;
      
      console.log(`📊 Organisation des fichiers:`);
      console.log(`   - ${totalSeasons} saison(s)`);
      console.log(`   - ${totalEpisodes} épisode(s) au total`);
      Object.keys(seasons).sort((a, b) => parseInt(a) - parseInt(b)).forEach(season => {
        const episodeCount = Object.keys(seasons[season]).length;
        console.log(`   - Saison ${season}: ${episodeCount} épisode(s)`);
      });
      
      // Si la série existe déjà, fusionner les saisons au lieu de les remplacer
      const seriesIndex = unifiedDataCopy.series.findIndex(s => String(s.tmdbId) === tmdbIdStr && 
                                                                 s.groups && s.groups.includes('Contenu personnalisé'));
      
      let finalSeasons = seasons;
      if (seriesIndex >= 0) {
        // Fusionner les saisons existantes avec les nouvelles
        const existingSeries = unifiedDataCopy.series[seriesIndex];
        const existingSeasons = existingSeries.seasons || {};
        
        console.log(`⚠️  Série existante trouvée - fusion des saisons...`);
        console.log(`   Saisons existantes: ${Object.keys(existingSeasons).length}`);
        console.log(`   Nouvelles saisons: ${Object.keys(seasons).length}`);
        
        // Fusionner les saisons
        finalSeasons = { ...existingSeasons };
        Object.keys(seasons).forEach(seasonKey => {
          if (!finalSeasons[seasonKey]) {
            finalSeasons[seasonKey] = {};
          }
          // Fusionner les épisodes de la saison
          finalSeasons[seasonKey] = {
            ...finalSeasons[seasonKey],
            ...seasons[seasonKey]
          };
        });
        
        console.log(`   Saisons après fusion: ${Object.keys(finalSeasons).length}`);
        Object.keys(finalSeasons).sort((a, b) => parseInt(a) - parseInt(b)).forEach(season => {
          const episodeCount = Object.keys(finalSeasons[season]).length;
          console.log(`   - Saison ${season}: ${episodeCount} épisode(s)`);
        });
      }
      
      const newSeries = {
        tmdbId: tmdbIdStr,
        name: tmdbMetadata.name,
        year: tmdbMetadata.year || new Date().getFullYear().toString(),
        diffuser: '[]',
        groups: ['Contenu personnalisé'],
        seasons: finalSeasons
      };
      
      if (seriesIndex >= 0) {
        unifiedDataCopy.series[seriesIndex] = newSeries;
        console.log(`✅ Série mise à jour: ${newSeries.name}`);
      } else {
        unifiedDataCopy.series.push(newSeries);
        console.log(`✅ Série ajoutée: ${newSeries.name}`);
      }
    }
    
    // Sauvegarder dans unified_data.js et recharger les index
    saveUnifiedDataAndReload(unifiedDataCopy);
    
    console.log(`${'='.repeat(60)}`);
    console.log('✅ Contenu ajouté avec succès!');
    console.log(`${'='.repeat(60)}\n`);
    
    res.json({ 
      success: true, 
      message: isCustomContent ? 'Contenu mis à jour avec succès' : 'Contenu ajouté avec succès',
      type: tmdbMetadata.type,
      name: tmdbMetadata.name,
      tmdbId: tmdbIdStr,
      filesCount: allDebridData.files.length,
      updated: isCustomContent
    });
  } catch (error) {
    console.error(`❌ Erreur lors de l'ajout du contenu: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Endpoint pour lister le contenu personnalisé
app.get('/api/custom-content', (req, res) => {
  try {
    const customFilms = FILMS_DATA.filter(f => f.groups && f.groups.includes('Contenu personnalisé'));
    const customSeries = SERIES_DATA.filter(s => s.groups && s.groups.includes('Contenu personnalisé'));
    
    const content = [
      ...customFilms.map(f => ({
        type: 'movie',
        tmdbId: f.tmdbId,
        name: f.name,
        year: f.year,
        filesCount: f.allDebridIds ? f.allDebridIds.length : 0
      })),
      ...customSeries.map(s => ({
        type: 'series',
        tmdbId: s.tmdbId,
        name: s.name,
        year: s.year,
        filesCount: s.seasons ? Object.values(s.seasons).reduce((sum, season) => 
          sum + Object.keys(season).length, 0) : 0,
        seasons: s.seasons ? Object.keys(s.seasons).map(seasonNum => ({
          number: parseInt(seasonNum),
          episodesCount: Object.keys(s.seasons[seasonNum]).length
        })).sort((a, b) => a.number - b.number) : []
      }))
    ];
    
    res.json({
      success: true,
      content: content
    });
  } catch (error) {
    console.error('Erreur lors de la récupération du contenu personnalisé:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour supprimer le contenu personnalisé
app.delete('/api/custom-content/:tmdbId', (req, res) => {
  try {
    const { tmdbId } = req.params;
    const tmdbIdStr = String(tmdbId);
    
    // Charger la base unifiée
    delete require.cache[require.resolve('./unified_data')];
    const unifiedData = require('./unified_data');
    const unifiedDataCopy = JSON.parse(JSON.stringify(unifiedData));
    
    // Chercher et supprimer le film
    const filmIndex = unifiedDataCopy.films.findIndex(f => 
      String(f.tmdbId) === tmdbIdStr && 
      f.groups && 
      f.groups.includes('Contenu personnalisé')
    );
    
    if (filmIndex >= 0) {
      const deletedFilm = unifiedDataCopy.films[filmIndex];
      unifiedDataCopy.films.splice(filmIndex, 1);
      console.log(`🗑️  Film supprimé: ${deletedFilm.name} (TMDB: ${tmdbIdStr})`);
    } else {
      // Chercher et supprimer la série
      const seriesIndex = unifiedDataCopy.series.findIndex(s => 
        String(s.tmdbId) === tmdbIdStr && 
        s.groups && 
        s.groups.includes('Contenu personnalisé')
      );
      
      if (seriesIndex >= 0) {
        const deletedSeries = unifiedDataCopy.series[seriesIndex];
        unifiedDataCopy.series.splice(seriesIndex, 1);
        console.log(`🗑️  Série supprimée: ${deletedSeries.name} (TMDB: ${tmdbIdStr})`);
      } else {
        return res.status(404).json({
          success: false,
          error: `Contenu personnalisé avec l'ID TMDB ${tmdbIdStr} non trouvé`
        });
      }
    }
    
    // Sauvegarder et recharger les index
    saveUnifiedDataAndReload(unifiedDataCopy);
    
    res.json({
      success: true,
      message: 'Contenu supprimé avec succès'
    });
  } catch (error) {
    console.error('Erreur lors de la suppression du contenu:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour supprimer une saison spécifique d'une série
app.delete('/api/custom-content/:tmdbId/season/:seasonNumber', (req, res) => {
  try {
    const { tmdbId, seasonNumber } = req.params;
    const tmdbIdStr = String(tmdbId);
    const seasonNumStr = String(seasonNumber);
    
    // Charger la base unifiée
    delete require.cache[require.resolve('./unified_data')];
    const unifiedData = require('./unified_data');
    const unifiedDataCopy = JSON.parse(JSON.stringify(unifiedData));
    
    // Chercher la série
    const seriesIndex = unifiedDataCopy.series.findIndex(s => 
      String(s.tmdbId) === tmdbIdStr && 
      s.groups && 
      s.groups.includes('Contenu personnalisé')
    );
    
    if (seriesIndex < 0) {
      return res.status(404).json({
        success: false,
        error: `Série personnalisée avec l'ID TMDB ${tmdbIdStr} non trouvée`
      });
    }
    
    const series = unifiedDataCopy.series[seriesIndex];
    
    // Vérifier si la saison existe
    if (!series.seasons || !series.seasons[seasonNumStr]) {
      return res.status(404).json({
        success: false,
        error: `Saison ${seasonNumber} non trouvée pour cette série`
      });
    }
    
    const episodesCount = Object.keys(series.seasons[seasonNumStr]).length;
    
    // Supprimer la saison
    delete series.seasons[seasonNumStr];
    
    // Si plus aucune saison, supprimer la série complète
    if (Object.keys(series.seasons).length === 0) {
      unifiedDataCopy.series.splice(seriesIndex, 1);
      console.log(`🗑️  Série supprimée (plus de saisons): ${series.name} (TMDB: ${tmdbIdStr})`);
    } else {
      console.log(`🗑️  Saison ${seasonNumber} supprimée de "${series.name}" (${episodesCount} épisode(s))`);
    }
    
    // Sauvegarder et recharger les index
    saveUnifiedDataAndReload(unifiedDataCopy);
    
    res.json({
      success: true,
      message: `Saison ${seasonNumber} supprimée avec succès`,
      seriesDeleted: Object.keys(series.seasons).length === 0
    });
  } catch (error) {
    console.error('Erreur lors de la suppression de la saison:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour rechercher un contenu par ID TMDB et retourner les détails existants
app.get('/api/search-content/:tmdbId', async (req, res) => {
  try {
    const { tmdbId } = req.params;
    const { type } = req.query; // Récupérer le type depuis les query parameters
    const tmdbIdStr = String(tmdbId);
    
    // Récupérer les métadonnées TMDB pour vérifier que le contenu existe
    let tmdbMetadata;
    try {
      // Si un type est spécifié, forcer la récupération avec ce type
      if (type === 'movie') {
        try {
          const movieResponse = await axios.get(`${TMDB_API_BASE}/movie/${tmdbIdStr}`, {
            params: {
              api_key: TMDB_API_KEY,
              language: 'fr-FR'
            },
            timeout: 5000
          });
          tmdbMetadata = {
            type: 'movie',
            data: movieResponse.data,
            name: movieResponse.data.title || movieResponse.data.original_title,
            year: movieResponse.data.release_date ? movieResponse.data.release_date.split('-')[0] : undefined
          };
        } catch (error) {
          return res.status(404).json({
            success: false,
            error: `Film avec l'ID TMDB ${tmdbIdStr} non trouvé`
          });
        }
      } else if (type === 'series') {
        try {
          const tvResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbIdStr}`, {
            params: {
              api_key: TMDB_API_KEY,
              language: 'fr-FR'
            },
            timeout: 5000
          });
          tmdbMetadata = {
            type: 'series',
            data: tvResponse.data,
            name: tvResponse.data.name || tvResponse.data.original_name,
            year: tvResponse.data.first_air_date ? tvResponse.data.first_air_date.split('-')[0] : undefined
          };
        } catch (error) {
          return res.status(404).json({
            success: false,
            error: `Série avec l'ID TMDB ${tmdbIdStr} non trouvé`
          });
        }
      } else {
        // Auto-détection si aucun type n'est spécifié
        tmdbMetadata = await getTmdbMetadata(tmdbIdStr);
      }
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: `Contenu avec l'ID TMDB ${tmdbIdStr} non trouvé`
      });
    }
    
    // Chercher dans la base de données
    const existingFilm = tmdbToFilmIndex.get(tmdbIdStr);
    const existingSeries = tmdbToSeriesIndex.get(tmdbIdStr);
    
    if (tmdbMetadata.type === 'movie') {
      // Pour un film
      // Vérifier d'abord dans l'index, puis dans la base de données directement
      let filmToCheck = existingFilm;
      let isCustomContent = false;
      
      // Si pas trouvé dans l'index, vérifier directement dans la base de données unifiée
      if (!filmToCheck) {
        try {
          delete require.cache[require.resolve('./unified_data')];
          const unifiedData = require('./unified_data');
          const filmInDb = unifiedData.films.find(f => String(f.tmdbId) === tmdbIdStr);
          
          if (filmInDb) {
            console.log(`🔍 Film trouvé dans la base de données (pas dans l'index) pour TMDB ${tmdbIdStr}`);
            filmToCheck = filmInDb;
          }
        } catch (error) {
          console.error('Erreur lors de la lecture de la base de données:', error.message);
        }
      }
      
      // Vérifier si le film a le groupe "Contenu personnalisé"
      if (filmToCheck && filmToCheck.groups && filmToCheck.groups.includes('Contenu personnalisé')) {
        isCustomContent = true;
      }
      
      if (filmToCheck) {
        // Le film existe dans la base de données
        return res.json({
          success: true,
          type: 'movie',
          tmdbId: tmdbIdStr,
          name: filmToCheck.name || tmdbMetadata.name,
          year: filmToCheck.year || tmdbMetadata.year,
          exists: true,
          isCustomContent: isCustomContent,
          filesCount: filmToCheck.allDebridIds ? filmToCheck.allDebridIds.length : 0,
          allDebridIds: filmToCheck.allDebridIds || []
        });
      } else {
        // Le film n'existe pas encore
        return res.json({
          success: true,
          type: 'movie',
          tmdbId: tmdbIdStr,
          name: tmdbMetadata.name,
          year: tmdbMetadata.year,
          exists: false,
          isCustomContent: false,
          filesCount: 0
        });
      }
    } else {
      // Pour une série
      // Vérifier d'abord dans l'index, puis dans la base de données directement
      let seriesToCheck = existingSeries;
      let isCustomContent = false;
      
      // Si pas trouvée dans l'index, vérifier directement dans la base de données unifiée
      if (!seriesToCheck) {
        try {
          delete require.cache[require.resolve('./unified_data')];
          const unifiedData = require('./unified_data');
          const seriesInDb = unifiedData.series.find(s => String(s.tmdbId) === tmdbIdStr);
          
          if (seriesInDb) {
            console.log(`🔍 Série trouvée dans la base de données (pas dans l'index) pour TMDB ${tmdbIdStr}`);
            seriesToCheck = seriesInDb;
          }
        } catch (error) {
          console.error('Erreur lors de la lecture de la base de données:', error.message);
        }
      }
      
      // Vérifier si la série a le groupe "Contenu personnalisé"
      if (seriesToCheck && seriesToCheck.groups && seriesToCheck.groups.includes('Contenu personnalisé')) {
        isCustomContent = true;
      } else if (seriesToCheck) {
        // La série existe mais n'a pas le groupe "Contenu personnalisé"
        // On la retourne quand même pour permettre d'ajouter des saisons/épisodes
        console.log(`⚠️  Série trouvée pour TMDB ${tmdbIdStr} mais sans groupe "Contenu personnalisé" - affichage quand même`);
      }
      
      if (seriesToCheck && seriesToCheck.seasons && Object.keys(seriesToCheck.seasons).length > 0) {
        // Construire la liste détaillée des saisons et épisodes
        const seasonsDetail = {};
        if (seriesToCheck.seasons) {
          Object.keys(seriesToCheck.seasons).forEach(seasonNum => {
            const episodes = seriesToCheck.seasons[seasonNum];
            seasonsDetail[seasonNum] = {
              number: parseInt(seasonNum),
              episodes: Object.keys(episodes).map(epNum => ({
                number: parseInt(epNum),
                allDebridId: episodes[epNum]
              })).sort((a, b) => a.number - b.number)
            };
          });
        }
        
        return res.json({
          success: true,
          type: 'series',
          tmdbId: tmdbIdStr,
          name: seriesToCheck.name,
          year: seriesToCheck.year,
          exists: true,
          isCustomContent: isCustomContent,
          seasons: Object.values(seasonsDetail).sort((a, b) => a.number - b.number),
          totalEpisodes: Object.values(seriesToCheck.seasons || {}).reduce((sum, season) => 
            sum + Object.keys(season).length, 0)
        });
      } else {
        // La série n'existe pas encore, mais on peut retourner les infos TMDB
        // Récupérer les saisons depuis TMDB pour afficher ce qui est disponible
        try {
          const tvResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbIdStr}`, {
            params: {
              api_key: TMDB_API_KEY,
              language: 'fr-FR'
            },
            timeout: 5000
          });
          
          const tmdbSeasons = (tvResponse.data.seasons || []).map(s => ({
            number: s.season_number,
            name: s.name,
            episodeCount: s.episode_count,
            airDate: s.air_date
          })).filter(s => s.number >= 0); // Exclure les saisons spéciales (numéro < 0)
          
          return res.json({
            success: true,
            type: 'series',
            tmdbId: tmdbIdStr,
            name: tmdbMetadata.name,
            year: tmdbMetadata.year,
            exists: false,
            seasons: [],
            tmdbSeasons: tmdbSeasons.sort((a, b) => a.number - b.number)
          });
        } catch (error) {
          return res.json({
            success: true,
            type: 'series',
            tmdbId: tmdbIdStr,
            name: tmdbMetadata.name,
            year: tmdbMetadata.year,
            exists: false,
            seasons: []
          });
        }
      }
    }
  } catch (error) {
    console.error('Erreur lors de la recherche du contenu:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour récupérer les épisodes d'une saison depuis TMDB
app.get('/api/series/:tmdbId/seasons/:seasonNumber/episodes', async (req, res) => {
  try {
    const { tmdbId, seasonNumber } = req.params;
    const tmdbIdStr = String(tmdbId);
    const seasonNum = parseInt(seasonNumber);
    
    if (isNaN(seasonNum) || seasonNum < 0) {
      return res.status(400).json({
        success: false,
        error: 'Numéro de saison invalide'
      });
    }
    
    // Récupérer les détails de la saison depuis TMDB
    try {
      const seasonResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbIdStr}/season/${seasonNum}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR'
        },
        timeout: 5000
      });
      
      const episodes = (seasonResponse.data.episodes || []).map(ep => ({
        number: ep.episode_number,
        name: ep.name,
        overview: ep.overview,
        airDate: ep.air_date,
        stillPath: ep.still_path
      }));
      
      return res.json({
        success: true,
        seasonNumber: seasonNum,
        seasonName: seasonResponse.data.name,
        episodes: episodes.sort((a, b) => a.number - b.number)
      });
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: `Saison ${seasonNum} non trouvée pour la série avec l'ID TMDB ${tmdbIdStr}`
      });
    }
  } catch (error) {
    console.error('Erreur lors de la récupération des épisodes:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour récupérer les saisons d'une série depuis TMDB
app.get('/api/series/:tmdbId/seasons', async (req, res) => {
  try {
    const { tmdbId } = req.params;
    const tmdbIdStr = String(tmdbId);
    
    // Récupérer les détails de la série depuis TMDB
    try {
      const tvResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbIdStr}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR'
        },
        timeout: 5000
      });
      
      const seasons = (tvResponse.data.seasons || [])
        .map(s => ({
          number: s.season_number,
          name: s.name,
          episodeCount: s.episode_count,
          airDate: s.air_date,
          overview: s.overview,
          posterPath: s.poster_path
        }))
        .filter(s => s.number >= 0) // Exclure les saisons spéciales
        .sort((a, b) => a.number - b.number);
      
      return res.json({
        success: true,
        seriesName: tvResponse.data.name,
        seasons: seasons
      });
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: `Série avec l'ID TMDB ${tmdbIdStr} non trouvée`
      });
    }
  } catch (error) {
    console.error('Erreur lors de la récupération des saisons:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour récupérer la liste des magnets AllDebrid
app.get('/api/alldebrid/magnets', async (req, res) => {
  try {
    const apiKey = getAllDebridApiKey();
    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Clé API AllDebrid non configurée' });
    }

    const { showAll } = req.query; // Paramètre optionnel pour afficher tous les magnets
    
    const response = await axios.get('https://api.alldebrid.com/v4.1/magnet/status', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 10000
    });
    
    if (response.data.status === 'success' && response.data.data && response.data.data.magnets) {
      // Récupérer tous les IDs AllDebrid déjà utilisés dans la base de données
      const usedAllDebridIds = new Set();
      
      // Charger la base unifiée pour vérifier les IDs utilisés
      try {
        delete require.cache[require.resolve('./unified_data')];
        const unifiedData = require('./unified_data');
        
        // Récupérer les IDs des films
        unifiedData.films.forEach(film => {
          if (film.allDebridIds && Array.isArray(film.allDebridIds)) {
            film.allDebridIds.forEach(id => usedAllDebridIds.add(String(id)));
          }
        });
        
        // Récupérer les IDs des séries
        unifiedData.series.forEach(series => {
          if (series.seasons) {
            Object.values(series.seasons).forEach(season => {
              if (season && typeof season === 'object') {
                Object.values(season).forEach(id => usedAllDebridIds.add(String(id)));
              }
            });
          }
        });
      } catch (error) {
        console.error('Erreur lors du chargement de la base de données pour vérifier les IDs:', error.message);
      }
      
      // Extensions vidéo courantes
      const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv'];
      
      // Mots-clés typiques des releases vidéo
      const videoKeywords = [
        '1080', '720', '480', '2160', '4k', 'uhd',
        'multi', 'vff', 'truefrench', 'french', 'fren',
        'dvd', 'bluray', 'blu-ray', 'bdrip', 'dvdrip', 'webrip', 'web-dl', 'webdl', 'web',
        'h264', 'h265', 'hevc', 'x264', 'x265', 'av1', 'avc',
        'hdtv', 'tv',
        'rip', 'hd', 'sd', 'fhd', 'uhd'
      ];
      
      // Formater et filtrer les magnets
      const allMagnets = response.data.data.magnets.map(magnet => ({
        id: magnet.id,
        filename: magnet.filename || 'Nom inconnu',
        size: magnet.size || 0,
        status: magnet.status || 'Unknown',
        statusCode: magnet.statusCode || 0,
        downloaded: magnet.downloaded || 0,
        uploaded: magnet.uploaded || 0,
        seeders: magnet.seeders || 0,
        downloadSpeed: magnet.downloadSpeed || 0,
        uploadSpeed: magnet.uploadSpeed || 0,
        uploadDate: magnet.uploadDate || 0,
        completionDate: magnet.completionDate || 0
      }));
      
      // Filtrer les magnets
      let filteredMagnets = allMagnets;
      
      if (showAll !== 'true') {
        // Filtrer : garder seulement les vidéos (par extension OU mots-clés vidéo), ceux non utilisés, et ceux qui sont Ready
        filteredMagnets = allMagnets.filter(magnet => {
          const filename = magnet.filename.toLowerCase();
          
          // Vérifier si c'est une vidéo par extension
          const hasVideoExtension = videoExtensions.some(ext => filename.endsWith(ext));
          
          // Vérifier si le nom contient des mots-clés typiques des releases vidéo
          const hasVideoKeywords = videoKeywords.some(keyword => filename.includes(keyword));
          
          // C'est une vidéo si extension OU mots-clés présents
          const isVideo = hasVideoExtension || hasVideoKeywords;
          
          // Vérifier si le magnet est déjà utilisé
          const isUsed = usedAllDebridIds.has(String(magnet.id));
          
          // Vérifier si le magnet est Ready (statusCode === 4)
          const isReady = magnet.statusCode === 4;
          
          return isVideo && !isUsed && isReady;
        });
      } else {
        // Si showAll=true, marquer quand même les magnets utilisés
        filteredMagnets = allMagnets.map(magnet => ({
          ...magnet,
          isUsed: usedAllDebridIds.has(String(magnet.id))
        }));
      }
      
      return res.json({
        success: true,
        magnets: filteredMagnets,
        total: allMagnets.length,
        filtered: filteredMagnets.length,
        hidden: allMagnets.length - filteredMagnets.length
      });
    } else {
      return res.status(400).json({
        success: false,
        error: response.data.error?.message || 'Erreur lors de la récupération des magnets'
      });
    }
  } catch (error) {
    console.error('Erreur lors de la récupération des magnets AllDebrid:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour créer une saison vide
app.post('/api/create-empty-season', async (req, res) => {
  try {
    const { tmdbId, seasonNumber } = req.body;
    
    // Validation
    if (!tmdbId) {
      return res.status(400).json({
        success: false,
        message: 'tmdbId est requis'
      });
    }
    
    if (!seasonNumber || isNaN(parseInt(seasonNumber)) || parseInt(seasonNumber) < 1) {
      return res.status(400).json({
        success: false,
        message: 'seasonNumber est requis et doit être un nombre positif'
      });
    }
    
    const tmdbIdStr = String(tmdbId);
    const seasonNum = parseInt(seasonNumber);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`➕ Création d'une saison vide`);
    console.log(`🎬 TMDB ID: ${tmdbIdStr}`);
    console.log(`📌 Saison: ${seasonNum}`);
    console.log(`${'='.repeat(60)}`);
    
    // Vérifier que c'est une série
    const existingSeries = tmdbToSeriesIndex.get(tmdbIdStr);
    if (!existingSeries || !existingSeries.groups || !existingSeries.groups.includes('Contenu personnalisé')) {
      // Vérifier que c'est bien une série via TMDB en forçant le type série
      try {
        const tvResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbIdStr}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: 'fr-FR'
          },
          timeout: 5000
        });
      } catch (error) {
        return res.status(404).json({
          success: false,
          message: `Série avec l'ID TMDB ${tmdbIdStr} non trouvée`
        });
      }
    }
    
    // Charger la base unifiée
    delete require.cache[require.resolve('./unified_data')];
    const unifiedData = require('./unified_data');
    const unifiedDataCopy = JSON.parse(JSON.stringify(unifiedData));
    
    // Trouver ou créer la série
    let seriesIndex = unifiedDataCopy.series.findIndex(s => String(s.tmdbId) === tmdbIdStr);
    
    let series;
    if (seriesIndex >= 0) {
      series = unifiedDataCopy.series[seriesIndex];
      // S'assurer que la série a le groupe "Contenu personnalisé"
      if (!series.groups) {
        series.groups = [];
      }
      if (!series.groups.includes('Contenu personnalisé')) {
        console.log(`📝 Ajout du groupe "Contenu personnalisé" à la série existante ${series.name}`);
        series.groups.push('Contenu personnalisé');
      }
      // S'assurer que la série a un objet seasons
      if (!series.seasons) {
        series.seasons = {};
      }
    } else {
      // Créer une nouvelle série
      const tmdbMetadata = await getTmdbMetadata(tmdbIdStr);
      if (tmdbMetadata.type !== 'series') {
        return res.status(400).json({
          success: false,
          message: 'Cet endpoint est uniquement pour les séries'
        });
      }
      series = {
        tmdbId: tmdbIdStr,
        name: tmdbMetadata.name,
        year: tmdbMetadata.year || new Date().getFullYear().toString(),
        diffuser: '[]',
        groups: ['Contenu personnalisé'],
        seasons: {}
      };
      unifiedDataCopy.series.push(series);
      seriesIndex = unifiedDataCopy.series.length - 1;
    }
    
    // Créer la saison vide
    const seasonKey = String(seasonNum);
    if (!series.seasons[seasonKey]) {
      series.seasons[seasonKey] = {};
      console.log(`✅ Saison ${seasonNum} créée (vide)`);
    } else {
      console.log(`ℹ️  Saison ${seasonNum} existe déjà`);
    }
    
    // Sauvegarder
    unifiedDataCopy.series[seriesIndex] = series;
    saveUnifiedDataAndReload(unifiedDataCopy);
    
    console.log(`${'='.repeat(60)}`);
    console.log('✅ Saison vide créée avec succès!');
    console.log(`${'='.repeat(60)}\n`);
    
    res.json({
      success: true,
      message: `Saison ${seasonNum} créée (vide). Vous pouvez maintenant ajouter des épisodes.`,
      season: seasonNum
    });
  } catch (error) {
    console.error(`❌ Erreur lors de la création de la saison: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour ajouter plusieurs épisodes avec détection automatique
app.post('/api/add-multiple-episodes', async (req, res) => {
  try {
    const { tmdbId, magnetIds, seasonNumber } = req.body;
    
    // Validation
    if (!tmdbId) {
      return res.status(400).json({
        success: false,
        message: 'tmdbId est requis'
      });
    }
    
    if (!magnetIds || !Array.isArray(magnetIds) || magnetIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'magnetIds est requis et doit être un tableau non vide'
      });
    }
    
    if (!seasonNumber || isNaN(parseInt(seasonNumber)) || parseInt(seasonNumber) < 1) {
      return res.status(400).json({
        success: false,
        message: 'seasonNumber est requis et doit être un nombre positif'
      });
    }
    
    const tmdbIdStr = String(tmdbId);
    const seasonNum = parseInt(seasonNumber);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`➕ Ajout de plusieurs épisodes avec détection automatique`);
    console.log(`🎬 TMDB ID: ${tmdbIdStr}`);
    console.log(`📌 Saison: ${seasonNum}`);
    console.log(`📋 Magnets: ${magnetIds.length}`);
    console.log(`${'='.repeat(60)}`);
    
    // Vérifier que c'est une série
    const existingSeries = tmdbToSeriesIndex.get(tmdbIdStr);
    if (!existingSeries || !existingSeries.groups || !existingSeries.groups.includes('Contenu personnalisé')) {
      try {
        const tvResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbIdStr}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: 'fr-FR'
          },
          timeout: 5000
        });
      } catch (error) {
        return res.status(404).json({
          success: false,
          message: `Série avec l'ID TMDB ${tmdbIdStr} non trouvée`
        });
      }
    }
    
    // Charger la base unifiée
    delete require.cache[require.resolve('./unified_data')];
    const unifiedData = require('./unified_data');
    const unifiedDataCopy = JSON.parse(JSON.stringify(unifiedData));
    
    // Trouver ou créer la série
    let seriesIndex = unifiedDataCopy.series.findIndex(s => String(s.tmdbId) === tmdbIdStr);
    
    let series;
    if (seriesIndex >= 0) {
      series = unifiedDataCopy.series[seriesIndex];
      if (!series.groups) {
        series.groups = [];
      }
      if (!series.groups.includes('Contenu personnalisé')) {
        series.groups.push('Contenu personnalisé');
      }
      if (!series.seasons) {
        series.seasons = {};
      }
    } else {
      const tmdbMetadata = await getTmdbMetadata(tmdbIdStr);
      if (tmdbMetadata.type !== 'series') {
        return res.status(400).json({
          success: false,
          message: 'Cet endpoint est uniquement pour les séries'
        });
      }
      series = {
        tmdbId: tmdbIdStr,
        name: tmdbMetadata.name,
        year: tmdbMetadata.year || new Date().getFullYear().toString(),
        diffuser: '[]',
        groups: ['Contenu personnalisé'],
        seasons: {}
      };
      unifiedDataCopy.series.push(series);
      seriesIndex = unifiedDataCopy.series.length - 1;
    }
    
    // Initialiser la saison si elle n'existe pas
    const seasonKey = String(seasonNum);
    if (!series.seasons[seasonKey]) {
      series.seasons[seasonKey] = {};
    }
    
    // Fonction pour parser le nom de fichier et extraire saison/épisode
    function parseEpisodeInfo(filename) {
      if (!filename) return null;
      
      const patterns = [
        /[Ss](\d+)[Ee](\d+)/,
        /(\d+)[xX](\d+)/,
        /\[(\d+)[xX](\d+)\]/,
        /\((\d+)[xX](\d+)\)/,
        /[Ee]pisode\s*(\d+)/i,
        /[Ee]p\s*(\d+)/i,
        /[Ee](\d+)/,
      ];
      
      for (const pattern of patterns) {
        const match = filename.match(pattern);
        if (match) {
          if (match.length === 3) {
            const season = parseInt(match[1], 10);
            const episode = parseInt(match[2], 10);
            if (season > 0 && episode > 0) {
              return { season, episode };
            }
          } else if (match.length === 2) {
            const episode = parseInt(match[1], 10);
            if (episode > 0) {
              return { season: seasonNum, episode };
            }
          }
        }
      }
      return null;
    }
    
    // Récupérer les fichiers pour chaque magnet et détecter les épisodes
    const episodesToAdd = [];
    const errors = [];
    
    for (const magnetId of magnetIds) {
      try {
        const allDebridData = await getAllDebridMagnetFiles(magnetId);
        
        if (!allDebridData || !allDebridData.files || allDebridData.files.length === 0) {
          errors.push({ magnetId, error: 'Aucun fichier trouvé' });
          continue;
        }
        
        // Prendre le meilleur fichier vidéo (ignore .nfo et autres sidecars)
        const filesList = allDebridData.files || [];
        const mainFileEntry = selectBestVideoFile(filesList);
        if (!mainFileEntry) {
          errors.push({ magnetId, error: 'Aucun fichier vidéo trouvé' });
          continue;
        }
        
        const filename = mainFileEntry.filename;
        const fileId = mainFileEntry.fileId;
        
        // Extraire la qualité depuis le nom de fichier
        const qualityMatch = filename.match(/(\d+p|1080p|720p|480p|2160p|4K|HDR|DV|Atmos|x264|x265|HEVC|WEBRip|WEBdl|BluRay|HDTV)/gi);
        const quality = qualityMatch ? qualityMatch.join(' - ') : null;
        
        // Parser le nom de fichier pour détecter l'épisode
        const episodeInfo = parseEpisodeInfo(filename);
        
        if (episodeInfo && episodeInfo.season === seasonNum) {
          episodesToAdd.push({
            episode: episodeInfo.episode,
            magnetId: magnetId,
            fileId: fileId,
            filename: filename,
            quality: quality
          });
        } else if (episodeInfo) {
          errors.push({ 
            magnetId, 
            filename,
            error: `Détecté comme saison ${episodeInfo.season} épisode ${episodeInfo.episode}, mais vous ajoutez à la saison ${seasonNum}` 
          });
        } else {
          // Si on ne peut pas parser, utiliser l'index + 1
          const nextEpisodeNum = Object.keys(series.seasons[seasonKey]).length + episodesToAdd.length + 1;
          episodesToAdd.push({
            episode: nextEpisodeNum,
            magnetId: magnetId,
            fileId: fileId,
            filename: filename,
            autoDetected: false
          });
        }
      } catch (error) {
        errors.push({ magnetId, error: error.message });
      }
    }
    
    // Ajouter les épisodes détectés
    let addedCount = 0;
    episodesToAdd.forEach(({ episode, fileId, filename, quality }) => {
      const episodeKey = String(episode);
      const existingEpisode = series.seasons[seasonKey][episodeKey];
      
      if (existingEpisode) {
        // Convertir en tableau si ce n'est pas déjà le cas
        let episodeLinks = Array.isArray(existingEpisode) ? existingEpisode : [existingEpisode];
        
        // Normaliser les liens existants en objets {id, quality}
        episodeLinks = episodeLinks.map(link => {
          if (typeof link === 'string') {
            return { id: link, quality: null };
          } else if (link && typeof link === 'object' && link.id) {
            return link;
          }
          return { id: String(link), quality: null };
        });
        
        // Vérifier si ce lien n'existe pas déjà
        const linkExists = episodeLinks.some(link => link.id === fileId);
        if (!linkExists) {
          // Ajouter le nouveau lien
          episodeLinks.push({ id: fileId, quality: quality || null });
          series.seasons[seasonKey][episodeKey] = episodeLinks;
          addedCount++;
          const qualityInfo = quality ? ` [${quality}]` : '';
          console.log(`✅ Épisode ${episode} ajouté${qualityInfo}: ${filename.substring(0, 50)}...`);
        } else {
          console.log(`⚠️  Épisode ${episode} - Lien déjà existant, ignoré: ${filename.substring(0, 50)}...`);
        }
      } else {
        // Nouvel épisode : stocker avec qualité si disponible
        if (quality) {
          series.seasons[seasonKey][episodeKey] = { id: fileId, quality: quality };
        } else {
          series.seasons[seasonKey][episodeKey] = fileId;
        }
        addedCount++;
        const qualityInfo = quality ? ` [${quality}]` : '';
        console.log(`✅ Épisode ${episode} ajouté${qualityInfo}: ${filename.substring(0, 50)}...`);
      }
    });
    
    // Sauvegarder
    unifiedDataCopy.series[seriesIndex] = series;
    saveUnifiedDataAndReload(unifiedDataCopy);
    
    console.log(`${'='.repeat(60)}`);
    console.log(`✅ ${addedCount} épisode(s) ajouté(s) avec succès!`);
    if (errors.length > 0) {
      console.log(`⚠️  ${errors.length} erreur(s) lors du traitement`);
    }
    console.log(`${'='.repeat(60)}\n`);
    
    res.json({
      success: true,
      message: `${addedCount} épisode(s) ajouté(s) avec succès`,
      addedCount: addedCount,
      episodes: episodesToAdd.map(e => ({ episode: e.episode, filename: e.filename })),
      errors: errors
    });
  } catch (error) {
    console.error(`❌ Erreur lors de l'ajout des épisodes: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour ajouter un épisode spécifique ou une saison complète
app.post('/api/add-episode', async (req, res) => {
  try {
    const { tmdbId, allDebridId, seasonNumber, episodeNumber } = req.body;
    
    // Validation
    if (!tmdbId) {
      return res.status(400).json({
        success: false,
        message: 'tmdbId est requis'
      });
    }
    
    if (!allDebridId || typeof allDebridId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'allDebridId est requis et doit être une chaîne de caractères'
      });
    }
    
    if (!seasonNumber || isNaN(parseInt(seasonNumber)) || parseInt(seasonNumber) < 1) {
      return res.status(400).json({
        success: false,
        message: 'seasonNumber est requis et doit être un nombre positif'
      });
    }
    
    const tmdbIdStr = String(tmdbId);
    const seasonNum = parseInt(seasonNumber);
    const episodeNum = episodeNumber ? parseInt(episodeNumber) : null;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`➕ Ajout d'${episodeNum ? 'un épisode' : 'une saison'} manuel`);
    console.log(`📋 AllDebrid ID: ${allDebridId}`);
    console.log(`🎬 TMDB ID: ${tmdbIdStr}`);
    console.log(`📌 Saison: ${seasonNum}${episodeNum ? `, Épisode: ${episodeNum}` : ' (complète)'}`);
    console.log(`${'='.repeat(60)}`);
    
    // Vérifier que c'est une série
    const existingSeries = tmdbToSeriesIndex.get(tmdbIdStr);
    if (!existingSeries || !existingSeries.groups || !existingSeries.groups.includes('Contenu personnalisé')) {
      // Vérifier que c'est bien une série via TMDB en forçant le type série
      let tmdbMetadata;
      try {
        // Essayer directement comme série (pas d'auto-détection)
        const tvResponse = await axios.get(`${TMDB_API_BASE}/tv/${tmdbIdStr}`, {
          params: {
            api_key: TMDB_API_KEY,
            language: 'fr-FR'
          },
          timeout: 5000
        });
        
        tmdbMetadata = {
          type: 'series',
          data: tvResponse.data,
          name: tvResponse.data.name || tvResponse.data.original_name,
          year: tvResponse.data.first_air_date ? tvResponse.data.first_air_date.split('-')[0] : undefined
        };
      } catch (error) {
        // Si ça échoue, essayer avec getTmdbMetadata (auto-détection)
        try {
          tmdbMetadata = await getTmdbMetadata(tmdbIdStr);
          if (tmdbMetadata.type !== 'series') {
            return res.status(400).json({
              success: false,
              message: `L'ID TMDB ${tmdbIdStr} ne correspond pas à une série. Utilisez /api/add-content pour les films.`
            });
          }
        } catch (metaError) {
          return res.status(404).json({
            success: false,
            message: `Série avec l'ID TMDB ${tmdbIdStr} non trouvée`
          });
        }
      }
    }
    
    // Récupérer les fichiers AllDebrid
    console.log('📥 Récupération des fichiers depuis AllDebrid...');
    const allDebridData = await getAllDebridMagnetFiles(allDebridId);
    
    if (!allDebridData || !allDebridData.files || allDebridData.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Aucun fichier trouvé pour ce magnet AllDebrid'
      });
    }
    
    // Charger la base unifiée
    delete require.cache[require.resolve('./unified_data')];
    const unifiedData = require('./unified_data');
    const unifiedDataCopy = JSON.parse(JSON.stringify(unifiedData));
    
    // Trouver ou créer la série
    // D'abord chercher une série existante (avec ou sans groupe "Contenu personnalisé")
    let seriesIndex = unifiedDataCopy.series.findIndex(s => String(s.tmdbId) === tmdbIdStr);
    
    let series;
    if (seriesIndex >= 0) {
      series = unifiedDataCopy.series[seriesIndex];
      // S'assurer que la série a le groupe "Contenu personnalisé"
      if (!series.groups) {
        series.groups = [];
      }
      if (!series.groups.includes('Contenu personnalisé')) {
        console.log(`📝 Ajout du groupe "Contenu personnalisé" à la série existante ${series.name}`);
        series.groups.push('Contenu personnalisé');
      }
      // S'assurer que la série a un objet seasons
      if (!series.seasons) {
        series.seasons = {};
      }
    } else {
      // Créer une nouvelle série
      const tmdbMetadata = await getTmdbMetadata(tmdbIdStr);
      series = {
        tmdbId: tmdbIdStr,
        name: tmdbMetadata.name,
        year: tmdbMetadata.year || new Date().getFullYear().toString(),
        diffuser: '[]',
        groups: ['Contenu personnalisé'],
        seasons: {}
      };
      unifiedDataCopy.series.push(series);
      seriesIndex = unifiedDataCopy.series.length - 1;
    }
    
    // Initialiser la saison si elle n'existe pas
    const seasonKey = String(seasonNum);
    if (!series.seasons[seasonKey]) {
      series.seasons[seasonKey] = {};
    }
    
    // Fonction pour parser le nom de fichier et extraire saison/épisode
    function parseEpisodeInfo(filename) {
      if (!filename) return null;
      
      const patterns = [
        /[Ss](\d+)[Ee](\d+)/,
        /(\d+)[xX](\d+)/,
        /\[(\d+)[xX](\d+)\]/,
        /\((\d+)[xX](\d+)\)/,
        /[Ee]pisode\s*(\d+)/i,
        /[Ee]p\s*(\d+)/i,
        /[Ee](\d+)/,
      ];
      
      for (const pattern of patterns) {
        const match = filename.match(pattern);
        if (match) {
          if (match.length === 3) {
            const season = parseInt(match[1], 10);
            const episode = parseInt(match[2], 10);
            if (season > 0 && episode > 0) {
              return { season, episode };
            }
          } else if (match.length === 2) {
            const episode = parseInt(match[1], 10);
            if (episode > 0) {
              return { season: seasonNum, episode };
            }
          }
        }
      }
      return null;
    }
    
    // Traiter les fichiers
    const filesList = allDebridData.files || [];
    let addedCount = 0;
    
    // Fonction pour extraire la qualité depuis le nom de fichier
    function extractQuality(filename) {
      if (!filename) return null;
      const qualityMatch = filename.match(/(\d+p|1080p|720p|480p|2160p|4K|HDR|DV|Atmos|x264|x265|HEVC|WEBRip|WEBdl|BluRay|HDTV|FR|VOF|VF|MULTI)/gi);
      return qualityMatch ? qualityMatch.join(' - ') : null;
    }
    
    if (episodeNum) {
      // Ajouter un épisode spécifique
      const bestFile = selectBestVideoFile(filesList);
      if (bestFile) {
        const { fileId, filename } = bestFile;
        const quality = extractQuality(filename);
        
        // Stocker avec qualité si disponible
        if (quality) {
          series.seasons[seasonKey][String(episodeNum)] = { id: fileId, quality: quality };
        } else {
          series.seasons[seasonKey][String(episodeNum)] = fileId;
        }
        
        addedCount = 1;
        const qualityInfo = quality ? ` [${quality}]` : '';
        console.log(`✅ Épisode ${episodeNum} de la saison ${seasonNum} ajouté${qualityInfo}`);
      }
    } else {
      // Ajouter toute la saison
      const episodeMeta = {};
      filesList.forEach((file) => {
        const entry = getFileEntry(file);
        if (!entry || shouldSkipEpisodeFile(entry.filename)) return;
        
        const { filename } = entry;
        const episodeInfo = parseEpisodeInfo(filename);
        const quality = extractQuality(filename);
        
        if (episodeInfo && episodeInfo.season === seasonNum) {
          const episodeKey = String(episodeInfo.episode);
          if (!assignEpisodeFile(series.seasons, episodeMeta, seasonKey, episodeKey, entry)) {
            return;
          }

          const storedId = series.seasons[seasonKey][episodeKey];
          if (quality && typeof storedId === 'string') {
            series.seasons[seasonKey][episodeKey] = { id: storedId, quality: quality };
          }
          addedCount++;
        } else if (!episodeInfo) {
          const nextEpisodeNum = Object.keys(series.seasons[seasonKey] || {}).length + 1;
          const episodeKey = String(nextEpisodeNum);
          if (assignEpisodeFile(series.seasons, episodeMeta, seasonKey, episodeKey, entry)) {
            if (quality) {
              series.seasons[seasonKey][episodeKey] = { id: entry.fileId, quality: quality };
            }
            addedCount++;
          }
        }
        // Si le fichier correspond à une autre saison, on l'ignore
      });
      
      console.log(`✅ ${addedCount} épisode(s) ajouté(s) à la saison ${seasonNum}`);
    }
    
    // Sauvegarder
    unifiedDataCopy.series[seriesIndex] = series;
    saveUnifiedDataAndReload(unifiedDataCopy);
    
    console.log(`${'='.repeat(60)}`);
    console.log('✅ Contenu ajouté avec succès!');
    console.log(`${'='.repeat(60)}\n`);
    
    res.json({
      success: true,
      message: episodeNum 
        ? `Épisode ${episodeNum} de la saison ${seasonNum} ajouté avec succès`
        : `${addedCount} épisode(s) ajouté(s) à la saison ${seasonNum}`,
      season: seasonNum,
      episode: episodeNum,
      addedCount: addedCount
    });
  } catch (error) {
    console.error(`❌ Erreur lors de l'ajout de l'épisode: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Démarrage du serveur
// Validation et conversion du PORT
let PORT = 7011; // Valeur par défaut
if (process.env.PORT && process.env.PORT.trim() !== '') {
    const portNum = parseInt(process.env.PORT.trim(), 10);
    if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
        PORT = portNum;
    } else {
        console.warn(`⚠️  PORT invalide dans .env (${process.env.PORT}), utilisation du port par défaut: ${PORT}`);
    }
}
const HOST = (process.env.HOST && process.env.HOST.trim() !== '') ? process.env.HOST.trim() : '0.0.0.0'; // Écouter sur toutes les interfaces pour être accessible à distance

// Fonction de refresh automatique
async function performAutoRefresh() {
  if (refreshInProgress) {
    console.log('⏸️ Refresh automatique ignoré (refresh manuel en cours)');
    return;
  }
  
  refreshInProgress = true;
  
  try {
    console.log('\n🔄 Démarrage du refresh automatique (toutes les 6 heures)...');
    
    const stats = await parseAllRecursively();
    
    console.log(`✅ Refresh automatique terminé: ${stats.filmsCount} films, ${stats.seriesCount} séries, ${stats.episodesCount} épisodes`);
    
    // Reconstruire les index
    const { newTmdbToFilmIndex, newTmdbToSeriesIndex, newCatalogs } = rebuildIndexes();
    tmdbToFilmIndex = newTmdbToFilmIndex;
    tmdbToSeriesIndex = newTmdbToSeriesIndex;
    catalogs = newCatalogs;
    
    // Vider les caches
    imdbToFilmIndex.clear();
    posterCache.clear();
    
    console.log('✅ Index et catalogues reconstruits');
    
    runPostRefreshBackgroundTasks();
  } catch (error) {
    console.error('❌ Erreur lors du refresh automatique:', error.message);
  } finally {
    refreshInProgress = false;
  }
}

// Configurer le refresh automatique toutes les 6 heures (6 * 60 * 60 * 1000 ms)
const AUTO_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6 heures en millisecondes

app.listen(PORT, HOST, () => {

  const serverUrl = BASE_URL || `http://localhost:${PORT}`;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 StremioPasteBin - VOD`);
  console.log(`📍 Serveur: ${HOST}:${PORT}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📋 Manifest: ${serverUrl}/manifest.json`);

  if (FILMS_DATA.length > 0) {
    console.log(`🎬 VOD: ${FILMS_DATA.length} films, ${SERIES_DATA.length} séries`);
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✨ MODE DÉBRIDAGE À LA VOLÉE ACTIVÉ ✨`);
  console.log(`Total de films configurés: ${FILMS_DATA.length}`);
  console.log(`Total de séries configurées: ${SERIES_DATA.length}`);
  console.log(`Total de qualités: ${FILMS_DATA.reduce((sum, f) => sum + f.qualities.length, 0)}`);
  logCustomContentStats('Démarrage');
  console.log(`${'='.repeat(60)}\n`);
  console.log(`📥 Ajoutez cet URL dans Stremio: ${serverUrl}/manifest.json`);
  console.log(`💡 Les index seront construits progressivement lors des premières recherches.`);
  console.log(`🔄 Refresh automatique activé (toutes les 6 heures)\n`);
  
  if (!BASE_URL) {
    console.log(`⚠️  Pour un déploiement distant, définissez BASE_URL dans vos variables d'environnement`);
    console.log(`   Exemple: BASE_URL=https://votre-serveur.com\n`);
  }
  
  // Programmer le premier refresh automatique après 6 heures
  setInterval(() => {
    performAutoRefresh();
  }, AUTO_REFRESH_INTERVAL);
  
  console.log(`⏰ Premier refresh automatique dans 6 heures...\n`);

  // Synchroniser le cache VOD du contenu personnalisé avec les données live
  invalidateCustomContentCatalogCache();
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Erreur: Le port ${PORT} est déjà utilisé.`);
    console.error(`   Vérifiez qu'aucun autre processus n'utilise ce port.`);
    console.error(`   Commandes utiles:`);
    console.error(`   - Trouver le processus: sudo lsof -i :${PORT} ou sudo netstat -tulpn | grep ${PORT}`);
    console.error(`   - Tuer le processus: sudo kill -9 <PID>`);
    process.exit(1);
  } else {
    console.error(`❌ Erreur lors du démarrage du serveur: ${err.message}`);
    process.exit(1);
  }
});
