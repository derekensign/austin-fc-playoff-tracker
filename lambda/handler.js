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

/** Files refresh.js regenerates, and therefore the files worth committing. */
const PUBLISHED_FILES = ["data.json", "report.json", "index.html", "audit.json"];

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
 * @param {object} report
 * @param {object} projectRoot
 */
function buildCommitMessage(report, projectRoot) {
  const forecast = JSON.parse(fs.readFileSync(path.join(projectRoot, "report.json"), "utf8"));
  const austin = forecast.baseline.atx;
  const playedCount = report.newlyPlayed.length;

  const subject =
    playedCount > 0
      ? `Refresh forecast for ${playedCount} new result${playedCount === 1 ? "" : "s"} (${report.asOf})`
      : `Refresh forecast (${report.asOf})`;

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
  bodyLines.push("", "Source: American Soccer Analysis results feed", "Automated by the hourly refresh Lambda.");
  return subject + "\n" + bodyLines.join("\n");
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

  const result = await ingest({ force: Boolean(event.force) });

  if (!result.changed && !event.force) {
    const summary = {
      published: false,
      reason: "no new results",
      asOf: result.report.asOf,
      completedGames: result.report.completedGames,
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
    message: buildCommitMessage(result.report, projectRoot),
    files: PUBLISHED_FILES.map((fileName) => ({
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
