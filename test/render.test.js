// Render tests for statusline.js
// Spawns the real script and asserts on its stdin -> stdout contract.
// Fully self-contained: no network, no credentials, no API key required.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'statusline.js');

// Empty fake HOME so the todos/credentials lookups find nothing -> deterministic.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-'));
after(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// Run statusline.js with the given stdin string. Returns { code, raw, clean }.
// opts.home  : override the fake HOME (default: empty FAKE_HOME -> no usage/todos)
// opts.usage : when true, allow the usage path to run (otherwise a dummy
//              ANTHROPIC_API_KEY is set so the usage fetch is skipped entirely)
function run(input, opts = {}) {
  const home = opts.home || FAKE_HOME;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (opts.usage) {
    delete env.ANTHROPIC_API_KEY;
  } else {
    env.ANTHROPIC_API_KEY = 'test';
  }
  // Width drives the responsive wrap. Default: unset -> always single line (matches
  // pre-responsive behavior, keeps `split(' │ ')` assertions deterministic).
  if (opts.columns != null) {
    env.COLUMNS = String(opts.columns);
  } else {
    delete env.COLUMNS;
  }
  // Segment opt-out. Default: unset so a value in the dev env can't skew assertions.
  if (opts.disable != null) {
    env.CTXLINE_DISABLE = opts.disable;
  } else {
    delete env.CTXLINE_DISABLE;
  }
  // Config file. opts.config takes an object (serialized) or a raw string (to exercise
  // malformed input). Default: a path that doesn't exist, so a real config in the dev
  // environment can never leak into a test.
  env.CTXLINE_CONFIG = opts.config != null
    ? writeConfig(opts.config)
    : path.join(FAKE_HOME, 'no-such-config.json');
  const res = spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', timeout: 5000, env });
  const raw = res.stdout || '';
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI for readable assertions
  return { code: res.status, raw, clean };
}

// Write a config file into the shared fake HOME and return its path. Each call gets a
// distinct filename so tests can't observe each other's config.
let configSeq = 0;
function writeConfig(config) {
  const file = path.join(FAKE_HOME, `ctxline-${configSeq++}.json`);
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  return file;
}

// Build a throwaway HOME containing a tokenless credentials file (so getApiUsage
// bails out before any network/keychain call) and optionally a seeded usage cache
// of a given age. Lets us exercise the cache-first / stale-fallback logic offline.
function seedHome({ cacheAgeMs, percentage = 42, weeklyPercentage = 31 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cache-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), '{}'); // no accessToken -> API skipped
  if (cacheAgeMs != null) {
    const cache = {
      timestamp: Date.now() - cacheAgeMs,
      data: {
        fiveHour: { percentage, resetsAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() },
        // 62h out -> exercises the day-aware countdown (2d14h)
        weekly: { percentage: weeklyPercentage, resetsAt: new Date(Date.now() + 62 * 3600 * 1000).toISOString() }
      }
    };
    fs.writeFileSync(path.join(claudeDir, 'cache', 'usage-cache.json'), JSON.stringify(cache));
  }
  return home;
}

function fixture(remaining, dir = '/tmp/myproject', model = 'Opus 4.8', effort, cost) {
  const obj = {
    model: { display_name: model },
    workspace: { current_dir: dir },
    session_id: 'test-session',
    context_window: { remaining_percentage: remaining }
  };
  if (effort) obj.effort = { level: effort };
  if (cost != null) obj.cost = { total_cost_usd: cost };
  return JSON.stringify(obj);
}

// stdin payload carrying `rate_limits` (Claude.ai Pro/Max, post-first-response).
// resets_at is a Unix epoch in SECONDS. 5h ~2h out, 7d ~62h out (exercises day-aware countdown).
// Claude Code pipes only five_hour and seven_day here — never a model-scoped limit.
function fixtureWithRateLimits(remaining, { five = 23.5, seven = 41.2, model = 'Opus 4.8', effort } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    model: { display_name: model },
    workspace: { current_dir: '/tmp/myproject' },
    session_id: 'test-session',
    context_window: { remaining_percentage: remaining },
    ...(effort ? { effort: { level: effort } } : {}),
    rate_limits: {
      five_hour: { used_percentage: five, resets_at: nowSec + 2 * 3600 },
      seven_day: { used_percentage: seven, resets_at: nowSec + 62 * 3600 }
    }
  });
}

// Add model-scoped limits to an already-seeded cache, so the render path can be tested
// without a network call. Each entry is { name, percentage }; the reset is 62h out.
function seedScopedCache(home, models) {
  const cacheFile = path.join(home, '.claude', 'cache', 'usage-cache.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache.data.models = models.map(m => ({
    ...m,
    resetsAt: new Date(Date.now() + 62 * 3600 * 1000).toISOString()
  }));
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
}

// Make a real dir with a seeded .git/HEAD so the branch segment renders deterministically.
function seedRepo(branch = 'feature/x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-repo-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

// --- real-git helpers for the ahead/behind segment ---
function git(dir, args) { return spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); }
function hasGit() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}
function gitCommit(dir, tag) {
  fs.writeFileSync(path.join(dir, 'f-' + tag), tag);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', tag]);
}

