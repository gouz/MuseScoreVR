# MuseScoreVR

Écouter une partition MuseScore depuis l'intérieur de l'orchestre, en réalité virtuelle.

On choisit un morceau (`.mscz`), on dispose les musiciens sur un plan, et dans le casque on entend l'orchestre
en son spatialisé : depuis le podium du chef, ou depuis la chaise de n'importe quel musicien.

- **Son** : les vrais MuseSounds, rendus par MuseScore, une piste par partie, spatialisés (HRTF) avec
  rayonnement des instruments, pupitres décorrélés et réverbération de salle.
- **Plugin MuseScore** : nombre de musiciens par partie, placement par glisser-déposer, réglages du rendu, envoi au casque.
- **Lecteur** (casque, testé sur Meta Quest 3) : rendu seul. On écoute, on se met en pause, on change de place.
  Les musiciens (des cubes colorés par famille) s'illuminent quand ils jouent.
- **Pupitres** : chaque musicien a sa partie séparée sur son pupitre, le chef a le conducteur.
  Les pages tournent toutes seules, et les notes s'allument pendant qu'elles sonnent.

## Installation

- [MuseScore 4](https://musescore.org) (testé avec 4.7) et les MuseSounds installés via Muse Hub
- Télécharger le zip de votre système dans les [releases](https://github.com/gouz/MuseScoreVR/releases)
  (`MuseScoreVR-<version>-macos.zip`, `-windows.zip` ou `-linux.zip`) et le décompresser dans le dossier des plugins
  de MuseScore : on obtient `Documents/MuseScore4/Plugins/MuseScoreVR`
- macOS : le serveur n'est pas notarisé par Apple ; après la décompression, autoriser le dossier une fois dans le Terminal :
  `xattr -dr com.apple.quarantine ~/Documents/MuseScore4/Plugins/MuseScoreVR`
- Dans MuseScore : Accueil › Plugins, activer **MuseScoreVR**
- Sur le Quest : rien à installer, c'est une page web (navigateur du Quest)

Le plugin contient son propre petit serveur (`plugin/bin/`, un exécutable par système). Il le démarre à l'ouverture
et le serveur s'arrête avec MuseScore. Rien d'autre à installer : ni Bun, ni ffmpeg.
Au premier lancement, le pare-feu du système peut demander d'autoriser `musescorevr` sur le réseau local : acceptez,
c'est par là que le Quest reçoit le morceau.

## Utilisation

1. Ouvrir une partition dans MuseScore, puis **Plugins › MuseScoreVR**.
   La partition doit avoir été enregistrée avec MuseScore 4 (une partition MuseScore 3 doit d'abord être ouverte
   puis enregistrée). Pour les pupitres, générer les parties séparées (bouton « Parties ») avant d'enregistrer.
2. Le premier rendu prend ~30 s par partie (MuseScore rend chaque partie avec les MuseSounds). Il est gardé :
   rouvrir la même partition est immédiat.
3. **Sur le Quest** : ouvrir l'adresse affichée en bas de la fenêtre du plugin (`https://<ip-du-pc>:8443/`),
   accepter l'avertissement de certificat, et laisser la page ouverte.
4. Dans le plugin : choisir une disposition (ordre de la partition, orchestre symphonique, orchestre d'harmonie,
   big band), régler le nombre de musiciens, les déplacer si besoin, puis **« Envoyer au casque »**.
   Le Quest charge le morceau tout seul, même déjà en VR. Les boutons Lecture / Pause / Stop pilotent la lecture dans le casque.
5. Dans le casque, « Enter VR ». Avec les mains (ou les manettes) :
   viser un musicien et pincer pour s'asseoir à sa place, le podium pour revenir au chef.
   Le panneau à votre droite se touche du doigt : lecture / pause, stop, ±10 s, place précédente / suivante,
   volume, barre de temps, ✕ pour quitter la VR.

Gardez la fenêtre du plugin ouverte pendant l'écoute : la fermer arrête le serveur (le morceau déjà reçu continue de jouer
dans le casque, mais la télécommande ne répond plus).

## Développement

[Bun](https://bun.sh) ≥ 1.3 sert à assembler le plugin et aux tests.

```sh
bun install
bun run plugin --here   # compile le serveur pour ce système seulement, copie la page du casque dans plugin/
bun run plugin          # pour macOS (binaire universel), Windows et Linux
bun run plugin --release 1.2.0   # + dist/MuseScoreVR-1.2.0-<os>.zip, comme une release
# pendant le développement, un vrai dossier dont le contenu est lié (MuseScore ne suit pas un dossier lié) :
mkdir -p ~/Documents/MuseScore4/Plugins/MuseScoreVR
for f in MuseScoreVR.qml layout.mjs logo.png bin web; do ln -sfn "$PWD/plugin/$f" ~/Documents/MuseScore4/Plugins/MuseScoreVR/; done
bun run serve           # le serveur depuis les sources (le plugin l'utilise s'il tourne déjà)
bun run stems partition.mscz projet.zip   # le rendu seul, en ligne de commande
```

### Publier une version

Pousser un tag `v<version>` (`git tag v1.2.0 && git push origin v1.2.0`) : la CI (`.github/workflows/release.yml`)
lance les tests, assemble le plugin pour macOS, Windows et Linux, et crée la release GitHub avec un zip par système.

## Format de projet

Un `.zip` **non compressé**, que le navigateur lit morceau par morceau sans le charger en entier :

```
project.json        titre, parties (famille, rang, nombre de musiciens), sièges, réglages
<partie>/<n>.flac   tranches mono de 10 s, sans réverbération (les tranches silencieuses sont omises)
room.wav|flac       optionnel : réponse impulsionnelle d'une vraie salle
scores/full/        conducteur : pages en SVG (<n>.svg) + sheet.json (tournes de page, instant de chaque note)
scores/<partie>/    partie séparée, même format
```

Sans `room.*`, une réverbération synthétique est utilisée. Des réponses impulsionnelles de vraies salles se trouvent
par exemple dans la bibliothèque OpenAIR ; chacune a sa licence, vérifiez-la avant de partager un projet.

Les familles d'instruments et leur ordre viennent du bloc `<Order>` de la partition.
Pendant la lecture, seules les tranches des ~12 prochaines secondes sont décodées : la mémoire reste stable
quelle que soit la durée du morceau.

## Structure

```
plugin/MuseScoreVR.qml  le plugin : interface dans MuseScore, démarre le serveur et lui parle
tools/serve.js        serveur : rendu, page du casque en HTTPS sur le Wi-Fi, envoi des morceaux et des commandes
tools/stems.js        .mscz → projet (rendu MuseScore en ligne de commande, une partie à la fois en solo)
tools/flac.js         lecture du WAV de MuseScore, encodage FLAC (sans ffmpeg)
tools/sheet.js        pages SVG + positions temporelles MuseScore (.spos) → tournes de page et instant de chaque note
tools/build-plugin.js assemble plugin/ : serveur compilé par système, page du casque ; zips de release
proto/index.html      lecteur VR (casque)
proto/engine.js       ouverture de projet, audio spatial en flux, niveaux
proto/stands.js       pupitres : partition ouverte comme un livre, notes allumées pendant qu'elles sonnent
proto/layout.js       placement des familles en blocs, rayonnement des instruments (aussi utilisé par le plugin)
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
