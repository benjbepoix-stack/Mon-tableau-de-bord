# Carnet

Tableau de bord personnel (PWA installable sur iPhone), point d'entrée quotidien.

**Briefing du matin** (`js/features/briefing.js`) : à la première ouverture du jour, quatre écrans plein écran — météo et séance du jour (« Je la fais » ou « Demain »), rendez-vous / événements / courses des 7 prochains jours avec compte à rebours, tâches échues en pile (glisser à droite = faite, à gauche = demain), puis une plante qui gagne une feuille par geste et la série de matins. Rejouable avec le soleil de l'en-tête ; il remplace ce jour-là le pop-up des retards. Style « Vivant » (`css/vivant.css`) : palette Forêt et Pollen en sombre et en clair, dates en Geist Mono. Saisie express en langage naturel (`js/core/parse.js`) : « payer la cantine demain » = tâche datée, « dentiste jeudi 17h30 » = rendez-vous. Dans À faire, glisser une tâche à droite la coche, à gauche la reporte à demain (avec « Annuler »).

Trois onglets :
- **Aujourd'hui** (Accueil) : accès aux autres apps (Allure, Mon budget, Ma Maison, Mon Garage), séance du jour, puis rendez-vous, événements et courses (d'Allure) des 30 prochains jours (le reste se déplie sous « Plus tard »), ou vue calendrier du mois ; notes.
- **À faire** (Tâches) : tâches saisies ici (répétables), et en lecture seule celles venant d'Allure (course à préparer, résultat à noter), de Garage, de Ma Maison et de son calendrier de saison. Saisie express : écrire le titre puis Entrée (champ vide + bouton : formulaire complet avec échéance et répétition).
- **Semaine** (Planning) : planning sportif de la semaine (séances, météo), avec les phases de saison et les courses d'Allure.

La saison, les courses et les mesures se gèrent dans l'app **Allure** (même compte, même nœud Firebase, mêmes données : rien n'est copié).
Style minimaliste commun aux apps (anthracite, cartes pleines), couleur Menthe ; les courses gardent la couleur Aurore d'Allure.
HTML / CSS / JavaScript purs (modules ES), sans étape de build ni dépendance payante. Synchronisation multi-appareils via **Firebase Realtime Database** (offre gratuite), avec le **même compte** (e-mail / mot de passe) que Mon Garage, Ma Maison, Allure et Mon budget.

## Structure

```
index.html                  Squelette HTML (aucun script inline hormis l'anti-flash du thème)
manifest.webmanifest        Manifeste PWA
database.rules.json         Règles fermées à publier sur l'ANCIENNE base publique (voir « Sécurité »)
css/horizon.css             Style « Horizon » (paysage, accent citron, police Geist), chargé en dernier
fonts/, img/                Police Geist et paysages de l'accueil, servis par l'app (marchent hors ligne)
css/
  tokens.css                Design tokens (couleurs clair/sombre, rayons, ombres, mouvement)
  base.css                  Reset, typographie, fond d'ambiance, accessibilité
  components.css            Boutons, champs, cartes, modales, toasts, graphiques…
  layout.css                En-tête, barre d'onglets, grilles responsive
  views/*.css               Styles propres à chaque vue
js/
  main.js                   Point d'entrée : navigation, abonnements, erreurs globales
  config/firebase-config.js Configuration Firebase (projet commun aux apps, publique par conception)
  core/
    store.js                État central + persistance locale + diffusion des changements
    schema.js               Normalisation / validation de forme des données
    validation.js           Règles de validation des formulaires
    season.js               Phases d'entraînement (types, conseils, phase d'un jour, courses d'un jour)
    dates.js, utils.js      Utilitaires
  services/
    firebase.js             Compte + synchronisation (chargement dynamique, file d'écriture, état réseau, transfert depuis l'ancienne base)
    storage.js              localStorage sécurisé
    weather.js              Météo Open-Meteo avec cache
  features/
    ics.js                  Génération iCalendar (RFC 5545) + ouverture Calendrier iOS
    calendar-prompt.js      Modale « Ajouter au calendrier »
    overdue-prompt.js       Pop-up de démarrage : tâches, entretiens Garage et Maison en retard (une seule liste)
    linked-apps.js          Échéances de Garage / Maison lues dans le nœud de Carnet (sections, calendrier, pastilles)
    auth.js                 Feuille de connexion (« Continuer sans compte » possible)
    settings.js             Feuille Réglages : thème Auto / Sombre / Clair, compte connecté, déconnexion
    persist.js              Attente de l'accusé de réception Firebase
  ui/                       Icônes SVG, modales, toasts, thème, pastille de synchro, graphiques
  views/                    dashboard (accueil + tâches), training (planning)
```

