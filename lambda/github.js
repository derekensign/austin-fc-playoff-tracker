"use strict";
/**
 * Commit files to GitHub through the Git Data API.
 *
 * Deliberately does NOT shell out to git: the Lambda runtime has no git binary,
 * and this needs no dependencies beyond global fetch. The sequence is the
 * standard low-level one — blobs, then a tree layered on the current tree, then
 * a commit, then a fast-forward of the branch ref.
 *
 * The ref update is sent WITHOUT force, so a concurrent push (or a manual commit
 * made while the Lambda was mid-run) fails the update instead of clobbering it.
 */

const GITHUB_API_BASE = "https://api.github.com";

/**
 * @param {object} params
 * @param {string} params.token       fine-grained PAT with contents:write
 * @param {string} params.method
 * @param {string} params.path        e.g. "/repos/owner/repo/git/refs/heads/main"
 * @param {unknown} [params.body]
 * @returns {Promise<any>}
 */
async function githubRequest({ token, method, path: requestPath, body }) {
  const response = await fetch(`${GITHUB_API_BASE}${requestPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "verde-run-in-refresh",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${requestPath} -> ${response.status}: ${responseText.slice(0, 400)}`);
  }
  return responseText ? JSON.parse(responseText) : null;
}

/**
 * Create a single commit containing the given files and fast-forward the branch.
 *
 * @param {object} params
 * @param {string} params.token
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.branch
 * @param {string} params.message
 * @param {Array<{path: string, content: string}>} params.files
 * @returns {Promise<{commitSha: string, treeSha: string, unchanged: boolean}>}
 */
async function commitFiles({ token, owner, repo, branch, message, files }) {
  const repoPath = `/repos/${owner}/${repo}`;
  const request = (method, path, body) => githubRequest({ token, method, path, body });

  const branchRef = await request("GET", `${repoPath}/git/ref/heads/${branch}`);
  const baseCommitSha = branchRef.object.sha;
  const baseCommit = await request("GET", `${repoPath}/git/commits/${baseCommitSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  const treeEntries = [];
  for (const file of files) {
    const blob = await request("POST", `${repoPath}/git/blobs`, {
      content: Buffer.from(file.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const newTree = await request("POST", `${repoPath}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeEntries,
  });

  // Identical tree means the refreshed output matched what is already published.
  if (newTree.sha === baseTreeSha) {
    return { commitSha: baseCommitSha, treeSha: baseTreeSha, unchanged: true };
  }

  const newCommit = await request("POST", `${repoPath}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [baseCommitSha],
  });

  await request("PATCH", `${repoPath}/git/refs/heads/${branch}`, {
    sha: newCommit.sha,
    force: false,
  });

  return { commitSha: newCommit.sha, treeSha: newTree.sha, unchanged: false };
}

module.exports = { commitFiles, githubRequest };
