/*
 * Configuration Firebase (application Web).
 *
 * ⚠️ Ces valeurs ne sont PAS des secrets : Firebase les conçoit pour être
 * publiques et embarquées dans le navigateur. La sécurité des données repose
 * uniquement sur les règles de la Realtime Database (voir database.rules.json
 * et le README). Ne placez jamais ici de clé de compte de service (Admin SDK).
 */
export const FIREBASE_SDK_VERSION = '12.19.0';

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDFeBr47Vcji_5WNTiwQ9MtpxF4_AbAnvE',
  authDomain: 'dashboard---projet.firebaseapp.com',
  projectId: 'dashboard---projet',
  storageBucket: 'dashboard---projet.firebasestorage.app',
  messagingSenderId: '990150166669',
  appId: '1:990150166669:web:be185ca24e231f0bb5bac4',
  databaseURL: 'https://dashboard---projet-default-rtdb.europe-west1.firebasedatabase.app'
};

/** Nœud racine des données de l'application dans la base. */
export const DB_ROOT = 'app';
