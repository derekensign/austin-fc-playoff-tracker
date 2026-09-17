# Verde Run-In, model v2.3
Austin FC Western Conference playoff forecast. All figures are experimental model estimates.

The snapshot date lives in `data.json` (`asOf`) and the page renders it; this README no longer
hardcodes it, because the snapshot now refreshes automatically.

## Reproduce the forecast
The site has no external JavaScript dependencies. Save model.js and data.json in one directory, then run with Node:
```js
const fs = require('node:fs');
const model = require('./model.js');
const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
model.validate(data);
const report = model.simulate(data, {iterations: 50000, seed: Number(data.asOf.replaceAll('-', ''))});
console.log(report.atx, report.cutoff, report.unresolved);
```
Use `node tests.js` to run invariant tests against the saved snapshot.
Use `node refresh.js` after updating the input snapshot to regenerate report.json and index.html.

## Published files
- model.js: actual executable score and season simulation.
- data.json: all 30 teams' season records, all 80 remaining MLS fixtures involving Western teams, dated sources.
- report.json: baseline and six sensitivity runs, plus `nextMatch` (Austin's odds after each result
  of its next match), `rootingGuide` (every fixture in the first week of remaining play × home win /
  draw / away win → Austin's odds, ranked by swing), `schedule` (each Western club's remaining
  matches and expected points), and `baseline.pointsCurve` (P(top 9 | exact final total)).
- audit.json: review corrections, validation summary and explicit limitations.
- index.html, styles.css, app.js, worker.js: public dashboard and interactive conditional simulation.
- render.js and paths.js: page rendering and maximum-likelihood exact-target paths.
- template.html: server-rendered page template.
- refresh.js: recompute the forecast and render the page.
- ingest/: automated result ingestion (see Automated refresh below).
- shield.json, shield.html, render-shield.js, shield-template.html: the Copa Tejas Shield page.
- lambda/, template.yaml and deploy.sh: the hourly AWS refresh job.
- vercel.json: `cleanUrls`, so the Shield lives at `/shield`.

## Model
League-average goals per team-game = total GF / total GP. For each team, season GF/GP and GA/GP are shrunk toward that league average with 8 pseudo-games.
With `recentWeight` set, every club's rates are first blended with its last six completed matches
(`data.recentForm`); clubs without a form sample fall back to season rates. Expected home goals = home attack × away concession / league average × exp(0.13). Expected away goals use exp(-0.13). Scores follow two Poisson distributions with a Dixon–Coles low-score correction: the joint probabilities of 0–0, 1–0, 0–1 and 1–1 are scaled by `1−λμρ`, `1+μρ`, `1+λρ` and `1−ρ` and the table is renormalised. Independent Poissons under-produce draws (this season: 95 real draws in 372 matches vs ~85 modelled), and a negative ρ repairs exactly that. ρ is **fitted at every ingest** so the model reproduces the season's observed draw count on the season's actual fixtures, and stored in `data.calibration`; the model reads it from there, so snapshots without the block fall back to ρ = 0. One shared score per fixture updates both teams' points, wins and goals. Strengths are fixed. East-only matches therefore cannot affect Western results and are omitted.
Ranking priority: points, wins, GD, GF. Remaining ties are randomly ordered with the fixed seed, with an explicit Austin best/worst tie bound. Historical H2H, discipline and venue tiebreakers are not implemented. This is disclosed; do not describe all tiebreakers as exact.
The headline presents marginal medians of Austin points and Western place. These do not assert that the median point total necessarily yields the median rank in the same season.

## What the page shows
Beyond the headline odds: every club's finishing-position heatmap; standings with GD, GF, matches
left and expected points from them; a weekly rooting guide (which results this week move Austin's
odds, and which way); the points curve (how often each exact final total was enough); and Austin's
magic and tragic numbers, which are arithmetic rather than simulation. Conditional cells in the
rooting guide use 20,000 iterations under the same seed as everything else, so they are comparable
with each other; the headline stays at 50,000.

`simulate()` accepts `fixed` results for any fixture: `"H"`, `"D"`, `"A"` from the home side's view
on any match, or `"W"`, `"D"`, `"L"` from Austin's view on Austin's own matches.

## Scenarios
Baseline: 50,000 iterations, seed from `asOf`, priorGames 8, homeLog .13, calibrated drawRho, no form override.
Sensitivity: low-score correction off (ρ = 0); recent weight .2; priorGames 4 and 16; homeLog .08 and .18. Change one at a time.
Recent scenario blends every club's last six completed MLS matches, computed from the results feed rather than hand-entered.
User scenarios: 20,000 iterations with selected Austin W/D/L results. Scorelines are sampled conditional on each chosen result; rivals receive the same fixture outcome.
No validation against held-out seasons has been performed. These are not calibrated betting odds.

