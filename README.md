# Prowlarr Watcher

> **Disclaimer : ce projet est entièrement vibecoded.** Le code a été généré par IA (Claude) sans relecture approfondie
> ni tests formels. Il fonctionne, mais ne t'attends pas à du code de production soigné.

Sur les trackers privés, le ratio (upload/download) est primordial. Certains trackers organisent des périodes de *
*freeleach** : les torrents téléchargés pendant cette fenêtre ne comptent pas dans le download, mais l'upload engrangé,
lui, compte bien. C'est le moment idéal pour booster son ratio.

Pour en profiter au maximum, il faut être parmi les **premiers seeders** d'un torrent : plus tu arrives tôt, plus tu
uploades avant que la nuée de seeders ne dilue ta part. Faire ça manuellement (surveiller le tracker, télécharger vite)
est fastidieux.

**Prowlarr Watcher automatise ça** : il surveille tes trackers via Prowlarr et télécharge immédiatement les nouveaux
torrents dès qu'ils apparaissent, avec notifications Discord et une petite UI web pour activer/désactiver chaque tracker
à la volée.

## Comment ça marche

```
Prowlarr (indexeurs)
       │
       │  polling toutes les N secondes
       ▼
prowlarr-watcher
       │
       ├──▶ télécharge via Prowlarr → client torrent
       ├──▶ notification Discord
       └──▶ UI web (statut + logs)
```

Prowlarr fait le vrai travail (accès aux trackers, téléchargement). Ce watcher ne fait que poller l'API de recherche et
déclencher les téléchargements automatiquement.

## Prérequis

- [Prowlarr](https://prowlarr.com/) configuré avec tes trackers et un client torrent
- Docker

## Installation

```bash
cp docker-compose.example.yml docker-compose.yml
# édite docker-compose.yml avec tes vraies valeurs
docker compose up -d
```

## Configuration

Toute la config passe par les variables d'environnement dans `docker-compose.yml` :

| Variable            | Description                                      | Défaut |
|---------------------|--------------------------------------------------|--------|
| `PROWLARR_URL`      | URL de ton instance Prowlarr                     | —      |
| `PROWLARR_API_KEY`  | Clé API Prowlarr                                 | —      |
| `DISCORD_WEBHOOK`   | URL du webhook Discord (optionnel)               | —      |
| `INTERVAL`          | Intervalle de polling en secondes                | `60`   |
| `MAX_AGE_MINUTES`   | Ignorer les torrents plus vieux que N minutes    | `10`   |
| `HISTORY_TTL_HOURS` | Durée de mémorisation des torrents déjà vus      | `24`   |
| `UI_PORT`           | Port de l'UI web                                 | `3000` |
| `TRACKERS`          | JSON des trackers à surveiller (voir ci-dessous) | —      |

### Format TRACKERS

```json
[
  {
    "id": 22,
    "name": "MonTracker",
    "color": 16711680
  },
  {
    "id": 23,
    "name": "AutreTracker",
    "color": 3447003
  }
]
```

- `id` : l'ID de l'indexeur dans Prowlarr — visible dans Settings → Indexers, dans l'URL quand tu cliques sur un
  indexeur
- `name` : nom libre, utilisé dans les logs, les notifs Discord et l'UI web
- `color` : couleur en entier décimal — utilisée pour la bordure de l'embed Discord et le badge de l'UI. Convertir un
  hex CSS (`#FF0000`) sur [SpyColor](https://www.spycolor.com/) ou avec `parseInt('FF0000', 16)`

## UI Web

Accessible sur `http://localhost:3005` (ou le port mappé dans docker-compose).

Permet d'activer/désactiver chaque tracker et de définir une taille max de torrent à la volée, sans redémarrer le
conteneur.

## Logs

Les logs sont visibles dans l'UI web et dans la sortie Docker :

```bash
docker compose logs -f
```
