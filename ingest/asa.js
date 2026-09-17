"use strict";
/**
 * American Soccer Analysis (ASA) results provider.
 *
 * ASA publishes a free, keyless, documented API — the same one their own
 * `itscalledsoccer` R/Python client libraries consume, so automated use is the
 * intended use. We identify ourselves honestly in the User-Agent, as their
 * policy asks.
 *
 * Two things about this API that are easy to get wrong:
 *   1. Timestamps come back as "2026-09-14 01:00:00 UTC", which is NOT ISO-8601
 *      and will make `new Date()` / `Date.parse()` return NaN in Node.
 *   2. It only publishes COMPLETED games. There are no future fixtures here, so
 *      this provider can refresh results but never the remaining schedule.
 */

/**
 * ASA serves one API per league under the same root. The playoff forecast only
 * ever reads "mls"; the Copa Tejas Shield (ingest/shield.js) reads the others.
 */
const ASA_API_ROOT = "https://app.americansocceranalysis.com/api/v1";
const DEFAULT_LEAGUE = "mls";

/** ASA is slow — a full-season games query routinely takes ~30 seconds. */
const REQUEST_TIMEOUT_MS = 90000;
const REQUEST_RETRY_ATTEMPTS = 3;

const HONEST_USER_AGENT =
  "verde-run-in/2.1 (+https://github.com/derekensign/austin-fc-playoff-tracker; derekensign@gmail.com)";

/**
 * ASA abbreviations that differ from the team IDs used in data.json.
 * The other 25 clubs match exactly. Chivas USA (CHV) is defunct and is
 * excluded by virtue of never appearing in a current-season game.
 */
const ASA_ABBREVIATION_ALIASES = {
  FCD: "DAL",
  SJE: "SJ",
  NER: "NE",
  NYRB: "RBNY",
  DCU: "DC",
};

/**
 * Convert an ASA UTC timestamp to the match-local calendar date, matching the
 * convention data.json documents ("Dates are match-local calendar dates").
 *
 * Every MLS venue sits between UTC-4 and UTC-8 and no match kicks off before
 * midday local time, so a UTC hour below 12 always means the local date is the
 * previous UTC day. This is what maps "2026-09-14 01:00:00 UTC" (a San Diego
 * evening kickoff) back to 2026-09-13.
 *
 * @param {string} asaTimestamp e.g. "2026-09-14 01:00:00 UTC"
 * @returns {string} ISO calendar date, e.g. "2026-09-13"
 */
function matchLocalDate(asaTimestamp) {
  const isoLike = String(asaTimestamp).replace(" UTC", "").replace(" ", "T") + "Z";
  const parsedInstant = new Date(isoLike);
  if (Number.isNaN(parsedInstant.getTime())) {
    throw new Error(`Unparseable ASA timestamp: ${asaTimestamp}`);
  }
  if (parsedInstant.getUTCHours() < 12) {
    parsedInstant.setUTCDate(parsedInstant.getUTCDate() - 1);
  }
  return parsedInstant.toISOString().slice(0, 10);
}

/**
 * @param {string} endpointPath e.g. "/teams"
 * @param {string} [league] ASA league slug: mls, nwsl, uslc, usl1, usls, mlsnp
 * @returns {Promise<unknown>} parsed JSON body
 */
