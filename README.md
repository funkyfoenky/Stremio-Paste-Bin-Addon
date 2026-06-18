# StremioPasteBin

[English](#english) · [Français](#français)

---

<a id="english"></a>

## English

**StremioPasteBin** is a self-hosted [Stremio](https://www.stremio.com/) addon that exposes a VOD catalogue (movies and series). It parses catalogue data from raw pastebin URLs, resolves streams through [AllDebrid](https://alldebrid.com/), and serves per-user addon URLs secured by a unique Stremio token.

The **bilingual web interface** (English / French, language selector on every page) lets administrators manage users, pastebin configuration, catalogue refresh, custom content, and analytics.

### Table of contents

- [Prerequisites](#prerequisites)
- [Main features](#main-features)
- [Installation — server](#installation--server)
- [Installation — Caddy (external HTTPS access)](#installation--caddy-external-https-access)
- [Admin guide](#admin-guide)
- [User guide](#user-guide)
- [Configuration reference](#configuration-reference)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [License](#license)

### Prerequisites

#### Required

| Requirement | Notes |
|-------------|--------|
| **Node.js 18+** | LTS recommended. Required to run the server. |
| **npm** | Comes with Node.js. Used to install dependencies. |
| **AllDebrid account** | Active subscription with an API key. Streams are debrid through AllDebrid. |
| **Paste / raw hosting** | A service that serves catalogue files as plain text (raw URL). The addon appends 8-character paste codes to a configurable base URL. |
| **Stremio client** | Desktop, mobile, or TV app to install and use the addon. |

#### Required on Linux for `npm install`

The `sqlite3` package compiles native bindings. On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential python3
```

#### Recommended for production

| Requirement | Notes |
|-------------|--------|
| **Linux server** | VPS or home server with a public IP or port forwarding. |
| **Domain name** | Point DNS to your server for HTTPS with Caddy. |
| **Caddy** (or another reverse proxy) | Terminates TLS and forwards traffic to the Node.js process. |
| **systemd** | Keeps the addon running after reboot (see `stremio-pastebin.service.example`). |

#### Optional

| Requirement | Notes |
|-------------|--------|
| **TMDB API key** | Improves metadata and posters. A default public key is used if unset (`TMDB_API_KEY` in `.env`). |

### Main features

- **Stremio addon** — Manifest, catalogues, metadata, and streams compatible with Stremio (`com.stremio.stremiopastebin`).
- **Pastebin-driven catalogue** — Recursively parses configured paste codes and builds a unified movie/series database.
- **AllDebrid streaming** — On-demand debrid and proxy streaming with automatic link refresh on expiry.
- **Per-user tokens** — Each user gets a unique Stremio token; streams are authorized per account.
- **Bilingual web panel** — English / French UI with a language dropdown on every page.
- **Custom content** — Manually add movies/series (TMDB ID + AllDebrid link); preserved across catalogue refreshes.
- **Catalogues in Stremio** — Trending lists, provider-based categories (Netflix, Disney+, etc.), and a custom content section when applicable.
- **SQLite VOD cache** — Speeds up catalogue browsing after refresh.

### Installation — server

#### 1. Get the code

```bash
git clone <your-repo-url> stremio-pastebin
cd stremio-pastebin
```

#### 2. Install dependencies

```bash
npm install
```

#### 3. Configure environment

```bash
cp .env.example .env
```

Minimum for local testing:

```env
PORT=7011
HOST=0.0.0.0
SESSION_SECRET=change-me-to-a-long-random-string-at-least-32-chars
NODE_ENV=development
TRUST_PROXY=false
```

For production behind Caddy, also set:

```env
NODE_ENV=production
BASE_URL=https://your-domain.example.com
TRUST_PROXY=1
SESSION_SECRET=<run: openssl rand -hex 32>
```

AllDebrid and pastebin settings can be set in `.env` **or** later in the web UI (stored in `settings.json`).

#### 4. Start the server

```bash
npm start
```

The server listens on `http://0.0.0.0:7011` by default.

#### 5. First access

Open in a browser:

```
http://<server-ip>:7011/
```

Default administrator credentials (when `users.json` is created for the first time):

| Field | Default |
|-------|---------|
| Username | `admin` |
| Password | `admin` |

Override on first database creation with `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`.

> **Security:** Change the admin password immediately via **Admin account** (`/admin-account.html`).

#### 6. Run as a systemd service (optional)

```bash
sudo cp stremio-pastebin.service.example /etc/systemd/system/stremio-pastebin.service
sudo systemctl daemon-reload
sudo systemctl enable --now stremio-pastebin
sudo systemctl status stremio-pastebin
```

Example layout:

- App directory: `/opt/stremio-pastebin`
- Environment file: `/opt/stremio-pastebin/.env`
- Service user: `stremio`

### Installation — Caddy (external HTTPS access)

Caddy provides automatic HTTPS and reverse-proxies requests to the Node.js app on port `7011`.

#### 1. Install Caddy

Follow the [official Caddy installation guide](https://caddyserver.com/docs/install) for your OS.

On Debian/Ubuntu (example):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

#### 2. DNS

Create an **A** (or **AAAA**) record pointing your domain to the server’s public IP, e.g.:

```
stremio-pastebin.example.com  →  203.0.113.10
```

#### 3. Caddyfile

```bash
sudo cp Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
```

Example content:

```caddy
stremio-pastebin.example.com {
    reverse_proxy localhost:7011

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy no-referrer-when-downgrade
    }

    log {
        output file /var/log/caddy/stremio-pastebin.log
    }
}
```

Reload Caddy:

```bash
sudo systemctl reload caddy
```

#### 4. Application environment

```env
BASE_URL=https://stremio-pastebin.example.com
TRUST_PROXY=1
NODE_ENV=production
SESSION_SECRET=<strong-random-secret>
PORT=7011
HOST=0.0.0.0
```

`BASE_URL` ensures Stremio receives correct stream and manifest URLs when the app sits behind the proxy.

#### 5. Firewall

Expose **443** (HTTPS) publicly. Keep **7011** on localhost only if Caddy proxies locally.

```bash
sudo ufw allow 443/tcp
sudo ufw enable
```

#### 6. Verify

- Web UI: `https://stremio-pastebin.example.com/`
- Manifest (with token): `https://stremio-pastebin.example.com/manifest.json?token=YOUR_TOKEN`

### Admin guide

Administrators are redirected to the main menu (`/index.html`) after login. Regular users only see the Stremio setup page.

#### First login

1. Go to `https://your-domain/` or `http://server-ip:7011/`.
2. Sign in with the admin account.
3. If prompted, set a new admin password on **Admin account**.

#### Create a new user

1. Open the main menu → **User management** (`/admin-users.html`).
2. Under **Add a user**, enter username and password.
3. Click **Add**.

Each user automatically receives a unique **Stremio token** (visible in the user list and details). Share the login credentials so they can retrieve their personal addon URL.

#### Configure AllDebrid API key

1. Open **Pastebin & AllDebrid configuration** (`/pastebin-manager.html`).
2. In **General settings**, paste your key in **AllDebrid API key**.
   - Get it from [AllDebrid → My account → API](https://alldebrid.com/account/).
   - Leave the field **empty** when saving to keep the existing key.
3. Click **Save changes**.

Stored in `settings.json`, or set via `ALLDEBRID_API_KEY` in `.env`.

#### Configure pastebin base URL

On the same page:

1. Set **Pastebin base URL (raw)** to the prefix used to fetch raw paste content.
2. The URL **must** end with a trailing slash.

Example: `https://paste.example.com/raw/` — code `Ab12Cd34` is fetched from `https://paste.example.com/raw/Ab12Cd34`

3. Click **Save changes**.

Can also be set with `PASTEBIN_BASE_URL` in `.env`.

#### Add pastebin codes

1. Enter an **8-character alphanumeric** code (e.g. `F8h3sAzM`).
2. Click **Add**.
3. Repeat for all root catalogue pastes (nested pastes are discovered automatically during refresh).
4. Click **Save changes**.

Codes are stored in `pastebin_codes.json`.

#### Refresh the catalogue

1. Open **Refresh catalogue** (`/refresh.html`).
2. Click the refresh button and wait for completion.

The refresh downloads and parses all pastes, updates `unified_data.js`, rebuilds catalogues and the SQLite cache, and **preserves** custom content.

#### Other admin pages

| Page | Purpose |
|------|---------|
| **Add content** | Manually add a movie/series (TMDB + AllDebrid). |
| **Manage content** | View, edit, or delete custom content. |
| **Analytics** | Streams per day and most-watched content. |
| **Reset** | Wipe catalogues, cache, users, codes, and settings (destructive). |

### User guide

Regular users only need the web UI to obtain their addon URL.

#### Log in and get your addon URL

1. Open the server URL in a browser.
2. Sign in with credentials provided by the administrator.
3. You are redirected to **Stremio setup** (`/devices.html`).
4. Copy your **Stremio token** or the full **manifest URL**, e.g.  
   `https://stremio-pastebin.example.com/manifest.json?token=YOUR_TOKEN`
5. Use **Copy full URL** to paste it into Stremio.
6. If the token is compromised, use **Regenerate token** and reinstall the addon.

#### Add the addon in Stremio

1. Open **Stremio**.
2. Go to **Addons** → **Addon Store** → **Add addon manually**.
3. Paste the **full manifest URL** including `?token=...`.
4. Click **Install** / **Add**.

> **Important:** Always use the URL **with** your personal token.

#### Browse and play content

1. In Stremio, open **Discover** or **Addons**.
2. Find catalogues from **StremioPasteBin** (trending, provider categories, custom content).
3. Select a movie or series, then a stream quality to play.

If no catalogues appear, ask your administrator to run a **catalogue refresh**.

### Configuration reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7011` | HTTP port listened by Node.js. |
| `HOST` | `0.0.0.0` | Bind address. |
| `BASE_URL` | *(auto)* | Public URL (required behind HTTPS proxy). |
| `SESSION_SECRET` | — | **Required in production** for session cookies. |
| `NODE_ENV` | — | Set to `production` on a live server. |
| `TRUST_PROXY` | `1` in prod | Number of reverse proxies (`1` for Caddy). Use `false` locally. |
| `ALLDEBRID_API_KEY` | — | Optional if set in web UI. |
| `PASTEBIN_BASE_URL` | — | Optional if set in web UI. |
| `TMDB_API_KEY` | built-in fallback | TMDB metadata. |
| `ADMIN_USERNAME` | `admin` | Only used when creating `users.json`. |
| `ADMIN_PASSWORD` | `admin` | Only used when creating `users.json`. |

#### Runtime data files

| File | Purpose |
|------|---------|
| `users.json` | Users, admin account, Stremio tokens |
| `settings.json` | AllDebrid key and pastebin base URL |
| `pastebin_codes.json` | List of paste codes |
| `unified_data.js` | Parsed catalogue (movies + series) |
| `vod_catalog_cache.db` | SQLite cache for catalogue browsing |

### Project structure

```
├── server.js                 # Main Express server & Stremio endpoints
├── refresh_parser.js         # Pastebin parsing logic
├── user-manager.js           # Authentication & users
├── settings-manager.js       # AllDebrid / pastebin settings
├── db-cache-vod.js           # SQLite catalogue cache
├── unified-data-utils.js     # Catalogue deduplication & custom content
├── public/                   # Web UI (HTML + i18n.js)
├── .env.example              # Environment template
├── Caddyfile.example         # Caddy reverse proxy example
└── stremio-pastebin.service.example  # systemd unit example
```

#### Key URLs

| URL | Access |
|-----|--------|
| `/` | Login page (or redirect if signed in) |
| `/index.html` | Admin main menu |
| `/admin-users.html` | User management |
| `/pastebin-manager.html` | AllDebrid, pastebin URL, codes |
| `/refresh.html` | Catalogue refresh |
| `/devices.html` | User Stremio token & manifest URL |
| `/manifest.json?token=…` | Stremio addon manifest |

### Troubleshooting

| Problem | What to check |
|---------|----------------|
| **403 on manifest or streams** | Token missing, invalid, or regenerated — reinstall addon with the new URL. |
| **Empty catalogues in Stremio** | Run a catalogue refresh; verify pastebin codes and base URL. |
| **Debrid / playback errors** | AllDebrid API key valid; link still available on AllDebrid. |
| **Wrong URLs in Stremio** | Set `BASE_URL` to your public HTTPS domain and `TRUST_PROXY=1`. |
| **`npm install` fails on sqlite3** | Install `build-essential` and `python3` on Linux. |
| **Rate limit / trust proxy error** | Do not set `TRUST_PROXY=true`; use `1` or `false`. |

Logs: console output, or `journalctl -u stremio-pastebin` with systemd.

### License

[MIT](LICENSE) — Copyright (c) 2026 funkyfoenky

---

<a id="français"></a>

## Français

**StremioPasteBin** est un addon [Stremio](https://www.stremio.com/) auto-hébergé qui expose un catalogue VOD (films et séries). Il parse les données catalogue depuis des URL pastebin brutes, résout les flux via [AllDebrid](https://alldebrid.com/), et fournit à chaque utilisateur une URL d'addon sécurisée par un token Stremio unique.

L'**interface web bilingue** (anglais / français, menu déroulant de langue sur chaque page) permet aux administrateurs de gérer les utilisateurs, la configuration pastebin, le refresh du catalogue, le contenu personnalisé et les indicateurs.

### Table des matières

- [Prérequis](#prérequis)
- [Fonctionnalités principales](#fonctionnalités-principales)
- [Installation — serveur](#installation--serveur)
- [Installation — Caddy (accès HTTPS externe)](#installation--caddy-accès-https-externe)
- [Guide administrateur](#guide-administrateur)
- [Guide utilisateur](#guide-utilisateur)
- [Référence de configuration](#référence-de-configuration)
- [Structure du projet](#structure-du-projet)
- [Dépannage](#dépannage)
- [Licence](#licence)

### Prérequis

#### Obligatoire

| Élément | Notes |
|---------|--------|
| **Node.js 18+** | LTS recommandé. Nécessaire pour exécuter le serveur. |
| **npm** | Fourni avec Node.js. Pour installer les dépendances. |
| **Compte AllDebrid** | Abonnement actif avec clé API. Les flux passent par AllDebrid. |
| **Hébergement paste brut** | Service servant les catalogues en texte brut (URL raw). L'addon ajoute des codes de 8 caractères à une URL de base configurable. |
| **Client Stremio** | Application desktop, mobile ou TV pour installer l'addon. |

#### Requis sur Linux pour `npm install`

Le paquet `sqlite3` compile des bindings natifs. Sur Debian/Ubuntu :

```bash
sudo apt update
sudo apt install -y build-essential python3
```

#### Recommandé en production

| Élément | Notes |
|---------|--------|
| **Serveur Linux** | VPS ou serveur domestique avec IP publique ou redirection de port. |
| **Nom de domaine** | Enregistrement DNS pointant vers le serveur pour HTTPS avec Caddy. |
| **Caddy** (ou autre reverse proxy) | Termine le TLS et transmet le trafic au processus Node.js. |
| **systemd** | Maintient l'addon actif après redémarrage (voir `stremio-pastebin.service.example`). |

#### Optionnel

| Élément | Notes |
|---------|--------|
| **Clé API TMDB** | Améliore métadonnées et affiches. Une clé publique par défaut est utilisée si non définie (`TMDB_API_KEY` dans `.env`). |

### Fonctionnalités principales

- **Addon Stremio** — Manifest, catalogues, métadonnées et flux compatibles Stremio (`com.stremio.stremiopastebin`).
- **Catalogue via Pastebin** — Parse récursivement les codes configurés et construit une base films/séries unifiée.
- **Streaming AllDebrid** — Débridage à la demande et proxy avec rafraîchissement automatique des liens expirés.
- **Tokens par utilisateur** — Chaque utilisateur possède un token Stremio unique ; les flux sont autorisés par compte.
- **Interface web bilingue** — UI anglais / français avec menu déroulant sur chaque page.
- **Contenu personnalisé** — Ajout manuel de films/séries (ID TMDB + lien AllDebrid) ; préservé lors des refresh.
- **Catalogues dans Stremio** — Tendances, catégories par diffuseur (Netflix, Disney+, etc.) et section contenu personnalisé.
- **Cache VOD SQLite** — Accélère la navigation dans les catalogues après refresh.

### Installation — serveur

#### 1. Récupérer le code

```bash
git clone <url-de-votre-repo> stremio-pastebin
cd stremio-pastebin
```

#### 2. Installer les dépendances

```bash
npm install
```

#### 3. Configurer l'environnement

```bash
cp .env.example .env
```

Minimum pour tests locaux :

```env
PORT=7011
HOST=0.0.0.0
SESSION_SECRET=changez-moi-par-une-longue-chaine-aleatoire-32-caracteres-min
NODE_ENV=development
TRUST_PROXY=false
```

En production derrière Caddy, ajoutez aussi :

```env
NODE_ENV=production
BASE_URL=https://votre-domaine.example.com
TRUST_PROXY=1
SESSION_SECRET=<exécutez : openssl rand -hex 32>
```

AllDebrid et pastebin peuvent être configurés dans `.env` **ou** via l'interface web (stocké dans `settings.json`).

#### 4. Démarrer le serveur

```bash
npm start
```

Le serveur écoute par défaut sur `http://0.0.0.0:7011`.

#### 5. Premier accès

Ouvrez dans un navigateur :

```
http://<ip-serveur>:7011/
```

Identifiants administrateur par défaut (à la création de `users.json`) :

| Champ | Valeur |
|-------|--------|
| Utilisateur | `admin` |
| Mot de passe | `admin` |

Personnalisable à la création via `ADMIN_USERNAME` et `ADMIN_PASSWORD` dans `.env`.

> **Sécurité :** changez immédiatement le mot de passe admin via **Compte Admin** (`/admin-account.html`).

#### 6. Service systemd (optionnel)

```bash
sudo cp stremio-pastebin.service.example /etc/systemd/system/stremio-pastebin.service
sudo systemctl daemon-reload
sudo systemctl enable --now stremio-pastebin
sudo systemctl status stremio-pastebin
```

Exemple d'arborescence :

- Répertoire applicatif : `/opt/stremio-pastebin`
- Fichier d'environnement : `/opt/stremio-pastebin/.env`
- Utilisateur du service : `stremio`

### Installation — Caddy (accès HTTPS externe)

Caddy fournit le HTTPS automatique et reverse-proxy vers l'application Node.js sur le port `7011`.

#### 1. Installer Caddy

Suivez le [guide d'installation officiel de Caddy](https://caddyserver.com/docs/install).

Sur Debian/Ubuntu (exemple) :

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

#### 2. DNS

Créez un enregistrement **A** (ou **AAAA**) pointant votre domaine vers l'IP publique du serveur, ex. :

```
stremio-pastebin.example.com  →  203.0.113.10
```

#### 3. Caddyfile

```bash
sudo cp Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
```

Exemple de contenu :

```caddy
stremio-pastebin.example.com {
    reverse_proxy localhost:7011

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy no-referrer-when-downgrade
    }

    log {
        output file /var/log/caddy/stremio-pastebin.log
    }
}
```

Rechargez Caddy :

```bash
sudo systemctl reload caddy
```

#### 4. Environnement applicatif

```env
BASE_URL=https://stremio-pastebin.example.com
TRUST_PROXY=1
NODE_ENV=production
SESSION_SECRET=<secret-aleatoire-fort>
PORT=7011
HOST=0.0.0.0
```

`BASE_URL` garantit que Stremio reçoit les bonnes URL de manifest et de flux derrière le proxy.

#### 5. Pare-feu

Exposez le port **443** (HTTPS). Gardez **7011** en écoute locale si Caddy fait le proxy.

```bash
sudo ufw allow 443/tcp
sudo ufw enable
```

#### 6. Vérification

- Interface web : `https://stremio-pastebin.example.com/`
- Manifest (avec token) : `https://stremio-pastebin.example.com/manifest.json?token=VOTRE_TOKEN`

### Guide administrateur

Les administrateurs sont redirigés vers le menu principal (`/index.html`) après connexion. Les utilisateurs classiques voient uniquement la page de configuration Stremio.

#### Première connexion

1. Allez sur `https://votre-domaine/` ou `http://ip-serveur:7011/`.
2. Connectez-vous avec le compte admin.
3. Si demandé, définissez un nouveau mot de passe sur **Compte Admin**.

#### Créer un utilisateur

1. Menu principal → **Gestion Utilisateurs** (`/admin-users.html`).
2. Sous **Ajouter un utilisateur**, saisissez identifiant et mot de passe.
3. Cliquez sur **Ajouter**.

Chaque utilisateur reçoit automatiquement un **token Stremio** unique (visible dans la liste et les détails). Communiquez-lui ses identifiants pour qu'il récupère son URL d'addon.

#### Configurer la clé API AllDebrid

1. Ouvrez **Configuration Pastebin & AllDebrid** (`/pastebin-manager.html`).
2. Dans **Paramètres généraux**, collez votre clé dans **Clé API AllDebrid**.
   - Disponible sur [AllDebrid → Mon compte → API](https://alldebrid.com/account/).
   - Laissez le champ **vide** pour conserver la clé actuelle.
3. Cliquez sur **Enregistrer les modifications**.

Stockée dans `settings.json`, ou via `ALLDEBRID_API_KEY` dans `.env`.

#### Configurer l'URL de base pastebin

Sur la même page :

1. Renseignez **URL de base Pastebin (raw)** — préfixe pour récupérer le contenu brut.
2. L'URL **doit** se terminer par un slash `/`.

Exemple : `https://paste.example.com/raw/` — le code `Ab12Cd34` est récupéré depuis `https://paste.example.com/raw/Ab12Cd34`

3. Cliquez sur **Enregistrer les modifications**.

Également configurable via `PASTEBIN_BASE_URL` dans `.env`.

#### Ajouter des codes pastebin

1. Saisissez un code **alphanumérique de 8 caractères** (ex. `F8h3sAzM`).
2. Cliquez sur **Ajouter**.
3. Répétez pour tous les pastes racine (les pastes imbriqués sont découverts automatiquement au refresh).
4. Cliquez sur **Enregistrer les modifications**.

Codes stockés dans `pastebin_codes.json`.

#### Rafraîchir le catalogue

1. Ouvrez **Refresh Catalogue** (`/refresh.html`).
2. Cliquez sur le bouton de refresh et attendez la fin.

Le refresh télécharge et parse les pastes, met à jour `unified_data.js`, reconstruit les catalogues et le cache SQLite, et **préserve** le contenu personnalisé.

#### Autres pages admin

| Page | Rôle |
|------|------|
| **Ajouter du contenu** | Ajouter manuellement un film/série (TMDB + AllDebrid). |
| **Gérer le contenu** | Voir, modifier ou supprimer le contenu personnalisé. |
| **Indicateurs** | Streams par jour et contenus les plus regardés. |
| **Réinitialisation** | Vider catalogues, cache, utilisateurs, codes et paramètres (destructif). |

#### Changer la langue de l'interface

Utilisez le menu déroulant **Langue / Language** en haut à droite de chaque page. Le choix est mémorisé dans le navigateur.

### Guide utilisateur

Les utilisateurs n'ont besoin que de l'interface web pour obtenir leur URL d'addon.

#### Se connecter et obtenir l'URL de l'addon

1. Ouvrez l'URL du serveur dans un navigateur.
2. Connectez-vous avec les identifiants fournis par l'administrateur.
3. Vous êtes redirigé vers **Configuration Stremio** (`/devices.html`).
4. Copiez votre **token Stremio** ou l'**URL complète du manifest**, ex.  
   `https://stremio-pastebin.example.com/manifest.json?token=VOTRE_TOKEN`
5. Utilisez **Copier l'URL complète** pour l'ajouter dans Stremio.
6. En cas de compromission, utilisez **Régénérer le token** et réinstallez l'addon.

#### Ajouter l'addon dans Stremio

1. Ouvrez **Stremio**.
2. Allez dans **Addons** → **Addon Store** → **Add addon manually**.
3. Collez l'**URL complète du manifest** incluant `?token=...`.
4. Cliquez sur **Add** / **Install**.

> **Important :** utilisez toujours l'URL **avec** votre token personnel.

#### Parcourir et lancer un contenu

1. Dans Stremio, ouvrez **Discover** ou **Addons**.
2. Trouvez les catalogues **StremioPasteBin** (tendances, catégories par diffuseur, contenu personnalisé).
3. Sélectionnez un film ou une série, puis une qualité de flux pour lancer la lecture.

Si aucun catalogue n'apparaît, demandez à l'administrateur d'exécuter un **refresh du catalogue**.

### Référence de configuration

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `7011` | Port HTTP d'écoute de Node.js. |
| `HOST` | `0.0.0.0` | Adresse d'écoute. |
| `BASE_URL` | *(auto)* | URL publique (requise derrière proxy HTTPS). |
| `SESSION_SECRET` | — | **Obligatoire en production** pour les cookies de session. |
| `NODE_ENV` | — | Mettre à `production` sur un serveur live. |
| `TRUST_PROXY` | `1` en prod | Nombre de reverse proxies (`1` pour Caddy). `false` en local. |
| `ALLDEBRID_API_KEY` | — | Optionnel si configuré via l'interface web. |
| `PASTEBIN_BASE_URL` | — | Optionnel si configuré via l'interface web. |
| `TMDB_API_KEY` | clé par défaut | Métadonnées TMDB. |
| `ADMIN_USERNAME` | `admin` | Uniquement à la création de `users.json`. |
| `ADMIN_PASSWORD` | `admin` | Uniquement à la création de `users.json`. |

#### Fichiers de données runtime

| Fichier | Rôle |
|---------|------|
| `users.json` | Utilisateurs, compte admin, tokens Stremio |
| `settings.json` | Clé AllDebrid et URL pastebin |
| `pastebin_codes.json` | Liste des codes pastebin |
| `unified_data.js` | Catalogue parsé (films + séries) |
| `vod_catalog_cache.db` | Cache SQLite pour la navigation catalogue |

### Structure du projet

```
├── server.js                 # Serveur Express principal & endpoints Stremio
├── refresh_parser.js         # Logique de parsing pastebin
├── user-manager.js           # Authentification & utilisateurs
├── settings-manager.js       # Paramètres AllDebrid / pastebin
├── db-cache-vod.js           # Cache catalogue SQLite
├── unified-data-utils.js     # Déduplication & contenu personnalisé
├── public/                   # Interface web (HTML + i18n.js)
├── .env.example              # Modèle d'environnement
├── Caddyfile.example         # Exemple reverse proxy Caddy
└── stremio-pastebin.service.example  # Exemple unité systemd
```

#### URLs principales

| URL | Accès |
|-----|--------|
| `/` | Page de connexion (ou redirection si connecté) |
| `/index.html` | Menu principal admin |
| `/admin-users.html` | Gestion des utilisateurs |
| `/pastebin-manager.html` | AllDebrid, URL pastebin, codes |
| `/refresh.html` | Refresh du catalogue |
| `/devices.html` | Token Stremio & URL manifest utilisateur |
| `/manifest.json?token=…` | Manifest addon Stremio |

### Dépannage

| Problème | Vérifications |
|----------|----------------|
| **403 sur manifest ou flux** | Token manquant, invalide ou régénéré — réinstallez l'addon avec la nouvelle URL. |
| **Catalogues vides dans Stremio** | Lancez un refresh ; vérifiez codes pastebin et URL de base. |
| **Erreurs de débridage / lecture** | Clé AllDebrid valide ; lien encore disponible sur AllDebrid. |
| **Mauvaises URL dans Stremio** | Définissez `BASE_URL` sur votre domaine HTTPS public et `TRUST_PROXY=1`. |
| **`npm install` échoue sur sqlite3** | Installez `build-essential` et `python3` sur Linux. |
| **Erreur rate limit / trust proxy** | N'utilisez pas `TRUST_PROXY=true` ; utilisez `1` ou `false`. |

Logs : sortie console, ou `journalctl -u stremio-pastebin` avec systemd.

### Licence

[MIT](LICENSE) — Copyright (c) 2026 funkyfoenky
