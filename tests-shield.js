"use strict";
/**
 * Copa Tejas Shield invariants. Pure-function tests on synthetic games, then
 * consistency checks on the published shield.json and its rendered page.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const shieldModule = require("./ingest/shield.js");
const renderShield = require("./render-shield.js");

const { accumulateClubRecord, rankClubs, compareForShield, isCompletedLeagueGame, LEAGUES, TEXAS_CLUBS } = shieldModule;

// --- Configuration sanity -----------------------------------------------------
const configuredIds = TEXAS_CLUBS.map((club) => club.id);
assert.equal(new Set(configuredIds).size, configuredIds.length, "club IDs must be unique");
for (const club of TEXAS_CLUBS) assert.ok(LEAGUES[club.league], `unknown league for ${club.name}: ${club.league}`);
assert.ok(TEXAS_CLUBS.some((club) => club.id === "ATX" && club.league === "mls"), "Austin FC must be configured");
assert.ok(!LEAGUES.mlsnp.eligible && LEAGUES.mls.eligible, "reserve league must be ineligible, MLS eligible");

// --- Record accumulation on synthetic games -----------------------------------
const club = { id: "T", asaTeamId: "team-t" };
const names = { "team-t": "Test FC", "team-a": "Alpha", "team-b": "Beta" };
const game = (home, away, hs, as, extra = {}) => ({
  game_id: `${home}-${away}-${hs}${as}`,
  date_time_utc: "2026-05-02 01:00:00 UTC",
  home_team_id: home,
  away_team_id: away,
  home_score: hs,
  away_score: as,
  knockout_game: false,
  ...extra,
});
const games = [
  game("team-t", "team-a", 2, 1), // home win
  game("team-b", "team-t", 1, 1), // away draw (shootout in Next Pro must still be a draw)
  game("team-t", "team-b", 0, 3), // home loss
  game("team-a", "team-b", 4, 0), // does not involve T
  game("team-t", "team-a", 5, 0, { knockout_game: true }), // playoff: excluded
  game("team-t", "team-a", null, null), // unplayed: excluded
];
assert.equal(isCompletedLeagueGame(games[4]), false, "knockout games must not count");
assert.equal(isCompletedLeagueGame(games[5]), false, "unplayed games must not count");
const record = accumulateClubRecord(club, games, names);
assert.deepEqual(
  { gp: record.gp, w: record.w, d: record.d, l: record.l, gf: record.gf, ga: record.ga, pts: record.pts },
  { gp: 3, w: 1, d: 1, l: 1, gf: 3, ga: 5, pts: 4 }
);
assert.equal(record.results.length, 3);
assert.equal(record.results[0].opponent, "Alpha");
assert.equal(record.results[0].date, "2026-05-01", "01:00 UTC must map to the previous local date");
assert.deepEqual(record.results.map((r) => r.result), ["W", "D", "L"]);

// --- Ranking ------------------------------------------------------------------
const mk = (id, league, gp, pts, gf, ga, name = id) => ({ id, name, league, gp, pts, gf, ga, w: 0, d: 0, l: 0, results: [] });
const ranked = rankClubs([
  mk("A", "mls", 10, 20, 15, 10, "Alpha"), // 2.00
  mk("B", "uslc", 4, 8, 10, 2, "Beta"), // 2.00, better GD/game -> above A
  mk("C", "nwsl", 20, 30, 20, 20, "Gamma"), // 1.50
  mk("R", "mlsnp", 10, 30, 30, 0, "Reserve"), // 3.00 but reserve league
  mk("Z", "usl1", 0, 0, 0, 0, "Zero"), // unplayed: dropped
]);
assert.deepEqual(ranked.standings.map((c) => c.id), ["B", "A", "C"], "PPG then GD per game must order the table");
assert.deepEqual(ranked.standings.map((c) => c.rank), [1, 2, 3]);
assert.deepEqual(ranked.reserveStandings.map((c) => c.id), ["R"], "reserve sides rank separately");
assert.ok(!ranked.standings.some((c) => c.id === "Z"), "a club with no games must not be ranked");
assert.equal(ranked.standings[0].ppg, 2);
assert.ok(compareForShield({ ppg: 1, gdPerGame: 0, gfPerGame: 1, name: "a" }, { ppg: 1, gdPerGame: 0, gfPerGame: 2, name: "b" }) > 0, "goals for per game breaks GD ties");
assert.ok(compareForShield({ ppg: 1, gdPerGame: 0, gfPerGame: 1, name: "a" }, { ppg: 1, gdPerGame: 0, gfPerGame: 1, name: "b" }) < 0, "name is the final deterministic tiebreak");

// --- Published snapshot -------------------------------------------------------
const snapshotPath = path.join(__dirname, "shield.json");
if (fs.existsSync(snapshotPath)) {
  const shield = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.ok(shield.standings.length > 0, "snapshot has no ranked clubs");
  assert.equal(shield.holder, shield.standings[0].id, "holder must be the top-ranked club");
  let latestDate = "";
  for (const [index, entry] of [...shield.standings, ...shield.reserveStandings].entries()) {
    assert.equal(entry.w + entry.d + entry.l, entry.gp, `W+D+L != GP for ${entry.name}`);
    assert.equal(3 * entry.w + entry.d, entry.pts, `points do not match record for ${entry.name}`);
    assert.ok(Math.abs(entry.ppg - entry.pts / entry.gp) < 1e-3, `PPG mismatch for ${entry.name}`);
    assert.equal(entry.gd, entry.gf - entry.ga, `GD mismatch for ${entry.name}`);
    assert.equal(entry.results.length, entry.gp, `results list does not match GP for ${entry.name}`);
    assert.ok(entry.form.length <= 5 && entry.form.every((r) => "WDL".includes(r)), `bad form for ${entry.name}`);
    for (const r of entry.results) if (r.date > latestDate) latestDate = r.date;
    void index;
  }
  assert.equal(shield.asOf, latestDate, "asOf must be the latest completed Texas-club match");
  for (let i = 1; i < shield.standings.length; i++) {
    assert.equal(shield.standings[i].rank, i + 1, "ranks must be contiguous");
    assert.ok(compareForShield(shield.standings[i - 1], shield.standings[i]) <= 0, "standings must be sorted by the tiebreak order");
  }
  for (const entry of shield.standings) assert.ok(shield.leagues[entry.league].eligible, `${entry.name} is in an ineligible league`);
  for (const entry of shield.reserveStandings) assert.ok(!shield.leagues[entry.league].eligible, `${entry.name} should not be a reserve row`);
  const template = fs.readFileSync(path.join(__dirname, "shield-template.html"), "utf8");
  const html = renderShield(template, shield);
  assert.ok(!html.includes("{{"), "rendered page has unfilled slots");
  assert.ok(html.includes(shield.standings[0].name), "rendered page must name the holder");
  assert.ok(html.includes("Shield holder"), "rendered page must badge the holder");
  const published = fs.readFileSync(path.join(__dirname, "shield.html"), "utf8");
  assert.equal(published, html, "shield.html is stale relative to shield.json; run `npm run shield -- --force`");
}

console.log("PASS: shield configuration, record accumulation, exclusions, ranking, snapshot and render checks.");
