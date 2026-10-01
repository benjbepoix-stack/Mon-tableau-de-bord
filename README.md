# Carnet

Tableau de bord personnel (PWA installable sur iPhone) : rendez-vous, événements, tâches, notes, planning d'entraînement, courses et mesures physiques.
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
    persist.js              Attente de l'accusé de réception Firebase
  ui/                       Icônes SVG, modales, toasts, thème, pastille de synchro, graphiques
  views/                    dashboard, training, races, metrics
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

## Saison (phases d'entraînement)

L'onglet **Entraînement** a deux sous-onglets : **Cette semaine** (planning, bouton « Sports & séances ») et **Saison**.
La Saison permet de planifier ses phases : préparation générale (foncier), spécifique volume, spécifique intensité, spécifique allure course, spécifique mixte, affûtage, récupération, transition.
Elle affiche la phase en cours (avec l'orientation des séances), la prochaine course et un calendrier macro sur six mois (phases en couleur, courses cerclées de rouge ; un appui ouvre la semaine correspondante).
Le planning hebdomadaire montre la phase de chaque jour et les courses du calendrier.

Les phases sont enregistrées dans `objectives.seasonPhases` : ce nœud accepte déjà un contenu libre dans `database.rules.json`, aucune republication des règles n'est nécessaire.

## Tâches → app Rappels (iPhone)

Sur iPhone, chaque tâche datée et non terminée a un bouton cloche : il copie le titre et l’échéance (« Appeler le garage — samedi 3 octobre à 10:30 ») puis ouvre l’app Rappels, où il suffit de coller. Une page web ne peut pas créer elle-même un rappel.

## Mensurations sur mannequin

« Nouvelle prise de mensurations » ouvre une fenêtre avec une silhouette : chaque zone (poitrine, bras, taille, hanche, cuisse, mollet) est tracée sur le corps, la case de saisie est à côté et la consigne de mesure s’affiche quand on touche une zone ou une case. La valeur de la prise précédente est rappelée sous chaque case. Modifier une prise depuis l’historique rouvre le même mannequin.

## Mises à jour

`sw.js` (service worker) vérifie à chaque ouverture si les fichiers de l’app ont changé sur le serveur et garde la dernière version pour le mode hors ligne. Une version publiée sur GitHub Pages apparaît donc à la réouverture de l’app, sans attendre l’expiration du cache du navigateur.