async function fetchAsaJson(endpointPath, league = DEFAULT_LEAGUE) {
  const requestUrl = `${ASA_API_ROOT}/${league}${endpointPath}`;
  let lastFailure;
  for (let attemptNumber = 1; attemptNumber <= REQUEST_RETRY_ATTEMPTS; attemptNumber++) {
    try {
      const response = await fetch(requestUrl, {
        headers: { "user-agent": HONEST_USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`ASA ${endpointPath} returned HTTP ${response.status}`);
      }
      return await response.json();
    } catch (failure) {
      lastFailure = failure;
      if (attemptNumber < REQUEST_RETRY_ATTEMPTS) {
        // Linear backoff is plenty; ASA's failures are latency, not rate limits.
        await new Promise((resolve) => setTimeout(resolve, 2000 * attemptNumber));
      }
    }
  }
  throw new Error(`ASA ${endpointPath} failed after ${REQUEST_RETRY_ATTEMPTS} attempts: ${lastFailure.message}`);
}

/**
 * Build a map from ASA's opaque team_id to our data.json team ID.
 * We key on team_id rather than abbreviation because the opaque IDs are stable
 * and the abbreviations are the part ASA could restyle.
 *
 * @returns {Promise<Record<string,string>>}
 */
async function fetchTeamIdMap() {
  const asaTeams = await fetchAsaJson("/teams");
  if (!Array.isArray(asaTeams) || asaTeams.length === 0) {
    throw new Error("ASA /teams returned no teams");
  }
  const teamIdToOurId = {};
  for (const asaTeam of asaTeams) {
    const abbreviation = asaTeam.team_abbreviation;
    if (!abbreviation) continue;
    teamIdToOurId[asaTeam.team_id] = ASA_ABBREVIATION_ALIASES[abbreviation] ?? abbreviation;
  }
  return teamIdToOurId;
}

/**
 * @typedef {object} CompletedGame
 * @property {string} gameId    ASA's stable game identifier
 * @property {string} date      match-local calendar date, "YYYY-MM-DD"
 * @property {string} home      our team ID, e.g. "ATX"
 * @property {string} away      our team ID
 * @property {number} homeGoals
 * @property {number} awayGoals
 */

/**
 * Fetch every completed regular-season game for a season, normalised to our
 * team IDs and match-local dates, sorted oldest-first.
 *
 * @param {string} seasonName e.g. "2026"
 * @param {Set<string>} knownTeamIds team IDs present in data.json, used to reject
 *   anything we cannot account for rather than silently dropping it
 * @returns {Promise<CompletedGame[]>}
 */
async function fetchCompletedGames(seasonName, knownTeamIds) {
  const [teamIdToOurId, asaGames] = await Promise.all([
    fetchTeamIdMap(),
    fetchAsaJson(`/games?season_name=${encodeURIComponent(seasonName)}`),
  ]);
  if (!Array.isArray(asaGames)) {
    throw new Error("ASA /games did not return an array");
  }

  const completedGames = [];
  const unmappedTeamIds = new Set();
  for (const asaGame of asaGames) {
    if (String(asaGame.season_name) !== String(seasonName)) continue;
    // Playoff games must never touch regular-season records.
    if (asaGame.knockout_game) continue;
    if (asaGame.home_score === null || asaGame.away_score === null) continue;

    const homeTeamId = teamIdToOurId[asaGame.home_team_id];
    const awayTeamId = teamIdToOurId[asaGame.away_team_id];
    if (!knownTeamIds.has(homeTeamId) || !knownTeamIds.has(awayTeamId)) {
      unmappedTeamIds.add(asaGame.home_team_id + "/" + asaGame.away_team_id);
      continue;
    }

    completedGames.push({
      gameId: asaGame.game_id,
      date: matchLocalDate(asaGame.date_time_utc),
      home: homeTeamId,
      away: awayTeamId,
      homeGoals: Number(asaGame.home_score),
      awayGoals: Number(asaGame.away_score),
    });
  }

  // A team we cannot map is a schema change, not a data quirk. Fail loudly
  // rather than quietly computing standings from a subset of the league.
  if (unmappedTeamIds.size > 0) {
    throw new Error(
      `ASA returned games for teams absent from data.json: ${[...unmappedTeamIds].join(", ")}`
    );
  }
  if (completedGames.length === 0) {
    throw new Error(`ASA returned no completed ${seasonName} regular-season games`);
  }

  completedGames.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return completedGames;
}

module.exports = {
  fetchAsaJson,
  fetchCompletedGames,
  fetchTeamIdMap,
  matchLocalDate,
  ASA_ABBREVIATION_ALIASES,
  HONEST_USER_AGENT,
};