// Real git repo whose HEAD is `ahead` commits ahead and `behind` behind a tracked
// upstream (origin/<branch>), so `git rev-list @{u}...HEAD` reports real counts.
function seedDivergedRepo({ ahead = 0, behind = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-gitdiv-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // register origin so the merge ref maps to a remote-tracking branch (@{u} resolves)
  git(dir, ['config', 'remote.origin.url', '.']);
  git(dir, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  gitCommit(dir, 'base');
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const baseSha = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  // build the upstream (behind) chain on top of base, park it in origin/<branch>
  for (let i = 0; i < behind; i++) gitCommit(dir, 'up' + i);
  const upstreamSha = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  git(dir, ['update-ref', 'refs/remotes/origin/' + branch, upstreamSha]);
  git(dir, ['config', 'branch.' + branch + '.remote', 'origin']);
  git(dir, ['config', 'branch.' + branch + '.merge', 'refs/heads/' + branch]);
  // reset HEAD back to base, then build the local (ahead) chain -> diverges from upstream
  git(dir, ['reset', '--hard', '-q', baseSha]);
  for (let i = 0; i < ahead; i++) gitCommit(dir, 'local' + i);
  return dir;
}

// Throwaway HOME so each git test gets an isolated git-cache.json.
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-githome-'));
  after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

// ANSI color codes the script emits (kept in sync with statusline.js `colors`).
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const ORANGE = '\x1b[38;5;208m';
const RED = '\x1b[31m';
const PURPLE = '\x1b[38;5;135m';
const DIM = '\x1b[2m';
const BLINK = '\x1b[5m';

test('line assembly: dir basename | model | context, separated by │', () => {
  const { code, clean } = run(fixture(40, '/home/me/cool-project', 'Sonnet 4.6'));
  assert.strictEqual(code, 0);
  const parts = clean.split(' │ ');
  assert.strictEqual(parts[0], 'cool-project');        // basename only
  assert.strictEqual(parts[1], 'Sonnet 4.6');          // model passes through
  assert.match(parts[2], /^C\d+ /);                    // compact context label "C60 ███░░░"
});

test('model name is shortened: "(1M context)" -> "(1M)"', () => {
  const { clean } = run(fixture(40, '/home/me/p', 'Opus 4.8 (1M context)'));
  const parts = clean.split(' │ ');
  assert.strictEqual(parts[1], 'Opus 4.8 (1M)');
});

test('git branch renders next to the dir (⎇ <branch>)', () => {
  const repo = seedRepo('feature/x');
  const { clean } = run(fixture(40, repo));
  const parts = clean.split(' │ ');
  assert.match(parts[0], /⎇ feature\/x$/);              // branch glued to dir segment
  assert.ok(parts[0].startsWith(path.basename(repo)));  // dir basename still first
});

test('short ticket branch is not truncated (TAMA5-32796 stays whole)', () => {
  const repo = seedRepo('TAMA5-32796');
  const { clean } = run(fixture(40, repo));
  assert.match(clean, /⎇ TAMA5-32796 /);                 // intact, no ellipsis
});

test('over-long branch is tail-truncated to 24 chars with …', () => {
  const repo = seedRepo('TAMA5-32796-add-login-form-and-tests');
  const { clean } = run(fixture(40, repo));
  const parts = clean.split(' │ ');
  const m = parts[0].match(/⎇ (.+)$/);
  assert.ok(m, 'branch segment present');
  assert.strictEqual(m[1].length, 24);                   // 23 chars + …
  assert.ok(m[1].endsWith('…'));
  assert.ok(m[1].startsWith('TAMA5-32796'));             // ticket ID preserved
});

test('no .git -> no branch glyph in dir segment', () => {
  const { clean } = run(fixture(40, '/no/such/repo/here'));
  const parts = clean.split(' │ ');
  assert.ok(!parts[0].includes('⎇'), 'branch glyph should be absent without a repo');
});

test('detached HEAD -> short 7-char SHA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-detach-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'abc1234567890abcdef1234567890abcdef12345\n'); // 40-char SHA
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { clean } = run(fixture(40, dir));
  assert.match(clean.split(' │ ')[0], /⎇ abc1234$/);   // first 7 chars of the SHA
});

test('worktree (.git is a file with gitdir:) -> branch still renders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-wt-'));
  const gitdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-wtgit-'));
  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/feature/wt\n');
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitdir}\n`); // .git as a file pointer
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(gitdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { clean } = run(fixture(40, dir));
  assert.match(clean.split(' │ ')[0], /⎇ feature\/wt$/);
});

test('control chars in a hand-crafted HEAD are stripped from the branch', () => {
  const repo = seedRepo('bad\x1b[31mname\x07');   // injected ANSI escape + BEL
  const { raw, clean } = run(fixture(40, repo));
  assert.ok(!raw.includes('\x1b[31mname'), 'injected escape sequence must not reach output');
  assert.match(clean.split(' │ ')[0], /⎇ bad\[31mname$/);  // printable remainder kept, controls gone
});

test('thinking effort renders next to the model (· <level>)', () => {
  const { clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', 'high'));
  const parts = clean.split(' │ ');
  assert.match(parts[1], /Opus 4\.8 · high$/);
});

test('no effort field -> model segment unchanged', () => {
  const { clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8'));
  const parts = clean.split(' │ ');
  assert.strictEqual(parts[1], 'Opus 4.8');
});

test('effort = max is red', () => {
  const { raw, clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', 'max'));
  assert.strictEqual(clean.split(' │ ')[1], 'Opus 4.8 · max');
  assert.ok(raw.includes(RED), 'expected red for max effort');
});

test('effort = ultracode is purple', () => {
  const { raw, clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', 'ultracode'));
  assert.strictEqual(clean.split(' │ ')[1], 'Opus 4.8 · ultracode');
  assert.ok(raw.includes(PURPLE), 'expected purple for ultracode effort');
});

test('effort = xhigh is dim (not highlighted red/purple)', () => {
  const { raw, clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', 'xhigh'));
  assert.strictEqual(clean.split(' │ ')[1], 'Opus 4.8 · xhigh');
  assert.ok(raw.includes(DIM), 'xhigh effort uses the dim style');
  assert.ok(!raw.includes(PURPLE) && !raw.includes(RED), 'xhigh must not be highlighted');
});

test('session cost renders as $X.XX (two decimals)', () => {
  const { clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', undefined, 0.4));
  assert.match(clean, /\$0\.40\b/);                    // 0.4 -> "$0.40"
});

test('session cost is dim', () => {
  const { raw } = run(fixture(40, '/no/such/repo', 'Opus 4.8', undefined, 1.5));
  assert.ok(raw.includes(`${DIM}$1.50`), 'expected dim-rendered cost');
});

test('no cost field -> segment omitted (finite-guarded, no $)', () => {
  const { clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8'));
  assert.ok(!clean.includes('$'), 'cost segment should be absent without cost.total_cost_usd');
});

test('cost renders after usage and before task', () => {
  // Fresh-cache usage + cost present; no in_progress todo in FAKE_HOME -> cost is last.
  const home = seedHome({ cacheAgeMs: 5000, percentage: 42, weeklyPercentage: 31 });
  const { clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', undefined, 0.42), { home, usage: true });
  const parts = clean.split(' │ ');
  const costIdx = parts.findIndex(p => p.includes('$0.42'));
  const weeklyIdx = parts.findIndex(p => /^W\d+/.test(p));
  assert.ok(costIdx > weeklyIdx, 'cost should come after the weekly usage segment');
  assert.strictEqual(costIdx, parts.length - 1, 'cost is the last segment when no task is active');
});

test('context bar shows used% = 100 - remaining', () => {
  const { clean } = run(fixture(65));
  assert.match(clean, /C35 /);                    // remaining 65 -> used 35 -> "C35 <bar>"
});

test('threshold: used < 50 is green', () => {
  const { raw } = run(fixture(60));                    // used 40
  assert.ok(raw.includes(GREEN), 'expected green color code');
});

test('threshold: 50 <= used < 65 is yellow', () => {
  const { raw } = run(fixture(40));                    // used 60
  assert.ok(raw.includes(YELLOW), 'expected yellow color code');
});

test('threshold: 65 <= used < 80 is orange', () => {
  const { raw } = run(fixture(25));                    // used 75
  assert.ok(raw.includes(ORANGE), 'expected orange color code');
});

test('threshold: used >= 80 is blinking red, no emoji', () => {
  const { raw, clean } = run(fixture(10));             // used 90
  assert.ok(raw.includes(BLINK) && raw.includes(RED), 'expected blink + red');
  assert.ok(!clean.includes('\u{1F480}'), 'skull emoji should not be present');
  assert.match(clean, /C90 /);
});

// The contract that must never break: always print, always exit 0.
test('empty stdin -> fallback line, exit 0', () => {
  const { code, clean } = run('');
  assert.strictEqual(code, 0);
  assert.ok(clean.includes('│'), 'expected a separator in fallback');
  assert.match(clean, /C\d+ /, 'expected context label in fallback');
});

test('malformed JSON -> fallback line, exit 0', () => {
  const { code, clean } = run('not json at all');
  assert.strictEqual(code, 0);
  assert.match(clean, /C\d+ /);
});

test('missing fields -> no crash, exit 0', () => {
  const { code, clean } = run('{}');
  assert.strictEqual(code, 0);
  assert.ok(clean.includes('Claude'));                 // default model name
  assert.match(clean, /C\d+ /);
});

// Usage bar: cache-first behavior and the stale fallback that fixes the
// "usage section disappears mid-session" bug.

test('fresh cache -> current + weekly rendered from cache (no API call)', () => {
  const home = seedHome({ cacheAgeMs: 5000, percentage: 42, weeklyPercentage: 31 }); // < FRESH_TTL (30s)
  const { code, clean } = run(fixture(40), { home, usage: true });
  assert.strictEqual(code, 0);
  assert.match(clean, /H42\b/);
  assert.match(clean, /W31\b/);
  assert.match(clean, /W31 ↺ 2d\d{1,2}h/);                    // day-aware reset countdown (Xd Yh)
});

test('stale cache + failing API -> usage stays visible (does not disappear)', () => {
  const home = seedHome({ cacheAgeMs: 2 * 60 * 1000, percentage: 57 }); // > FRESH, < STALE
  const { clean } = run(fixture(40), { home, usage: true });
  assert.match(clean, /H57\b/);
});

test('expired cache + failing API -> usage omitted', () => {
  const home = seedHome({ cacheAgeMs: 20 * 60 * 1000, percentage: 57 }); // > STALE_TTL (10m)
  const { code, clean } = run(fixture(40), { home, usage: true });
  assert.strictEqual(code, 0);                                  // ran successfully
  assert.match(clean, /C\d+ /, 'expected the normal line to still render');
  assert.ok(!clean.includes('↺'), 'usage (and its reset glyph) should be omitted once cache is too old');
  assert.ok(!clean.includes('H57'), 'current usage should be omitted once cache is too old');
});

// Usage from stdin `rate_limits`: the network/cache path is bypassed entirely.

test('stdin rate_limits -> 5h/7d render with no cache and no creds', () => {
  // FAKE_HOME has neither a usage cache nor a credentials file, so the only way usage
  // can render is straight from stdin rate_limits (proves the API/cache path is skipped).
  const { code, clean } = run(fixtureWithRateLimits(40), { usage: true });
  assert.strictEqual(code, 0);
  assert.match(clean, /H24\b/);                                 // 23.5 -> 24 (fractional, rounded)
  assert.match(clean, /W41\b/);                                 // 41.2 -> 41
  assert.match(clean, /W41 ↺ 2d\d{1,2}h/);                      // epoch-seconds -> day-aware countdown
});

// Model-scoped weekly limits ("Fable weekly limit at 86%"). The /usage payload reports
// these in a `limits` array; they never appear on stdin, so they always come from the
// cache/API path. parseScopedLimits is exercised directly against the real payload shape.

const { parseScopedLimits } = require('../statusline.js');

// A trimmed copy of a real GET /api/oauth/usage response: the legacy seven_day_<model>
// keys are all null, and the live scoped limit lives in `limits`.
function usagePayload({ scopedPercent = 86, model = 'Fable' } = {}) {
  return {
    five_hour: { utilization: 43, resets_at: '2026-08-02T17:00:00+00:00' },
    seven_day: { utilization: 63, resets_at: '2026-08-05T13:00:00+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      { kind: 'session', group: 'session', percent: 43, resets_at: '2026-08-02T17:00:00+00:00', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 63, resets_at: '2026-08-05T13:00:00+00:00', scope: null },
      {
        kind: 'weekly_scoped', group: 'weekly', percent: scopedPercent, severity: 'warning',
        resets_at: '2026-08-05T13:00:00+00:00', is_active: true,
        scope: { model: { id: null, display_name: model } }
      }
    ]
  };
}

test('parseScopedLimits picks weekly_scoped out of the limits array', () => {
  const scoped = parseScopedLimits(usagePayload());
  assert.deepStrictEqual(scoped, [
    { name: 'Fable', percentage: 86, resetsAt: '2026-08-05T13:00:00+00:00' }
  ]);
});

test('parseScopedLimits ignores session and weekly_all entries', () => {
  // percent 43 (session) and 63 (weekly_all) must not leak in as scoped bars.
  const scoped = parseScopedLimits(usagePayload());
  assert.strictEqual(scoped.length, 1, 'only the weekly_scoped entry is a model bar');
  assert.ok(!scoped.some(s => s.percentage === 43 || s.percentage === 63));
});

test('parseScopedLimits keeps the model name for render-time labelling', () => {
  assert.strictEqual(parseScopedLimits(usagePayload({ model: 'Opus' }))[0].name, 'Opus');
  assert.strictEqual(parseScopedLimits(usagePayload({ model: 'Newmodel' }))[0].name, 'Newmodel');
});

test('parseScopedLimits skips malformed entries instead of rendering NaN', () => {
  const payload = usagePayload();
  payload.limits.push({ kind: 'weekly_scoped', percent: null, scope: { model: { display_name: 'Ghost' } } });
  payload.limits.push({ kind: 'weekly_scoped', percent: 50, scope: { model: {} } });
  payload.limits.push({ kind: 'weekly_scoped', percent: 50, scope: null });
  const scoped = parseScopedLimits(payload);
  assert.strictEqual(scoped.length, 1, 'only the well-formed entry survives');
  assert.ok(!scoped.some(s => s.name === 'Ghost'));
});

test('parseScopedLimits falls back to legacy seven_day_<model> keys when limits is absent', () => {
  const legacy = {
    five_hour: { utilization: 43 },
    seven_day_opus: { utilization: 77, resets_at: '2026-08-05T13:00:00+00:00' },
    seven_day_sonnet: null
  };
  assert.deepStrictEqual(parseScopedLimits(legacy), [
    { name: 'Opus', percentage: 77, resetsAt: '2026-08-05T13:00:00+00:00' }
  ]);
});

test('parseScopedLimits does not double-count when both shapes are present', () => {
  const both = usagePayload();
  both.seven_day_opus = { utilization: 77, resets_at: '2026-08-05T13:00:00+00:00' };
  const scoped = parseScopedLimits(both);
  assert.strictEqual(scoped.length, 1, 'the limits array wins outright');
  assert.strictEqual(scoped[0].name, 'Fable');
});

test('no scoped limits -> nothing extra renders', () => {
  assert.deepStrictEqual(parseScopedLimits({ five_hour: { utilization: 43 } }), []);
  const { clean } = run(fixtureWithRateLimits(40), { usage: true });
  assert.match(clean, /H24\b/);
  assert.match(clean, /W41\b/);
  assert.ok(!/\bF\d+/.test(clean), 'no F bar when the account reports no scoped limit');
});

// Rendering: scoped bars come from the cache, including on the stdin fast path.

test('scoped bar renders alongside the stdin H/W bars', () => {
  // The crux of the feature: stdin supplies H/W (no network), the scoped limit comes from
  // the cache. Before this, a scoped limit could never reach the screen in a live session.
  const home = seedHome({ cacheAgeMs: 5000 });
  seedScopedCache(home, [{ name: 'Fable', percentage: 86 }]);
  const { code, clean } = run(fixtureWithRateLimits(40), { home, usage: true });
  assert.strictEqual(code, 0);
  assert.match(clean, /H24\b/, 'H still comes from stdin, not the cache');
  assert.match(clean, /W41\b/, 'W still comes from stdin');
  assert.match(clean, /F86\b/, 'scoped bar comes from the cache');
});

test('scoped bars render after W, in payload order', () => {
  const home = seedHome({ cacheAgeMs: 5000 });
  seedScopedCache(home, [{ name: 'Opus', percentage: 12 }, { name: 'Fable', percentage: 86 }]);
  const { clean } = run(fixtureWithRateLimits(40), { home, usage: true });
  const parts = clean.split('│').map(s => s.trim());
  const idx = (re) => parts.findIndex(p => re.test(p));
  assert.ok(idx(/^W\d+/) < idx(/^O\d+/), 'W precedes the scoped bars');
  assert.ok(idx(/^O\d+/) < idx(/^F\d+/), 'scoped bars keep payload order');
});

test('CTXLINE_DISABLE=usage also hides the scoped bars', () => {
  const home = seedHome({ cacheAgeMs: 5000 });
  seedScopedCache(home, [{ name: 'Fable', percentage: 86 }]);
  const { clean } = run(fixtureWithRateLimits(40), { home, usage: true, disable: 'usage' });
  assert.ok(!/\bF\d+/.test(clean), 'scoped bar is part of the usage segment');
  assert.ok(!clean.includes('H24'), 'H bar hidden too');
});

test('a cache written before scoped bars existed stays valid', () => {
  // No `models` key at all — must be accepted (H/W render, no scoped bars) rather than
  // rejected as malformed, which would force a refetch for everyone on upgrade.
  const home = seedHome({ cacheAgeMs: 5000, percentage: 42, weeklyPercentage: 31 });
  const { clean } = run(fixture(40), { home, usage: true });
  assert.match(clean, /H42\b/, 'legacy cache without models is still readable');
  assert.match(clean, /W31\b/);
  assert.ok(!/\bF\d+/.test(clean));
});

test('stdin rate_limits takes precedence over a fresh cache', () => {
  // Fresh cache says 42% / 31%; stdin says 23.5% / 41.2%. stdin must win (cache not read).
  const home = seedHome({ cacheAgeMs: 5000, percentage: 42, weeklyPercentage: 31 });
  const { clean } = run(fixtureWithRateLimits(40), { home, usage: true });
  assert.match(clean, /H24\b/);
  assert.ok(!clean.includes('H42'), 'cached 5h value must not appear when stdin rate_limits is present');
});

// Responsive layout: usage/cost/task wrap to a second line only when the rendered line
// overflows the terminal width (process.env.COLUMNS). Width unknown or line fits -> single.

test('narrow terminal wraps usage to a second line (line1 identity+context, line2 usage)', () => {
  const { code, raw, clean } = run(fixtureWithRateLimits(40), { usage: true, columns: 30 });
  assert.strictEqual(code, 0);
  assert.ok(raw.includes('\n'), 'expected a line break on a narrow terminal');
  const [l1, l2] = clean.split('\n');
  assert.match(l1, /C\d+ /, 'context stays on line 1');
  assert.ok(!/[HW]\d+/.test(l1), 'usage must not be on line 1 when wrapped');
  assert.match(l2, /H\d+\b/, 'current usage moves to line 2');
  assert.match(l2, /W\d+\b/, 'weekly usage moves to line 2');
});

test('wide terminal keeps everything on one line', () => {
  const { raw, clean } = run(fixtureWithRateLimits(40), { usage: true, columns: 200 });
  assert.ok(!raw.includes('\n'), 'no wrap when the line fits');
  assert.match(clean, /C\d+ .*H\d+\b.*W\d+\b/, 'context + usage all on one line');
});

test('unknown width (COLUMNS unset) never wraps', () => {
  const { raw } = run(fixtureWithRateLimits(40), { usage: true });   // run() deletes COLUMNS
  assert.ok(!raw.includes('\n'), 'absent COLUMNS -> single line (no regression on old clients)');
});

test('narrow terminal with no usage/cost/task stays single line', () => {
  // Only identity + context exist (no rate_limits, API-key path skips usage) -> nothing to wrap.
  const { raw } = run(fixture(40, '/no/such/repo', 'Opus 4.8'), { columns: 10 });
  assert.ok(!raw.includes('\n'), 'empty line2 -> single line regardless of width');
});

test('narrow wrap puts cost on line 2 alongside usage', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const input = JSON.stringify({
    model: { display_name: 'Opus 4.8' },
    workspace: { current_dir: '/tmp/myproject' },
    session_id: 'test-session',
    context_window: { remaining_percentage: 40 },
    cost: { total_cost_usd: 1.23 },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: nowSec + 2 * 3600 },
      seven_day: { used_percentage: 41.2, resets_at: nowSec + 62 * 3600 }
    }
  });
  const { clean } = run(input, { usage: true, columns: 30 });
  const [l1, l2] = clean.split('\n');
  assert.ok(!l1.includes('$1.23'), 'cost must not be on line 1');
  assert.match(l2, /\$1\.23\b/, 'cost wraps to line 2');
});

// Git ahead/behind: counts come from a guarded, cache-fronted `git rev-list`. Needs real git.

test('ahead of upstream -> ↑N in the branch segment', (t) => {
  if (!hasGit()) return t.skip('git not available');
  const dir = seedDivergedRepo({ ahead: 2 });
  const { clean } = run(fixture(40, dir), { home: freshHome() });
  assert.match(clean, /⎇ \S+ ↑2/, 'expected ↑2');
  assert.ok(!clean.includes('↓'), 'no behind marker when only ahead');
});

test('behind upstream -> ↓N in the branch segment', (t) => {
  if (!hasGit()) return t.skip('git not available');
  const dir = seedDivergedRepo({ behind: 3 });
  const { clean } = run(fixture(40, dir), { home: freshHome() });
  assert.match(clean, /⎇ \S+ ↓3/, 'expected ↓3');
  assert.ok(!clean.includes('↑'), 'no ahead marker when only behind');
});

test('diverged -> ↑N↓M (ahead then behind)', (t) => {
  if (!hasGit()) return t.skip('git not available');
  const dir = seedDivergedRepo({ ahead: 2, behind: 1 });
  const { clean } = run(fixture(40, dir), { home: freshHome() });
  assert.match(clean, /⎇ \S+ ↑2↓1/, 'expected ↑2↓1');
});

test('ahead is green, behind is red', (t) => {
  if (!hasGit()) return t.skip('git not available');
  const dir = seedDivergedRepo({ ahead: 2, behind: 1 });
  const { raw } = run(fixture(40, dir), { home: freshHome() });
  assert.ok(raw.includes(`${GREEN}↑2`), 'ahead count should be green');
  assert.ok(raw.includes(`${RED}↓1`), 'behind count should be red');
});

test('in sync with upstream -> no ahead/behind marker', (t) => {
  if (!hasGit()) return t.skip('git not available');
  const dir = seedDivergedRepo({ ahead: 0, behind: 0 });
  const { clean } = run(fixture(40, dir), { home: freshHome() });
  assert.match(clean, /⎇ \S+/, 'branch still renders');
  assert.ok(!clean.includes('↑') && !clean.includes('↓'), 'no marker when in sync');
});

test('no upstream -> branch renders, no ahead/behind marker', (t) => {
  if (!hasGit()) return t.skip('git not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-noup-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  gitCommit(dir, 'base');                                  // committed, but no upstream configured
  const { clean } = run(fixture(40, dir), { home: freshHome() });
  assert.match(clean, /⎇ \S+/, 'branch renders');
  assert.ok(!clean.includes('↑') && !clean.includes('↓'), 'no marker without an upstream');
});

test('counts are cached: a commit within the TTL does not change the rendered count', (t) => {
  if (!hasGit()) return t.skip('git not available');
  const home = freshHome();                                // shared across both renders -> shared cache
  const dir = seedDivergedRepo({ ahead: 1 });
  const first = run(fixture(40, dir), { home });
  assert.match(first.clean, /↑1/, 'first render shows ↑1 and writes cache');
  gitCommit(dir, 'extra');                                 // now actually ↑2
  const second = run(fixture(40, dir), { home });          // within 5s TTL -> cache hit
  assert.match(second.clean, /↑1/, 'cached ↑1 reused; git not re-run');
  assert.ok(!second.clean.includes('↑2'), 'fresh count must not appear within the TTL');
});

// Segment opt-out via CTXLINE_DISABLE (comma list; dir/model/context always render).

// HOME seeded with an in-progress todo so the task segment renders for the session id.
function seedTodo(activeForm) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-todo-'));
  after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const todosDir = path.join(home, '.claude', 'todos');
  fs.mkdirSync(todosDir, { recursive: true });
  fs.writeFileSync(path.join(todosDir, 'test-session-agent-1.json'),
    JSON.stringify([{ status: 'in_progress', activeForm }]));
  return home;
}

test('disable=cost hides cost; model + context intact', () => {
  const { clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', undefined, 0.42), { disable: 'cost' });
  assert.ok(!clean.includes('$'), 'cost hidden');
  assert.match(clean, /Opus 4\.8/, 'model still renders');
  assert.match(clean, /C\d+ /, 'context still renders');
});

test('disable=effort drops the · level suffix', () => {
  const { clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', 'high'), { disable: 'effort' });
  assert.strictEqual(clean.split(' │ ')[1], 'Opus 4.8', 'no "· high"');
});

test('disable=branch hides the branch (and ahead/behind) glyph', () => {
  const repo = seedRepo('feature/x');
  const { clean } = run(fixture(40, repo), { disable: 'branch' });
  assert.ok(!clean.includes('⎇'), 'branch segment hidden');
});

test('disable=usage hides H/W', () => {
  const home = seedHome({ cacheAgeMs: 5000, percentage: 42, weeklyPercentage: 31 });
  const { clean } = run(fixture(40), { home, usage: true, disable: 'usage' });
  assert.ok(!clean.includes('H42') && !clean.includes('W31'), 'usage segments hidden');
  assert.ok(!clean.includes('↺'), 'no reset countdown');
  assert.match(clean, /C\d+ /, 'context still renders');
});

test('disable=task hides the in-progress todo', () => {
  const home = seedTodo('Refactoring usage cache');
  assert.match(run(fixture(40), { home }).clean, /Refactoring usage cache/, 'task shows by default (control)');
  const { clean } = run(fixture(40), { home, disable: 'task' });
  assert.ok(!clean.includes('Refactoring usage cache'), 'task hidden when disabled');
});

test('disable with an unknown token changes nothing', () => {
  const { clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', undefined, 0.42), { disable: 'bogus,nope' });
  assert.match(clean, /\$0\.42/, 'cost still renders for unknown tokens');
});

test('disable accepts multiple segments', () => {
  const { clean } = run(fixture(40, '/no/such/repo', 'Opus 4.8', 'high', 0.42), { disable: 'cost,effort' });
  assert.ok(!clean.includes('$'), 'cost hidden');
  assert.strictEqual(clean.split(' │ ')[1], 'Opus 4.8', 'effort hidden');
});

// ---------------------------------------------------------------------------
// Config file (~/.claude/ctxline.json; path overridable via CTXLINE_CONFIG).
// Every key is optional. Anything invalid falls back to its own default without
// discarding the rest of the file, and a broken file never breaks the render.

const ESC = '';

test('no config file -> stock defaults', () => {
  const { code, clean } = run(fixtureWithRateLimits(40), { usage: true });
  assert.strictEqual(code, 0);
  assert.match(clean, /H24\b/, 'session bar defaults to H');
  assert.match(clean, /W41\b/);
  assert.match(clean, /C\d+ /, 'context bar defaults to C');
  assert.ok(clean.includes(' │ '), 'default separator');
});

test('labels: session/weekly/context are overridable', () => {
  const config = { labels: { session: 'S', weekly: '7d', context: 'ctx' } };
  const { clean } = run(fixtureWithRateLimits(40), { usage: true, config });
  assert.match(clean, /S24\b/, 'session relabelled');
  assert.match(clean, /7d41\b/, 'multi-char label works');
  assert.match(clean, /ctx\d+ /, 'context relabelled');
  assert.ok(!/\bH24\b/.test(clean), 'old label gone');
});

test('modelLabels: a scoped bar is relabelled by model name', () => {
  const home = seedHome({ cacheAgeMs: 5000 });
  seedScopedCache(home, [{ name: 'Fable', percentage: 86 }]);
  const { clean } = run(fixtureWithRateLimits(40), {
    home, usage: true, config: { modelLabels: { fable: 'fb' } }
  });
  assert.match(clean, /fb86\b/, 'label comes from config, matched case-insensitively');
  assert.ok(!/\bF86\b/.test(clean), 'derived initial replaced');
});

test('modelLabels applies to an already-cached entry (no wait for expiry)', () => {
  // The cache stores the model name, not a rendered label, so a config edit takes effect
  // on the very next render rather than after the usage cache expires.
  const home = seedHome({ cacheAgeMs: 5000 });
  seedScopedCache(home, [{ name: 'Fable', percentage: 86 }]);
  assert.match(run(fixtureWithRateLimits(40), { home, usage: true }).clean, /F86\b/);
  assert.match(
    run(fixtureWithRateLimits(40), { home, usage: true, config: { modelLabels: { Fable: 'x' } } }).clean,
    /x86\b/
  );
});

test('order: segments render in the configured order', () => {
  const config = { order: ['context', 'session', 'weekly', 'dir', 'model'], wrapAfter: null };
  const { clean } = run(fixtureWithRateLimits(40), { usage: true, config });
  const parts = clean.split('│').map(s => s.trim());
  const idx = (re) => parts.findIndex(p => re.test(p));
  assert.ok(idx(/^C\d+/) < idx(/^H\d+/), 'context first');
  assert.ok(idx(/^H\d+/) < idx(/^W\d+/), 'session before weekly');
  assert.ok(idx(/^W\d+/) < idx(/myproject/), 'dir moved to the end');
});

test('order: omitting a segment hides it', () => {
  const config = { order: ['dir', 'context'], wrapAfter: null };
  const { code, clean } = run(fixtureWithRateLimits(40), { usage: true, config });
  assert.strictEqual(code, 0);
  assert.match(clean, /C\d+ /, 'listed segment renders');
  assert.ok(!/\bH24\b/.test(clean), 'unlisted session bar hidden');
  assert.ok(!/\bW41\b/.test(clean), 'unlisted weekly bar hidden');
  assert.ok(!clean.includes('Opus'), 'unlisted model segment hidden');
});

test('order: unknown names dropped, duplicates collapsed', () => {
  const config = { order: ['dir', 'nonsense', 'dir', 'context'], wrapAfter: null };
  const { clean } = run(fixtureWithRateLimits(40), { usage: true, config });
  assert.strictEqual(clean.split('│').length, 2, 'dir + context only, dir not repeated');
});

test('order: an all-invalid order falls back to the default (never a blank line)', () => {
  const { code, clean } = run(fixtureWithRateLimits(40), { usage: true, config: { order: ['nope', 'x'] } });
  assert.strictEqual(code, 0);
  assert.match(clean, /myproject/);
  assert.match(clean, /H24\b/, 'full default order restored');
});

test('hideContextSize drops the context size from the model name', () => {
  const on = { hideContextSize: true };
  assert.strictEqual(
    run(fixture(40, '/tmp/p', 'Opus 5 (1M context)'), { config: on }).clean.split(' │ ')[1],
    'Opus 5'
  );
  assert.strictEqual(
    run(fixture(40, '/tmp/p', 'Sonnet 5 (200k)'), { config: on }).clean.split(' │ ')[1],
    'Sonnet 5'
  );
  // Default keeps the size, just de-verbosed.
  assert.strictEqual(
    run(fixture(40, '/tmp/p', 'Opus 5 (1M context)')).clean.split(' │ ')[1],
    'Opus 5 (1M)'
  );
});

test('hideContextSize only strips a size, not any parenthetical', () => {
  const config = { hideContextSize: true };
  assert.strictEqual(
    run(fixture(40, '/tmp/p', 'Opus 5 (preview)'), { config }).clean.split(' │ ')[1],
    'Opus 5 (preview)',
    'a non-size parenthetical is left alone'
  );
  assert.strictEqual(
    run(fixture(40, '/tmp/p', 'Opus 5'), { config }).clean.split(' │ ')[1],
    'Opus 5',
    'a name with no parenthetical is untouched'
  );
});

// `compact`: shed detail progressively as the terminal narrows, wrapping only once
// there's nothing left to shed. Levels: 0 full, 1 no countdowns, 2 no context glyphs,
// 3 no effort + truncated model name.

test('compact off (default): full detail at any width, wrap as the only response', () => {
  const { clean } = run(fixtureWithRateLimits(40, { effort: 'high' }), { usage: true, columns: 30 });
  assert.match(clean, /↺/, 'countdowns kept');
  assert.match(clean, /█|░/, 'context glyphs kept');
  assert.ok(clean.includes('\n'), 'narrow width wraps instead of abbreviating');
});

test('compact: wide terminal keeps full detail', () => {
  const { clean } = run(fixtureWithRateLimits(40, { effort: 'high' }), {
    usage: true, config: { compact: true }, columns: 200
  });
  assert.match(clean, /H24 ↺ /, 'countdown kept when there is room');
  assert.match(clean, /█|░/, 'context glyphs kept');
  assert.ok(!clean.includes('\n'), 'single line');
});

test('compact level 1: countdowns go first', () => {
  const { clean } = run(fixtureWithRateLimits(40, { effort: 'high' }), {
    usage: true, config: { compact: true }, columns: 55
  });
  assert.ok(!clean.includes('↺'), 'countdowns dropped');
  assert.match(clean, /H24\b/, 'percentages kept');
  assert.match(clean, /W41\b/);
  assert.match(clean, /█|░/, 'context glyphs still present at this width');
  assert.ok(!clean.includes('\n'), 'still one line');
});

test('compact level 2: context bar glyphs go next, the number stays', () => {
  const { clean } = run(fixtureWithRateLimits(40, { effort: 'high' }), {
    usage: true, config: { compact: true }, columns: 42
  });
  assert.ok(!/[█░]/.test(clean), 'bar glyphs dropped');
  assert.match(clean, /C60\b/, 'context percentage kept');
  assert.match(clean, /H24\b/);
  assert.ok(!clean.includes('\n'), 'still one line');
});

test('compact level 3: effort suffix drops and a long model name truncates', () => {
  const { clean } = run(
    fixtureWithRateLimits(40, { effort: 'high', model: 'Some Very Long Model' }),
    { usage: true, config: { compact: true }, columns: 34 }
  );
  assert.ok(!clean.includes('high'), 'effort suffix dropped');
  assert.match(clean, /Some Very…/, 'model truncated to 10 cells with an ellipsis');
  assert.match(clean, /C60\b/, 'percentages survive to the last level');
  assert.match(clean, /H24\b/);
});

test('compact: a short model name is never truncated', () => {
  const { clean } = run(fixtureWithRateLimits(40, { model: 'Opus 5' }), {
    usage: true, config: { compact: true }, columns: 30
  });
  assert.ok(!clean.includes('…'), 'nothing to truncate at 6 characters');
  assert.match(clean, /Opus 5/);
});

test('compact: wrapping is the last resort, after all detail is shed', () => {
  const { clean } = run(fixtureWithRateLimits(40, { effort: 'high' }), {
    usage: true, config: { compact: true }, columns: 20
  });
  assert.ok(clean.includes('\n'), 'wraps once even level 3 does not fit');
  assert.ok(!clean.includes('↺'), 'and it wraps in the abbreviated form, not the full one');
  assert.ok(!/[█░]/.test(clean));
});

test('compact: unknown width keeps full detail (nothing to measure against)', () => {
  const { clean } = run(fixtureWithRateLimits(40, { effort: 'high' }), {
    usage: true, config: { compact: true }   // no columns -> COLUMNS unset
  });
  assert.match(clean, /↺/, 'no measurement possible -> do not abbreviate');
  assert.match(clean, /█|░/);
});

test('separator is configurable', () => {
  const { clean } = run(fixtureWithRateLimits(40), { usage: true, config: { separator: ' :: ' } });
  assert.ok(clean.includes(' :: '), 'custom separator used');
  assert.ok(!clean.includes(' │ '), 'default separator gone');
});

test('thresholds change the usage bar colors', () => {
  // 24% is green on the default 50/75/90 ramp. On 5/10/20 it is at or past the top
  // threshold, so it renders red; on 10/20/30 it sits in the orange band between them.
  const red = run(fixtureWithRateLimits(40), { usage: true, config: { thresholds: [5, 10, 20] } });
  assert.ok(red.raw.includes(`${ESC}[31mH24`), 'H24 red once 24 >= the top threshold');
  const orange = run(fixtureWithRateLimits(40), { usage: true, config: { thresholds: [10, 20, 30] } });
  assert.ok(orange.raw.includes(`${ESC}[38;5;208mH24`), 'H24 orange in the band below it');
});

test('wrapAfter moves the line break', () => {
  const { clean } = run(fixtureWithRateLimits(40), { usage: true, config: { wrapAfter: 'dir' }, columns: 40 });
  const lines = clean.split('\n');
  assert.strictEqual(lines.length, 2, 'still wraps to two lines');
  assert.match(lines[0], /myproject/, 'line 1 is just the dir');
  assert.ok(!/C\d+ /.test(lines[0]), 'context moved to line 2');
  assert.match(lines[1], /C\d+ /);
});

test('wrapAfter: null never wraps, however narrow the terminal', () => {
  const { clean } = run(fixtureWithRateLimits(40), { usage: true, config: { wrapAfter: null }, columns: 20 });
  assert.ok(!clean.includes('\n'), 'single line despite a 20-column terminal');
});

test('wrapAfter naming a segment not in order means no wrap', () => {
  const config = { order: ['dir', 'context'], wrapAfter: 'cost' };
  const { clean } = run(fixtureWithRateLimits(40), { usage: true, config, columns: 20 });
  assert.ok(!clean.includes('\n'), 'nowhere to break -> single line');
});

// Robustness: a bad config degrades to defaults rather than breaking the statusline.

test('malformed JSON is ignored, statusline still renders', () => {
  const { code, clean } = run(fixtureWithRateLimits(40), { usage: true, config: '{ this is not json' });
  assert.strictEqual(code, 0);
  assert.match(clean, /myproject/);
  assert.match(clean, /H24\b/, 'defaults intact');
});

test('a non-object config is ignored', () => {
  const { code, clean } = run(fixtureWithRateLimits(40), { usage: true, config: '["an","array"]' });
  assert.strictEqual(code, 0);
  assert.match(clean, /H24\b/);
});

test('invalid values fall back individually, valid ones still apply', () => {
  const config = {
    labels: { session: 'S', weekly: 'far-too-long', context: 42 },
    thresholds: [90, 50, 10],          // not ascending
    separator: ''                       // empty
  };
  const { clean, raw } = run(fixtureWithRateLimits(40), { usage: true, config });
  assert.match(clean, /S24\b/, 'the valid label applies');
  assert.match(clean, /W41\b/, 'over-long label rejected -> default W');
  assert.match(clean, /C\d+ /, 'non-string label rejected -> default C');
  assert.ok(clean.includes(' │ '), 'empty separator rejected -> default');
  assert.ok(raw.includes(`${ESC}[32mS24`), 'bad thresholds rejected -> 24% still green');
});

test('control characters in config values are rejected (no escape injection)', () => {
  const config = { separator: ` ${ESC}[31m `, labels: { session: `${ESC}[5mH` } };
  const { clean } = run(fixtureWithRateLimits(40), { usage: true, config });
  assert.ok(clean.includes(' │ '), 'separator falls back to the default');
  assert.match(clean, /H24\b/, 'label falls back to the default');
});
