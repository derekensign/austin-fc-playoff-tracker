"use strict";
/**
 * Hourly refresh Lambda.
 *
 *   EventBridge (hourly) -> ingest ASA results -> rebuild data.json ->
 *   refresh.js -> commit to GitHub -> Vercel redeploys
 *
 * Exits early and cheaply when no new results have landed, which is what happens
 * on the great majority of invocations. The whole point is that a rival's result
 * moves Austin's odds just as much as Austin's own, so this runs on the league's
 * schedule rather than Austin's.
 */

const fs = require("node:fs");
const path = require("node:path");

const { commitFiles } = require("./github.js");

/**
 * Files the refresh regenerates, and therefore the files worth committing.
 * The first four are the playoff forecast; the last two are the Copa Tejas Shield.
 */
const PUBLISHED_FILES = ["data.json", "report.json", "index.html", "audit.json", "shield.json", "shield.html", "shield-embed.html"];

/** Everything ingest + refresh need in order to run. */
const RUNTIME_FILES = [
  "data.json",
  "report.json",
  "audit.json",
  "model.js",
  "render.js",
  "paths.js",
  "refresh.js",
  "template.html",
  "ingest/asa.js",
  "ingest/rebuild.js",
  "ingest/index.js",
  // Copa Tejas Shield page, refreshed by the same hourly run.
  "shield.json",
  "shield-template.html",
  "shield-embed-template.html",
  "render-shield.js",
  "ingest/shield.js",
];

const READ_ONLY_TASK_ROOT = path.join(__dirname, "..");
const WRITABLE_PROJECT_ROOT = "/tmp/verde";

/**
 * Copy the project out of the read-only bundle into /tmp so refresh.js can write.
 * @returns {string} the writable project root
 */
function stageProjectInTmp() {
  fs.rmSync(WRITABLE_PROJECT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(WRITABLE_PROJECT_ROOT, "ingest"), { recursive: true });
  for (const relativePath of RUNTIME_FILES) {
    fs.copyFileSync(
      path.join(READ_ONLY_TASK_ROOT, relativePath),
      path.join(WRITABLE_PROJECT_ROOT, relativePath)
    );
  }
  return WRITABLE_PROJECT_ROOT;
}

/**
 * Read the GitHub token. Prefers a Secrets Manager secret; falls back to an env
 * var so the handler can be exercised locally.
 *
 * @returns {Promise<string>}
 */
async function resolveGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  const secretId = process.env.GITHUB_TOKEN_SECRET_ID;
  if (!secretId) {
    throw new Error("Set GITHUB_TOKEN_SECRET_ID (or GITHUB_TOKEN for local runs)");
  }
  // Required lazily so local runs without the SDK still work.
  const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
  const secretsClient = new SecretsManagerClient({});
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!secret.SecretString) throw new Error(`Secret ${secretId} has no SecretString`);

  // Accept either a bare token or {"token":"..."} / {"GITHUB_TOKEN":"..."}.
  const raw = secret.SecretString.trim();
  if (!raw.startsWith("{")) return raw;
  const parsed = JSON.parse(raw);
  const token = parsed.token || parsed.GITHUB_TOKEN || parsed.githubToken;
  if (!token) throw new Error(`Secret ${secretId} JSON has no token field`);
  return token;
}

/**
 * Summarise what changed, for the commit message.
 * @param {object} forecastResult  result of ingest(): {changed, report}
 * @param {object} shieldResult    result of ingestShield(): {changed, shield, error?}
 * @param {string} projectRoot
 */
function buildCommitMessage(forecastResult, shieldResult, projectRoot) {
  const report = forecastResult.report;
  const forecast = JSON.parse(fs.readFileSync(path.join(projectRoot, "report.json"), "utf8"));
  const austin = forecast.baseline.atx;
  const playedCount = report.newlyPlayed.length;

  let subject;
  if (forecastResult.changed) {
    subject =
      playedCount > 0
        ? `Refresh forecast for ${playedCount} new result${playedCount === 1 ? "" : "s"} (${report.asOf})`
        : `Refresh forecast (${report.asOf})`;
    if (shieldResult.changed) subject += " and Copa Tejas Shield";
  } else if (shieldResult.changed) {
    subject = `Refresh Copa Tejas Shield (${shieldResult.shield.asOf})`;
  } else {
    subject = `Republish site (${report.asOf})`;
  }

  const bodyLines = [
    "",
    `Austin top-nine chance: ${austin.top9Pct.toFixed(1)}% · median ${austin.medianPoints} pts, ${austin.medianPlace}th`,
    `Completed games: ${report.completedGames} · remaining fixtures: ${report.remainingFixtures}`,
  ];
  if (playedCount > 0) {
    bodyLines.push("", "Newly completed:");
    for (const fixtureId of report.newlyPlayed) bodyLines.push(`  ${fixtureId}`);
  }
  for (const entry of report.rescheduledFixtures) {
    bodyLines.push(`Postponed: ${entry.id} moved ${entry.from} -> ${entry.to}`);
  }
  if (shieldResult.shield) {
    const holder = shieldResult.shield.standings[0];
    bodyLines.push(
      "",
      `Copa Tejas Shield: ${holder.name} ${holder.ppg.toFixed(2)} PPG · results through ${shieldResult.shield.asOf}` +
        (shieldResult.changed ? "" : " (unchanged)")
    );
  }
  if (shieldResult.error) bodyLines.push("", `Copa Tejas Shield not refreshed: ${shieldResult.error}`);
  bodyLines.push("", "Source: American Soccer Analysis results feed", "Automated by the hourly refresh Lambda.");
  return subject + "\n" + bodyLines.join("\n");
}

