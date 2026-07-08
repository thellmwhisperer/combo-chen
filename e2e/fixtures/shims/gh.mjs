#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (process.env.E2E_GH_LOG) {
  appendFileSync(process.env.E2E_GH_LOG, `${JSON.stringify({ args })}\n`);
}

const statePath = process.env.E2E_GH_STATE;

function load() {
  return statePath && existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { prLabels: [], knownLabels: [], failedMissingLabelAdd: false };
}

function save(state) {
  if (statePath) writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function names(value) {
  return String(value || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function uniq(values) {
  return [...new Set(values)];
}

function statusCheckRollup() {
  const rollup = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];
  if (process.env.E2E_CODERABBIT_SUCCESS_STATUS === "1") {
    rollup.push({
      __typename: "StatusContext",
      context: "CodeRabbit",
      state: "SUCCESS",
    });
  } else if (process.env.E2E_CODERABBIT_SKIPPED_STATUS === "1") {
    rollup.push({
      __typename: "StatusContext",
      context: "CodeRabbit",
      state: "SUCCESS",
      description: "Review skipped",
    });
  }
  return rollup;
}

function prComments() {
  if (process.env.E2E_CODERABBIT_SKIPPED_COMMENT === "1") {
    return [
      {
        author: { login: "coderabbitai[bot]" },
        body: [
          "<!-- This is an auto-generated comment: skip review by coderabbit.ai -->",
          "",
          "> [!IMPORTANT]",
          "> ## Review skipped",
          ">",
          "> Auto reviews are disabled on this repository. To trigger a single review, invoke the `@coderabbitai review` command.",
        ].join("\n"),
        createdAt: "2026-06-23T21:55:40Z",
        url: "https://github.com/o/r/pull/1#issuecomment-skipped",
      },
    ];
  }
  return [];
}

if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(`${process.env.E2E_PR_URL || "https://github.com/o/r/pull/1"}\n`);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  const state = load();
  if (args.includes("--jq")) {
    process.stdout.write(`${process.env.E2E_HEAD_SHA || process.env.E2E_MERGE_SHA || "head"}\n`);
    process.exit(0);
  }
  const prView = {
    headRefOid: process.env.E2E_HEAD_SHA || process.env.E2E_MERGE_SHA || "head",
    state: process.env.E2E_PR_STATE || "MERGED",
    mergedAt: "2026-06-23T00:00:00.000Z",
    mergedBy: { login: "e2e-maintainer" },
    baseRefName: "main",
    mergeCommit: { oid: process.env.E2E_MERGE_SHA || "merge" },
    labels: state.prLabels.map((name) => ({ name })),
    statusCheckRollup: statusCheckRollup(),
    comments: prComments(),
  };
  if (process.env.E2E_MERGE_STATE_STATUS) prView.mergeStateStatus = process.env.E2E_MERGE_STATE_STATUS;
  if (process.env.E2E_MERGEABLE) prView.mergeable = process.env.E2E_MERGEABLE;
  process.stdout.write(`${JSON.stringify(prView)}\n`);
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "edit") {
  const state = load();
  const flag = args[3] || "";
  const labelNames = names(args[4]);
  if (flag === "--add-label") {
    const missing = labelNames.find((name) => name.startsWith("combo:") && !state.knownLabels.includes(name));
    if (
      process.env.E2E_GH_MISSING_COMBO_LABELS_ON_FIRST_ADD === "1" &&
      !state.failedMissingLabelAdd &&
      missing
    ) {
      state.failedMissingLabelAdd = true;
      save(state);
      process.stderr.write(`'${missing}' not found\n`);
      process.exit(1);
    }
    state.prLabels = uniq([...(state.prLabels || []), ...labelNames]);
    save(state);
    process.exit(0);
  }
  if (flag === "--remove-label") {
    const removed = new Set(labelNames);
    state.prLabels = (state.prLabels || []).filter((name) => !removed.has(name));
    save(state);
    process.exit(0);
  }
}

if (args[0] === "label" && args[1] === "create") {
  const state = load();
  const labelName = args[2] || "";
  if (labelName) state.knownLabels = uniq([...(state.knownLabels || []), labelName]);
  save(state);
  process.exit(0);
}

if (args[0] === "api") {
  const endpoint = args[args.length - 1] || "";
  if (process.env.E2E_REVIEWER_CODE1 === "1" && endpoint === "repos/o/r/pulls/1/reviews") {
    const head = process.env.E2E_HEAD_SHA || process.env.E2E_MERGE_SHA || "head";
    process.stdout.write(
      `${JSON.stringify([
        {
          html_url: "https://github.com/o/r/pull/1#pullrequestreview-reviewer-code-1",
          user: { login: "e2e-reviewer" },
          state: "COMMENTED",
          body: ["combo-chen-reviewer-verdict:", `head: ${head}`, "code: 1"].join("\n"),
          commit_id: head,
          submitted_at: "2026-06-23T23:19:47Z",
        },
      ])}\n`,
    );
    process.exit(0);
  }
  if (process.env.E2E_REVIEWER_CODE0_LOGIN && endpoint === "repos/o/r/pulls/1/reviews") {
    const head = process.env.E2E_HEAD_SHA || process.env.E2E_MERGE_SHA || "head";
    process.stdout.write(
      `${JSON.stringify([
        {
          html_url: "https://github.com/o/r/pull/1#pullrequestreview-reviewer-code-0",
          user: { login: process.env.E2E_REVIEWER_CODE0_LOGIN },
          state: "COMMENTED",
          body: ["combo-chen-reviewer-verdict:", `head: ${head}`, "code: 0", `lgtm @ ${head}`].join("\n"),
          commit_id: head,
          submitted_at: "2026-06-23T23:21:47Z",
        },
      ])}\n`,
    );
    process.exit(0);
  }
  if (process.env.E2E_CODERABBIT_REVIEW === "1" && endpoint === "repos/o/r/pulls/1/comments") {
    process.stdout.write(
      `${JSON.stringify([
        {
          html_url: "https://github.com/o/r/pull/1#discussion_r1",
          user: { login: "coderabbitai[bot]" },
          body: "Please validate this mechanical issue.",
          path: "src/cli/update.ts",
          line: 163,
        },
      ])}\n`,
    );
    process.exit(0);
  }
  if (process.env.E2E_CODERABBIT_REVIEW === "1" && endpoint === "repos/o/r/pulls/1/reviews") {
    process.stdout.write(
      `${JSON.stringify([
        {
          html_url: "https://github.com/o/r/pull/1#pullrequestreview-1",
          user: { login: "coderabbitai[bot]" },
          state: "COMMENTED",
          body: "Actionable comments posted: 1",
          submitted_at: "2026-06-23T21:55:40Z",
        },
      ])}\n`,
    );
    process.exit(0);
  }
  process.stdout.write("[]\n");
  process.exit(0);
}

if (args[0] === "issue" && args[1] === "view") {
  process.stdout.write(`${JSON.stringify({ title: "E2E issue", body: "" })}\n`);
  process.exit(0);
}

process.stdout.write("[]\n");
process.exit(0);
