# StremioPasteBin

**StremioPasteBin** is a self-hosted [Stremio](https://www.stremio.com/) addon that exposes a VOD catalogue (movies and series). It parses catalogue data from raw pastebin URLs, resolves streams through [AllDebrid](https://alldebrid.com/), and serves per-user addon URLs secured by a unique Stremio token.

The web interface (French UI) lets administrators manage users, pastebin configuration, catalogue refresh, custom content, and analytics.

---

## Table of contents

- [Prerequisites](#prerequisites)
- [Main features](#main-features)
- [Installation — server](#installation--server)
- [Installation — Caddy (external HTTPS access)](#installation--caddy-external-https-access)
- [Admin guide](#admin-guide)
  - [First login](#first-login)
  - [Create a new user](#create-a-new-user)
  - [Configure AllDebrid API key](#configure-alldebrid-api-key)
  - [Configure pastebin base URL](#configure-pastebin-base-url)
  - [Add pastebin codes](#add-pastebin-codes)
  - [Refresh the catalogue](#refresh-the-catalogue)
- [User guide](#user-guide)
  - [Log in and get your addon URL](#log-in-and-get-your-addon-url)
  - [Add the addon in Stremio](#add-the-addon-in-stremio)
  - [Browse and play content](#browse-and-play-content)
- [Configuration reference](#configuration-reference)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Prerequisites

### Required

| Requirement | Notes |
|-------------|--------|
| **Node.js 18+** | LTS recommended. Required to run the server. |
| **npm** | Comes with Node.js. Used to install dependencies. |
| **AllDebrid account** | Active subscription with an API key. Streams are debrid through AllDebrid. |
| **Paste / raw hosting** | A service that serves catalogue files as plain text (raw URL). The addon appends 8-character paste codes to a configurable base URL. |
| **Stremio client** | Desktop, mobile, or TV app to install and use the addon. |

### Required on Linux for `npm install`

The `sqlite3` package compiles native bindings. On Debian/Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential python3
```

### Recommended for production

| Requirement | Notes |
|-------------|--------|
| **Linux server** | VPS or home server with a public IP or port forwarding. |
| **Domain name** | Point DNS to your server for HTTPS with Caddy. |
| **Caddy** (or another reverse proxy) | Terminates TLS and forwards traffic to the Node.js process. |
| **systemd** | Keeps the addon running after reboot (see `stremio-pastebin.service.example`). |

### Optional

| Requirement | Notes |
|-------------|--------|
| **TMDB API key** | Improves metadata and posters. A default public key is used if unset (`TMDB_API_KEY` in `.env`). |

---

## Main features

- **Stremio addon** — Manifest, catalogues, metadata, and streams compatible with Stremio (`com.stremio.stremiopastebin`).
- **Pastebin-driven catalogue** — Recursively parses configured paste codes and builds a unified movie/series database.
- **AllDebrid streaming** — On-demand debrid and proxy streaming with automatic link refresh on expiry.
- **Per-user tokens** — Each user gets a unique Stremio token; streams are authorized per account.
- **Web admin panel** — User management, pastebin/AllDebrid settings, catalogue refresh, custom content, analytics, and full reset.
- **Custom content** — Manually add movies/series (TMDB ID + AllDebrid link); preserved across catalogue refreshes.
- **Catalogues in Stremio** — Trending lists, provider-based categories (Netflix, Disney+, etc.), and a “Contenu personnalisé” section when applicable.
- **SQLite VOD cache** — Speeds up catalogue browsing after refresh.

---

## Installation — server

### 1. Get the code

```bash
git clone <your-repo-url> stremio-pastebin
cd stremio-pastebin
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

Copy the example file and edit it:

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

AllDebrid and pastebin settings can be set in `.env` **or** later in the web UI (web UI values are stored in `settings.json`).

### 4. Start the server

```bash
npm start
```

The server listens on `http://0.0.0.0:7011` by default.

### 5. First access

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

> **Security:** Change the admin password immediately via **Compte Admin** (`/admin-account.html`).

### 6. Run as a systemd service (optional)

```bash
# Adapt paths and user in the example file
sudo cp stremio-pastebin.service.example /etc/systemd/system/stremio-pastebin.service
sudo systemctl daemon-reload
sudo systemctl enable --now stremio-pastebin
sudo systemctl status stremio-pastebin
```

Example layout:

- App directory: `/opt/stremio-pastebin`
- Environment file: `/opt/stremio-pastebin/.env`
- Service user: `stremio`

---

## Installation — Caddy (external HTTPS access)

Caddy provides automatic HTTPS and reverse-proxies requests to the Node.js app on port `7011`.

### 1. Install Caddy

Follow the [official Caddy installation guide](https://caddyserver.com/docs/install) for your OS.

On Debian/Ubuntu (example):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### 2. DNS

Create an **A** (or **AAAA**) record pointing your domain to the server’s public IP, e.g.:

```
stremio-pastebin.example.com  →  203.0.113.10
```

### 3. Caddyfile

Copy and adapt the example:

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

### 4. Application environment

In `.env` on the server:

```env
BASE_URL=https://stremio-pastebin.example.com
TRUST_PROXY=1
NODE_ENV=production
SESSION_SECRET=<strong-random-secret>
PORT=7011
HOST=0.0.0.0
```

`BASE_URL` ensures Stremio receives correct stream and manifest URLs when the app sits behind the proxy.

### 5. Firewall

Expose **443** (HTTPS) publicly. Keep **7011** bound to localhost only (not required on the public firewall if Caddy proxies locally).

```bash
sudo ufw allow 443/tcp
sudo ufw enable
```

### 6. Verify

- Web UI: `https://stremio-pastebin.example.com/`
- Manifest (with token): `https://stremio-pastebin.example.com/manifest.json?token=YOUR_TOKEN`

---

## Admin guide

Administrators are redirected to the main menu (`/index.html`) after login. Regular users only see the Stremio configuration page.

### First login

1. Go to `https://your-domain/` or `http://server-ip:7011/`.
2. Sign in with the admin account.
3. If prompted, set a new admin password on **Compte Admin**.

### Create a new user

1. Open the main menu → **Gestion Utilisateurs** (`/admin-users.html`).
2. Under **Ajouter un utilisateur**, enter:
   - **Nom d'utilisateur**
   - **Mot de passe**
3. Click **Ajouter**.

Each user automatically receives a unique **Stremio token** (visible in the user list and in user details). Share the login credentials with the user so they can retrieve their personal addon URL.

From the user list you can also **view details**, **edit** (password), **delete** users, and see daily usage statistics.

### Configure AllDebrid API key

1. Open **Gestion Pastebin** (`/pastebin-manager.html`).
2. In **Paramètres généraux**, paste your key in **Clé API AllDebrid**.
   - Get it from [AllDebrid → My account → API](https://alldebrid.com/account/).
   - Leave the field **empty** when saving if you only want to update other settings (the existing key is kept).
3. Click **Enregistrer les modifications**.

The key is stored in `settings.json`. It can also be set via `ALLDEBRID_API_KEY` in `.env` (used when `settings.json` has no key).

### Configure pastebin base URL

On the same **Gestion Pastebin** page:

1. Set **URL de base Pastebin (raw)** to the prefix used to fetch raw paste content.
2. The URL **must** point to the raw endpoint and **end with a trailing slash**.

Example:

```
https://paste.example.com/raw/
```

A code `Ab12Cd34` is fetched from:

```
https://paste.example.com/raw/Ab12Cd34
```

3. Click **Enregistrer les modifications**.

Can also be set with `PASTEBIN_BASE_URL` in `.env`.

### Add pastebin codes

Still on **Gestion Pastebin**:

1. Enter an **8-character alphanumeric** code (e.g. `F8h3sAzM`) in the input field.
2. Click **Ajouter**.
3. Repeat for all root catalogue pastes (nested pastes inside a catalogue are discovered automatically during refresh).
4. Reorder or remove codes with the list actions if needed.
5. Click **Enregistrer les modifications**.

Codes are stored in `pastebin_codes.json`.

### Refresh the catalogue

After AllDebrid, base URL, and codes are configured:

1. Open **Refresh Catalogue** (`/refresh.html`).
2. Click the refresh button to start parsing.
3. Wait until the process completes (the page shows progress and statistics).

The refresh:

- Downloads and parses all configured pastes (recursively).
- Updates `unified_data.js` (and related data files).
- Rebuilds catalogues and the SQLite VOD cache.
- **Preserves** manually added custom content.

Run a refresh whenever catalogue pastes are updated upstream.

### Other admin pages

| Page | Purpose |
|------|---------|
| **Ajouter du contenu** | Add a movie/series manually (TMDB + AllDebrid). |
| **Gérer le contenu** | View, edit, or delete custom content. |
| **Indicateurs** | Streams per day and most-watched content. |
| **Réinitialisation** | Wipe catalogues, cache, users, codes, and settings (destructive). |

---

## User guide

Regular users (non-admin) only need the web UI to obtain their addon URL. They do not have access to the admin menu.

### Log in and get your addon URL

1. Open the server URL in a browser, e.g. `https://stremio-pastebin.example.com/`.
2. Sign in with the username and password provided by the administrator.
3. You are redirected to **Configuration Stremio** (`/devices.html`).
4. On this page you will see:
   - Your **Stremio token**
   - The full **manifest URL**, e.g.  
     `https://stremio-pastebin.example.com/manifest.json?token=YOUR_TOKEN`
5. Use **Copier l'URL complète** to copy the manifest URL for Stremio.
6. If the token is compromised, use **Régénérer le token** and reinstall the addon in Stremio with the new URL.

### Add the addon in Stremio

#### Desktop / Web

1. Open **Stremio**.
2. Go to the **puzzle icon** (Addons) → **Addon Store** (or **Community addons**).
3. Scroll down and choose **Add addon manually** (or paste the URL in the search/install field depending on your Stremio version).
4. Paste the **full manifest URL** including `?token=...`.
5. Click **Install** / **Add**.

#### Android / iOS / TV

The steps are similar: open Addons → install manually → paste the full URL with your token.

> **Important:** Always use the URL **with** your personal token. Without a valid token, catalogues and streams will be rejected.

### Browse and play content

Once the addon is installed:

1. In Stremio, open the **Discover** or **Addons** section (wording varies by platform).
2. Find catalogues from **StremioPasteBin**, for example:
   - **Films tendances StremioPasteBin** / **Séries tendances StremioPasteBin**
   - Provider categories (Netflix, Disney+, Prime Video, Apple TV+, etc.) when present in the catalogue
   - **Contenu personnalisé** for admin-added titles
3. Select a **movie** or **series**.
4. For series, pick a **season** and **episode**.
5. Stremio shows available **streams** (qualities/sources). Select one to start playback.
6. Playback goes through the addon server and AllDebrid; a stable internet connection is required.

If no catalogues appear, ask your administrator to run a **catalogue refresh** and confirm your token is still valid.

---

## Configuration reference

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

### Runtime data files

| File | Purpose |
|------|---------|
| `users.json` | Users, admin account, Stremio tokens |
| `settings.json` | AllDebrid key and pastebin base URL |
| `pastebin_codes.json` | List of paste codes |
| `unified_data.js` | Parsed catalogue (movies + series) |
| `vod_catalog_cache.db` | SQLite cache for catalogue browsing |

---

## Project structure

```
├── server.js                 # Main Express server & Stremio endpoints
├── refresh_parser.js         # Pastebin parsing logic
├── user-manager.js           # Authentication & users
├── settings-manager.js       # AllDebrid / pastebin settings
├── db-cache-vod.js           # SQLite catalogue cache
├── unified-data-utils.js     # Catalogue deduplication & custom content
├── public/                   # Web UI (HTML)
├── .env.example              # Environment template
├── Caddyfile.example         # Caddy reverse proxy example
└── stremio-pastebin.service.example  # systemd unit example
```

### Key URLs

| URL | Access |
|-----|--------|
| `/` | Login page (or redirect if already signed in) |
| `/index.html` | Admin main menu |
| `/admin-users.html` | User management |
| `/pastebin-manager.html` | AllDebrid, pastebin URL, codes |
| `/refresh.html` | Catalogue refresh |
| `/devices.html` | User Stremio token & manifest URL |
| `/manifest.json?token=…` | Stremio addon manifest |

---

## Troubleshooting

| Problem | What to check |
|---------|----------------|
| **403 on manifest or streams** | Token missing, invalid, or regenerated — reinstall addon with the new URL. |
| **Empty catalogues in Stremio** | Run a catalogue refresh; verify pastebin codes and base URL. |
| **Debrid / playback errors** | AllDebrid API key valid; link still available on AllDebrid. |
| **Wrong URLs in Stremio** | Set `BASE_URL` to your public HTTPS domain and `TRUST_PROXY=1`. |
| **`npm install` fails on sqlite3** | Install `build-essential` and `python3` on Linux. |
| **Rate limit / trust proxy error** | Do not set `TRUST_PROXY=true`; use `1` or `false`. |

Logs are printed to the console (or `journalctl -u stremio-pastebin` when using systemd).

---

## License

[MIT](LICENSE) — Copyright (c) 2026 funkyfoenky