## Lancer en local

Les modules ES ne fonctionnent pas en `file://`. Servez le dossier :

```bash
python3 -m http.server 8080
# puis http://localhost:8080
```

## Déploiement

GitHub Pages (ou tout hébergement statique) : publier la racine du dépôt. Aucune compilation nécessaire.

## Compte et synchronisation

* **Un seul compte pour les 5 apps** : Carnet utilise le projet Firebase de Mon Garage et Ma Maison (`test-e27e9`, même `firebase-config.js`). Les données sont sous `users/<uid>/carnet` (tranches `dashboard`, `notes`, `theme`, `families`, `plans`, `objectives`, `races`, `bodyMetrics`, partagées avec Allure). Le même nœud reçoit `garage_alerts` (écrit par Mon Garage), `maison_alerts` (Ma Maison) et `migrated` (marque du transfert) : Carnet les lit et ne les réécrit jamais.
* **Pas d'écran bloquant au démarrage** : l'app s'affiche tout de suite avec les données de l'appareil. Si Firebase répond « pas de compte », une feuille de connexion s'ouvre par-dessus (e-mail, mot de passe, « Mot de passe oublié ? », « Créer un compte »), avec **« Continuer sans compte »** : données sur l'appareil seulement, pas de synchronisation, pastille « Local » (choix gardé jusqu'à la fermeture de l'app, la feuille revient au lancement suivant ; on peut aussi se connecter depuis les Réglages). Firebase injoignable : pas de feuille, mode local.
* **Session partagée** : les apps sont sur la même origine (`benjbepoix-stack.github.io`) ; dans un même navigateur, être connecté dans Mon Garage suffit. Sur iPhone, chaque app installée sur l'écran d'accueil a son propre stockage : une connexion par app, une seule fois.
* **Changement de compte** sur l'appareil (autre compte que le dernier mémorisé, clé `dashboard_last_uid`) : les données locales sont vidées avant la synchro. À la première connexion après la mise à jour, rien n'est vidé.
* **Réglages** (roue dentée de l'en-tête) : « Connecté : e-mail » et « Se déconnecter » (les données restent dans le compte et sur l'appareil).
* Sans compte, rien n'est mis en attente d'envoi : à la connexion, les données du compte priment (compte vide : celles de l'appareil y sont envoyées).

## Transfert depuis l'ancienne base (automatique, une seule fois)

Au premier instantané de `users/<uid>/carnet` après connexion, si `migrated` est absent, Carnet lit l'ancienne base publique en REST (`dashboard---projet…/app.json`, 8 s max) :
* données trouvées → toutes les tranches de Carnet sont écrites dans le nouveau nœud (sans écraser une tranche qu'Allure y aurait déjà mise ; jamais les anciens `garage_alerts` / `maison_alerts`), avec `migrated: { from: '<hôte>', at, by: 'carnet' }`, puis affichées ;
* ancienne base vide ou injoignable → les données de l'appareil deviennent la référence, `migrated: { from: 'local', … }` ;
* Allure a fait le transfert pendant la lecture (marque `migrated` apparue entre-temps) → Carnet n'écrit rien de plus et garde la marque d'Allure.

Un nœud qui ne contient que `garage_alerts` / `maison_alerts` / `migrated` est considéré comme vide : les données de l'appareil n'en sont jamais effacées. Le ménage des tâches cochées et le pop-up des retards attendent la fin de ce premier chargement.

## Sécurité Firebase — à lire

* La `apiKey` et le reste de `firebase-config.js` **ne sont pas des secrets** : Firebase les destine au navigateur. Aucune clé privée (compte de service) ne doit jamais être commitée ; le `.gitignore` les exclut.
* Les données de Carnet sont protégées par le compte : les règles du projet `test-e27e9` (gérées dans le dépôt Mon Garage) n'autorisent que `users/<uid>` au compte connecté. **Aucune règle à publier** pour les nouveaux chemins.
* ⚠️ **Verrouiller l'ancienne base** `dashboard---projet` (lisible et modifiable par n'importe qui jusque-là) **une fois les données transférées** : ouvrez Carnet connecté sur un appareil à jour, vérifiez que vos données s'affichent (et, dans la console Firebase du projet `test-e27e9`, que `users/<uid>/carnet/migrated` existe), puis console Firebase du projet **dashboard---projet** → Realtime Database → *Règles* → coller le contenu de `database.rules.json` (`".read": false, ".write": false`) → *Publier*. Après cela, l'ancienne base n'est plus lisible : un appareil qui n'aurait jamais été mis à jour enverra ses propres données à sa première connexion (transfert « local »).

## Robustesse

* Fonctionne hors ligne / si Firebase est indisponible ou sans compte (mode « Local » affiché dans l'en-tête), puis resynchronise.
* Les modifications faites avant la première synchronisation ne sont pas écrasées par le cloud.
* Accès refusé par Firebase (ex. : mot de passe changé sur un autre appareil) : mode « Local », puis la synchronisation reprend dès la reconnexion, sans recharger l'app ; une écriture refusée pour un compte précédent n'affecte pas le compte connecté.
* Données lues toujours normalisées (localStorage corrompu, tableaux convertis en objets par Firebase, nœuds vides supprimés).
* Validation stricte de chaque formulaire avant écriture ; erreurs affichées sous les champs.

## Calendrier iOS (.ics)

Après l'enregistrement d'un rendez-vous (confirmé par Firebase si en ligne), une modale propose **« Ajouter au Calendrier »**.
Sur iPhone, Safari reçoit un événement `text/calendar` et affiche directement la fiche native d'ajout à l'app Calendrier. Ailleurs, un fichier `.ics` est téléchargé.
Un bouton calendrier est aussi disponible sur chaque rendez-vous, événement et course à venir. L'UID est stable : réimporter un rendez-vous modifié met à jour l'événement.

## Périodicité

Rendez-vous et événements peuvent se répéter (tous les jours, semaines, mois ou ans — ex. un anniversaire). La date saisie est la première occurrence ; l'accueil affiche la prochaine occurrence et l'export `.ics` inclut la règle `RRULE`.

> Depuis l'app installée sur l'écran d'accueil, si la fiche ne s'ouvre pas, utilisez le bouton « Partager le fichier .ics ».

## Lien avec Allure
Allure écrit `races`, `objectives.seasonPhases` et `bodyMetrics` dans le même nœud (`users/<uid>/carnet`, même compte) ; Carnet les lit pour l'agenda, la séance du jour, les tâches Sport et le planning (phase de chaque jour, courses). Un appui sur une course ou une tâche Sport ouvre Allure.

## Tâches → app Rappels (iPhone)

Sur iPhone, chaque tâche datée et non terminée a un bouton cloche : il copie le titre et l’échéance (« Appeler le garage — samedi 3 octobre à 10:30 ») puis ouvre l’app Rappels, où il suffit de coller. Une page web ne peut pas créer elle-même un rappel.

## Mises à jour

`sw.js` (service worker) vérifie à chaque ouverture si les fichiers de l’app ont changé sur le serveur et garde la dernière version pour le mode hors ligne. Une version publiée sur GitHub Pages apparaît donc à la réouverture de l’app, sans attendre l’expiration du cache du navigateur.

À l’installation, l’app-shell (HTML/CSS/JS/icônes) est aussi pré-mis en cache : un tout premier lancement hors ligne (avant toute visite en ligne réussie) affiche donc l’app au lieu d’un écran blanc.

## Notifications

* **Activer** : Réglages → Notifications → « Activer les notifications » (compte connecté). Sur iPhone : iOS 16.4+ et Carnet ouverte depuis l'écran d'accueil. Réglages par appareil : rappel avant les rendez-vous / événements (15 min à 24 h), résumé du matin (séances, agenda, tâches du jour et en retard, échéances Garage / Maison), rappel à l'heure des tâches qui en ont une, notification quand Mon Garage ou Ma Maison publie une nouvelle tâche (y compris les tâches de saison du mois). Code : `js/features/push.js`, réception dans `sw.js` (même chose dans `test/`).
* **Envoi** : la tâche GitHub `.github/workflows/notifications.yml` lance `scripts/notify/send.mjs`, qui vérifie une fois par minute pendant 5 h 30 puis relance la tâche (GitHub ne lance les tâches planifiées que toutes les quelques heures ; le planning toutes les 30 min sert de secours). Abonnements : `users/<uid>/carnet_push/devices`, envois déjà faits : `users/<uid>/carnet_push/sent` (jamais deux fois la même notification). Tâches Garage / Maison déjà vues : `users/<uid>/carnet_push/linked_seen` (au premier passage, tout est noté comme vu sans notifier).
* **Secrets à créer une fois** (dépôt → *Settings* → *Secrets and variables* → *Actions*) : `FIREBASE_SERVICE_ACCOUNT` (console Firebase `test-e27e9` → Paramètres du projet → Comptes de service → *Générer une nouvelle clé privée*, coller tout le JSON) et `VAPID_PRIVATE_KEY` (clé privée associée à la clé publique écrite dans `push.js` et `send.mjs`). Sans ces secrets, la tâche ne fait rien.
* Essai sans rien envoyer : `cd scripts/notify && npm ci && FIREBASE_SERVICE_ACCOUNT="$(cat cle.json)" TZ=Europe/Paris node send.mjs --dry`.

## Météo

Par défaut sur Besançon. Le bouton 📍 à côté de la météo (onglet Planning) permet de changer de ville (recherche via l’API de géocodage gratuite d’Open-Meteo) ; le choix est mémorisé sur l’appareil.

## Accès aux autres apps

L'accueil s'ouvre sur un paysage (crépuscule en sombre, matin en clair) avec la séance du jour en grand titre, puis une rangée de 4 tuiles (icône au trait + nom) qui ouvre Allure, Mon budget, Ma Maison et Mon Garage. Une **pastille rouge** sur Ma Maison / Mon Garage indique le nombre d'entretiens en retard qu'elles ont publiés.

## Lien avec Garage

- Garage n'envoie plus de tâches une à une (ancien bouton « Carnet », source de doublons) : ses échéances arrivent uniquement par la section « Garage » ci-dessous. Les tâches déjà reçues restent des tâches normales.
- **Section « Garage »** : dans l'onglet Tâches, en lecture seule et en direct, tout ce qui est en retard ou dû dans les 30 jours sur chaque véhicule (retard en rouge, bientôt en orange, avec la date d'échéance quand elle existe), publié par Garage dans `users/<uid>/carnet/garage_alerts` (même compte). Les échéances datées apparaissent aussi dans le calendrier du mois. Carnet lit ce chemin dans l'instantané de son propre nœud (pas d'écouteur séparé) et ne l'écrit jamais. La section reste masquée tant que Garage n'a rien publié. Détail dans `js/features/linked-apps.js`.

