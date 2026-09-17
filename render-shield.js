"use strict";
/**
 * Render shield-template.html from a shield.json snapshot. Pure: no I/O, no clock.
 * Same slot convention as render.js: every {{name}} must be filled or we throw.
 */

const { LEAGUES } = require("./ingest/shield.js");

/** MLS regular season length, used only to say how many matches Austin has left. */
const MLS_REGULAR_SEASON_MATCHES = 34;

/** @param {unknown} value */
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** @param {number} n */
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");

/** @param {string} isoDate */
const shortDate = (isoDate) =>
  new Date(isoDate + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** @param {number} value */
const signed = (value) => (value > 0 ? "+" : "") + value;

/** @param {number} ppg */
const formatPpg = (ppg) => ppg.toFixed(2);

/**
 * @param {string} template
 * @param {object} shield parsed shield.json
 * @returns {string} HTML
 */
module.exports = function renderShield(template, shield) {
  const standings = shield.standings;
  const holder = standings[0];
  const runnerUp = standings[1];
  const austin = standings.find((club) => club.id === "ATX");
  const leagueOf = (club) => shield.leagues[club.league] || LEAGUES[club.league];
  const eligibleLeagueSlugs = Object.keys(shield.leagues).filter((slug) => shield.leagues[slug].eligible);

  const metric = (label, value, sub) =>
    '<article class="card metric"><div class="label">' + label + '</div><div class="value compact">' + value +
    '</div><div class="sub">' + sub + "</div></article>";

  const formCells = (club) =>
    '<span class="form" aria-label="Last ' + club.form.length + ' results">' +
    club.form.map((r) => '<span class="res ' + r + '" title="' + { W: "Win", D: "Draw", L: "Loss" }[r] + '">' + r + "</span>").join("") +
    "</span>";

  const resultLine = (r) =>
    shortDate(r.date) + " " + (r.home ? "vs " : "@ ") + escapeHtml(r.opponent) + " " + r.gf + "–" + r.ga + " (" + r.result + ")";

  const clubInfo = (club) => {
    const league = leagueOf(club);
    const recent = [...club.results].slice(-6).reverse();
    return '<div class="clubinfo"><span>' + escapeHtml(league.name) + " · " + escapeHtml(club.season) + " season · " +
      escapeHtml(club.city) + "</span><span>Recent: " + (recent.length ? recent.map(resultLine).join("; ") : "n/a") + "</span></div>";
  };

  const row = (club, options = {}) => {
    const league = leagueOf(club);
    const classes = [club.id === "ATX" || club.reserveOf === "ATX" ? "atx" : "", club.rank === 1 && !options.reserve ? "holder" : ""]
      .filter(Boolean).join(" ");
    return '<tr class="' + classes + '"><td>' + club.rank + "</td><td><details class=\"club\"><summary>" + escapeHtml(club.name) +
      (club.rank === 1 && !options.reserve ? ' <span class="badge gold">Shield holder</span>' : "") +
      (club.reserveOf ? ' <span class="badge">Reserve side</span>' : "") + "</summary>" + clubInfo(club) + "</details></td>" +
      '<td><abbr title="' + escapeHtml(league.name) + '">' + escapeHtml(league.shortName) + "</abbr></td>" +
      "<td>" + club.gp + "</td><td>" + club.w + "–" + club.d + "–" + club.l + "</td><td>" + club.gf + "</td><td>" + club.ga + "</td>" +
      "<td>" + signed(club.gd) + "</td><td>" + club.pts + '</td><td class="ppg"><strong>' + formatPpg(club.ppg) + "</strong></td><td>" +
      formCells(club) + "</td></tr>";
  };

  const leagueRows = eligibleLeagueSlugs
    .map((slug) => ({ slug, ...shield.leagues[slug] }))
    .sort((a, b) => a.division - b.division || a.shortName.localeCompare(b.shortName))
    .map((league) => {
      const clubs = standings.filter((club) => club.league === league.slug);
      return "<tr><td>" + escapeHtml(league.shortName) + "</td><td>" + escapeHtml(league.name) + "</td><td>" +
        (league.gender === "women" ? "Women" : "Men") + "</td><td>" + escapeHtml(league.season) + "</td><td>" +
        (clubs.length ? clubs.map((club) => escapeHtml(club.name)).join(", ") : "—") + "</td><td>" + league.completedGames +
        "</td><td>" + league.drawPct.toFixed(1) + "%</td><td>" + (league.latestResult ? shortDate(league.latestResult) : "—") + "</td></tr>";
    })
    .join("");

  const austinSentence = (() => {
    if (!austin) return "Austin FC has not played a league match this season.";
    const gap = holder.ppg - austin.ppg;
    if (austin.rank === 1) {
      return "Austin FC holds the Shield at " + formatPpg(austin.ppg) + " points per game, " +
        formatPpg(austin.ppg - runnerUp.ppg) + " clear of " + escapeHtml(runnerUp.name) + ".";
    }
    // Consecutive wins Austin needs for (pts + 3k) / (gp + k) to reach the holder's current PPG.
    // Solving for k: k >= (holderPpg * gp - pts) / (3 - holderPpg). A holder on a perfect 3.00 is unreachable.
    const winsNeeded = holder.ppg >= 3 ? Infinity : Math.max(1, Math.ceil((holder.ppg * austin.gp - austin.pts) / (3 - holder.ppg) - 1e-9));
    const matchesLeft = MLS_REGULAR_SEASON_MATCHES - austin.gp;
    let reachable;
    if (winsNeeded === 1) {
      reachable = "A win in its next match would lift it to " + formatPpg((austin.pts + 3) / (austin.gp + 1)) + ", past " +
        escapeHtml(holder.name) + " where it stands today.";
    } else if (winsNeeded > matchesLeft) {
      reachable = "Reaching " + escapeHtml(holder.name) + "’s current " + formatPpg(holder.ppg) + " would take " +
        (Number.isFinite(winsNeeded) ? winsNeeded + " straight wins" : "a perfect record") + ", and Austin has only " + matchesLeft +
        " MLS matches left; the Shield now depends on the clubs above dropping points.";
    } else {
      reachable = winsNeeded + " straight wins would carry it past " + escapeHtml(holder.name) + "’s current " + formatPpg(holder.ppg) +
        ", with " + matchesLeft + " MLS matches left.";
    }
    return "Austin FC sits " + ordinal(austin.rank) + " of " + standings.length + " at " + formatPpg(austin.ppg) +
      " points per game, " + formatPpg(gap) + " behind " + escapeHtml(holder.name) + ". " + reachable;
  })();

  const slots = {
    lede: standings.length + " professional clubs across " + eligibleLeagueSlugs.length +
      " leagues, men’s and women’s, ranked by points per game in league play. The top club holds the Shield.",
    stamp: "Results through " + escapeHtml(shield.asOf) + " · rebuilt hourly from the American Soccer Analysis results feed",
    metrics:
      metric("Shield holder", escapeHtml(holder.name), formatPpg(holder.ppg) + " points per game · " + escapeHtml(leagueOf(holder).shortName) +
        " · " + holder.w + "–" + holder.d + "–" + holder.l) +
      metric("Runner-up", escapeHtml(runnerUp.name), formatPpg(runnerUp.ppg) + " PPG · " + formatPpg(holder.ppg - runnerUp.ppg) + " behind") +
      metric("Austin FC", austin ? ordinal(austin.rank) + " · " + formatPpg(austin.ppg) + " PPG" : "No matches",
        austin ? austin.w + "–" + austin.d + "–" + austin.l + " in " + austin.gp + " MLS matches" : "") +
      metric("Clubs counted", standings.length + " clubs", eligibleLeagueSlugs.length + " leagues · " +
        standings.reduce((sum, club) => sum + club.gp, 0) + " league matches played"),
    standings: standings.map((club) => row(club)).join(""),
    austinSentence,
    reserveStandings: shield.reserveStandings.length
      ? shield.reserveStandings.map((club) => row(club, { reserve: true })).join("")
      : '<tr><td colspan="11">No reserve side has played this season.</td></tr>',
    leagues: leagueRows,
    inactive: shield.inactiveClubs.length
      ? "<p class=\"small\">Not ranked, no league match this season: " +
        shield.inactiveClubs.map((club) => escapeHtml(club.name) + " (" + escapeHtml((LEAGUES[club.league] || {}).shortName || club.league) + ")").join(", ") + ".</p>"
      : "",
    warnings: shield.warnings.length
      ? '<p class="small flag">Data notes: ' + shield.warnings.map(escapeHtml).join(" · ") + "</p>"
      : "",
    tiebreakers: shield.tiebreakers.map(escapeHtml).join(", then "),
    scoring: escapeHtml(shield.scoring),
    date: escapeHtml(shield.asOf),
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in slots)) throw new Error("Missing slot " + key);
    return slots[key];
  });
};
