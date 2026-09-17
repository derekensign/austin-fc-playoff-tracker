"use strict";
/**
 * Copa Tejas Shield: every professional club in Texas, men's and women's, across
 * every league, ranked by points per game in league play. The top club holds the
 * Shield. This mirrors the supporter-run competition at copatejas.com, which
 * publishes the same ranking by hand; we compute it from the results feed.
 *
 * Design notes:
 *
 *   * Records are rebuilt from each league's full game log every run (same
 *     self-healing approach as the playoff forecast). Nothing is patched.
 *
 *   * Leagues are on different calendars. MLS, NWSL and the USL men's leagues run
 *     spring to autumn; the USL Super League runs autumn to spring. Each club is
 *     ranked on its league's CURRENT season, whatever ASA calls it, so early in a
 *     season a club can sit on a handful of games. Games played is shown for
 *     exactly that reason.
 *
 *   * Points are a uniform 3/1/0 on the 90-minute result in every league. MLS
 *     Next Pro settles drawn matches with a shootout and awards 2/1; we ignore
 *     that so that a point means the same thing in every row.
 *
 *   * Cup and playoff matches never count. ASA flags them as knockout_game.
 *
 *   * Clubs are configured by ASA's opaque team_id, which is stable, rather than
 *     by name or abbreviation. Two Houston clubs share the abbreviation "HOU".
 */

const fs = require("node:fs");
const path = require("node:path");

const { fetchAsaJson, matchLocalDate } = require("./asa.js");

const PROJECT_ROOT = process.env.VERDE_PROJECT_ROOT || path.join(__dirname, "..");
const SHIELD_DATA_FILE = "shield.json";
const SHIELD_PAGE_FILE = "shield.html";
const SHIELD_TEMPLATE_FILE = "shield-template.html";
const RECENT_RESULTS_SHOWN = 5;

/**
 * Leagues the Shield draws from. `eligible` marks the first-team professional
 * leagues that count for the Shield itself; reserve leagues are tracked but
 * ranked separately so a second team can never hold the trophy.
 */
const LEAGUES = {
  mls: { name: "Major League Soccer", shortName: "MLS", division: 1, gender: "men", eligible: true },
  nwsl: { name: "National Women's Soccer League", shortName: "NWSL", division: 1, gender: "women", eligible: true },
  uslc: { name: "USL Championship", shortName: "USLC", division: 2, gender: "men", eligible: true },
  usls: { name: "USL Super League", shortName: "USLS", division: 1, gender: "women", eligible: true },
  usl1: { name: "USL League One", shortName: "USL1", division: 3, gender: "men", eligible: true },
  mlsnp: { name: "MLS Next Pro", shortName: "MLSNP", division: 3, gender: "men", eligible: false, reserve: true },
};

/**
 * Every professional club based in Texas, by ASA team_id.
 * A club with no completed game in its league's current season (a defunct or
 * not-yet-started side) is reported under `inactiveClubs` rather than ranked.
 */
const TEXAS_CLUBS = [
  { id: "ATX", asaTeamId: "gpMOLwl5zy", name: "Austin FC", city: "Austin", league: "mls" },
  { id: "DAL", asaTeamId: "mKAqBBmqbg", name: "FC Dallas", city: "Frisco", league: "mls" },
  { id: "HOU", asaTeamId: "YgOMngl5wN", name: "Houston Dynamo FC", city: "Houston", league: "mls" },
  { id: "DASH", asaTeamId: "4JMAk47qKg", name: "Houston Dash", city: "Houston", league: "nwsl" },
  { id: "ELP", asaTeamId: "7VqGLwzQvW", name: "El Paso Locomotive FC", city: "El Paso", league: "uslc" },
  { id: "SA", asaTeamId: "7vQ7x3YMD1", name: "San Antonio FC", city: "San Antonio", league: "uslc" },
  // RGV and Texoma have played no 2026 league match in the feed; they stay configured so
  // they rank automatically if they return, and are reported as inactive until then.
  { id: "RGV", asaTeamId: "ljqEJ7OQx0", name: "Rio Grande Valley FC Toros", city: "Edinburg", league: "uslc" },
  { id: "DTFC", asaTeamId: "2vQ1y44QrA", name: "Dallas Trinity FC", city: "Dallas", league: "usls" },
  { id: "TXO", asaTeamId: "Oa5wbm8M14", name: "Texoma FC", city: "Sherman", league: "usl1" },
  { id: "CRP", asaTeamId: "e7MzzaKMr0", name: "Corpus Christi FC", city: "Corpus Christi", league: "usl1" },
  // FC Dallas's reserve side. ASA also lists this team_id under USL League One; if it
  // ever plays there, the unconfigured-Texas-club warning below will say so.
  { id: "NTX", asaTeamId: "ljqE94Vqx0", name: "North Texas SC", city: "Arlington", league: "mlsnp", reserveOf: "DAL" },
  { id: "ATX2", asaTeamId: "eV5Dw4EMKn", name: "Austin FC II", city: "Austin", league: "mlsnp", reserveOf: "ATX" },
  { id: "HOU2", asaTeamId: "gOMnJnOMwN", name: "Houston Dynamo FC 2", city: "Houston", league: "mlsnp", reserveOf: "HOU" },
];

