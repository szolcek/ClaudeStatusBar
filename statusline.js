#!/usr/bin/env node
// Claude Code Enhanced Statusline
// Shows: directory | model | context usage | 5-hour + weekly + model-scoped usage | current task
// Auto-detects API key vs subscription usage
// https://github.com/szolcek/ClaudeStatusBar

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync, execFileSync } = require('child_process');

const IS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

// Optional segment opt-out: CTXLINE_DISABLE is a comma list of segments to hide.
// Recognized: branch, effort, cost, task, usage (H+W+model-scoped). dir/model/context always render.
// Unknown names are ignored. Disabling a segment also skips its work (git, todo read,
// usage fetch).
const DISABLED = new Set(
  (process.env.CTXLINE_DISABLE || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

// Optional config file: ~/.claude/ctxline.json (override the path with CTXLINE_CONFIG).
// Absent is the normal case — the statusline stays zero-config, and every key below is
// independently validated so one bad value falls back to its own default instead of
// discarding the whole file. A malformed or unreadable file is ignored outright: a config
// mistake must never be able to break the statusline.
const CONFIG_FILE = process.env.CTXLINE_CONFIG || path.join(os.homedir(), '.claude', 'ctxline.json');

// Segment names usable in `order`. `dir` carries the git branch and ahead/behind, `model`
// carries the effort suffix, `scoped` covers every model-scoped weekly limit at once.
const SEGMENT_NAMES = ['dir', 'model', 'context', 'session', 'weekly', 'scoped', 'cost', 'task'];

const DEFAULT_CONFIG = {
  labels: { session: 'H', weekly: 'W', context: 'C' },
  modelLabels: {},                 // { "<model display name>": "<label>" }, case-insensitive
  order: SEGMENT_NAMES.slice(),
  wrapAfter: 'context',            // line breaks after this segment when too wide; null = never
  hideContextSize: false,          // true -> "Opus 5 (1M)" renders as "Opus 5"
  compact: false,                  // true -> abbreviate progressively before wrapping
  separator: ' │ ',
  thresholds: [50, 75, 90]         // usage colors: green <50, yellow <75, orange <90, else red
};

// A label is short printable text. The length cap keeps a stray value from blowing out the
// line, and control chars are rejected so a config file can't inject terminal escapes.
function isValidLabel(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 4 && !/[\x00-\x1f\x7f]/.test(v);
}

function loadConfig() {
  const cfg = {
    ...DEFAULT_CONFIG,
    labels: { ...DEFAULT_CONFIG.labels },
    modelLabels: {},
    order: DEFAULT_CONFIG.order.slice(),
    thresholds: DEFAULT_CONFIG.thresholds.slice()
  };

  let raw;
  try {
    if (!fs.existsSync(CONFIG_FILE)) return cfg;
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return cfg;                    // unreadable or invalid JSON -> silent defaults
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cfg;

  if (raw.labels && typeof raw.labels === 'object') {
    for (const key of Object.keys(cfg.labels)) {
      if (isValidLabel(raw.labels[key])) cfg.labels[key] = raw.labels[key];
    }
  }

  if (raw.modelLabels && typeof raw.modelLabels === 'object') {
    for (const [name, label] of Object.entries(raw.modelLabels)) {
      if (name.trim() && isValidLabel(label)) cfg.modelLabels[name.trim().toLowerCase()] = label;
    }
  }

  // Unknown names and duplicates are dropped; omitting a segment hides it (CTXLINE_DISABLE
  // still applies on top). An order that survives as empty is ignored, so a file of typos
  // can't produce a blank statusline.
  if (Array.isArray(raw.order)) {
    const seen = new Set();
    const order = [];
    for (const name of raw.order) {
      if (typeof name !== 'string' || !SEGMENT_NAMES.includes(name) || seen.has(name)) continue;
      seen.add(name);
      order.push(name);
    }
    if (order.length) cfg.order = order;
  }

  // The wrap point must be a segment that actually renders, otherwise there's nowhere to
  // break — an unusable value means "never wrap" rather than a silent fallback elsewhere.
  if (raw.wrapAfter === null) cfg.wrapAfter = null;
  else if (typeof raw.wrapAfter === 'string' && SEGMENT_NAMES.includes(raw.wrapAfter)) cfg.wrapAfter = raw.wrapAfter;
  if (!cfg.order.includes(cfg.wrapAfter)) cfg.wrapAfter = null;

  if (typeof raw.hideContextSize === 'boolean') cfg.hideContextSize = raw.hideContextSize;
  if (typeof raw.compact === 'boolean') cfg.compact = raw.compact;

  if (typeof raw.separator === 'string' && raw.separator.length > 0 && !/[\x00-\x1f\x7f]/.test(raw.separator)) {
    cfg.separator = raw.separator;
  }

  // Three strictly ascending percentages. Anything else keeps the defaults whole — a
  // partially-applied threshold set would give nonsensical color bands.
  if (Array.isArray(raw.thresholds) && raw.thresholds.length === 3 &&
      raw.thresholds.every(n => Number.isFinite(n) && n >= 0 && n <= 100) &&
      raw.thresholds[0] < raw.thresholds[1] && raw.thresholds[1] < raw.thresholds[2]) {
    cfg.thresholds = raw.thresholds.slice();
  }

  return cfg;
}

const CONFIG = loadConfig();

// Shared width (cells) for all progress bars: context, current, weekly.
const BAR_WIDTH = 6;

// Highest `compact` detail level, and the model-name budget at that level. See the
// buildLines() ladder in outputStatus for what each level drops.
const MAX_COMPACT_LEVEL = 3;
const COMPACT_MODEL_LEN = 10;

// Max characters shown for the git branch; longer names are tail-truncated with "…".
// Tail-truncation keeps the start (ticket IDs like "TAMA5-32796" live there) visible.
const MAX_BRANCH_LEN = 24;

// Separator between segments on a rendered line (config: `separator`).
const SEGMENT_SEP = CONFIG.separator;

// Cells reserved at the terminal edge when deciding to wrap to a second line.
// 0 = use the full COLUMNS; bump it if Claude Code reserves columns and the line
// truncates a char or two before wrapping.
const WIDTH_MARGIN = 0;

// Cache configuration
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const USAGE_CACHE_FILE = path.join(CACHE_DIR, 'usage-cache.json');
// Fresh: trust the cache and skip the API call entirely (fewer calls, faster render).
const FRESH_TTL_MS = 30000;            // 30 seconds
// Stale: used only as a fallback when a live API call fails, so the usage bar stays
// visible through transient timeouts/errors instead of disappearing.
const STALE_TTL_MS = 10 * 60 * 1000;   // 10 minutes

// Git ahead/behind cache (single repo entry, keyed by git dir). Throttles the one
// `git rev-list` subprocess so a burst of renders in a turn runs it once, not per render.
const GIT_CACHE_FILE = path.join(CACHE_DIR, 'git-cache.json');
const GIT_FRESH_TTL_MS = 5000;          // 5s: reuse counts within a render burst
const GIT_STALE_TTL_MS = 60000;         // 60s: fall back to last counts if git fails
const GIT_TIMEOUT_MS = 500;             // hard cap on the rev-list subprocess (warm ~130ms)

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
  red: '\x1b[31m',
  purple: '\x1b[38;5;135m',
  blink: '\x1b[5m'
};

// Color for the thinking-effort indicator. Levels rank low < medium < high < xhigh < max
// < ultracode; only the top two are highlighted — "max" red, "ultracode" purple. Every
// other level (including xhigh) renders dim like the rest of the metadata.
function getEffortColor(level) {
  const lvl = String(level).toLowerCase();
  if (lvl === 'max') return colors.red;
  if (lvl === 'ultracode') return colors.purple;
  return colors.dim;
}

function getUsageColor(percentage) {
  const [green, yellow, orange] = CONFIG.thresholds;
  if (percentage < green) return colors.green;
  if (percentage < yellow) return colors.yellow;
  if (percentage < orange) return colors.orange;
  return colors.red;
}

// Shorten verbose model names for the statusline: "Opus 4.8 (1M context)" -> "Opus 4.8 (1M)".
// With config `hideContextSize`, drop the size entirely -> "Opus 4.8". The pattern is
// deliberately narrow (a size like 1M/200k, optionally followed by "context") so a model
// name that carries some other parenthetical keeps it.
function shortenModel(name) {
  const short = name.replace(/\s+context\)/i, ')');
  return CONFIG.hideContextSize ? short.replace(/\s*\(\d+\s*[km]\)\s*$/i, '') : short;
}

// Tail-truncate an over-long branch name, preserving the leading ticket ID.
function truncateBranch(name) {
  return name.length > MAX_BRANCH_LEN ? name.slice(0, MAX_BRANCH_LEN - 1) + '…' : name;
}

// Model name at the tightest compact level. Short names ("Opus 5") are already within
// budget and pass through untouched.
function truncateModel(name) {
  return name.length > COMPACT_MODEL_LEN ? name.slice(0, COMPACT_MODEL_LEN - 1) + '…' : name;
}

// Resolve the repo's git dir by walking up from `dir` (no `git` subprocess). Handles
// worktrees/submodules (".git" as a file pointing at the real dir). '' on any failure.
function resolveGitDir(dir) {
  let cur = dir;
  let gitPath = '';
  for (let i = 0; i < 50 && cur; i++) {
    const candidate = path.join(cur, '.git');
    if (fs.existsSync(candidate)) { gitPath = candidate; break; }
    const parent = path.dirname(cur);
    if (parent === cur) break;          // reached filesystem root
    cur = parent;
  }
  if (!gitPath) return '';

  if (fs.statSync(gitPath).isFile()) {
    // ".git" is a file like "gitdir: /path/to/.git/worktrees/x".
    const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
    if (!m) return '';
    return path.resolve(path.dirname(gitPath), m[1].trim());
  }
  return gitPath;
}

// Current git branch, read straight from .git/HEAD (no `git` subprocess — fast,
// dependency-free). Detached HEAD -> short sha. Best-effort: '' on any failure.
function getGitBranch(dir) {
  try {
    const gitDir = resolveGitDir(dir);
    if (!gitDir) return '';
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    // Strip control chars: HEAD is read raw (not git-validated), so a hand-crafted file
    // in an untrusted archive could inject terminal escape sequences.
    if (ref) return truncateBranch(ref[1].replace(/[\x00-\x1f\x7f]/g, ''));
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);  // detached HEAD -> short sha
    return '';
  } catch (e) {
    return '';
  }
}

