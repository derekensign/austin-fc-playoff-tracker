# Verde Run-In, model v2.0
Snapshot: 2026-09-14. All figures are experimental model estimates.

## Reproduce the forecast
The site has no external JavaScript dependencies. Save model.js and data.json in one directory, then run with Node:
```js
const fs = require('node:fs');
const model = require('./model.js');
const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
model.validate(data);
const report = model.simulate(data, {iterations: 50000, seed: 20260914});
console.log(report.atx, report.cutoff, report.unresolved);
```
Use `node tests.js` to run invariant tests against the saved snapshot.
Use `node refresh.js` after updating the input snapshot to regenerate report.json and index.html.

## Published files
- model.js: actual executable score and season simulation.
- data.json: all 30 teams' season records, all 80 remaining MLS fixtures involving Western teams, dated sources.
- report.json: baseline and five sensitivity runs.
- audit.json: review corrections, validation summary and explicit limitations.
- index.html, styles.css, app.js, worker.js: public dashboard and interactive conditional simulation.
- source.json: complete source-file payload (excluding source.json itself); suitable for direct Vercel deployment. Includes update scripts.
- render.js and paths.js: page rendering and maximum-likelihood exact-target paths.
- template.html: server-rendered page template.
- refresh.js: recompute snapshot, render the page and regenerate source.json.

## Model
League-average goals per team-game = total GF / total GP. For each team, season GF/GP and GA/GP are shrunk toward that league average with 8 pseudo-games. Expected home goals = home attack × away concession / league average × exp(0.13). Expected away goals use exp(-0.13). Scores follow independent Poisson distributions. One shared score per fixture updates both teams' points, wins and goals. Strengths are fixed. East-only matches therefore cannot affect Western results and are omitted.
Ranking priority: points, wins, GD, GF. Remaining ties are randomly ordered with the fixed seed, with an explicit Austin best/worst tie bound. Historical H2H, discipline and venue tiebreakers are not implemented. This is disclosed; do not describe all tiebreakers as exact.
The headline presents marginal medians of Austin points and Western place. These do not assert that the median point total necessarily yields the median rank in the same season.

## Scenarios
Baseline: 50,000 iterations, seed 20260914, priorGames 8, homeLog .13, no form override.
Sensitivity: Austin recent weight .2; priorGames 4 and 16; homeLog .08 and .18. Change one at a time.
Recent scenario uses Austin's last six completed MLS matches, not a league-wide form fit. Refresh austinRecent on each update.
User scenarios: 20,000 iterations with selected Austin W/D/L results. Scorelines are sampled conditional on each chosen result; rivals receive the same fixture outcome.
No validation against held-out seasons has been performed. These are not calibrated betting odds.

## Updating after a match
1. Read the current public data.json to detect whether Austin has completed another MLS match. Use the latest verified result, not just a passage of time.
2. Refresh all team records and sources; do not add Austin points without updating its opponent and the rest of the table.
3. Refresh every Western club's remaining schedule including postponements. Each future intraconference fixture must have both clubs in listedBy.
4. Retain 34 matches per Western club, no duplicates, no impossible records, and league-wide goals/wins balance. Validation MUST pass.
5. Refresh the six-match Austin goals sample. Recompute reports using refresh.js; do not hand-edit probabilities or keep stale numbers.
6. Run tests.js, inspect the new report and page, retain all source files, and deploy the complete file payload to the existing project.
7. Direct Vercel deployment shape:
```js
deploy_to_vercel({
  name: "austin-fc-playoff-tracker",
  target: "production",
  files: [{file: "index.html", data: html}, /* every other public site file */]
})
```
Only include this site's public source and public soccer data. Do not upload unrelated files or secrets.
8. Preserve the existing public production alias. Report deployment success only on explicit READY confirmation; distinguish it from public HTTP verification and unattended-task verification.

## Publish to GitHub without the ChatGPT connector
Open export.html on the deployed site, download and extract the source ZIP, create a repository at https://github.com/new, then use Add file → Upload files to upload the extracted files to the repository root and commit. Upload files, not the ZIP archive itself. This saves the code; it does not automatically connect Vercel to GitHub. The existing Vercel site remains the production site.