/** Catches a Texas club ASA adds that nobody has configured yet. Warns, never fails. */
const TEXAS_NAME_PATTERN =
  /austin|dallas|houston|san antonio|el paso|rio grande|texoma|corpus christi|fort worth|north texas|texas|laredo|lubbock|mcallen|frisco|arlington|plano|galveston|waco/i;

/** @param {object} asaGame */
function isCompletedLeagueGame(asaGame) {
  return (
    !asaGame.knockout_game &&
    asaGame.home_score !== null &&
    asaGame.home_score !== undefined &&
    asaGame.away_score !== null &&
    asaGame.away_score !== undefined
  );
}

/**
 * The season a league is currently in is the one holding its most recently
 * completed game. Fetching by season keeps the payload small; the unfiltered
 * fallback covers the off-season and any label ASA uses that we did not guess.
 *
 * @param {string} league
 * @param {number} calendarYear
 * @returns {Promise<{seasonName: string, games: object[]}>}
 */
async function fetchCurrentSeasonGames(league, calendarYear) {
  const candidateSeasonNames = [
    String(calendarYear),
    `${calendarYear - 1}-${String(calendarYear).slice(2)}`,
    `${calendarYear}-${String(calendarYear + 1).slice(2)}`,
  ];
  let bestCandidate = null;
  for (const seasonName of candidateSeasonNames) {
    const games = await fetchAsaJson(`/games?season_name=${encodeURIComponent(seasonName)}`, league);
    const completed = Array.isArray(games) ? games.filter(isCompletedLeagueGame) : [];
    if (completed.length === 0) continue;
    const latest = completed.reduce((max, g) => (g.date_time_utc > max ? g.date_time_utc : max), "");
    if (!bestCandidate || latest > bestCandidate.latest) bestCandidate = { seasonName, games, latest };
  }
  if (bestCandidate) return { seasonName: bestCandidate.seasonName, games: bestCandidate.games };

  const allGames = await fetchAsaJson("/games", league);
  const completed = (Array.isArray(allGames) ? allGames : []).filter(isCompletedLeagueGame);
  if (completed.length === 0) throw new Error(`ASA ${league} has no completed games at all`);
  const latestGame = completed.reduce((max, g) => (g.date_time_utc > max.date_time_utc ? g : max));
  const seasonName = String(latestGame.season_name);
  return { seasonName, games: allGames.filter((g) => String(g.season_name) === seasonName) };
}

/**
 * Pure: one club's record and result list from its league's completed games.
 *
 * @param {{id:string, asaTeamId:string}} club
 * @param {object[]} leagueGames raw ASA games for one season
 * @param {Record<string,string>} teamNamesById ASA team_id -> display name
 * @returns {{gp:number,w:number,d:number,l:number,gf:number,ga:number,pts:number,results:object[]}}
 */
function accumulateClubRecord(club, leagueGames, teamNamesById) {
  const record = { gp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, results: [] };
  for (const game of leagueGames) {
    if (!isCompletedLeagueGame(game)) continue;
    const isHome = game.home_team_id === club.asaTeamId;
    const isAway = game.away_team_id === club.asaTeamId;
    if (!isHome && !isAway) continue;
    const scored = Number(isHome ? game.home_score : game.away_score);
    const conceded = Number(isHome ? game.away_score : game.home_score);
    const result = scored > conceded ? "W" : scored === conceded ? "D" : "L";
    record.gp += 1;
    record.gf += scored;
    record.ga += conceded;
    record.w += result === "W" ? 1 : 0;
    record.d += result === "D" ? 1 : 0;
    record.l += result === "L" ? 1 : 0;
    record.pts += { W: 3, D: 1, L: 0 }[result];
    const opponentId = isHome ? game.away_team_id : game.home_team_id;
    record.results.push({
      gameId: game.game_id,
      date: matchLocalDate(game.date_time_utc),
      home: isHome,
      opponent: teamNamesById[opponentId] || opponentId,
      gf: scored,
      ga: conceded,
      result,
    });
  }
  record.results.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return record;
}

