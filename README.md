# Carnet

Tableau de bord personnel (PWA installable sur iPhone), point d'entrée quotidien. Trois onglets :
- **Accueil** : séance du jour, puis rendez-vous, événements et courses (d'Allure) des 30 prochains jours (le reste se déplie sous « Plus tard »), ou vue calendrier du mois ; notes.
- **Tâches** : tâches saisies ici (répétables), et en lecture seule celles venant d'Allure (course à préparer, résultat à noter), de Garage, de Ma Maison et de son calendrier de saison.
- **Planning** : planning sportif de la semaine (séances, météo), avec les phases de saison et les courses d'Allure.

La saison, les courses et les mesures se gèrent dans l'app **Allure** (même base Firebase, mêmes données : rien n'est copié).
Style minimaliste commun aux apps (anthracite, cartes pleines), couleur Menthe ; les courses gardent la couleur Aurore d'Allure.
HTML / CSS / JavaScript purs (modules ES), sans étape de build ni dépendance payante. Synchronisation multi-appareils via **Firebase Realtime Database** (offre gratuite).

## Structure

```
index.html                  Squelette HTML (aucun script inline hormis l'anti-flash du thème)
manifest.webmanifest        Manifeste PWA
database.rules.json         Règles de sécurité recommandées pour la Realtime Database
css/
  tokens.css                Design tokens (couleurs clair/sombre, rayons, ombres, mouvement)
  base.css                  Reset, typographie, fond d'ambiance, accessibilité
  components.css            Boutons, champs, cartes, modales, toasts, graphiques…
  layout.css                En-tête, barre d'onglets, grilles responsive
  views/*.css               Styles propres à chaque vue
js/
  main.js                   Point d'entrée : navigation, abonnements, erreurs globales
  config/firebase-config.js Configuration Firebase (publique par conception)
  core/
    store.js                État central + persistance locale + diffusion des changements
    schema.js               Normalisation / validation de forme des données
    validation.js           Règles de validation des formulaires
    season.js               Phases d'entraînement (types, conseils, phase d'un jour, courses d'un jour)
    dates.js, utils.js      Utilitaires
  services/
    firebase.js             Synchronisation (chargement dynamique, file d'écriture, état réseau)
    storage.js              localStorage sécurisé
    weather.js              Météo Open-Meteo avec cache
  features/
    ics.js                  Génération iCalendar (RFC 5545) + ouverture Calendrier iOS
    calendar-prompt.js      Modale « Ajouter au calendrier »
    overdue-prompt.js       Pop-up de démarrage : tâches et entretiens Garage en retard
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

## Sécurité Firebase — à lire

* La `apiKey` et le reste de `firebase-config.js` **ne sont pas des secrets** : Firebase les destine au navigateur. Aucune clé privée (compte de service) ne doit jamais être commitée ; le `.gitignore` les exclut.
* La protection des données repose **uniquement sur les règles** de la base. `database.rules.json` :
  * limite l'accès au seul nœud `app` ;
  * refuse toute clé inconnue et valide la forme et la taille des données (empêche d'utiliser la base comme stockage libre).
* **Déployer les règles** : console Firebase → Realtime Database → *Règles* → coller le contenu de `database.rules.json` → *Publier* (ou `firebase deploy --only database`).
* ⚠️ Sans authentification, toute personne connaissant l'URL de la base peut lire/écrire le nœud `app`. Pour une protection complète, activez *Firebase Authentication* (e-mail/mot de passe, gratuit) et remplacez `".read": true, ".write": true` par `"auth != null && auth.uid === '<VOTRE_UID>'"`.

## Robustesse

* Fonctionne hors ligne / si Firebase est indisponible (mode « Local » affiché dans l'en-tête), puis resynchronise.
* Les modifications faites avant la première synchronisation ne sont pas écrasées par le cloud.
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
Allure écrit `races`, `objectives.seasonPhases` et `bodyMetrics` dans la même base ; Carnet les lit pour l'agenda, la séance du jour, les tâches Sport et le planning (phase de chaque jour, courses). Un appui sur une course ou une tâche Sport ouvre Allure.

## Tâches → app Rappels (iPhone)

Sur iPhone, chaque tâche datée et non terminée a un bouton cloche : il copie le titre et l’échéance (« Appeler le garage — samedi 3 octobre à 10:30 ») puis ouvre l’app Rappels, où il suffit de coller. Une page web ne peut pas créer elle-même un rappel.

## Mises à jour

`sw.js` (service worker) vérifie à chaque ouverture si les fichiers de l’app ont changé sur le serveur et garde la dernière version pour le mode hors ligne. Une version publiée sur GitHub Pages apparaît donc à la réouverture de l’app, sans attendre l’expiration du cache du navigateur.

À l’installation, l’app-shell (HTML/CSS/JS/icônes) est aussi pré-mis en cache : un tout premier lancement hors ligne (avant toute visite en ligne réussie) affiche donc l’app au lieu d’un écran blanc.

## Météo

Par défaut sur Besançon. Le bouton 📍 à côté de la météo (onglet Planning) permet de changer de ville (recherche via l’API de géocodage gratuite d’Open-Meteo) ; le choix est mémorisé sur l’appareil.

## Lien avec Garage

- **Tâches envoyées depuis Garage** : un rappel d'entretien (vidange, contrôle technique…) envoyé depuis l'app **Garage** arrive directement comme tâche datée dans l'onglet Tâches, au même titre qu'une tâche créée ici. Rien à faire côté Carnet.
- **Section « Garage »** : dans l'onglet Tâches, en lecture seule et en direct, tout ce qui est en retard ou dû dans les 30 jours sur chaque véhicule (retard en rouge, bientôt en orange, avec la date d'échéance quand elle existe), publié par Garage via `app/garage_alerts`. Les échéances datées apparaissent aussi dans le calendrier du mois. Carnet ne fait que lire ce chemin. La section reste masquée tant que Garage n'a rien publié. Détail dans `js/features/linked-apps.js`.

⚠️ **Étape unique à faire manuellement** : le chemin `garage_alerts` doit être autorisé dans les règles de cette base Firebase. Le fichier `database.rules.json` de ce dépôt a été mis à jour en conséquence, mais Claude ne peut pas déployer des règles Firebase depuis cet environnement — il faut copier son contenu dans la console Firebase (Realtime Database → Règles → coller → Publier) une seule fois. Tant que ce n'est pas fait, le widget reste vide (Garage retentera automatiquement l'envoi dès que les règles seront en place, sans rien à refaire).

## Lien avec Ma Maison

**Sections « Maison » et « Saison »** : dans l'onglet Tâches, en lecture seule et en direct, ce qu'a publié l'app **Ma Maison** dans `app/maison_alerts` : entretiens en retard ou à moins de 30 jours et garanties qui expirent (avec leur date, aussi dans le calendrier du mois), puis les tâches du calendrier de saison du mois restant à faire. Un appui ouvre Ma Maison. Détail dans `js/features/linked-apps.js`.

⚠️ **Étape unique à faire manuellement** : comme pour Garage, le chemin `maison_alerts` doit être autorisé dans les règles Firebase de Carnet. `database.rules.json` est à jour : copiez son contenu dans la console Firebase (Realtime Database → Règles → coller → Publier).

## Pop-up de démarrage (tâches et entretiens en retard)

Au lancement de l'app, s'il existe des tâches en retard (échéance passée, non cochées) et/ou des entretiens en retard remontés par Garage (`garage_alerts`, niveau « en retard »), une fenêtre s'ouvre automatiquement pour les passer en revue une par une (« Suivant » puis « Terminé » ; « Voir cette tâche » pour les tâches, qui ouvre l'accueil directement dessus). Un seul passage par session. Si Garage ne répond pas sous 2,5 s (hors ligne, jamais utilisé), le pop-up s'affiche tout de même avec les seules tâches en retard. Détail dans `js/features/overdue-prompt.js`.

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

À l'ouverture de l'app, le planning hebdomadaire (onglet Entraînement → Cette semaine) défile automatiquement jusqu'à la carte du jour, plutôt que de rester sur le lundi de la semaine affichée.
