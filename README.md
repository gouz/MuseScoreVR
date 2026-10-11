# MuseScoreVR

Écouter une partition MuseScore depuis l'intérieur de l'orchestre, en réalité virtuelle.

On choisit un morceau (`.mscz`), on dispose les musiciens sur un plan, et dans le casque on entend l'orchestre
en son spatialisé : depuis le podium du chef, ou depuis la chaise de n'importe quel musicien.

- **Son** : les vrais MuseSounds, rendus par MuseScore, une piste par partie, spatialisés (HRTF) avec
  rayonnement des instruments, pupitres décorrélés et réverbération de salle.
- **Configurateur** (PC) : nombre de musiciens par partie, placement par glisser-déposer, réglages du rendu, aperçu d'écoute.
- **Lecteur** (casque, testé sur Meta Quest 3) : rendu seul. On écoute, on se met en pause, on change de place.
  Les musiciens (des cubes colorés par famille) s'illuminent quand ils jouent.

## Prérequis

- [MuseScore 4](https://musescore.org) et les MuseSounds installés via Muse Hub
- [Bun](https://bun.sh) ≥ 1.3
- [ffmpeg](https://ffmpeg.org) dans le `PATH`
- MuseScore est cherché à son emplacement par défaut (macOS, Windows) ou comme `mscore` (Linux) ;
  sinon indiquer son chemin dans la variable `MSCORE`
- Un navigateur avec WebXR (navigateur du Quest), et Chrome ou Edge sur le PC

## Utilisation

```sh
# 1. Rendre un projet depuis une partition enregistrée avec MuseScore 4 (~30 s par partie)
#    (un fichier MuseScore 3 doit d'abord être ouvert puis enregistré dans MuseScore 4)
bun run stems partition.mscz proto/projects/mon-morceau.zip

# 2. Créer une fois le certificat local (le Quest exige HTTPS pour la VR)
mkdir -p .cert && openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout .cert/key.pem -out .cert/cert.pem -subj "/CN=musescorevr" \
  -addext "subjectAltName=IP:<ip-du-pc>,DNS:localhost"

# 3. Servir l'application sur le réseau local
bun run serve
```

- **Sur le Quest** : ouvrir `https://<ip-du-pc>:8443/` (accepter l'avertissement de certificat) et le laisser ouvert.
  Le casque attend qu'un morceau lui soit envoyé.
- **Sur le PC** : `https://localhost:8443/config.html`, ouvrir le `.zip`, régler, puis **« Envoyer au casque »**.
  Le Quest charge le morceau tout seul, même déjà en VR ; « Enregistrer le projet » garde la configuration dans un fichier.
  Les boutons « Casque : ▶︎ ❚❚ ■ » lancent, mettent en pause ou arrêtent la lecture dans le casque.
- Dans le casque, « Enter VR ».
  Gâchette sur un musicien : s'asseoir à sa place · gâchette sur le podium : revenir au chef · poignée : lecture / pause.

## Format de projet

Un `.zip` **non compressé**, que le navigateur lit morceau par morceau sans le charger en entier :

```
project.json        titre, parties (famille, rang, nombre de musiciens), sièges, réglages
<partie>/<n>.flac   tranches mono de 10 s, sans réverbération (les tranches silencieuses sont omises)
room.wav|flac       optionnel : réponse impulsionnelle de la salle choisie dans le configurateur
```

Sans `room.*`, une réverbération synthétique est utilisée. Des réponses impulsionnelles de vraies salles se trouvent
par exemple dans la bibliothèque OpenAIR ; chacune a sa licence, vérifiez-la avant de partager un projet.

Les familles d'instruments et leur ordre viennent du bloc `<Order>` de la partition.
Pendant la lecture, seules les tranches des ~12 prochaines secondes sont décodées : la mémoire reste stable
quelle que soit la durée du morceau.

## Structure

```
tools/stems.js        .mscz → projet (rendu MuseScore en ligne de commande, une partie à la fois en solo)
tools/serve.js        serveur HTTPS local + relais configurateur → casques (WebSocket)
proto/config.html     configurateur (PC)
proto/index.html      lecteur VR (casque)
proto/engine.js       commun : ouverture/enregistrement de projet, audio spatial en flux, niveaux
proto/layout.js       placement des familles en blocs, rayonnement des instruments
proto/zip.js          zip : écriture non compressée, lecture non compressée et deflate (.mscz)
```

## Tests

```sh
bun test
```

## MuseSounds et droits

Ce dépôt ne contient aucun son. Les MuseSounds sont soumis à leur propre licence : les projets que vous
générez contiennent de l'audio rendu avec eux. Ne les publiez pas sans avoir vérifié ce que leur licence
autorise (et les droits de la partition elle-même).

## Licence

[GPL-3.0](LICENSE)
