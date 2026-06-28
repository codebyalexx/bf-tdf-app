# Basic-Fit Club Selector

Script Puppeteer qui ouvre la campagne Basic-Fit, sélectionne le club
`Lamballe-Armor`, puis arrive sur la page principale.

Les cookies, le `localStorage` et l'`IndexedDB` sont conservés dans
`.browser-profile/` grâce à `userDataDir`. Les lancements suivants réutilisent
donc la même session.

## Installation

Node.js 20 ou plus récent est requis.

```bash
npm install
npm start
```

L'interface web écoute par défaut sur `http://0.0.0.0:80`. Le bouton de
capture appelle Puppeteer et affiche la page Basic-Fit courante. Chromium reste
actif côté serveur et continue d'utiliser `.browser-profile/`.

Le parcours CLI d'origine reste disponible avec `npm run select-club`.

Le service lance également un worker sur l'environnement de test. Il choisit
l'exercice disponible qui rapporte le plus de points, attend la fin du chrono,
récupère les points puis revient à la liste pour sélectionner une autre
activité pendant le cooldown. Son état est exposé dans l'interface et par
`GET /api/status`.

Le worker peut être désactivé au démarrage avec `ACTIVITY_WORKER=0`.

## Multi-session

Le dashboard permet de choisir le nombre de sessions simultanées et de définir
un cooldown additionnel global en secondes. Sans configuration, la limite est
de 3 pour protéger les petites machines. En Docker, elle est pilotée par
`MAX_SESSIONS`.

- Session 1 : profil historique `.browser-profile/`
- Sessions suivantes : `.browser-sessions/session-N/`
- Configuration : `.browser-sessions/config.json`
- Compteurs : `worker-state.json` dans chaque profil

Chaque session dispose d'une page de détail et de son endpoint de capture :
`POST /api/sessions/:id/screenshot`. L'état agrégé, le rang du club et tous les
workers sont disponibles dans `GET /api/status`.

## Options

```bash
# Autre club
CLUB_NAME="Rennes" npm run select-club

# Exécution invisible, utile en CI
HEADLESS=1 KEEP_OPEN=0 npm run select-club

# Profil persistant dans un autre dossier
BROWSER_PROFILE="./profiles/lamballe" npm start

# Autre port HTTP
PORT=8080 npm start
```

Un profil déjà associé à un club est directement redirigé vers `/overview`.
Pour démontrer une nouvelle sélection sans perdre l'ancien profil, utiliser un
autre `BROWSER_PROFILE`.

## Service permanent

L'unité systemd fournie dans `deploy/basicfit-capture.service` démarre le
serveur au boot et le relance automatiquement en cas de panne.

```bash
sudo install -m 0644 deploy/basicfit-capture.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now basicfit-capture.service
```

## Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f app
```

L'interface est exposee sur le port `80` par defaut. Les cookies, profils et
compteurs sont stockes dans les volumes nommes `basicfit_profile` et
`basicfit_sessions`, et survivent donc aux recreations du conteneur.

Adaptez `MAX_SESSIONS` dans `.env` a la RAM disponible. Comptez environ 150 a
200 Mo par session Chromium, en gardant une marge pour Node et le systeme. La
limite absolue est de 25 sessions et la configuration Docker propose 25 par
defaut.