// Read the cached ahead/behind for `gitDir`. Single-entry file: a different repo
// invalidates it. Returns { age, ahead, behind } or null.
function readGitCache(gitDir) {
  try {
    const c = JSON.parse(fs.readFileSync(GIT_CACHE_FILE, 'utf8'));
    if (!c || c.gitDir !== gitDir || !Number.isFinite(c.timestamp)) return null;
    if (!Number.isFinite(c.ahead) || !Number.isFinite(c.behind)) return null;
    return { age: Date.now() - c.timestamp, ahead: c.ahead, behind: c.behind };
  } catch (e) {
    return null;
  }
}

function writeGitCache(gitDir, ahead, behind) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(GIT_CACHE_FILE, JSON.stringify({ gitDir, timestamp: Date.now(), ahead, behind }), 'utf8');
  } catch (e) {}
}

// Commits ahead/behind the upstream (@{u}), cache-fronted. The single `git` call in the
// whole script — gated by GIT_FRESH_TTL_MS so a render burst runs it once. No upstream /
// detached / no git -> the subprocess errors -> null (segment omitted). On a slow/failed
// call, falls back to the last counts up to GIT_STALE_TTL_MS so they don't flicker.
function getGitAheadBehind(dir) {
  const gitDir = resolveGitDir(dir);
  if (!gitDir) return null;

  const cached = readGitCache(gitDir);
  if (cached && cached.age < GIT_FRESH_TTL_MS) {
    return { ahead: cached.ahead, behind: cached.behind };
  }

  try {
    // execFileSync (no shell): faster cold spawn than execSync and passes `@{u}` literally.
    // `@{u}...HEAD` with --left-right --count prints "<behind>\t<ahead>" (left = upstream).
    const out = execFileSync('git', ['rev-list', '--left-right', '--count', '@{u}...HEAD'], {
      cwd: dir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const parts = out.split(/\s+/);
    const behind = parseInt(parts[0], 10);
    const ahead = parseInt(parts[1], 10);
    if (Number.isFinite(ahead) && Number.isFinite(behind)) {
      writeGitCache(gitDir, ahead, behind);
      return { ahead, behind };
    }
    return null;
  } catch (e) {
    if (cached && cached.age < GIT_STALE_TTL_MS) {
      return { ahead: cached.ahead, behind: cached.behind };
    }
    return null;
  }
}

// "↑N↓M" from ahead/behind counts: ahead green (commits to push), behind red (missing
// commits). Each part self-resets so it doesn't inherit the dim branch color. Omit a zero
// side; '' when in sync or null.
function formatAheadBehind(ab) {
  if (!ab) return '';
  let s = '';
  if (ab.ahead) s += `${colors.green}↑${ab.ahead}${colors.reset}`;
  if (ab.behind) s += `${colors.red}↓${ab.behind}${colors.reset}`;
  return s;
}

function getContextBar(remaining, { showBar = true } = {}) {
  const effectiveRemaining = remaining ?? 100;
  const used = Math.max(0, Math.min(100, 100 - Math.round(effectiveRemaining)));

  const filled = Math.round((used / 100) * BAR_WIDTH);
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(BAR_WIDTH - filled);

  // Context color: green <50 / yellow <65 / orange <80 / blink-red >=80.
  let color;
  if (used < 50) color = colors.green;
  else if (used < 65) color = colors.yellow;
  else if (used < 80) color = colors.orange;
  else color = colors.blink + colors.red;

  // Compact label form: "C<used> <bar>" (e.g. "C45 ███░░░"), colored as a whole.
  // showBar: false drops the glyphs and keeps the number ("C45") when space is tight.
  const barPart = showBar ? ` ${bar}` : '';
  return `${color}${CONFIG.labels.context}${used}${barPart}${colors.reset}`;
}

// Render a compact usage segment from raw data: "<label><pct> ↺ <countdown>"
// (e.g. "H81 ↺ 2h21m") — no bar. Called on every read (live or cached) so the reset
// countdown is always recomputed from resetsAt rather than frozen at fetch time.
function buildUsageBar(label, percentage, resetsAt) {
  let timeStr = '';
  if (resetsAt) {
    const diffMins = Math.max(0, Math.floor((new Date(resetsAt) - new Date()) / 60000));
    const days = Math.floor(diffMins / 1440);
    const hours = Math.floor((diffMins % 1440) / 60);
    const mins = diffMins % 60;
    if (days > 0) timeStr = `${days}d${hours}h`;
    else if (hours > 0) timeStr = `${hours}h${mins}m`;
    else timeStr = `${mins}m`;
  }

  const color = getUsageColor(percentage);
  const timePart = timeStr ? `${colors.dim} ↺ ${timeStr}${colors.reset}` : '';

  return `${color}${label}${percentage}${colors.reset}${timePart}`;
}

// Model-scoped weekly limits (e.g. "Fable weekly limit at 86%"), rendered after the
// account-wide W bar. The /usage payload reports these in a `limits` array, each entry
// carrying the model in scope.model.display_name:
//
//   { kind: "weekly_scoped", percent: 86, severity: "warning",
//     resets_at: "...", scope: { model: { display_name: "Fable" } } }
//
// The label is the model's first initial (Fable -> F), so a new model family needs no
// code change. Older payloads instead exposed flat seven_day_<model> keys, kept below as
// a fallback for accounts still reporting that shape.
//
// NOTE: these appear only in the API payload. Claude Code's statusline stdin carries just
// five_hour and seven_day under rate_limits, so the scoped limits always come from the
// cache/API path even when stdin supplies the H and W bars.
const LEGACY_MODEL_WEEKLY_KEYS = [
  { key: 'seven_day_opus', name: 'Opus' },
  { key: 'seven_day_sonnet', name: 'Sonnet' }
];

// Label for a scoped entry: the model's initial by default, overridden by config
// `modelLabels` (keyed by display name, case-insensitive). Derived at render time rather
// than at parse time so a config edit takes effect on the next render instead of waiting
// for the usage cache to expire. `label` is the pre-name cache shape.
function scopedLabel(entry) {
  const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
  if (!name) return entry?.label || '?';
  return CONFIG.modelLabels[name.toLowerCase()] || name.charAt(0).toUpperCase();
}

// Build the usage segments from raw entries. fiveHour/weekly are { percentage, resetsAt }
// or null/absent; models is an array of { label, percentage, resetsAt } (possibly empty).
// Returns { current, weekly, models } — the first two rendered strings or null, models a
// (possibly empty) array of rendered strings.
// showCountdown: false drops the "↺ 2d13h" suffix, the cheapest detail to lose when the
// terminal is narrow — the percentage is what you glance at, the reset time rarely.
function buildUsageBars(fiveHour, weekly, models, { showCountdown = true } = {}) {
  const at = (e) => (showCountdown ? e.resetsAt : null);
  return {
    current: fiveHour ? buildUsageBar(CONFIG.labels.session, fiveHour.percentage, at(fiveHour)) : null,
    weekly: weekly ? buildUsageBar(CONFIG.labels.weekly, weekly.percentage, at(weekly)) : null,
    models: (models || []).map(m => buildUsageBar(scopedLabel(m), m.percentage, at(m)))
  };
}

// Normalize a raw API utilization into the 0-100 integer that the rest of the
// pipeline (cache validation + bar rendering) expects. Returns null when the value
// isn't a finite number, so callers can omit that bar instead of rendering "NaN%".
function normalizePercentage(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Extract the model-scoped weekly limits from a raw /usage payload as
// [{ label, percentage, resetsAt }], in payload order. Prefers the `limits` array;
// falls back to the legacy flat keys only when it yields nothing, so an account
// reporting both shapes doesn't render the same limit twice.
function parseScopedLimits(usage) {
  const scoped = [];

  if (Array.isArray(usage?.limits)) {
    for (const entry of usage.limits) {
      if (!entry || entry.kind !== 'weekly_scoped') continue;
      const name = entry.scope?.model?.display_name;
      const pct = normalizePercentage(entry.percent);
      if (typeof name !== 'string' || !name.trim() || pct == null) continue;
      // Store the model name, not a label — see scopedLabel().
      scoped.push({ name: name.trim(), percentage: pct, resetsAt: entry.resets_at || null });
    }
    if (scoped.length) return scoped;
  }

  for (const { key, name } of LEGACY_MODEL_WEEKLY_KEYS) {
    const seg = usage?.[key];
    const pct = seg ? normalizePercentage(seg.utilization) : null;
    if (pct != null) scoped.push({ name, percentage: pct, resetsAt: seg.resets_at || null });
  }
  return scoped;
}

// Build usage bars from stdin `rate_limits` (Claude.ai Pro/Max, present only after the
// first API response of a session). Same data as the OAuth usage API, so reading it here
// skips the network/credentials/cache path entirely. `resets_at` is a Unix epoch in
// SECONDS (not ISO) — ×1000 before Date. Returns raw { fiveHour, weekly } entries, or null
// when rate_limits is absent or the required five_hour segment is unusable (caller falls
// back). Model-scoped weekly limits are never present here — see LEGACY_MODEL_WEEKLY_KEYS.
function buildUsageFromStdin(data) {
  const rl = data?.rate_limits;
  if (!rl) return null;

  const toEntry = (seg) => {
    if (!seg) return null;
    const pct = normalizePercentage(seg.used_percentage);
    if (pct == null) return null;
    // resets_at is a Unix epoch in SECONDS. Coerce + validate defensively: a non-numeric
    // or out-of-range value would make new Date(...).toISOString() throw, and this path
    // runs outside outputStatus's try/catch. Fall back to resetsAt: null on anything bad.
    let resetsAt = null;
    const epoch = Number(seg.resets_at);
    if (Number.isFinite(epoch) && epoch > 0) {
      const d = new Date(epoch * 1000);
      if (!Number.isNaN(d.getTime())) resetsAt = d.toISOString();
    }
    return { percentage: pct, resetsAt };
  };

  const fiveHour = toEntry(rl.five_hour);
  if (!fiveHour) return null;          // five_hour is the required bar
  return { fiveHour, weekly: toEntry(rl.seven_day) };
}

// Validate a single usage entry ({ percentage, resetsAt }). Returns true only for a
// finite 0-100 percentage and a parseable (or absent) resetsAt.
function isValidUsageEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!Number.isFinite(entry.percentage) || entry.percentage < 0 || entry.percentage > 100) return false;
  if (entry.resetsAt != null && Number.isNaN(new Date(entry.resetsAt).getTime())) return false;
  return true;
}

// Read the raw cached usage data
// ({ timestamp, data: { fiveHour: {percentage,resetsAt}, weekly: {...}|null } }).
// Returns { age, data } or null. Age-vs-TTL decisions are made by the caller.
function readCachedUsage() {
  try {
    if (!fs.existsSync(USAGE_CACHE_FILE)) return null;

    const cache = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'));
    if (!cache || !Number.isFinite(cache.timestamp) || cache.timestamp <= 0) return null;

    // Validate data. fiveHour is required; weekly and models are optional (the API may
    // omit either). This also rejects the legacy single-{percentage,resetsAt} format from
    // older versions, which had no fiveHour key, so stale caches are ignored on read.
    // A cache written before model bars existed simply has no models key — still valid.
    const data = cache.data;
    if (!data || typeof data !== 'object') return null;
    if (!isValidUsageEntry(data.fiveHour)) return null;
    if (data.weekly != null && !isValidUsageEntry(data.weekly)) return null;
    if (data.models != null) {
      if (!Array.isArray(data.models)) return null;
      // Accept either shape: `name` (current) or `label` (written before modelLabels).
      if (!data.models.every(m => (typeof m?.name === 'string' || typeof m?.label === 'string') && isValidUsageEntry(m))) return null;
    }

    return { age: Date.now() - cache.timestamp, data };
  } catch (e) {
    return null;
  }
}

// Write usage data to cache (shared across all sessions)
function setCachedUsage(data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    const cache = {
      timestamp: Date.now(),
      data: data
    };

    fs.writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch (e) {
    // Silently fail
  }
}

function getCredentials() {
  // Try file first (legacy / Linux / Windows)
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(credsPath)) {
    try {
      return JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    } catch (e) {}
  }

  // Fallback: macOS keychain
  if (os.platform() === 'darwin') {
    try {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', { encoding: 'utf8', timeout: 1000 });
      return JSON.parse(raw.trim());
    } catch (e) {}
  }

  return null;
}

