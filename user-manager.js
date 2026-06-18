const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_DB_PATH = path.join(__dirname, 'users.json');

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(
    String(password),
    salt,
    SCRYPT_KEYLEN,
    { cost: SCRYPT_COST, blockSize: SCRYPT_BLOCK_SIZE, parallelization: SCRYPT_PARALLELIZATION }
  );
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

function verifyPassword(stored, password) {
  if (!stored) return false;

  // Legacy: mot de passe stocké en clair
  if (typeof stored === 'string' && !stored.startsWith('scrypt$')) {
    return stored === password;
  }

  if (typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  const saltB64 = parts[4];
  const hashB64 = parts[5];

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  const actual = crypto.scryptSync(
    String(password),
    salt,
    expected.length,
    { cost, blockSize, parallelization }
  );

  return crypto.timingSafeEqual(expected, actual);
}

// Structure par défaut de la base de données
const DEFAULT_DB = {
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: hashPassword(process.env.ADMIN_PASSWORD || 'admin'),
    role: 'admin',
    mustChangePassword: false
  },
  users: {}
};

function isDefaultAdminCredentials(db) {
  if (!db?.admin) return false;
  const username = db.admin.username;
  const stored = db.admin.passwordHash ?? db.admin.password;
  return username === 'admin' && stored === 'admin';
}

function stripTrackingFields(db) {
  let changed = false;
  if (!db || typeof db !== 'object') return { db, changed };

  if (db.admin && typeof db.admin === 'object') {
    if ('lastLoginIp' in db.admin) {
      delete db.admin.lastLoginIp;
      changed = true;
    }
    if ('activity' in db.admin) {
      delete db.admin.activity;
      changed = true;
    }
  }

  if (db.users && typeof db.users === 'object') {
    for (const username of Object.keys(db.users)) {
      const user = db.users[username];
      if (!user || typeof user !== 'object') continue;
      if ('lastLoginIp' in user) {
        delete user.lastLoginIp;
        changed = true;
      }
      if ('activity' in user) {
        delete user.activity;
        changed = true;
      }
    }
  }

  return { db, changed };
}

function stripLegacyDevices(db) {
  let changed = false;
  if (!db || typeof db !== 'object') return { db, changed };

  if (db.users && typeof db.users === 'object') {
    for (const username of Object.keys(db.users)) {
      const user = db.users[username];
      if (!user || typeof user !== 'object') continue;
      if ('devices' in user) {
        delete user.devices;
        changed = true;
      }
    }
  }

  return { db, changed };
}

function pruneDailyViews(db) {
  let changed = false;
  if (!db || typeof db !== 'object') return { db, changed };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAILY_VIEWS_RETENTION_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  if (db.users && typeof db.users === 'object') {
    for (const username of Object.keys(db.users)) {
      const user = db.users[username];
      if (!user || typeof user !== 'object') continue;
      if (!user.dailyViews || typeof user.dailyViews !== 'object') continue;

      const keys = Object.keys(user.dailyViews);
      for (const date of keys) {
        if (date < cutoffKey) {
          delete user.dailyViews[date];
          changed = true;
        }
      }
      if (Object.keys(user.dailyViews).length === 0) {
        delete user.dailyViews;
        changed = true;
      }
    }
  }

  return { db, changed };
}

function migratePasswordsToHashes(db) {
  let changed = false;
  if (!db || typeof db !== 'object') return { db, changed };

  if (db.admin) {
    if (db.admin.password && !db.admin.passwordHash) {
      db.admin.passwordHash = hashPassword(db.admin.password);
      delete db.admin.password;
      changed = true;
    }

    if (db.admin.passwordHash && db.admin.password) {
      delete db.admin.password;
      changed = true;
    }

    if (typeof db.admin.mustChangePassword !== 'boolean') {
      db.admin.mustChangePassword = isDefaultAdminCredentials(db);
      changed = true;
    }
  }

  if (db.users && typeof db.users === 'object') {
    for (const username of Object.keys(db.users)) {
      const user = db.users[username];
      if (!user) continue;
      if (user.password && !user.passwordHash) {
        user.passwordHash = hashPassword(user.password);
        delete user.password;
        changed = true;
      }
      if (user.passwordHash && user.password) {
        delete user.password;
        changed = true;
      }
    }
  }

  return { db, changed };
}

// Charger la base de données
function loadDB() {
  try {
    if (fs.existsSync(USERS_DB_PATH)) {
      const data = fs.readFileSync(USERS_DB_PATH, 'utf8');
      const parsed = JSON.parse(data);
      const migratedPasswords = migratePasswordsToHashes(parsed);
      const migratedPrivacy = stripTrackingFields(migratedPasswords.db);
      const migratedDevices = stripLegacyDevices(migratedPrivacy.db);
      const migratedDailyViews = pruneDailyViews(migratedDevices.db);
      const didChange = migratedPasswords.changed || migratedPrivacy.changed || migratedDevices.changed || migratedDailyViews.changed;
      if (didChange) saveDB(migratedDailyViews.db);
      return migratedDailyViews.db;
    }
  } catch (error) {
    console.error('Erreur lors du chargement de la base de données:', error.message);
  }
  // Créer la base de données par défaut
  saveDB(DEFAULT_DB);
  return DEFAULT_DB;
}

