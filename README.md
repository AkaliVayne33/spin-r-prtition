# Spin Variance Lab

Outil local pour calculer l'EV et simuler la variance des formats jackpot à 3 joueurs (Spin & Go, Expresso, Twister…). Il fait le même travail que Swongsim, avec une interface plus claire et un modèle plus complet.

**Lancement :** double-clic sur `index.html`. Pas d'installation, pas de serveur, pas d'internet. La simulation tourne en parallèle sur tous les cœurs du processeur (Web Workers).

## Grilles intégrées

Ces grilles ont été recopiées des pages officielles le 03/11/2026. Le rake implicite de chacune est identique au rake annoncé par la room, ce qui confirme que la saisie est juste (un test automatique le vérifie).

| Room | Buy-ins | Source |
|---|---|---|
| Winamax Expresso | 0,25 € → 500 € | winamax.fr/expresso |
| Unibet Power Spin | 1 € → 250 € | unibet.fr/paris-sportifs/poker-power-spin |
| PMU Twister | 0,25 € → 100 € | poker.pmu.fr/twister |
| Betclic Twister | 0,20 € → 200 € | betclic.fr (tableaux 0,20–100 € et 200 €) |

- PMU 0,25 € : le tableau publié par PMU totalise 99 %, les fréquences sont donc renormalisées.
- Betclic : le tapis de départ n'est pas indiqué sur la page. L'outil met 500 jetons par défaut, à vérifier dans le client.
- **PokerStars.fr** ne publie pas de tableau accessible en ligne. Saisis-le depuis le client de jeu dans l'onglet Grille, puis clique sur « Enregistrer dans Mes grilles ».
- Les rooms changent leurs grilles et lancent des promos (jackpots boostés). En cas de doute, revérifie sur la page source indiquée sous le buy-in.

## Modes

- **Simple** (par défaut) : room, buy-in, cEV, nombre de parties sur lesquelles le cEV a été mesuré, rakeback en %, volume et bankroll. Tout le reste prend des valeurs standard. Les réglages experts restent enregistrés, mais ne sont pas utilisés.
- **Expert** : cEV par tranche, modèle pour la 2e place, rakeback par paliers, bonus, réglages de simulation, analyse de chance, import/export.

## Ce que fait l'outil

| Onglet | Contenu |
|---|---|
| **Grille** | Éditeur de multiplicateurs (multiplicateur ou prix fixe en €, fréquence, répartition 1er/2e/3e). Calcul du **rake caché** réel = 1 − E[m]/3. Presets personnels, import/export JSON, import CSV. |
| **Analyse EV** | Calcul exact, sans simulation : EV et ROI avec et sans rakeback, EV horaire, ROI hors jackpots, poids des jackpots, probabilité d'en toucher un, cEV de break-even, contribution de chaque multiplicateur. |
| **Simulation** | Monte Carlo : bandes de percentiles des trajectoires, distribution du résultat final, pire downswing, breakeven stretch, risque de ruine selon la bankroll, bankroll nécessaire pour 10 %, 5 % ou 1 % de ruine. |
| **Comparatif** | Scénarios enregistrés côte à côte (rooms, buy-ins, cEV…), export CSV. |
| **Analyse de chance** | Tes résultats réels comparés à l'EV, avec l'écart séparé en chance sur les multiplicateurs et chance sur les places. Probabilité binomiale de chaque écart. |
| **Méthode** | Formules et hypothèses. |

## Paramètres

- **Grille :** buy-in total (fee comprise), tapis de départ, fee nominale (sert de base au rakeback), lignes de multiplicateurs.
- **Profil :**
  - cEV global, ou par tranche de multiplicateur.
  - Modèle pour la 2e place : Harville ou tes stats réelles.
  - Incertitude sur le cEV : nombre de parties ayant servi à le mesurer, et écart-type des jetons.
- **Rakeback :** % de la fee, montant fixe, ou paliers selon le volume mensuel. Les bonus et leaderboards s'ajoutent en € par partie.
- **Simulation :** nombre de parties, nombre de trajectoires, bankroll, parties par heure, seuil « jackpot », graine (pour des résultats reproductibles), lissage des jackpots.

## Modèle (résumé)

1. **P(1er) = (S + cEV) / 3S.** Exact, par conservation des jetons.
2. **P(2e) et P(3e).** Le cEV ne suffit pas à les déterminer. On utilise soit le modèle de Malmuth-Harville, P(2e) = 2x(1−x)/(1+x), soit tes stats réelles. Cela ne compte que pour les multiplicateurs qui paient le 2e et le 3e.
3. **Profit par partie** = prix − buy-in + rakeback + bonus.
4. **Incertitude sur le cEV.** Chaque trajectoire tire un « vrai » cEV selon N(cEV, σ/√n). Sans ça, la variance et le risque de ruine sont sous-estimés.
5. **Ruine** = bankroll + pire cumul < buy-in, sans changer de limite pendant la trajectoire.
6. **Jackpots rares.** La moyenne simulée converge mal vers l'EV théorique. Compare toujours les deux, et regarde le ROI hors jackpots, qui est une espérance conditionnelle à ce qu'aucun jackpot ne tombe.

## Format CSV

```
multiplicateur;fréquence;%1er;%2e;%3e;prix_fixe_€
2;750000;100
1000;100;80;12;8
```

Séparateurs acceptés : `;`, tabulation ou `,`. Les colonnes après la fréquence sont optionnelles (par défaut 100 / 0 / 0, sans prix fixe). Les lignes d'en-tête sont ignorées.

## Tests

```
node --test tests/model.test.js
```

## Structure

```
index.html         page unique
css/style.css      thème clair/sombre (variables CSS)
js/model.js        moteur de calcul pur (EV, simulation, stats, chance)
js/sim.js          pool de Web Workers (Blob) + repli thread principal
js/charts.js       graphiques canvas (bandes, histogramme, courbe)
js/presets.js      grilles intégrées + état par défaut
js/app.js          interface, liaisons formulaire ↔ état, persistance localStorage
tests/             tests Node du moteur
```

Les réglages sont sauvegardés dans le navigateur (localStorage). Utilise **Exporter config** pour en garder une copie.