## Lien avec Ma Maison

**Sections « Maison » et « Saison »** : dans l'onglet Tâches, en lecture seule et en direct, ce qu'a publié l'app **Ma Maison** dans `users/<uid>/carnet/maison_alerts` : entretiens en retard ou à moins de 30 jours et garanties qui expirent (avec leur date, aussi dans le calendrier du mois), puis les tâches du calendrier de saison du mois restant à faire. Un appui ouvre Ma Maison. Détail dans `js/features/linked-apps.js`.

Plus aucune règle Firebase à publier pour ces liens : tout est sous le compte connecté.

## Thème

Réglages › Thème : **Auto** (par défaut, suit le réglage clair / sombre de l'iPhone, y compris son passage automatique le soir), Sombre ou Clair. Le choix est synchronisé (tranche `theme`). À la mise à jour, l'ancien thème « sombre » (ancien défaut) devient Auto, une seule fois (drapeau `dashboard_theme_auto_v1`) ; « clair » reste clair.

## Pop-up de démarrage (tout ce qui est en retard)

Au lancement de l'app, une fenêtre liste **en une seule fois** les tâches en retard (échéance passée, non cochées) et les entretiens en retard publiés par Garage et Ma Maison. Une tâche se coche directement dans la liste (ou s'ouvre d'un appui) ; un entretien ouvre l'app concernée ; un seul bouton « Fermer ». Un seul passage par session, une fois les données du compte reçues (une tâche faite sur un autre appareil n'y figure pas ; après le choix « se connecter » ou « continuer sans compte » si la feuille de connexion est ouverte) et les résumés Garage / Maison lus — sans les attendre plus de 2,5 s. Détail dans `js/features/overdue-prompt.js`.

## Modifier et supprimer

Un appui sur une carte (rendez-vous, événement) ou une ligne (tâche) ouvre sa modification ; « Supprimer » est en bas de la feuille. Les listes n'affichent plus d'icônes crayon / corbeille. Le rond d'une tâche la coche sans ouvrir la feuille ; l'icône calendrier des rendez-vous à venir reste disponible.

## Accueil : 30 prochains jours et calendrier du mois

- L'accueil n'affiche que les rendez-vous, événements et courses des **30 prochains jours** ; les suivants se déplient sous « Plus tard (N) ».
- **Échéance à 10 jours ou moins** : carte encadrée en couleur — ambre, rouge pour aujourd'hui et demain — avec badge de date assorti.
- **Vue « Mois »** (bascule en haut de « À venir », choix mémorisé sur l'appareil) : calendrier mensuel avec une pastille par type (RDV, événement, course, tâche, garage / maison), occurrences des éléments répétés comprises ; toucher un jour liste ce qu'il contient.

## Tâches répétées et tâches cochées

- Une tâche datée peut se répéter (jour, semaine, mois, an — champ « Répétition » dans « Plus de détails »).
- Une tâche cochée reste visible, barrée, jusqu'au soir, puis **disparaît le lendemain**.
- Une tâche **répétée** cochée n'est pas supprimée : le lendemain, elle revient décochée à sa **prochaine échéance** (« Revient le … » s'affiche en attendant). Faite en retard, elle saute les échéances déjà passées. Les occurrences se comptent depuis la première échéance (« le 31 de chaque mois » reste le dernier jour des mois courts).
- Ce ménage n'a lieu qu'une fois les données du cloud reçues, pour ne jamais écraser une tâche ajoutée sur un autre appareil. Détail dans `js/features/task-tidy.js`.

## Planning de la semaine

À l'ouverture de l'app, le planning hebdomadaire (onglet Planning) défile automatiquement jusqu'à la carte du jour, plutôt que de rester sur le lundi de la semaine affichée. Seuls les jours réellement planifiés sont enregistrés (consulter une semaine ne crée plus de jours vides dans la base). Un appui sur une course du planning ouvre Allure.

Carnet n'écrit jamais `objectives` (les phases de saison appartiennent à Allure) : la gestion des sports ne peut donc plus écraser une phase créée dans Allure.
