"use strict";
/**
 * Pure transform: previous data.json + authoritative completed-game log -> new data.json.
 *
 * Design notes worth keeping in mind before editing:
 *
 *   * Records are rebuilt from the FULL game log every run, not patched
 *     incrementally. That makes the job self-healing — a missed hour, a
 *     corrected scoreline, or a retroactively voided match all converge on the
 *     right answer next run instead of accumulating drift.
 *
 *   * The remaining-fixture list cannot be refreshed from ASA (it publishes
 *     completed games only), so fixtures are only ever REMOVED here, matched by
 *     their (home, away) ordered pair. That pair is unique across both the
 *     played and remaining sets, which is what makes it a safe key.
 *
 *   * model.validate() enforces `gp + remaining === 34` for every Western club.
 *     Schedule drift therefore surfaces as a hard failure rather than a wrong
 *     forecast, which is the behaviour we want from an unattended job.
 */

const RUN_IN_FINAL_DATE = "2026-11-07"; // model.validate() rejects fixtures past this
const RECENT_FORM_MATCH_COUNT = 6;
const MATCHES_PER_TEAM_PER_SEASON = 34;

/** Points, then wins, then goal difference, then goals for — MLS order. */
function compareForStandings(teamA, teamB) {
  return (
    teamB.pts - teamA.pts ||
    teamB.wins - teamA.wins ||
    (teamB.gf - teamB.ga) - (teamA.gf - teamA.ga) ||
    teamB.gf - teamA.gf ||
    // Deterministic final tiebreak so ranks never churn between identical runs.
    teamA.id.localeCompare(teamB.id)
  );
}

/**
 * Accumulate every club's season record from the completed-game log.
 *
 * @param {Array<{id:string}>} previousTeams carries name/conference forward
 * @param {import('./asa.js').CompletedGame[]} completedGames
 * @returns {Record<string, object>} team ID -> record fields
 */
function accumulateRecords(previousTeams, completedGames) {
  const recordsByTeamId = {};
  for (const previousTeam of previousTeams) {
    recordsByTeamId[previousTeam.id] = {
      id: previousTeam.id,
      name: previousTeam.name,
      conference: previousTeam.conference,
      gp: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      gf: 0,
      ga: 0,
      pts: 0,
    };
  }

  for (const game of completedGames) {
    const sides = [
      { record: recordsByTeamId[game.home], scored: game.homeGoals, conceded: game.awayGoals },
      { record: recordsByTeamId[game.away], scored: game.awayGoals, conceded: game.homeGoals },
    ];
    for (const { record, scored, conceded } of sides) {
      record.gp += 1;
      record.gf += scored;
      record.ga += conceded;
      if (scored > conceded) {
        record.wins += 1;
        record.pts += 3;
      } else if (scored === conceded) {
        record.draws += 1;
        record.pts += 1;
      } else {
        record.losses += 1;
      }
    }
  }
  return recordsByTeamId;
}

/**
 * Last-N form for every club, computed from real matches.
 *
 * The `description` reproduces the format the hand-built snapshot used:
 * oldest match first, "Opponent ourGoals–theirGoals" with an en dash.
 *
 * @param {Record<string,object>} recordsByTeamId
 * @param {import('./asa.js').CompletedGame[]} completedGames oldest-first
 * @returns {Record<string, {gp:number, gf:number, ga:number, description:string}>}
 */
function computeRecentForm(recordsByTeamId, completedGames) {
  const recentFormByTeamId = {};
  for (const teamId of Object.keys(recordsByTeamId)) {
    const teamMatches = [];
    // Walk newest-first and stop early once we have enough.
    for (let index = completedGames.length - 1; index >= 0 && teamMatches.length < RECENT_FORM_MATCH_COUNT; index--) {
      const game = completedGames[index];
      const isHome = game.home === teamId;
      if (!isHome && game.away !== teamId) continue;
      teamMatches.push({
        opponentId: isHome ? game.away : game.home,
        scored: isHome ? game.homeGoals : game.awayGoals,
        conceded: isHome ? game.awayGoals : game.homeGoals,
      });
    }
    teamMatches.reverse(); // present oldest-first

    if (teamMatches.length === 0) continue;
    recentFormByTeamId[teamId] = {
      gp: teamMatches.length,
      gf: teamMatches.reduce((total, match) => total + match.scored, 0),
      ga: teamMatches.reduce((total, match) => total + match.conceded, 0),
      description: teamMatches
        .map((match) => `${recordsByTeamId[match.opponentId].name} ${match.scored}–${match.conceded}`)
        .join(", "),
    };
  }
  return recentFormByTeamId;
}

/**
 * Reschedule a fixture whose date has passed without the match appearing in the
 * results feed — i.e. a postponement. We move it to the earliest date after
 * `asOf` on which neither club is already committed, which keeps the fixture in
 * the simulation and keeps validate() happy. This is a disclosed heuristic: the
 * real replacement date is not knowable from a results-only feed.
 *
 * @returns {string|null} the chosen date, or null if no slot exists
 */
function findReplacementDate(fixture, asOfDate, occupiedTeamDates) {
  const candidate = new Date(`${asOfDate}T00:00:00Z`);
  const finalInstant = new Date(`${RUN_IN_FINAL_DATE}T00:00:00Z`);
  while (candidate < finalInstant) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
    const candidateDate = candidate.toISOString().slice(0, 10);
    const homeIsFree = !occupiedTeamDates.has(`${candidateDate}:${fixture.home}`);
    const awayIsFree = !occupiedTeamDates.has(`${candidateDate}:${fixture.away}`);
    if (homeIsFree && awayIsFree) return candidateDate;
  }
  return null;
}