function getApiUsage(callback) {
  try {
    // Read credentials (file or macOS keychain)
    const creds = getCredentials();
    if (!creds) {
      return callback(null);
    }

    const accessToken = creds.claudeAiOauth?.accessToken;

    if (!accessToken) {
      return callback(null);
    }

    // Adaptive timeout: if cache exists, be faster (1200ms); if not, be patient (1500ms)
    // API typically takes ~850ms, so 1200ms gives reasonable headroom
    const hasCache = fs.existsSync(USAGE_CACHE_FILE);
    const timeout = hasCache ? 1200 : 1500;

    // Make API call with adaptive timeout
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20'
      },
      timeout: timeout
    }, (res) => {
      let data = '';

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const usage = JSON.parse(data);

          // 5-hour session usage is required; weekly (seven_day) is rendered when present.
          // Normalize utilization first so a missing/non-finite value omits the bar
          // instead of rendering "NaN%" or an out-of-range percentage.
          const fivePct = usage.five_hour ? normalizePercentage(usage.five_hour.utilization) : null;
          if (fivePct != null) {
            const fiveHour = {
              percentage: fivePct,
              resetsAt: usage.five_hour.resets_at || null
            };
            const weeklyPct = usage.seven_day ? normalizePercentage(usage.seven_day.utilization) : null;
            const weekly = weeklyPct != null ? {
              percentage: weeklyPct,
              resetsAt: usage.seven_day.resets_at || null
            } : null;

            // Model-scoped weekly limits, rendered only when the account reports them.
            const models = parseScopedLimits(usage);

            // Cache the raw data (shared across sessions); callers render from it.
            const resolved = { fiveHour, weekly, models };
            setCachedUsage(resolved);
            callback(resolved);
          } else {
            callback(null);
          }
        } catch (e) {
          callback(null);
        }
      });
    });

    req.on('error', () => callback(null));
    req.on('timeout', () => {
      req.destroy();
      callback(null);
    });

    req.end();
  } catch (e) {
    callback(null);
  }
}