// Sauvegarder la base de données
function saveDB(db) {
  try {
    fs.writeFileSync(USERS_DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Erreur lors de la sauvegarde de la base de données:', error.message);
    return false;
  }
}

// Obtenir la base de données
function getDB() {
  return loadDB();
}

// Vérifier les identifiants et enregistrer l'activité
function authenticate(username, password, ip = null) {
  const db = loadDB();
  
  // Vérifier l'admin
  if (db.admin && db.admin.username === username && verifyPassword(db.admin.passwordHash ?? db.admin.password, password)) {
    db.admin.lastLogin = new Date().toISOString();
    // Migration à la volée si nécessaire (ancien format en clair)
    if (db.admin.password && !db.admin.passwordHash) {
      db.admin.passwordHash = hashPassword(db.admin.password);
      delete db.admin.password;
    }
    // Forcer le changement si identifiants par défaut
    if (typeof db.admin.mustChangePassword !== 'boolean') {
      db.admin.mustChangePassword = isDefaultAdminCredentials(db);
    }
    saveDB(db);
    return { success: true, user: { username: db.admin.username, role: 'admin' }, mustChangePassword: !!db.admin.mustChangePassword };
  }
  
  // Vérifier les utilisateurs
  if (db.users[username] && verifyPassword(db.users[username].passwordHash ?? db.users[username].password, password)) {
    db.users[username].lastLogin = new Date().toISOString();
    // Migration à la volée si nécessaire (ancien format en clair)
    if (db.users[username].password && !db.users[username].passwordHash) {
      db.users[username].passwordHash = hashPassword(db.users[username].password);
      delete db.users[username].password;
    }
    saveDB(db);
    return { success: true, user: { username, role: 'user' } };
  }
  
  return { success: false, error: 'Identifiants invalides' };
}

// Créer un nouvel utilisateur
function createUser(username, password) {
  const db = loadDB();
  
  if (db.users[username]) {
    return { success: false, error: 'Utilisateur déjà existant' };
  }
  
  // Générer un token unique pour Stremio
  const stremioToken = crypto.randomBytes(16).toString('hex');
  
  db.users[username] = {
    passwordHash: hashPassword(password),
    stremioToken: stremioToken,
    createdAt: new Date().toISOString(),
    lastLogin: null,
    dailyViews: {} // { "YYYY-MM-DD": ["movie:tt123", "series:tt456:1:2"], ... } — un contenu par jour compte 1
  };
  
  if (saveDB(db)) {
    return { success: true };
  }
  
  return { success: false, error: 'Erreur lors de la création de l\'utilisateur' };
}

const DAILY_VIEWS_RETENTION_DAYS = 31;

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Enregistrer une utilisation (lecture film ou épisode) : 1 par contenu unique par jour, quel que soit le lien
function recordContentView(username, contentId) {
  if (!username || !contentId) return;
  const db = loadDB();
  if (!db.users[username]) return;
  const user = db.users[username];
  if (!user.dailyViews) user.dailyViews = {};
  const today = getTodayKey();
  if (!user.dailyViews[today]) user.dailyViews[today] = [];
  if (user.dailyViews[today].indexOf(contentId) === -1) {
    user.dailyViews[today].push(contentId);
  }
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAILY_VIEWS_RETENTION_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  Object.keys(user.dailyViews).forEach(date => {
    if (date < cutoffKey) delete user.dailyViews[date];
  });
  saveDB(db);
}

function getUsageToday(user) {
  const dailyViews = user.dailyViews || {};
  const today = getTodayKey();
  const list = dailyViews[today];
  return Array.isArray(list) ? list.length : 0;
}

// Obtenir tous les utilisateurs avec leurs informations (admin uniquement)
function getAllUsers() {
  const db = loadDB();
  return Object.keys(db.users).map(username => {
    const user = db.users[username];
    if (!user.stremioToken) {
      const newToken = crypto.randomBytes(16).toString('hex');
      user.stremioToken = newToken;
      saveDB(db);
    }
    return {
      username,
      stremioToken: user.stremioToken || null,
      createdAt: user.createdAt || null,
      lastLogin: user.lastLogin || null,
      usageToday: getUsageToday(user)
    };
  });
}

// Obtenir un utilisateur par son token Stremio
function getUserByStremioToken(token) {
  const db = loadDB();
  
  for (const username in db.users) {
    if (db.users[username].stremioToken === token) {
      return { username, user: db.users[username] };
    }
  }
  
  return null;
}

// Enregistrer l'activité Stremio (connexion via token)
function recordStremioActivity(username, ip = null) {
  const db = loadDB();
  
  // Vérifier si c'est l'admin (l'admin n'a pas de token Stremio normalement)
  if (db.admin && db.admin.username === username) {
    db.admin.lastLogin = new Date().toISOString();
    saveDB(db);
    return true;
  }
  
  // Enregistrer l'activité utilisateur
  if (db.users[username]) {
    db.users[username].lastLogin = new Date().toISOString();
    saveDB(db);
    return true;
  }
  
  return false;
}

// Régénérer le token Stremio d'un utilisateur
function regenerateStremioToken(username) {
  const db = loadDB();
  
  if (!db.users[username]) {
    return { success: false, error: 'Utilisateur non trouvé' };
  }
  
  const newToken = crypto.randomBytes(16).toString('hex');
  db.users[username].stremioToken = newToken;
  
  if (saveDB(db)) {
    return { success: true, token: newToken };
  }
  
  return { success: false, error: 'Erreur lors de la régénération du token' };
}

// Obtenir les détails complets d'un utilisateur
function getUserDetails(username) {
  const db = loadDB();
  
  if (!db.users[username]) {
    return null;
  }
  
  const user = db.users[username];
  
  // Générer un token si l'utilisateur n'en a pas (migration pour utilisateurs existants)
  if (!user.stremioToken) {
    const newToken = crypto.randomBytes(16).toString('hex');
    user.stremioToken = newToken;
    saveDB(db);
  }
  
  return {
    username,
    stremioToken: user.stremioToken || null,
    createdAt: user.createdAt || null,
    lastLogin: user.lastLogin || null,
    usageToday: getUsageToday(user)
  };
}

// Supprimer un utilisateur
function deleteUser(username) {
  const db = loadDB();
  
  if (!db.users[username]) {
    return { success: false, error: 'Utilisateur non trouvé' };
  }
  
  delete db.users[username];
  
  if (saveDB(db)) {
    return { success: true };
  }
  
  return { success: false, error: 'Erreur lors de la suppression de l\'utilisateur' };
}

// Modifier un utilisateur (changer le mot de passe)
function updateUser(username, newPassword) {
  const db = loadDB();
  
  if (!db.users[username]) {
    return { success: false, error: 'Utilisateur non trouvé' };
  }
  
  if (newPassword) {
    db.users[username].passwordHash = hashPassword(newPassword);
    delete db.users[username].password;
  }
  
  if (saveDB(db)) {
    return { success: true };
  }
  
  return { success: false, error: 'Erreur lors de la modification de l\'utilisateur' };
}

function getAdminInfo() {
  const db = loadDB();
  if (!db.admin) return { username: 'admin', mustChangePassword: true };
  return { username: db.admin.username, mustChangePassword: !!db.admin.mustChangePassword };
}

function updateAdminAccount({ currentPassword, newUsername, newPassword }) {
  const db = loadDB();
  if (!db.admin) return { success: false, error: 'Admin non initialisé' };

  const ok = verifyPassword(db.admin.passwordHash ?? db.admin.password, currentPassword);
  if (!ok) return { success: false, error: 'Mot de passe actuel incorrect' };

  let changed = false;

  if (newUsername && typeof newUsername === 'string' && newUsername.trim()) {
    db.admin.username = newUsername.trim();
    changed = true;
  }

  if (newPassword && typeof newPassword === 'string' && newPassword.length >= 8) {
    db.admin.passwordHash = hashPassword(newPassword);
    delete db.admin.password;
    db.admin.mustChangePassword = false;
    changed = true;
  } else if (newPassword) {
    return { success: false, error: 'Le nouveau mot de passe doit contenir au moins 8 caractères' };
  }

  if (!changed) {
    return { success: false, error: 'Aucune modification demandée' };
  }

  if (saveDB(db)) {
    return { success: true, admin: { username: db.admin.username, mustChangePassword: !!db.admin.mustChangePassword } };
  }
  return { success: false, error: 'Erreur lors de la sauvegarde' };
}

function resetToDefaultAdmin() {
  const db = {
    admin: {
      username: process.env.ADMIN_USERNAME || 'admin',
      passwordHash: hashPassword(process.env.ADMIN_PASSWORD || 'admin'),
      role: 'admin',
      mustChangePassword: false
    },
    users: {}
  };
  saveDB(db);
  return db;
}

// Charger une fois au démarrage pour appliquer les migrations (hash, nettoyage IP, etc.)
loadDB();

module.exports = {
  authenticate,
  createUser,
  getAllUsers,
  getUserDetails,
  getUserByStremioToken,
  regenerateStremioToken,
  deleteUser,
  updateUser,
  recordStremioActivity,
  recordContentView,
  getDB,
  getAdminInfo,
  updateAdminAccount,
  resetToDefaultAdmin
};