/**
 * Refresh the Copa Tejas Shield. A failure here must not block the playoff
 * forecast, so it is caught and reported rather than thrown; the previously
 * published Shield simply stays up until the next successful hour.
 *
 * @param {string} projectRoot
 * @param {boolean} force
 * @returns {Promise<{changed: boolean, shield: object|null, error: string|null}>}
 */
async function refreshShield(projectRoot, force) {
  const { ingestShield } = require(path.join(projectRoot, "ingest", "shield.js"));
  try {
    const result = await ingestShield({ force });
    return { changed: result.changed, shield: result.shield, error: null };
  } catch (failure) {
    console.error("Shield ingest failed (forecast continues):", failure.message);
    let previousShield = null;
    try {
      previousShield = JSON.parse(fs.readFileSync(path.join(projectRoot, "shield.json"), "utf8"));
    } catch {
      /* no previous snapshot to fall back on */
    }
    return { changed: false, shield: previousShield, error: failure.message };
  }
}

/**
 * @param {object} [event] EventBridge event; `{"force": true}` republishes even
 *   when nothing changed, which is useful for a manual test invocation.
 */
async function handler(event = {}) {
  const startedAtMs = Date.now();
  const projectRoot = stageProjectInTmp();
  process.env.VERDE_PROJECT_ROOT = projectRoot;

  // Required after VERDE_PROJECT_ROOT is set, since it is read at module load.
  const { ingest } = require(path.join(projectRoot, "ingest", "index.js"));

  // Sequential on purpose. ingest() runs refresh.js with execFileSync, which blocks
  // the event loop for minutes; Shield fetches in flight during that block would see
  // their AbortSignal timers fire before their responses were delivered.
  const result = await ingest({ force: Boolean(event.force) });
  const shieldResult = await refreshShield(projectRoot, Boolean(event.force));

  if (!result.changed && !shieldResult.changed && !event.force) {
    const summary = {
      published: false,
      reason: "no new results",
      asOf: result.report.asOf,
      completedGames: result.report.completedGames,
      shieldAsOf: shieldResult.shield ? shieldResult.shield.asOf : null,
      shieldError: shieldResult.error,
      elapsedMs: Date.now() - startedAtMs,
    };
    console.log(JSON.stringify(summary));
    return summary;
  }

  const token = await resolveGithubToken();
  const commit = await commitFiles({
    token,
    owner: process.env.GITHUB_OWNER || "derekensign",
    repo: process.env.GITHUB_REPO || "austin-fc-playoff-tracker",
    branch: process.env.GITHUB_BRANCH || "main",
    message: buildCommitMessage(result, shieldResult, projectRoot),
    // A file missing from the staged copy (a Shield that has never been built) is
    // skipped rather than failing the whole publish.
    files: PUBLISHED_FILES.filter((fileName) => fs.existsSync(path.join(projectRoot, fileName))).map((fileName) => ({
      path: fileName,
      content: fs.readFileSync(path.join(projectRoot, fileName), "utf8"),
    })),
  });

  const summary = {
    published: !commit.unchanged,
    commitSha: commit.commitSha,
    asOf: result.report.asOf,
    newlyPlayed: result.report.newlyPlayed,
    rescheduledFixtures: result.report.rescheduledFixtures,
    completedGames: result.report.completedGames,
    shieldChanged: shieldResult.changed,
    shieldAsOf: shieldResult.shield ? shieldResult.shield.asOf : null,
    shieldHolder: shieldResult.shield ? shieldResult.shield.holder : null,
    shieldError: shieldResult.error,
    elapsedMs: Date.now() - startedAtMs,
  };
  console.log(JSON.stringify(summary));
  return summary;
}

module.exports = { handler };

if (require.main === module) {
  handler({ force: process.argv.includes("--force") }).catch((failure) => {
    console.error("Refresh failed:", failure.message);
    process.exit(1);
  });
}