## Copa Tejas Shield (`/shield`)
A second page ranks every professional club in Texas, men's and women's, by points per game in
league play; the top club holds the Shield. It mirrors the supporter-run
[Copa Tejas](https://www.copatejas.com/) Shield, computed from the results feed rather than by hand,
and adds the USL League One clubs the official table omits.

- `ingest/shield.js`: fetches MLS, NWSL, USL Championship, USL Super League, USL League One and MLS
  Next Pro from ASA, picks each league's current season (the one holding its latest completed game,
  so the autumn–spring Super League is handled), rebuilds every Texas club's record from the full
  game log, and writes `shield.json` + `shield.html`. Clubs are configured by ASA `team_id`; a
  Texas-named club that plays without being configured raises a warning in the data, never a failure.
- Scoring is a uniform 3/1/0 on the 90-minute result of completed league matches; cups, playoffs
  and Next Pro shootout bonuses are excluded. Tiebreakers: PPG, GD per game, GF per game, name.
- MLS Next Pro sides (Austin FC II, Houston Dynamo FC 2, North Texas SC) are ranked in a separate
  reserve table and can never hold the Shield.
- `render-shield.js` + `shield-template.html` render the page; `tests-shield.js` checks the maths
  and that `shield.html` matches `shield.json`.

```shell
node ingest/shield.js --dry-run   # print the table, write nothing
node ingest/shield.js             # rebuild shield.json and shield.html
node ingest/shield.js --force     # rebuild even if nothing changed (after a template edit)
```

The hourly Lambda refreshes the Shield after the forecast. A Shield failure is logged and the
previous Shield stays published; it never blocks the forecast.

## Automated refresh
The forecast re-runs whenever any club we are competing with finishes a match, not just Austin.
A rival dropping points moves Austin's odds as much as Austin winning does.

```
EventBridge (hourly) -> Lambda -> ASA results -> rebuild data.json
  -> refresh.js -> commit to GitHub -> Vercel redeploys
```

Run it locally:

```shell
node ingest --dry-run   # report what would change, write nothing
node ingest             # rebuild data.json and regenerate the forecast
node tests.js           # invariants against the new snapshot
```

Results come from the [American Soccer Analysis](https://app.americansocceranalysis.com/) MLS API:
free, keyless, documented, and the same endpoint their `itscalledsoccer` client libraries use. We
send an identifying User-Agent as their policy asks. Every run rebuilds all 30 clubs' records from
the full season game log rather than patching the previous snapshot, so a missed hour or a corrected
scoreline self-heals on the next run.

### What is still manual
ASA publishes completed games only, so the **remaining-fixture list cannot be refreshed
automatically**. Ingestion only ever removes fixtures that have been played, matched on their
(home, away) pair. If MLS reschedules a match into or out of the run-in, `model.validate()` fails
the run with `Incomplete schedule <TEAM>` rather than publishing a wrong forecast, and `data.json`
needs a manual fixture edit. Postponements past the data boundary are moved to the next date both
clubs have free and disclosed in `data.notes`.

### Deploying the refresh job
Needs a GitHub fine-grained PAT with `contents:write` on this repository, stored in Secrets Manager:

```shell
AWS_PROFILE=personal aws secretsmanager create-secret \
  --name verde-run-in/github-token --secret-string 'github_pat_...'
AWS_PROFILE=personal ./deploy.sh
```

`deploy.sh` refuses to run against any account but the personal one, and fails before building if
the token secret is missing — an hourly job whose only output is a commit is worthless without it.

**Redeploy after any change to the model, template, or hand-edited fixtures.** The function runs
the copy of this repository that was packaged at deploy time, not the current `main`. Left stale,
the next result would republish the site from the old model and overwrite whatever was pushed.
The schedule is hardcoded in `template.yaml` rather than parameterised, because `sam deploy
--parameter-overrides` splits values on spaces and `rate(1 hour)` cannot survive that.

Force a publish even when nothing has changed:

```shell
aws lambda invoke --function-name verde-run-in-refresh \
  --payload '{"force":true}' --cli-binary-format raw-in-base64-out /dev/stdout
```

The function is a cheap no-op on most invocations, alarms after three consecutive failing hours, and
commits with a message naming the results that triggered it.
