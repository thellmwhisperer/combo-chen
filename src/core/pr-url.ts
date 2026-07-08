/**
 * @overview Shared GitHub pull request URL parsing. ~35 lines, 2 exports,
 *   canonicalizing PR URL identity for CLI and role helpers.
 *
 *   READING GUIDE
 *   -------------
 *   1. Start at parseGitHubPullRequestUrl <- the full parser contract.
 *
 *   MAIN FLOW
 *   ---------
 *   URL string -> anchored GitHub PR regex -> GitHubPullRequestRef or undefined
 *
 *   PUBLIC API
 *   ----------
 *   GitHubPullRequestRef       Parsed owner/repo/pull number identity.
 *   parseGitHubPullRequestUrl  Parse github.com pull request URLs.
 *
 *   INTERNALS
 *   ---------
 *   GITHUB_PULL_REQUEST_URL
 *
 * @exports GitHubPullRequestRef, parseGitHubPullRequestUrl
 * @deps none
 */
// -- 1/1 CORE · parseGitHubPullRequestUrl <- START HERE --
export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parseGitHubPullRequestUrl(url: string): GitHubPullRequestRef | undefined {
  const match = GITHUB_PULL_REQUEST_URL.exec(url);
  if (!match) return undefined;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) };
}
// -/ 1/1
