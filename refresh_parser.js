// Module de parsing récursif réutilisable - Base unifiée (films + séries)
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { dedupeUnifiedData, extractCustomContent } = require('./unified-data-utils');
const { extractPasteCodesFromContent, isPasteContainerPage } = require('./pastebin-code-utils');
const {
  parsePasteColumnHeader,
  parseBracketListField,
  filterValidAllDebridIds,
  hasValidAllDebridIds
} = require('./paste-parse-utils');
const settingsManager = require('./settings-manager');

function loadStartCodes() {
  return settingsManager.loadPastebinCodes();
}

function getPastebinBaseUrl() {
  return settingsManager.getPastebinBaseUrl();
}

async function parseAllRecursively() {
  const baseUrl = getPastebinBaseUrl();
  const startCodes = loadStartCodes();

  if (!baseUrl) {
    throw new Error('URL de base pastebin non configurée. Renseignez-la dans l\'interface web.');
  }
  if (startCodes.length === 0) {
    throw new Error('Aucun code pastebin configuré. Ajoutez des codes dans l\'interface web.');
  }

  const visited = new Set();
  const allCodes = new Map();
  const parsedFilms = [];
  const parsedSeries = [];
  const codeHierarchy = []; // Pour stocker la hiérarchie des codes explorés
  
  // Fonction pour récupérer une page
  async function fetchPage(code) {
    if (visited.has(code)) {
      return null;
    }
    
    visited.add(code);
    
    try {
      const url = baseUrl + code;
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      return null;
    }
  }
  
  // Fonction pour parser le contenu
  function parseContent(content) {
    if (!content) return { hasCodes: false, codes: [], data: null };

    const extractedCodes = extractPasteCodesFromContent(content);
    const hasCodes = isPasteContainerPage(content, extractedCodes);

    if (hasCodes && extractedCodes.length > 0) {
      return { hasCodes: true, codes: extractedCodes, data: null };
    }

    return { hasCodes: false, codes: [], data: content };
  }
  
  // Fonction récursive pour explorer
  async function exploreCode(code, depth = 0, parentCode = null) {
    const indent = '  '.repeat(depth);
    const codeInfo = {
      code,
      depth,
      parentCode,
      type: 'unknown',
      subCodes: [],
      dataLines: 0,
      filmsFound: 0,
      seriesFound: 0
    };
    
    console.log(`${indent}🔍 [Niveau ${depth}] Exploration du code: ${code}${parentCode ? ` (parent: ${parentCode})` : ''}`);
    
    const content = await fetchPage(code);
    if (!content) {
      console.log(`${indent}  ❌ Impossible de récupérer le contenu pour ${code}`);
      codeInfo.type = 'error';
      codeHierarchy.push(codeInfo);
      return;
    }
    
    const parsed = parseContent(content);
    
    if (parsed.hasCodes) {
      codeInfo.type = 'container';
      codeInfo.subCodes = parsed.codes;
      console.log(`${indent}  📋 Code ${code} contient ${parsed.codes.length} sous-code(s): ${parsed.codes.join(', ')}`);
      
      const subCodeResults = [];
      for (const subCode of parsed.codes) {
        const subResult = await exploreCode(subCode, depth + 1, code);
        if (subResult) subCodeResults.push(subResult);
      }
      
      // Compter les films et séries trouvés dans les sous-codes
      codeInfo.filmsFound = subCodeResults.reduce((sum, r) => sum + (r.filmsFound || 0), 0);
      codeInfo.seriesFound = subCodeResults.reduce((sum, r) => sum + (r.seriesFound || 0), 0);
      
      codeHierarchy.push(codeInfo);
      return codeInfo;
    } else if (parsed.data) {
      codeInfo.type = 'data';
      const lineCount = parsed.data.split('\n').filter(l => l.trim()).length;
      codeInfo.dataLines = lineCount;
      console.log(`${indent}  📄 Code ${code} contient des données (${lineCount} lignes)`);
      allCodes.set(code, parsed.data);
      
      let filmsInCode = 0;
      let seriesInCode = 0;
      
      const lines = parsed.data.split('\n').filter(line => line.trim() !== '');
      const headerIndex = lines.findIndex(line => line.toUpperCase().startsWith('CAT') || line.startsWith('#'));
      const headerLine = headerIndex >= 0 ? lines[headerIndex] : null;
      const columns = parsePasteColumnHeader(headerLine);
      const dataLines = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines.slice(1);
      const minParts = Math.max(12, columns.urlsIndex + 1);
      
      for (const line of dataLines) {
        const parts = line.split(';');
        
        if (parts.length >= minParts) {
          const category = parts[0];
          const tmdbId = parts[1];
          const title = parts[2];
          const season = parts[3];
          const groupsStr = parts[4] || '[]';
          const diffuser = parts[columns.networkIndex] || '';
          const year = parts[8];
          const qualityStr = parts[columns.resIndex];
          const urlsStr = parts[columns.urlsIndex] || '[]';
          
          const groups = parseBracketListField(groupsStr);
          
          // Traiter les films
          // Note: Certains films ont une valeur dans la colonne "season" qui représente une saga/série de films
          // On considère toujours comme film si category === 'film', même si season n'est pas vide
          if (category === 'film') {
            const qualities = parseBracketListField(qualityStr);
            let allDebridIds = parseBracketListField(urlsStr);
            allDebridIds = filterValidAllDebridIds(allDebridIds);
            
            if (allDebridIds.length > 0 && allDebridIds.length === qualities.length) {
              const existingIndex = parsedFilms.findIndex(f => f.tmdbId === tmdbId);
              const filmEntry = {
                tmdbId,
                name: title,
                year,
                diffuser,
                groups,
                qualities,
                allDebridIds
              };

              if (existingIndex === -1) {
                parsedFilms.push(filmEntry);
                filmsInCode++;
              } else if (!hasValidAllDebridIds(parsedFilms[existingIndex].allDebridIds)) {
                parsedFilms[existingIndex] = filmEntry;
              }
            }
          }
          // Traiter les séries
          else if (category === 'serie' && season && season.trim() !== '') {
            const seasonNum = season.trim();
            
            // Parser les épisodes depuis urlsStr (format: {1:'id1', 2:'id2', ...})
            let episodesMap = {};
            try {
              // Essayer de parser comme JSON
              episodesMap = JSON.parse(urlsStr);
            } catch (e) {
              try {
                // Essayer avec guillemets simples
                episodesMap = JSON.parse(urlsStr.replace(/'/g, '"'));
              } catch (e2) {
                // Parser manuel du format {1:'id1', 2:'id2'}
                const matches = urlsStr.matchAll(/(\d+):\s*['"]?([a-zA-Z0-9_-]+)['"]?/g);
                for (const match of matches) {
                  episodesMap[match[1]] = match[2];
                }
              }
            }
            
            if (Object.keys(episodesMap).length > 0) {
              // Chercher si la série existe déjà
              let series = parsedSeries.find(s => s.tmdbId === tmdbId);
              
              if (!series) {
                series = {
                  tmdbId,
                  name: title,
                  year,
                  diffuser,
                  groups,
                  seasons: {}
                };
                parsedSeries.push(series);
                seriesInCode++; // Compter la nouvelle série
              }
              
              // Ajouter la saison et les épisodes
              if (!series.seasons[seasonNum]) {
                series.seasons[seasonNum] = {};
              }
              
              // Essayer d'extraire la qualité depuis qualityStr (même format que pour les films)
              let quality = null;
              if (qualityStr) {
                try {
                  const qualities = JSON.parse(qualityStr);
                  if (Array.isArray(qualities) && qualities.length > 0) {
                    quality = qualities[0]; // Prendre la première qualité comme référence
                  }
                } catch (e) {
                  try {
                    const qualities = JSON.parse(qualityStr.replace(/'/g, '"'));
                    if (Array.isArray(qualities) && qualities.length > 0) {
                      quality = qualities[0];
                    }
                  } catch (e2) {
                    // Si ce n'est pas un tableau, utiliser directement la valeur
                    const match = qualityStr.match(/\[(.*?)\]/);
                    if (match) {
                      const qualities = match[1].split(',').map(q => q.trim().replace(/^['"]|['"]$/g, '')).filter(q => q);
                      if (qualities.length > 0) {
                        quality = qualities[0];
                      }
                    } else if (qualityStr.trim() !== '' && qualityStr.trim() !== '[]') {
                      quality = qualityStr.trim();
                    }
                  }
                }
              }
              
              for (const [episodeNum, allDebridId] of Object.entries(episodesMap)) {
                if (allDebridId && allDebridId.trim() !== '') {
                  const trimmedId = allDebridId.trim();
                  const existingEpisode = series.seasons[seasonNum][episodeNum];
                  
                  if (existingEpisode) {
                    // L'épisode existe déjà, fusionner les liens
                    let episodeLinks = [];
                    
                    // Normaliser l'épisode existant en tableau
                    if (Array.isArray(existingEpisode)) {
                      episodeLinks = existingEpisode.map(link => {
                        if (typeof link === 'string') {
                          return { id: link, quality: null };
                        } else if (link && typeof link === 'object' && link.id) {
                          return link;
                        }
                        return { id: String(link), quality: null };
                      });
                    } else if (existingEpisode && typeof existingEpisode === 'object' && existingEpisode.id) {
                      episodeLinks = [existingEpisode];
                    } else {
                      episodeLinks = [{ id: String(existingEpisode), quality: null }];
                    }
                    
                    // Vérifier si ce lien n'existe pas déjà
                    const linkExists = episodeLinks.some(link => link.id === trimmedId);
                    if (!linkExists) {
                      // Ajouter le nouveau lien avec qualité si disponible
                      episodeLinks.push({ id: trimmedId, quality: quality });
                      series.seasons[seasonNum][episodeNum] = episodeLinks;
                    }
                  } else {
                    // Nouvel épisode : stocker avec qualité si disponible
                    if (quality) {
                      series.seasons[seasonNum][episodeNum] = { id: trimmedId, quality: quality };
                    } else {
                      series.seasons[seasonNum][episodeNum] = trimmedId;
                    }
                  }
                }
              }
            }
          }
        }
      }
      
      codeInfo.filmsFound = filmsInCode;
      codeInfo.seriesFound = seriesInCode;
      if (filmsInCode > 0 || seriesInCode > 0) {
        console.log(`${indent}  ✅ Code ${code}: ${filmsInCode} film(s), ${seriesInCode} série(s) parsée(s)`);
      }
      codeHierarchy.push(codeInfo);
      return codeInfo;
    }
    
    codeInfo.type = 'empty';
    codeHierarchy.push(codeInfo);
    return codeInfo;
  }
  
  // Charger les codes depuis le fichier ou utiliser les codes par défaut
  const START_CODES = loadStartCodes();
  
  // Explorer tous les codes de départ
  console.log(`🚀 Démarrage du parsing avec ${START_CODES.length} codes principaux...`);
  
  for (const startCode of START_CODES) {
    try {
      console.log(`📥 Exploration du code racine: ${startCode}...`);
      await exploreCode(startCode, 0, null);
    } catch (error) {
      console.error(`❌ Erreur lors de l'exploration du code ${startCode}:`, error.message);
    }
  }
  
  // Préserver le contenu personnalisé existant
  let customFilms = [];
  let customSeries = [];

  const unifiedDataPath = path.join(__dirname, 'unified_data.js');

  try {
    if (fs.existsSync(unifiedDataPath)) {
      delete require.cache[require.resolve('./unified_data')];
      const existingData = require('./unified_data');
      const custom = extractCustomContent(existingData);
      customFilms = custom.films;
      customSeries = custom.series;

      const customEpisodes = customSeries.reduce((sum, s) => {
        return sum + Object.values(s.seasons || {}).reduce((sSum, episodes) => {
          return sSum + Object.keys(episodes || {}).length;
        }, 0);
      }, 0);
      console.log(`💾 ${customFilms.length} film(s) personnalisé(s) préservé(s)`);
      console.log(`💾 ${customSeries.length} série(s) personnalisée(s) préservée(s) (${customEpisodes} épisodes)`);
    }
  } catch (error) {
    console.warn(`⚠️  Erreur lors de la préservation du contenu personnalisé: ${error.message}`);
    console.warn(`   Le contenu personnalisé pourrait être perdu. Continuez avec précaution.`);
  }
  
  // Fusionner le contenu parsé avec le contenu personnalisé
  // Dédupliquer par TMDB ID — le contenu personnalisé est prioritaire en cas de doublon
  const unifiedData = dedupeUnifiedData({
    films: [...customFilms, ...parsedFilms],
    series: [...customSeries, ...parsedSeries]
  });
  unifiedData.timestamp = new Date().toISOString();

  const preserved = extractCustomContent(unifiedData);
  if (customFilms.length > 0 || customSeries.length > 0) {
    if (preserved.films.length < customFilms.length || preserved.series.length < customSeries.length) {
      console.warn(`⚠️  Perte potentielle de contenu personnalisé après fusion (avant: ${customFilms.length}F/${customSeries.length}S, après: ${preserved.films.length}F/${preserved.series.length}S)`);
    } else {
      console.log(`✅ Contenu personnalisé conservé après fusion (${preserved.films.length} film(s), ${preserved.series.length} série(s))`);
    }
  }
  
  const output = `// Base de données unifiée (films + séries)\n// Généré le: ${new Date().toISOString()}\nmodule.exports = ${JSON.stringify(unifiedData, null, 2)};\n`;
  fs.writeFileSync(unifiedDataPath, output, 'utf-8');
  
  // Fichiers séparés alignés sur la base unifiée (fallback au démarrage)
  const filmsOutput = `exports.FILMS_DATA = ${JSON.stringify(unifiedData.films, null, 2)};`;
  fs.writeFileSync(path.join(__dirname, 'films_data.js'), filmsOutput, 'utf-8');
  
  const seriesOutput = `exports.SERIES_DATA = ${JSON.stringify(unifiedData.series, null, 2)};`;
  fs.writeFileSync(path.join(__dirname, 'series_data.js'), seriesOutput, 'utf-8');
  
  const totalEpisodes = parsedSeries.reduce((sum, s) => {
    return sum + Object.values(s.seasons || {}).reduce((sSum, episodes) => {
      return sSum + Object.keys(episodes || {}).length;
    }, 0);
  }, 0);
  
  console.log(`\n✅ Parsing terminé:`);
  console.log(`   - ${parsedFilms.length} films`);
  console.log(`   - ${parsedSeries.length} séries`);
  console.log(`   - ${totalEpisodes} épisodes`);
  console.log(`   - ${visited.size} codes visités`);
  
  console.log(`\n📊 Hiérarchie des codes explorés:`);
  function printHierarchy(codes, depth = 0) {
    for (const codeInfo of codes) {
      if (codeInfo.depth === depth) {
        const indent = '  '.repeat(depth);
        let status = '';
        if (codeInfo.type === 'container') {
          status = `→ ${codeInfo.subCodes.length} sous-code(s)`;
          if (codeInfo.filmsFound > 0 || codeInfo.seriesFound > 0) {
            status += ` (${codeInfo.filmsFound}F/${codeInfo.seriesFound}S)`;
          }
        } else if (codeInfo.type === 'data') {
          status = `📄 ${codeInfo.dataLines} lignes`;
          if (codeInfo.filmsFound > 0 || codeInfo.seriesFound > 0) {
            status += ` → ${codeInfo.filmsFound}F/${codeInfo.seriesFound}S`;
          }
        } else if (codeInfo.type === 'error') {
          status = '❌ Erreur';
        } else {
          status = '⚠️ Vide';
        }
        console.log(`${indent}${codeInfo.code} ${status}`);
        
        // Afficher les sous-codes
        const children = codes.filter(c => c.parentCode === codeInfo.code);
        if (children.length > 0) {
          printHierarchy(children, depth + 1);
        }
      }
    }
  }
  
  // Afficher la hiérarchie par code racine
  for (const startCode of START_CODES) {
    const rootInfo = codeHierarchy.find(c => c.code === startCode);
    if (rootInfo) {
      console.log(`\n🌳 Arborescence pour ${startCode}:`);
      
      // Fonction pour trouver tous les descendants d'un code
      function getDescendants(parentCode) {
        const descendants = codeHierarchy.filter(c => c.parentCode === parentCode);
        return descendants.concat(...descendants.map(d => getDescendants(d.code)));
      }
      
      // Obtenir tous les codes à afficher (le code racine + ses descendants)
      const codesToShow = [rootInfo, ...getDescendants(startCode)];
      printHierarchy(codesToShow, rootInfo.depth);
    } else {
      console.log(`\n⚠️ Code ${startCode} non trouvé dans la hiérarchie`);
    }
  }
  
  // Vérifier que les fichiers sont bien créés
  try {
    if (parsedFilms.length > 0 || parsedSeries.length > 0) {
      console.log(`💾 Sauvegarde des fichiers...`);
      // Les fichiers sont déjà sauvegardés plus haut, on vérifie juste qu'ils existent
      const unifiedExists = require('fs').existsSync('unified_data.js');
      const filmsExists = require('fs').existsSync('films_data.js');
      const seriesExists = require('fs').existsSync('series_data.js');
      console.log(`   - unified_data.js: ${unifiedExists ? '✅' : '❌'}`);
      console.log(`   - films_data.js: ${filmsExists ? '✅' : '❌'}`);
      console.log(`   - series_data.js: ${seriesExists ? '✅' : '❌'}`);
    }
  } catch (e) {
    console.error(`⚠️ Erreur lors de la vérification des fichiers: ${e.message}`);
  }
  
  const result = {
    filmsCount: parsedFilms.length,
    seriesCount: parsedSeries.length,
    episodesCount: totalEpisodes,
    codesVisited: visited.size
  };
  
  console.log(`\n📤 Résultat retourné:`, result);
  return result;
}

module.exports = { parseAllRecursively };

// Permettre l'exécution directe du fichier
if (require.main === module) {
  console.log('🚀 Exécution directe du parser...\n');
  parseAllRecursively()
    .then(result => {
      console.log('\n✅ Parsing terminé avec succès!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Erreur lors du parsing:', error);
      process.exit(1);
    });
}
