# CLAUDE.md

Outil perso de calcul d'EV et de simulation de variance pour les formats jackpot à 3 joueurs (Spin & Go, Expresso, Twister). Voir README.md pour le contenu fonctionnel.

## Contraintes d'architecture

- **Zéro dépendance, zéro build.** L'outil doit marcher en ouvrant `index.html` en `file://`. Pas de modules ES (`type="module"` est bloqué en `file://`), pas de CDN, pas de npm. Les scripts sont des scripts classiques chargés dans l'ordre de `index.html`.
- **`js/model.js` est pur et autonome.** Tout tient dans `spinModelFactory()` : pas de DOM, pas de variables extérieures à la factory. Sa source est injectée telle quelle dans les Web Workers via `spinModelFactory.toString()` (voir `js/sim.js`). Toute référence à un symbole extérieur casse les workers. Le fichier est aussi chargé par les tests Node (`module.exports` en fin de fichier).
- **Style ES5** dans `js/` (`var`, `function`), pour rester cohérent avec le code existant. Les tests peuvent utiliser de l'ES moderne.
- **Liaison UI.** Un élément `data-bind="chemin.dans.state"` est synchronisé automatiquement (`onBoundInput` → `setPath` → `refreshAll`). Les tableaux qui contiennent des champs (grille, tranches, paliers, chance) ne sont reconstruits que lors d'un changement de structure. Sinon, seules les cellules dérivées sont mises à jour, pour ne pas faire perdre le focus.
- **Couleurs.** Uniquement via les variables CSS de `css/style.css` (`--viz-*` pour les graphiques). Le mode sombre est défini deux fois : media query avec la garde `:not([data-theme="light"])`, et `[data-theme="dark"]`.

## Conventions du modèle

- `buyIn` = buy-in total payé (fee comprise). Prize pool = `mult × buyIn`, ou `prize` s'il est > 0.
- Rake réel = caché dans la grille (`tableStats`). La fee nominale ne sert que de base au rakeback.
- P(1er) = (S + cEV) / 3S. P(2e) vient du modèle Harville ou est saisi (`placeProbs`).
- Le rakeback et les bonus sont un montant constant ajouté au profit de chaque partie (`rbPerGame`).
- Ruine = `bankroll < max(0, −pire cumul) + buyIn`.
- `evNoJackpot` est une espérance **conditionnelle** (renormalisée sur les lignes hors jackpot).

## Vérifier un changement

```
node --test tests/model.test.js
```

Pour l'interface : ouvrir `index.html` et lancer une simulation. Avec Playwright (Python), on peut charger la page en `file://`, cliquer sur `#btn-run`, attendre que `#sim-status` commence par « Terminé », puis vérifier qu'il n'y a aucune erreur console.

## Modes simple / expert

- `state.ui.mode` vaut `'simple'` ou `'expert'`. En mode simple, la classe `body.mode-simple` masque tout élément `.adv-only`, et `.simple-only` n'est visible qu'en mode simple.
- Les calculs passent **toujours** par `effProfile()`, `effRb()` et `effSim()` (dans `app.js`), jamais directement par `state.profile`, `state.rb` ou `state.sim`. En mode simple, ces fonctions renvoient des valeurs standard (`SPIN_SIMPLE_SIM` dans `presets.js`), sans modifier les réglages experts enregistrés.

## Données

- Les grilles officielles (Winamax, Unibet, PMU, Betclic) sont dans `js/presets.js`, avec leur `source` et leur date `checked`. Pour les mettre à jour, il faut les recopier depuis la page source. Chez PMU, les tableaux sont des images, qu'il faut ouvrir dans un navigateur pour les lire.
- Le test « grilles officielles » vérifie que le rake implicite de chaque grille est égal au `feePct` annoncé. Une faute de frappe dans une fréquence le fait échouer.
- Ne jamais présenter une grille comme officielle sans source. PokerStars.fr n'a pas de tableau public : on ne l'invente pas. Betclic bloque les robots : ses tableaux viennent de captures fournies par l'utilisateur.