/**
 * Points per game, then goal difference per game, then goals for per game, then
 * name. Cross-league head-to-head is impossible, so per-game goal figures stand
 * in for the official competition's deeper tiebreakers.
 */
function compareForShield(a, b) {
  return (
    b.ppg - a.ppg ||
    b.gdPerGame - a.gdPerGame ||
    b.gfPerGame - a.gfPerGame ||
    a.name.localeCompare(b.name)
  );
}

/** @param {number} value */
function round(value, places = 4) {
  return Number(value.toFixed(places));
}

/**
 * Pure: turn per-club records into the ranked Shield table.
 *
 * @param {Array<object>} clubRecords clubs with league, gp, w, d, l, gf, ga, pts
 * @returns {{standings: object[], reserveStandings: object[]}}
 */
function rankClubs(clubRecords) {
  const decorate = (club) => ({
    ...club,
    gd: club.gf - club.ga,
    ppg: round(club.pts / club.gp),
    gdPerGame: round((club.gf - club.ga) / club.gp),
    gfPerGame: round(club.gf / club.gp),
    form: club.results.slice(-RECENT_RESULTS_SHOWN).map((r) => r.result),
  });
  const rank = (list) => list.sort(compareForShield).map((club, index) => ({ ...club, rank: index + 1 }));
  const active = clubRecords.filter((club) => club.gp > 0).map(decorate);
  return {
    standings: rank(active.filter((club) => LEAGUES[club.league].eligible)),
    reserveStandings: rank(active.filter((club) => !LEAGUES[club.league].eligible)),
  };
}

/**
 * Fetch every league and build the Shield snapshot. Network + pure transform.
 *
 * @param {{calendarYear?: number}} [options]
 * @returns {Promise<object>} the shield.json payload
 */
async function buildShield(options = {}) {
  const calendarYear = options.calendarYear ?? new Date().getUTCFullYear();
  const leagueSlugs = Object.keys(LEAGUES);

  // All leagues in parallel: ASA is slow per request, not rate-limited.
  const leagueFetches = await Promise.all(
    leagueSlugs.map(async (league) => {
      const [teams, season] = await Promise.all([
        fetchAsaJson("/teams", league),
        fetchCurrentSeasonGames(league, calendarYear),
      ]);
      if (!Array.isArray(teams) || teams.length === 0) throw new Error(`ASA ${league} /teams returned no teams`);
      return { league, teams, ...season };
    })
  );

  const warnings = [];
  const leagues = {};
  const clubRecords = [];
  const inactiveClubs = [];

  for (const { league, teams, seasonName, games } of leagueFetches) {
    const teamNamesById = Object.fromEntries(teams.map((t) => [t.team_id, t.team_name]));
    const completed = games.filter(isCompletedLeagueGame);
    const latestResult = completed.reduce((max, g) => {
      const date = matchLocalDate(g.date_time_utc);
      return date > max ? date : max;
    }, "");
    const draws = completed.filter((g) => Number(g.home_score) === Number(g.away_score)).length;
    leagues[league] = {
      ...LEAGUES[league],
      season: seasonName,
      completedGames: completed.length,
      drawPct: completed.length ? round((100 * draws) / completed.length, 1) : 0,
      latestResult,
    };

    const configured = TEXAS_CLUBS.filter((club) => club.league === league);
    for (const club of configured) {
      const record = accumulateClubRecord(club, games, teamNamesById);
      const entry = { ...club, season: seasonName, ...record };
      delete entry.asaTeamId;
      if (record.gp === 0) inactiveClubs.push({ id: club.id, name: club.name, league, season: seasonName });
      else clubRecords.push(entry);
    }

    // A Texas-named club that has played this season but is not configured.
    const configuredIds = new Set(configured.map((club) => club.asaTeamId));
    const activeTeamIds = new Set(completed.flatMap((g) => [g.home_team_id, g.away_team_id]));
    for (const team of teams) {
      if (configuredIds.has(team.team_id) || !activeTeamIds.has(team.team_id)) continue;
      if (TEXAS_NAME_PATTERN.test(team.team_name)) {
        warnings.push(`Unconfigured Texas-named club in ${league}: ${team.team_name} (${team.team_id})`);
      }
    }
  }

  // One club, one row: a side ASA lists in two leagues keeps the league it played in.
  const seenClubIds = new Set();
  const dedupedRecords = [];
  for (const record of clubRecords) {
    if (seenClubIds.has(record.id)) {
      warnings.push(`${record.name} has current-season games in more than one league; keeping the first`);
      continue;
    }
    seenClubIds.add(record.id);
    dedupedRecords.push(record);
  }

  const { standings, reserveStandings } = rankClubs(dedupedRecords);
  if (standings.length === 0) throw new Error("No eligible Texas club has played a league game this season");

  const asOf = [...standings, ...reserveStandings]
    .flatMap((club) => club.results.map((r) => r.date))
    .reduce((max, date) => (date > max ? date : max), "");

  return {
    competition: "Copa Tejas Shield",
    asOf,
    source: "American Soccer Analysis",
    scoring: "3 points for a win, 1 for a draw, 0 for a loss, on the 90-minute result of every completed league match. Cup and playoff matches excluded.",
    tiebreakers: ["points per game", "goal difference per game", "goals for per game", "club name"],
    leagues,
    holder: standings[0].id,
    standings,
    reserveStandings,
    inactiveClubs,
    warnings,
  };
}