/**
 * @param {object} previousData parsed data.json
 * @param {import('./asa.js').CompletedGame[]} completedGames oldest-first
 * @returns {{data: object, report: object}}
 */
function rebuildData(previousData, completedGames) {
  const recordsByTeamId = accumulateRecords(previousData.teams, completedGames);

  // asOf is the true data boundary: the latest date we have a result for.
  const asOfDate = completedGames[completedGames.length - 1].date;

  const playedOrderedPairs = new Set(completedGames.map((game) => `${game.home}:${game.away}`));
  const newlyPlayedFixtures = previousData.fixtures.filter((fixture) =>
    playedOrderedPairs.has(`${fixture.home}:${fixture.away}`)
  );
  let remainingFixtures = previousData.fixtures.filter(
    (fixture) => !playedOrderedPairs.has(`${fixture.home}:${fixture.away}`)
  );

  // Any fixture still listed but already past the data boundary is a postponement.
  const occupiedTeamDates = new Set();
  for (const fixture of remainingFixtures) {
    occupiedTeamDates.add(`${fixture.date}:${fixture.home}`);
    occupiedTeamDates.add(`${fixture.date}:${fixture.away}`);
  }
  const rescheduledFixtures = [];
  const unschedulableFixtures = [];
  remainingFixtures = remainingFixtures.map((fixture) => {
    if (fixture.date > asOfDate) return fixture;
    occupiedTeamDates.delete(`${fixture.date}:${fixture.home}`);
    occupiedTeamDates.delete(`${fixture.date}:${fixture.away}`);
    const replacementDate = findReplacementDate(fixture, asOfDate, occupiedTeamDates);
    if (!replacementDate) {
      unschedulableFixtures.push(fixture.id);
      return fixture;
    }
    occupiedTeamDates.add(`${replacementDate}:${fixture.home}`);
    occupiedTeamDates.add(`${replacementDate}:${fixture.away}`);
    rescheduledFixtures.push({ id: fixture.id, from: fixture.date, to: replacementDate });
    return { ...fixture, date: replacementDate, id: `${replacementDate}:${fixture.home}:${fixture.away}` };
  });
  remainingFixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Rank within each conference, then attach ranks to the carried-forward teams.
  const rankedTeams = [];
  for (const conference of ["East", "West"]) {
    const conferenceTeams = Object.values(recordsByTeamId)
      .filter((team) => team.conference === conference)
      .sort(compareForStandings);
    conferenceTeams.forEach((team, index) => {
      rankedTeams.push({ ...team, currentRank: index + 1 });
    });
  }
  rankedTeams.sort((a, b) => a.id.localeCompare(b.id));

  // Surface schedule drift precisely; validate() would only say "Incomplete schedule".
  const scheduleDrift = [];
  for (const team of rankedTeams) {
    if (team.conference !== "West") continue;
    const remainingCount = remainingFixtures.filter(
      (fixture) => fixture.home === team.id || fixture.away === team.id
    ).length;
    if (team.gp + remainingCount !== MATCHES_PER_TEAM_PER_SEASON) {
      scheduleDrift.push(
        `${team.id}: ${team.gp} played + ${remainingCount} remaining = ${team.gp + remainingCount}, expected ${MATCHES_PER_TEAM_PER_SEASON}`
      );
    }
  }

  const recentFormByTeamId = computeRecentForm(recordsByTeamId, completedGames);

  const notes = [
    `Snapshot as of ${asOfDate}, rebuilt automatically from the American Soccer Analysis results feed. Goals for/against and wins/losses reconcile across all 30 clubs.`,
    "All remaining MLS fixtures involving a Western club are included. East-vs-East fixtures are not required because team strengths are held fixed throughout each forecast.",
    "Dates are match-local calendar dates, with no kickoff-time assumptions.",
    "All future West-vs-West fixtures are listed by both teams and collapsed to exactly one shared outcome.",
    `Recent form is each club's last ${RECENT_FORM_MATCH_COUNT} completed league matches, computed from the results feed.`,
  ];
  if (rescheduledFixtures.length > 0) {
    notes.push(
      "Postponed fixtures moved to the next open date for both clubs, because a results-only feed cannot supply the official replacement date: " +
        rescheduledFixtures.map((entry) => `${entry.id} -> ${entry.to}`).join("; ")
    );
  }

  const data = {
    asOf: asOfDate,
    version: previousData.version,
    teams: rankedTeams,
    fixtures: remainingFixtures,
    recentForm: recentFormByTeamId,
    notes,
    sources: {
      ...previousData.sources,
      results: {
        label: "American Soccer Analysis — MLS games API",
        url: "https://app.americansocceranalysis.com/api/v1/mls/games?season_name=2026",
      },
    },
  };

  return {
    data,
    report: {
      asOf: asOfDate,
      previousAsOf: previousData.asOf,
      completedGames: completedGames.length,
      newlyPlayed: newlyPlayedFixtures.map((fixture) => fixture.id),
      remainingFixtures: remainingFixtures.length,
      rescheduledFixtures,
      unschedulableFixtures,
      scheduleDrift,
    },
  };
}

/**
 * Recursively sort object keys so successive snapshots produce minimal git diffs.
 * Arrays keep their order; only object key order is normalised.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
  return sorted;
}

module.exports = {
  rebuildData,
  compareForStandings,
  computeRecentForm,
  accumulateRecords,
  sortKeysDeep,
  RUN_IN_FINAL_DATE,
};