// Resolve raw usage data ({ fiveHour, weekly, models }), cache-first. Callers render it.
function getRawUsage(callback) {
  const cached = readCachedUsage();

  // Cache is fresh -> use it and skip the API entirely (fewer calls, faster).
  if (cached && cached.age < FRESH_TTL_MS) {
    return callback(cached.data);
  }

  // Cache is stale or missing -> refresh from the API.
  getApiUsage((fresh) => {
    if (fresh) {
      callback(fresh);
    } else if (cached && cached.age < STALE_TTL_MS) {
      // API failed/timed out, but recent cache exists -> show it instead of nothing.
      callback(cached.data);
    } else {
      callback(null);
    }
  });
}

// Model-scoped weekly limits only, cache-first. Used alongside the stdin H/W bars, which
// can't carry them. Falls back to the stale cache and finally to [] so a failed or slow
// call costs the scoped bars but never the bars stdin already gave us.
function getScopedModels(callback) {
  getRawUsage((data) => callback(data?.models || []));
}

// Session cost from stdin `cost.total_cost_usd` (USD float, computed client-side by
// Claude Code as tokens × per-model API pricing). Pure stdin — no network/cache.
// Returns "$0.00" rendered dim, or '' when absent/non-finite so the segment is omitted.
function getCostSegment(data) {
  const usd = data?.cost?.total_cost_usd;
  if (!Number.isFinite(usd)) return '';
  return `${colors.dim}$${usd.toFixed(2)}${colors.reset}`;
}