/** @param {string} fileName */
function readProjectFile(fileName) {
  return fs.readFileSync(path.join(PROJECT_ROOT, fileName), "utf8");
}

/** Sort keys so successive snapshots produce minimal, readable diffs in git. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
  return sorted;
}

/**
 * Fetch, compare with the published snapshot, and (unless dry-run) write
 * shield.json and shield.html.
 *
 * @param {{force?: boolean, dryRun?: boolean}} options
 * @returns {Promise<{changed: boolean, shield: object}>}
 */
async function ingestShield(options = {}) {
  let previousShield = null;
  try {
    previousShield = JSON.parse(readProjectFile(SHIELD_DATA_FILE));
  } catch (failure) {
    if (failure.code !== "ENOENT") throw failure;
  }

  const nextShield = await buildShield();
  const changed =
    !previousShield ||
    JSON.stringify(sortKeysDeep(previousShield)) !== JSON.stringify(sortKeysDeep(nextShield));

  if (!changed && !options.force) return { changed: false, shield: previousShield };
  if (options.dryRun) return { changed, shield: nextShield };

  const renderShield = require(path.join(PROJECT_ROOT, "render-shield.js"));
  const html = renderShield(readProjectFile(SHIELD_TEMPLATE_FILE), nextShield);
  if (html.includes("{{")) throw new Error("Unfilled Shield page template");

  fs.writeFileSync(path.join(PROJECT_ROOT, SHIELD_DATA_FILE), JSON.stringify(sortKeysDeep(nextShield), null, 2) + "\n");
  fs.writeFileSync(path.join(PROJECT_ROOT, SHIELD_PAGE_FILE), html);
  return { changed: true, shield: nextShield };
}

module.exports = {
  LEAGUES,
  TEXAS_CLUBS,
  accumulateClubRecord,
  buildShield,
  compareForShield,
  ingestShield,
  isCompletedLeagueGame,
  rankClubs,
  SHIELD_DATA_FILE,
  SHIELD_PAGE_FILE,
  SHIELD_TEMPLATE_FILE,
};

if (require.main === module) {
  const commandLineArguments = new Set(process.argv.slice(2));
  ingestShield({
    force: commandLineArguments.has("--force"),
    dryRun: commandLineArguments.has("--dry-run"),
  })
    .then(({ changed, shield }) => {
      console.log(`Copa Tejas Shield · results through ${shield.asOf}`);
      for (const club of shield.standings) {
        console.log(
          `  ${String(club.rank).padStart(2)}. ${club.name.padEnd(28)} ${club.league.toUpperCase().padEnd(6)}` +
            ` ${club.season.padEnd(8)} GP ${String(club.gp).padStart(2)}  ${club.w}-${club.d}-${club.l}` +
            `  GD ${String(club.gd).padStart(3)}  Pts ${String(club.pts).padStart(2)}  PPG ${club.ppg.toFixed(2)}`
        );
      }
      if (shield.reserveStandings.length) {
        console.log("  Reserve sides (not eligible):");
        for (const club of shield.reserveStandings) {
          console.log(`      ${club.name.padEnd(28)} ${club.league.toUpperCase().padEnd(6)} GP ${club.gp}  PPG ${club.ppg.toFixed(2)}`);
        }
      }
      for (const club of shield.inactiveClubs) console.log(`  inactive: ${club.name} (${club.league} ${club.season})`);
      for (const warning of shield.warnings) console.log(`  WARNING: ${warning}`);
      if (!changed) console.log("No change since the published snapshot.");
      else if (commandLineArguments.has("--dry-run")) console.log("Dry run — no files written.");
      else console.log(`Wrote ${SHIELD_DATA_FILE} and ${SHIELD_PAGE_FILE}.`);
    })
    .catch((failure) => {
      console.error("Shield ingest failed:", failure.message);
      process.exit(1);
    });
}
