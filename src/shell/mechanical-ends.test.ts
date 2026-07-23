/**
 * @overview P3 mechanical Launcher/Cleaner contracts with isolated fixture repositories.
 *
 *   READING GUIDE
 *   -------------
 *   1. Treehouse runway              <- real lease identity/path and refusal law.
 *   2. Explicit Git + Cleaner custody <- distinct ownership and safe release.
 *   3. Readiness boundary             <- aggregate seat/harness/auth failures.
 *   4. Fixture helpers                <- isolated repos, run inputs, exact cleanup.
 *
 * @exports none
 * @deps vitest, node:child_process, node:fs, node:path
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// -- 1/4 HELPER · Isolated fixture repositories and exact cleanup --
const ROOT = resolve(import.meta.dirname, "../..");
const BIN = join(ROOT, "bin");
const SCRATCH = join(ROOT, ".tmp");
const fixtures: Fixture[] = [];

type Fixture = {
  outer: string;
  repo: string;
  runs: string;
  treehousePaths: string[];
  gitWorktrees: string[];
};

type Ownership = {
  run: string;
  runway_kind: "treehouse" | "git-worktree-explicit";
  repo_dir: string;
  worktree: string;
  branch: string;
  base_sha: string;
  lease_id?: string;
  ownership_id?: string;
};

function command(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(bin, args, { cwd, encoding: "utf8", env, timeout: 30_000 });
}

function git(repo: string, ...args: string[]) {
  return command("git", ["-C", repo, ...args], ROOT);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function makeFixture(options: { treehouse?: boolean; noMistakes?: boolean } = {}): Fixture {
  mkdirSync(SCRATCH, { recursive: true });
  const outer = mkdtempSync(join(SCRATCH, "cb-p3-"));
  const repo = join(outer, "repo");
  const runs = join(outer, "runs");
  mkdirSync(repo);
  mkdirSync(runs);
  expect(command("git", ["init", "-b", "main"], repo).status).toBe(0);
  expect(git(repo, "config", "user.name", "Combo P3 Test").status).toBe(0);
  expect(git(repo, "config", "user.email", "combo-p3@example.test").status).toBe(0);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  if (options.treehouse) {
    expect(command("treehouse", ["init"], repo).status).toBe(0);
  }
  if (options.noMistakes) {
    writeFileSync(join(repo, ".no-mistakes.yaml"), "checks:\n  test: true\n");
  }
  expect(git(repo, "add", ".").status).toBe(0);
  expect(git(repo, "commit", "-m", "fixture base").status).toBe(0);
  const fixture = { outer, repo, runs, treehousePaths: [], gitWorktrees: [] };
  fixtures.push(fixture);
  return fixture;
}

function defaultReadiness() {
  return {
    required_seats: ["coder", "reviewer", "gate"],
    seats: [
      { id: "coder", harness: "/bin/sh", auth_cmd: "exit 0" },
      { id: "reviewer", harness: "/bin/sh", auth_cmd: "exit 0" },
      { id: "gate", harness: "/bin/sh", auth_cmd: "exit 0" },
    ],
  };
}

function makeRun(
  fixture: Fixture,
  run: string,
  input: {
    mode?: "treehouse" | "git-worktree-explicit";
    readiness?: object;
    setup?: string;
    custody?: string;
  } = {},
) {
  const runDir = join(fixture.runs, run);
  mkdirSync(join(runDir, "agents"), { recursive: true });
  const readiness = join(runDir, "readiness.json");
  writeFileSync(readiness, JSON.stringify(input.readiness ?? defaultReadiness()));
  const mode = input.mode ?? "treehouse";
  const gitPath = join(fixture.repo, ".worktrees", run);
  const config = [
    `CB_REPO_DIR=${shellQuote(fixture.repo)}`,
    `CB_RUNWAY_MODE=${shellQuote(mode)}`,
    `CB_READINESS_FILE=${shellQuote(readiness)}`,
    `CB_GIT_WORKTREE_PATH=${shellQuote(gitPath)}`,
    `CB_SETUP_CMD=${shellQuote(input.setup ?? "")}`,
    `CB_CLEAN_CUSTODY_CMD=${shellQuote(input.custody ?? "exit 0")}`,
  ];
  writeFileSync(join(runDir, "config.env"), config.join("\n") + "\n");
  return { runDir, readiness, gitPath };
}

function runScript(
  fixture: Fixture,
  script: "cb-launcher.sh" | "cb-cleaner.sh",
  run: string,
  env = process.env,
) {
  const result = command("sh", [join(BIN, script), run], ROOT, {
    ...env,
    CB_RUNS_DIR: fixture.runs,
  });
  const metaPath = join(fixture.runs, run, "agents", "launcher.ownership.json");
  if (script === "cb-launcher.sh" && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Ownership;
    const paths = meta.runway_kind === "treehouse" ? fixture.treehousePaths : fixture.gitWorktrees;
    if (existsSync(meta.worktree) && !paths.includes(meta.worktree)) paths.push(meta.worktree);
  }
  if (script === "cb-launcher.sh" && treehouseAvailable) {
    const status = command("treehouse", ["status"], fixture.repo);
    const held = (status.stdout ?? "")
      .split("\n")
      .find((line) => line.includes(`(held by ${run})`))
      ?.match(/\sleased\s+(.+?)\s+\(held by /)?.[1];
    const path = held?.startsWith("~/") ? join(process.env.HOME ?? "", held.slice(2)) : held;
    if (path && !fixture.treehousePaths.includes(path)) fixture.treehousePaths.push(path);
  }
  return result;
}

async function runScriptWithPidPause(
  fixture: Fixture,
  script: "cb-launcher.sh" | "cb-cleaner.sh",
  run: string,
  plantAttack: (pid: number) => void,
) {
  const realpathBin = command("sh", ["-c", "command -v realpath"], ROOT).stdout.trim();
  const fake = fakeCommand(
    fixture,
    "realpath",
    `#!/bin/sh
while [ ! -e $MARKER ]; do sleep 0.01; done
exec ${shellQuote(realpathBin)} "$@"
`,
  );
  const child = spawn("/bin/sh", [join(BIN, script), run], {
    cwd: ROOT,
    env: {
      ...process.env,
      CB_RUNS_DIR: fixture.runs,
      PATH: `${fake.path}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(child.pid).toBeTypeOf("number");
  plantAttack(child.pid as number);
  writeFileSync(fake.marker, "continue\n");
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolveChild) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("close", (status) => resolveChild({ status, stdout, stderr }));
    },
  );
  const metaPath = join(fixture.runs, run, "agents", "launcher.ownership.json");
  if (script === "cb-launcher.sh" && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Ownership;
    if (existsSync(meta.worktree) && !fixture.gitWorktrees.includes(meta.worktree)) {
      fixture.gitWorktrees.push(meta.worktree);
    }
  }
  return result;
}

function events(runDir: string) {
  const journal = join(runDir, "journal.jsonl");
  if (!existsSync(journal)) return [];
  return readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { agent: string; code: number; event: string; payload: Record<string, unknown> },
    );
}

function ownership(runDir: string) {
  return JSON.parse(readFileSync(join(runDir, "agents", "launcher.ownership.json"), "utf8")) as Ownership;
}

function fakeCommand(fixture: Fixture, name: string, body: string) {
  const fakeBin = join(fixture.outer, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const marker = join(fixture.outer, `${name}-called`);
  const path = join(fakeBin, name);
  writeFileSync(path, body.replaceAll("$MARKER", shellQuote(marker)), { mode: 0o755 });
  return { marker, path: fakeBin };
}

function fakeTreehouse(fixture: Fixture, body: string) {
  return fakeCommand(fixture, "treehouse", body);
}

function cleanupFixture(fixture: Fixture) {
  for (const worktree of fixture.gitWorktrees) {
    if (existsSync(worktree)) git(fixture.repo, "worktree", "remove", "--force", worktree);
  }
  for (const worktree of fixture.treehousePaths) {
    const status = command("treehouse", ["return", worktree], fixture.repo);
    if (status.status !== 0 && !/not leased|available/i.test(status.stderr + status.stdout)) {
      const forced = command("treehouse", ["return", "--force", worktree], fixture.repo);
      if (forced.status !== 0) {
        throw new Error(`failed to release fixture lease ${worktree}: ${forced.stderr || forced.stdout}`);
      }
    }
    command("treehouse", ["destroy", worktree, "--include-unlanded", "--yes"], fixture.repo);
  }
  rmSync(fixture.outer, { recursive: true, force: true });
}

beforeAll(() => mkdirSync(SCRATCH, { recursive: true }));

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupFixture(fixture);
});
// -/ 1/4

// -- 2/4 CORE · Real Treehouse runway and refusal law -- <- START HERE
const treehouseAvailable = command("treehouse", ["--version"], ROOT).status === 0;
const treehouseDescribe = treehouseAvailable ? describe : describe.skip;

treehouseDescribe("cb-launcher/cb-cleaner Treehouse runway", () => {
  it("persists the exact real lease and releases that same path", () => {
    const fixture = makeFixture({ treehouse: true, noMistakes: true });
    const run = "p3-treehouse-real";
    const { runDir } = makeRun(fixture, run, { setup: "test -f .no-mistakes.yaml" });
    const baseSha = git(fixture.repo, "rev-parse", "HEAD").stdout.trim();

    const launched = runScript(fixture, "cb-launcher.sh", run);
    expect(launched.status, launched.stderr).toBe(0);
    const meta = ownership(runDir);
    expect(meta).toMatchObject({
      run,
      runway_kind: "treehouse",
      repo_dir: fixture.repo,
      branch: `combo/${run}`,
      base_sha: baseSha,
      lease_id: run,
    });
    expect(resolve(meta.worktree)).toBe(meta.worktree);
    expect(git(meta.worktree, "branch", "--show-current").stdout.trim()).toBe(`combo/${run}`);
    expect(readFileSync(join(meta.worktree, ".no-mistakes.yaml"), "utf8")).toContain("test: true");
    const launchEvent = events(runDir).at(-1);
    expect(launchEvent).toMatchObject({
      agent: "launcher",
      code: 0,
      event: "launch_ready",
      payload: {
        worktree: meta.worktree,
        branch: `combo/${run}`,
        base_sha: baseSha,
        runway_kind: "treehouse",
        lease_id: run,
      },
    });
    const held = command("treehouse", ["status"], fixture.repo);
    expect(held.stdout).toContain(`held by ${run}`);
    expect(held.stdout).toContain(basename(meta.worktree));

    const cleaned = runScript(fixture, "cb-cleaner.sh", run);
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(events(runDir).at(-1)).toMatchObject({ agent: "cleaner", code: 0, event: "cleaned" });
    const available = command("treehouse", ["status"], fixture.repo);
    expect(available.stdout).toContain("available");
    expect(available.stdout).not.toContain(`held by ${run}`);
    const cleanerMeta = JSON.parse(
      readFileSync(join(runDir, "agents", "cleaner.ownership.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(cleanerMeta).toMatchObject({
      run,
      runway_kind: "treehouse",
      worktree: meta.worktree,
      released: true,
    });
  }, 30_000);

  it("journals a refused Treehouse return and leaves the exact lease held", () => {
    const fixture = makeFixture({ treehouse: true });
    const run = "p3-treehouse-refusal";
    const { runDir } = makeRun(fixture, run);
    expect(runScript(fixture, "cb-launcher.sh", run).status).toBe(0);
    const treehouseBin = command("sh", ["-c", "command -v treehouse"], ROOT).stdout.trim();
    const fake = fakeTreehouse(
      fixture,
      `#!/bin/sh
if [ "$1" = status ]; then exec ${shellQuote(treehouseBin)} "$@"; fi
exit 42
`,
    );

    const cleaned = runScript(fixture, "cb-cleaner.sh", run, {
      ...process.env,
      PATH: `${fake.path}:${process.env.PATH}`,
    });
    expect(cleaned.status).not.toBe(0);
    expect(events(runDir).at(-1)).toMatchObject({
      agent: "cleaner",
      code: 1,
      event: "clean_failed",
      payload: { reasons: expect.arrayContaining(["treehouse:release_refused"]) },
    });
    expect(command("treehouse", ["status"], fixture.repo).stdout).toContain(`held by ${run}`);
  }, 30_000);

  it("rechecks exact live identity immediately before Treehouse return", () => {
    const fixture = makeFixture({ treehouse: true });
    const run = "p3-treehouse-identity-race";
    const { runDir } = makeRun(fixture, run);
    expect(runScript(fixture, "cb-launcher.sh", run).status).toBe(0);
    const treehouseBin = command("sh", ["-c", "command -v treehouse"], ROOT).stdout.trim();
    const fake = fakeTreehouse(
      fixture,
      `#!/bin/sh
if [ "$1" = status ]; then
  count=$(cat $MARKER 2>/dev/null || printf 0); count=$((count + 1)); printf %s "$count" >$MARKER
  [ "$count" -eq 1 ] && exec ${shellQuote(treehouseBin)} "$@"
  exit 42
fi
if [ "$1" = return ]; then printf called >$MARKER.return; exit 99; fi
exec ${shellQuote(treehouseBin)} "$@"
`,
    );

    expect(
      runScript(fixture, "cb-cleaner.sh", run, { ...process.env, PATH: `${fake.path}:${process.env.PATH}` })
        .status,
    ).not.toBe(0);
    expect(events(runDir).at(-1)?.payload).toMatchObject({
      reasons: expect.arrayContaining(["treehouse:lease_identity_changed"]),
    });
    expect(existsSync(`${fake.marker}.return`)).toBe(false);
    expect(command("treehouse", ["status"], fixture.repo).stdout).toContain(`held by ${run}`);
  }, 30_000);

  it.each(["single", "dual"])(
    "recovers the holder after %s wrong absolute output",
    (shape) => {
      const fixture = makeFixture({ treehouse: true });
      const run = `p3-treehouse-${shape}-absolute`;
      const { runDir } = makeRun(fixture, run);
      const treehouseBin = command("sh", ["-c", "command -v treehouse"], ROOT).stdout.trim();
      const fake = fakeTreehouse(
        fixture,
        `#!/bin/sh
if [ "$1" = get ]; then
  actual=$(${shellQuote(treehouseBin)} "$@")
  code=$?
  [ "$code" -ne 0 ] || { printf '/wrong-treehouse-path\\n'; [ ${shellQuote(shape)} = dual ] && printf '%s\\n' "$actual"; }
  exit "$code"
fi
exec ${shellQuote(treehouseBin)} "$@"
`,
      );

      const launched = runScript(fixture, "cb-launcher.sh", run, {
        ...process.env,
        PATH: `${fake.path}:${process.env.PATH}`,
      });
      expect(launched.status).not.toBe(0);
      expect(events(runDir).at(-1)?.payload).toMatchObject({
        reasons: expect.arrayContaining(["treehouse:invalid_response"]),
      });
      expect(existsSync(join(runDir, "agents", "launcher.ownership.json"))).toBe(false);
      expect(command("treehouse", ["status"], fixture.repo).stdout).not.toContain(`held by ${run}`);
    },
    30_000,
  );

  it("allows exact cleanup after branch creation fails in a real lease", () => {
    const fixture = makeFixture({ treehouse: true });
    const run = "p3-treehouse-branch-fail";
    const { runDir } = makeRun(fixture, run);
    const gitBin = command("sh", ["-c", "command -v git"], ROOT).stdout.trim();
    const fake = fakeCommand(
      fixture,
      "git",
      `#!/bin/sh
if [ "$3" = switch ] && [ "$4" = -c ] && [ "$5" = "combo/${run}" ]; then exit 42; fi
exec ${shellQuote(gitBin)} "$@"
`,
    );

    const launched = runScript(fixture, "cb-launcher.sh", run, {
      ...process.env,
      PATH: `${fake.path}:${process.env.PATH}`,
    });
    expect(launched.status).not.toBe(0);
    expect(events(runDir).at(-1)?.payload).toMatchObject({
      reasons: expect.arrayContaining(["branch:create_failed"]),
    });
    expect(runScript(fixture, "cb-cleaner.sh", run).status).toBe(0);
    expect(command("treehouse", ["status"], fixture.repo).stdout).not.toContain(`held by ${run}`);
  }, 30_000);
});

describe("cb-launcher Treehouse refusal", () => {
  it("journals refusal and never creates an automatic Git worktree", () => {
    const fixture = makeFixture();
    const run = "p3-treehouse-refused";
    const { runDir, gitPath } = makeRun(fixture, run);
    const fake = fakeTreehouse(fixture, "#!/bin/sh\nprintf called >$MARKER\nexit 42\n");
    const result = runScript(fixture, "cb-launcher.sh", run, {
      ...process.env,
      PATH: `${fake.path}:${process.env.PATH}`,
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(fake.marker)).toBe(true);
    expect(existsSync(gitPath)).toBe(false);
    expect(git(fixture.repo, "show-ref", "--verify", `refs/heads/combo/${run}`).status).not.toBe(0);
    expect(events(runDir).at(-1)).toMatchObject({
      agent: "launcher",
      code: 1,
      event: "launch_not_ready",
      payload: { reasons: expect.arrayContaining(["treehouse:acquire_refused"]) },
    });
  });

  it("journals rollback refusal when no unique holder path can be recovered", () => {
    const fixture = makeFixture();
    const run = "p3-treehouse-unrecoverable";
    const { runDir, gitPath } = makeRun(fixture, run);
    const fake = fakeTreehouse(
      fixture,
      '#!/bin/sh\nif [ "$1" = get ]; then printf called >$MARKER; printf "unusable\\n"; exit 0; fi\nexit 42\n',
    );
    expect(
      runScript(fixture, "cb-launcher.sh", run, { ...process.env, PATH: `${fake.path}:${process.env.PATH}` })
        .status,
    ).not.toBe(0);
    expect(events(runDir).at(-1)?.payload).toMatchObject({
      reasons: expect.arrayContaining(["treehouse:invalid_response", "treehouse:rollback_refused"]),
    });
    expect(existsSync(gitPath)).toBe(false);
  });
});
// -/ 2/4

// -- 3/4 CORE · Explicit Git ownership and exact Cleaner custody --
describe("explicit Git runway and Cleaner custody", () => {
  it("records a distinct Git owner, never calls Treehouse, and removes only its exact path", () => {
    const fixture = makeFixture();
    const run = "p3-git-explicit";
    const { runDir, gitPath } = makeRun(fixture, run, { mode: "git-worktree-explicit" });
    const fake = fakeTreehouse(fixture, "#!/bin/sh\nprintf called >$MARKER\nexit 99\n");
    const env = { ...process.env, PATH: `${fake.path}:${process.env.PATH}` };

    const launched = runScript(fixture, "cb-launcher.sh", run, env);
    expect(launched.status, launched.stderr).toBe(0);
    const meta = ownership(runDir);
    expect(meta).toMatchObject({
      run,
      runway_kind: "git-worktree-explicit",
      worktree: gitPath,
      branch: `combo/${run}`,
      ownership_id: `git-worktree:${run}`,
    });
    expect(meta).not.toHaveProperty("lease_id");
    expect(events(runDir).at(-1)?.payload).toMatchObject({
      runway_kind: "git-worktree-explicit",
      ownership_id: `git-worktree:${run}`,
      lease_id: "not-applicable",
    });
    expect(existsSync(fake.marker)).toBe(false);

    const cleaned = runScript(fixture, "cb-cleaner.sh", run, env);
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(existsSync(gitPath)).toBe(false);
    expect(existsSync(fake.marker)).toBe(false);
  });

  it("refuses copied ownership metadata from another run", () => {
    const fixture = makeFixture();
    const run = "p3-owner-mismatch";
    const { runDir, gitPath } = makeRun(fixture, run, { mode: "git-worktree-explicit" });
    expect(runScript(fixture, "cb-launcher.sh", run).status).toBe(0);
    const meta = ownership(runDir);
    writeFileSync(
      join(runDir, "agents", "launcher.ownership.json"),
      JSON.stringify({ ...meta, run: "another-run", ownership_id: "git-worktree:another-run" }),
    );

    const cleaned = runScript(fixture, "cb-cleaner.sh", run);
    expect(cleaned.status).not.toBe(0);
    expect(existsSync(gitPath)).toBe(true);
    expect(events(runDir).at(-1)).toMatchObject({
      agent: "cleaner",
      code: 1,
      event: "clean_failed",
      payload: { reasons: expect.arrayContaining(["ownership:run_mismatch"]) },
    });
  });

  it("fails safely while Gate custody is active or the exact Git release is refused", () => {
    const fixture = makeFixture();
    const activeRun = "p3-custody-active";
    const active = makeRun(fixture, activeRun, { mode: "git-worktree-explicit", custody: "exit 1" });
    expect(runScript(fixture, "cb-launcher.sh", activeRun).status).toBe(0);
    const custody = runScript(fixture, "cb-cleaner.sh", activeRun);
    expect(custody.status).not.toBe(0);
    expect(existsSync(active.gitPath)).toBe(true);
    expect(events(active.runDir).at(-1)?.payload).toMatchObject({
      reasons: expect.arrayContaining(["custody:active_or_unverified"]),
    });

    const dirtyRun = "p3-release-refused";
    const dirty = makeRun(fixture, dirtyRun, { mode: "git-worktree-explicit" });
    expect(runScript(fixture, "cb-launcher.sh", dirtyRun).status).toBe(0);
    writeFileSync(join(dirty.gitPath, "dirty.txt"), "do not force\n");
    const refused = runScript(fixture, "cb-cleaner.sh", dirtyRun);
    expect(refused.status).not.toBe(0);
    expect(existsSync(dirty.gitPath)).toBe(true);
    expect(events(dirty.runDir).at(-1)?.payload).toMatchObject({
      reasons: expect.arrayContaining(["git-worktree:release_refused"]),
    });
  });

  it("refuses branch collisions and runs setup only when explicitly configured", () => {
    const fixture = makeFixture();
    const collisionRun = "p3-branch-collision";
    const collision = makeRun(fixture, collisionRun, { mode: "git-worktree-explicit" });
    expect(git(fixture.repo, "branch", `combo/${collisionRun}`).status).toBe(0);
    expect(runScript(fixture, "cb-launcher.sh", collisionRun).status).not.toBe(0);
    expect(events(collision.runDir).at(-1)?.payload).toMatchObject({
      reasons: expect.arrayContaining(["branch:collision"]),
    });
    expect(existsSync(collision.gitPath)).toBe(false);

    const setupRun = "p3-setup-explicit";
    const setup = makeRun(fixture, setupRun, { mode: "git-worktree-explicit", setup: "exit 7" });
    expect(runScript(fixture, "cb-launcher.sh", setupRun).status).not.toBe(0);
    expect(events(setup.runDir).at(-1)?.payload).toMatchObject({
      reasons: expect.arrayContaining(["setup:failed"]),
    });
    expect(runScript(fixture, "cb-cleaner.sh", setupRun).status).toBe(0);
  });

  it("clears failed explicit Git ownership so the same attempt can retry", () => {
    const fixture = makeFixture();
    const run = "p3-git-retry";
    const { runDir } = makeRun(fixture, run, { mode: "git-worktree-explicit" });
    const gitBin = command("sh", ["-c", "command -v git"], ROOT).stdout.trim();
    const fake = fakeCommand(
      fixture,
      "git",
      `#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = add ]; then exit 42; fi
exec ${shellQuote(gitBin)} "$@"
`,
    );

    expect(
      runScript(fixture, "cb-launcher.sh", run, {
        ...process.env,
        PATH: `${fake.path}:${process.env.PATH}`,
      }).status,
    ).not.toBe(0);
    expect(existsSync(join(runDir, "agents", "launcher.ownership.json"))).toBe(false);
    expect(runScript(fixture, "cb-launcher.sh", run).status).toBe(0);
    expect(runScript(fixture, "cb-cleaner.sh", run).status).toBe(0);
  });

  const launcherTemps = [
    ["reasons", "run", ".launcher-reasons."],
    ["seats", "run", ".launcher-seats."],
    ["treehouse stdout", "run", ".launcher-treehouse-out."],
    ["treehouse stderr", "run", ".launcher-treehouse-err."],
    ["ownership", "agents", ".launcher.ownership.tmp."],
    ["config", "run", ".config.env.tmp."],
  ] as const;

  it.each(
    launcherTemps.flatMap(([name, location, prefix]) =>
      (["existing", "dangling"] as const).map((targetKind) => [name, location, prefix, targetKind] as const),
    ),
  )(
    "does not follow a %s temp in %s at %s in Launcher (%s target)",
    async (_name, location, prefix, targetKind) => {
      const fixture = makeFixture();
      const run = `p3-launch-link-${prefix.replaceAll(/[^a-z]/g, "")}-${targetKind}`;
      const { runDir } = makeRun(fixture, run, { mode: "git-worktree-explicit" });
      const victim = join(fixture.outer, `${_name.replaceAll(" ", "-")}-${targetKind}-victim`);
      if (targetKind === "existing") writeFileSync(victim, "PRECIOUS\n");

      const result = await runScriptWithPidPause(fixture, "cb-launcher.sh", run, (pid) => {
        const parent = location === "agents" ? join(runDir, "agents") : runDir;
        symlinkSync(victim, join(parent, `${prefix}${pid}`));
      });

      expect(result.status).not.toBe(0);
      if (targetKind === "existing") expect(readFileSync(victim, "utf8")).toBe("PRECIOUS\n");
      else expect(existsSync(victim)).toBe(false);
    },
    30_000,
  );

  it.each([
    ["reasons", ".cleaner-reasons.", "existing"],
    ["reasons", ".cleaner-reasons.", "dangling"],
    ["ownership", ".cleaner.ownership.tmp.", "existing"],
    ["ownership", ".cleaner.ownership.tmp.", "dangling"],
  ])("does not follow a %s temp %s symlink in Cleaner (%s target)", async (_name, prefix, targetKind) => {
    const fixture = makeFixture();
    const run = `p3-clean-link-${_name}-${targetKind}`;
    const { runDir } = makeRun(fixture, run, { mode: "git-worktree-explicit" });
    expect(runScript(fixture, "cb-launcher.sh", run).status).toBe(0);
    const victim = join(fixture.outer, `${_name}-${targetKind}-victim`);
    if (targetKind === "existing") writeFileSync(victim, "PRECIOUS\n");

    const result = await runScriptWithPidPause(fixture, "cb-cleaner.sh", run, (pid) => {
      symlinkSync(victim, join(runDir, _name === "ownership" ? "agents" : "", `${prefix}${pid}`));
    });

    expect(result.status).not.toBe(0);
    if (targetKind === "existing") expect(readFileSync(victim, "utf8")).toBe("PRECIOUS\n");
    else expect(existsSync(victim)).toBe(false);
  });
});
// -/ 3/4

// -- 4/4 CORE · Generic seat/harness/auth readiness boundary --
describe("Launcher readiness input", () => {
  it("aggregates missing seat, missing/non-runnable harness, and failed auth without leaking output", () => {
    const fixture = makeFixture();
    const run = "p3-readiness-failures";
    const notRunnable = join(fixture.outer, "not-runnable");
    writeFileSync(notRunnable, "#!/bin/sh\nexit 0\n");
    chmodSync(notRunnable, 0o644);
    const readiness = {
      required_seats: ["missing", "no-bin", "not-runnable", "auth"],
      seats: [
        { id: "no-bin", harness: join(fixture.outer, "absent-harness"), auth_cmd: "exit 0" },
        { id: "not-runnable", harness: notRunnable, auth_cmd: "exit 0" },
        {
          id: "auth",
          harness: "/bin/sh",
          auth_cmd: "printf 'SUPER_SECRET_P3_TOKEN' >&2; exit 9",
        },
      ],
    };
    const { runDir } = makeRun(fixture, run, { readiness });
    const fake = fakeTreehouse(fixture, "#!/bin/sh\nprintf called >$MARKER\nexit 99\n");
    const result = runScript(fixture, "cb-launcher.sh", run, {
      ...process.env,
      PATH: `${fake.path}:${process.env.PATH}`,
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(fake.marker)).toBe(false);
    const failure = events(runDir).at(-1);
    expect(failure).toMatchObject({
      agent: "launcher",
      code: 1,
      event: "launch_not_ready",
      payload: {
        reasons: expect.arrayContaining([
          "seat:missing:missing",
          "seat:no-bin:harness:absent-harness:missing",
          "seat:not-runnable:harness:not-runnable:not_runnable",
          "seat:auth:auth:sh:not_ready",
        ]),
      },
    });
    expect(result.stdout + result.stderr + readFileSync(join(runDir, "journal.jsonl"), "utf8")).not.toContain(
      "SUPER_SECRET_P3_TOKEN",
    );
    expect(runScript(fixture, "cb-cleaner.sh", run).status).toBe(0);
    expect(existsSync(fake.marker)).toBe(false);
    expect(events(runDir).at(-1)).toMatchObject({ agent: "cleaner", code: 0, event: "cleaned" });
  });
});
// -/ 4/4