function getCurrentTask(sessionId) {
  if (!sessionId) return '';

  const homeDir = os.homedir();
  const todosDir = path.join(homeDir, '.claude', 'todos');

  if (!fs.existsSync(todosDir)) return '';

  try {
    const files = fs.readdirSync(todosDir)
      .filter(f => f.startsWith(sessionId) && f.includes('-agent-') && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
      const inProgress = todos.find(t => t.status === 'in_progress');
      if (inProgress) return inProgress.activeForm || '';
    }
  } catch (e) {}

  return '';
}

// Visible (printable) width of a segment string: strip ANSI color codes, count code points.
function visibleWidth(str) {
  return [...str.replace(/\x1b\[[0-9;]*m/g, '')].length;
}

// Responsive layout: one line when it fits the terminal, else line1 (identity + context)
// on top and line2 (usage/cost/task) below. Splits only when COLUMNS is known (Claude Code
// v2.1.153+) and the single line overflows — unknown width or an empty line2 stays single,
// so there is no regression on older clients or wide terminals.
function layout(line1Parts, line2Parts) {
  const single = [...line1Parts, ...line2Parts].join(SEGMENT_SEP);
  if (line2Parts.length === 0) return single;
  const cols = parseInt(process.env.COLUMNS, 10);
  if (Number.isFinite(cols) && cols > 0 && visibleWidth(single) > cols - WIDTH_MARGIN) {
    return line1Parts.join(SEGMENT_SEP) + '\n' + line2Parts.join(SEGMENT_SEP);
  }
  return single;
}

// Main
function outputStatus(data, usage) {
  try {
    const model = shortenModel(data?.model?.display_name || 'Claude');
    const dir = data?.workspace?.current_dir || process.cwd();
    const dirname = path.basename(dir);
    const branch = DISABLED.has('branch') ? '' : getGitBranch(dir);
    const sync = branch ? formatAheadBehind(getGitAheadBehind(dir)) : '';
    const effort = DISABLED.has('effort') ? '' : (data?.effort?.level || '');
    const sessionId = data?.session_id || '';
    const remaining = data?.context_window?.remaining_percentage;

    const cost = DISABLED.has('cost') ? '' : getCostSegment(data);
    const task = DISABLED.has('task') ? '' : getCurrentTask(sessionId);

    // Render every segment at a given detail level (0 = full). Higher levels shed the
    // least-valuable detail first, so a narrow terminal loses a reset countdown long
    // before it loses a percentage:
    //   0  everything
    //   1  no "↺ <countdown>" on the usage bars
    //   2  + no context bar glyphs (the "C38" number stays)
    //   3  + no effort suffix, model name truncated
    // '' means "nothing to show" (omitted); `scoped` is an array because an account can
    // report more than one model-scoped weekly limit.
    const buildLines = (level) => {
      const bars = buildUsageBars(usage?.fiveHour, usage?.weekly, usage?.models,
        { showCountdown: level < 1 });
      const modelText = level < 3 ? model : truncateModel(model);

      const segments = {
        dir: branch
          ? `${dirname} ${colors.dim}⎇ ${branch}${colors.reset}${sync ? ' ' + sync : ''}`
          : dirname,
        model: (effort && level < 3)
          ? `${modelText}${getEffortColor(effort)} · ${effort}${colors.reset}`
          : modelText,
        context: getContextBar(remaining, { showBar: level < 2 }),
        session: bars.current || '',
        weekly: bars.weekly || '',
        scoped: bars.models,
        cost: cost,
        task: task ? `${colors.dim}${task}${colors.reset}` : ''
      };

      // Walk the configured order, switching to the wrap target after `wrapAfter`. The
      // switch is positional: it happens even when that segment rendered nothing, so the
      // split stays where the config asked for it. Default order/wrapAfter reproduce the
      // original layout exactly — identity + context, then usage/cost/task.
      const l1 = [];
      const l2 = [];
      let target = l1;
      for (const name of CONFIG.order) {
        const value = segments[name];
        if (Array.isArray(value)) target.push(...value);
        else if (value) target.push(value);
        if (name === CONFIG.wrapAfter) target = l2;
      }
      return { line1: l1, line2: l2 };
    };

    // With `compact` off (the default) only level 0 is ever built, so output is exactly
    // what it was before. With it on, step down until the line fits on one row — wrapping
    // stays the last resort, used only once there's no detail left to shed. An unknown
    // width means no measuring is possible, so full detail is the safe choice.
    const cols = parseInt(process.env.COLUMNS, 10);
    let { line1, line2 } = buildLines(0);
    if (CONFIG.compact && Number.isFinite(cols) && cols > 0) {
      for (let level = 1; level <= MAX_COMPACT_LEVEL; level++) {
        if (visibleWidth([...line1, ...line2].join(SEGMENT_SEP)) <= cols - WIDTH_MARGIN) break;
        ({ line1, line2 } = buildLines(level));
      }
    }

    process.stdout.write(layout(line1, line2));
  } catch (e) {
    process.stdout.write('Status unavailable');
  }
}

function outputFallback(usage) {
  const bars = buildUsageBars(usage?.fiveHour, usage?.weekly, usage?.models);
  const parts = ['~', 'Claude', getContextBar(undefined)];
  if (bars.current) parts.push(bars.current);
  if (bars.weekly) parts.push(bars.weekly);
  parts.push(...bars.models);
  process.stdout.write(parts.join(SEGMENT_SEP));
}

// Resolve raw usage data ({ fiveHour, weekly, models }) for a parsed stdin payload.
// Raw rather than rendered: the renderer re-renders at several detail levels to fit the
// terminal, so it needs the numbers, not finished strings.
// Order: API-key users get none; otherwise prefer stdin `rate_limits` (no network),
// then fall back to the cache+API flow when stdin lacks it (cold start / non-Pro/Max).
function resolveUsage(data, callback) {
  if (IS_API_KEY || DISABLED.has('usage')) {
    return callback(null);
  }
  const fromStdin = buildUsageFromStdin(data);
  if (fromStdin) {
    // stdin covers H and W with no network. Model-scoped weekly limits only exist in the
    // API payload, so they come from the cache — refreshed on the same TTL as every other
    // usage read, which keeps at most one call per FRESH_TTL_MS regardless of render rate.
    return getScopedModels((models) => {
      callback({ fiveHour: fromStdin.fiveHour, weekly: fromStdin.weekly, models });
    });
  }
  getRawUsage(callback);
}

// Process with timeout
// Parse the accumulated stdin into a payload object, or null if empty/unparseable.
function parseInput(input) {
  if (!input || input.length === 0) return null;
  try {
    return JSON.parse(input);
  } catch (e) {
    return null;
  }
}

// Resolve usage for `data` (preferring stdin rate_limits), then render and exit.
function emit(data) {
  resolveUsage(data, (usage) => {
    if (data) {
      outputStatus(data, usage);
    } else {
      outputFallback(usage);
    }
    process.exit(0);
  });
}

// Entry point, guarded so tests can require this file to exercise payload parsing
// directly (the /usage response shape is the easiest thing here to get wrong, and it
// can't be reached through stdin). Running the script normally is unchanged.
if (require.main === module) {
  if (process.stdin.isTTY) {
    emit(null);
  } else {
    let input = '';
    let timeoutReached = false;

    const overallTimeout = IS_API_KEY ? 500 : (fs.existsSync(USAGE_CACHE_FILE) ? 1300 : 1600);

    const timeout = setTimeout(() => {
      timeoutReached = true;
      emit(parseInput(input));
    }, overallTimeout);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      if (timeoutReached) return;
      clearTimeout(timeout);
      emit(parseInput(input));
    });
  }
} else {
  module.exports = { parseScopedLimits, normalizePercentage };
}
