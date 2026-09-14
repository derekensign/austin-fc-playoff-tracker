"use strict";
/**
 * Ingest entry point: fetch results, rebuild data.json, regenerate the forecast.
 *
 * Usable three ways:
 *   node ingest              — refresh in place, skipping work if nothing changed
 *   node ingest --force      — refresh even when no new results have landed
 *   node ingest --dry-run    — report what would change, write nothing
 *
 * Returns a structured summary so the Lambda handler can decide whether there is
 * anything worth publishing.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { fetchCompletedGames } = require("./asa.js");
const { rebuildData, sortKeysDeep, RUN_IN_FINAL_DATE } = require("./rebuild.js");

/**
 * Overridable because Lambda's /var/task is read-only and refresh.js writes four
 * files — the handler copies the project into /tmp and points us there.
 */
const PROJECT_ROOT = process.env.VERDE_PROJECT_ROOT || path.join(__dirname, "..");
const SEASON_NAME = process.env.VERDE_SEASON || "2026";

/** @param {string} fileName */
function readProjectFile(fileName) {
  return fs.readFileSync(path.join(PROJECT_ROOT, fileName), "utf8");
}

/**
 * Fetch results, rebuild data.json, and run the existing refresh pipeline.
 *
 * @param {{force?: boolean, dryRun?: boolean}} options
 * @returns {Promise<{changed: boolean, report: object, data: object}>}
 */
async function ingest(options = {}) {
  const previousData = JSON.parse(readProjectFile("data.json"));
  const knownTeamIds = new Set(previousData.teams.map((team) => team.id));

  const completedGames = await fetchCompletedGames(SEASON_NAME, knownTeamIds);
  const { data: nextData, report } = rebuildData(previousData, completedGames);

  // Hard stops. These mean the schedule we hold no longer matches reality, and
  // publishing a forecast built on it would be worse than publishing nothing.
  if (report.scheduleDrift.length > 0) {
    throw new Error(
      "Schedule drift — a Western club's played + remaining no longer totals 34:\n  " +
        report.scheduleDrift.join("\n  ") +
        "\nThe remaining-fixture list needs a manual update; ASA publishes completed games only."
    );
  }
  if (report.unschedulableFixtures.length > 0) {
    throw new Error(
      `Postponed fixtures with no open date before ${RUN_IN_FINAL_DATE}: ${report.unschedulableFixtures.join(", ")}`
    );
  }

  // Compare canonically. A key-order difference is not a change, and treating it
  // as one would push an empty commit every single hour.
  const changed =
    JSON.stringify(sortKeysDeep(previousData)) !== JSON.stringify(sortKeysDeep(nextData));

  if (!changed && !options.force) {
    return { changed: false, report, data: previousData };
  }
  if (options.dryRun) {
    return { changed, report, data: nextData };
  }

  // Sort keys so successive snapshots produce minimal, readable diffs in git.
  fs.writeFileSync(
    path.join(PROJECT_ROOT, "data.json"),
    JSON.stringify(sortKeysDeep(nextData), null, 2) + "\n"
  );

  // model.validate() runs inside refresh.js and will throw on anything invalid.
  const refreshOutput = execFileSync(process.execPath, [path.join(PROJECT_ROOT, "refresh.js")], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });

  return { changed: true, report, data: nextData, refreshOutput: refreshOutput.trim() };
}

module.exports = { ingest };

if (require.main === module) {
  const commandLineArguments = new Set(process.argv.slice(2));
  ingest({
    force: commandLineArguments.has("--force"),
    dryRun: commandLineArguments.has("--dry-run"),
  })
    .then((result) => {
      const { report } = result;
      console.log(`asOf ${report.previousAsOf} -> ${report.asOf}`);
      console.log(`completed games: ${report.completedGames} | remaining fixtures: ${report.remainingFixtures}`);
      if (report.newlyPlayed.length > 0) {
        console.log(`newly played (${report.newlyPlayed.length}):`);
        for (const fixtureId of report.newlyPlayed) console.log(`  ${fixtureId}`);
      }
      for (const entry of report.rescheduledFixtures) {
        console.log(`postponed: ${entry.id} moved ${entry.from} -> ${entry.to}`);
      }
      if (!result.changed) {
        console.log("No new results. Nothing to publish.");
      } else if (commandLineArguments.has("--dry-run")) {
        console.log("Dry run — no files written.");
      } else {
        console.log(result.refreshOutput);
      }
    })
    .catch((failure) => {
      console.error("Ingest failed:", failure.message);
      process.exit(1);
    });
}
