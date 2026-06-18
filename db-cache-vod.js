const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'vod_catalog_cache.db');

// Initialiser la base de données
function initDatabase() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('✗ Erreur lors de l\'ouverture de la base de données VOD:', err);
                reject(err);
                return;
            }
            
            // Créer la table si elle n'existe pas
            db.run(`
                CREATE TABLE IF NOT EXISTS catalog_cache (
                    catalog_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    tmdb_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    poster_url TEXT,
                    backdrop_url TEXT,
                    year TEXT,
                    last_updated INTEGER NOT NULL,
                    PRIMARY KEY (catalog_id, type, tmdb_id)
                )
            `, (err) => {
                if (err) {
                    console.error('✗ Erreur lors de la création de la table catalog_cache:', err);
                    reject(err);
                } else {
                    // Créer des index pour accélérer les recherches
                    db.run(`
                        CREATE INDEX IF NOT EXISTS idx_catalog_id ON catalog_cache(catalog_id, type)
                    `, (err) => {
                        if (err) {
                            console.error('✗ Erreur lors de la création de l\'index:', err);
                            reject(err);
                        } else {
                            resolve(db);
                        }
                    });
                }
            });
        });
    });
}

// Sauvegarder un item de catalogue dans le cache
function saveCatalogItem(catalogId, type, tmdbId, name, posterUrl, backdropUrl, year) {
    return new Promise((resolve, reject) => {
        initDatabase().then(db => {
            const now = Date.now();
            
            db.run(`
                INSERT OR REPLACE INTO catalog_cache 
                (catalog_id, type, tmdb_id, name, poster_url, backdrop_url, year, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [catalogId, type, tmdbId, name, posterUrl, backdropUrl, year || null, now], (err) => {
                if (err) {
                    console.error(`✗ Erreur lors de la sauvegarde de l'item ${catalogId}:${type}:${tmdbId}:`, err);
                    reject(err);
                } else {
                    resolve();
                }
                db.close();
            });
        }).catch(reject);
    });
}

// Récupérer tous les items d'un catalogue
function getCatalogItems(catalogId, type) {
    return new Promise((resolve, reject) => {
        initDatabase().then(db => {
            db.all(`
                SELECT tmdb_id, name, poster_url, backdrop_url, year
                FROM catalog_cache
                WHERE catalog_id = ? AND type = ?
                ORDER BY name ASC
            `, [catalogId, type], (err, rows) => {
                if (err) {
                    console.error(`✗ Erreur lors de la récupération du catalogue ${catalogId}:`, err);
                    reject(err);
                } else {
                    const items = rows.map(row => ({
                        tmdbId: row.tmdb_id,
                        name: row.name,
                        poster: row.poster_url || undefined,
                        backdrop: row.backdrop_url || undefined,
                        year: row.year || undefined
                    }));
                    resolve(items);
                }
                db.close();
            });
        }).catch(reject);
    });
}

// Vider un catalogue spécifique (lors du refresh)
function clearCatalog(catalogId, type) {
    return new Promise((resolve, reject) => {
        initDatabase().then(db => {
            db.run(`
                DELETE FROM catalog_cache
                WHERE catalog_id = ? AND type = ?
            `, [catalogId, type], (err) => {
                if (err) {
                    console.error(`✗ Erreur lors de la suppression du catalogue ${catalogId}:`, err);
                    reject(err);
                } else {
                    resolve();
                }
                db.close();
            });
        }).catch(reject);
    });
}

// Vider tous les catalogues (lors du refresh complet)
function clearAllCatalogs() {
    return new Promise((resolve, reject) => {
        initDatabase().then(db => {
            db.run(`
                DELETE FROM catalog_cache
            `, [], (err) => {
                if (err) {
                    console.error('✗ Erreur lors de la suppression de tous les catalogues:', err);
                    reject(err);
                } else {
                    resolve();
                }
                db.close();
            });
        }).catch(reject);
    });
}

function saveCatalogItemsBulk(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return Promise.resolve(0);
    }

    return new Promise((resolve, reject) => {
        initDatabase().then(db => {
            const now = Date.now();
            db.serialize(() => {
                db.run('BEGIN TRANSACTION');
                const stmt = db.prepare(`
                    INSERT OR REPLACE INTO catalog_cache
                    (catalog_id, type, tmdb_id, name, poster_url, backdrop_url, year, last_updated)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const item of items) {
                    stmt.run([
                        item.catalogId,
                        item.type,
                        item.tmdbId,
                        item.name,
                        item.posterUrl || null,
                        item.backdropUrl || null,
                        item.year || null,
                        now
                    ]);
                }

                stmt.finalize((err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        db.close();
                        reject(err);
                        return;
                    }
                    db.run('COMMIT', (commitErr) => {
                        db.close();
                        if (commitErr) reject(commitErr);
                        else resolve(items.length);
                    });
                });
            });
        }).catch(reject);
    });
}

module.exports = {
    initDatabase,
    saveCatalogItem,
    saveCatalogItemsBulk,
    getCatalogItems,
    clearCatalog,
    clearAllCatalogs
};

