const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const BASE_URL = 'https://discuss.meshery.io/directory_items.json';
const PERIODS = ['weekly', 'monthly', 'yearly', 'all'];

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

// Network failures and our own timeout are worth retrying; anything else is a bug.
function isRetryableError(err) {
  return err.name === 'TimeoutError' || err.name === 'TypeError';
}

function backoffDelay(attempt, response) {
  const retryAfter = response && Number(response.headers.get('retry-after'));
  if (retryAfter > 0) return retryAfter * 1000;
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 250);
}

async function fetchWithRetry(url, options, label) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (attempt >= MAX_RETRIES || !isRetryableError(err)) throw err;
      const delay = backoffDelay(attempt);
      console.warn(`${label}: ${err.name} (${err.message}), retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      continue;
    }

    if (response.ok || attempt >= MAX_RETRIES || !isRetryableStatus(response.status)) {
      return response;
    }

    await response.body?.cancel();
    const delay = backoffDelay(attempt, response);
    console.warn(`${label}: HTTP ${response.status}, retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delay);
  }
}

async function fetchUsers(period) {
  const headers = {
    'User-Agent': 'meshery-leaderboard-bot/1.0',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br'
  };

  const url = `${BASE_URL}?period=${period}&order=likes_received&limit=50`;
  const response = await fetchWithRetry(url, { headers }, `period=${period}`);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discourse API error (period=${period}): ${response.status} - ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.directory_items;
}

function computeScore(item) {
  return (item.post_count || 0) +
    ((item.likes_received || 0) * 2) +
    ((item.solutions || 0) * 3);
}

function buildLeaderboard(items) {
  return (items || [])
    .filter(item => item && item.user && item.user.username && !item.user.username.startsWith('anon'))
    .map(item => ({
      rank: 0,
      username: item.user.username,
      avatar: item.user.avatar_template ? `https://discuss.meshery.io${item.user.avatar_template.replace('{size}', '200')}` : '',
      profile_url: `https://discuss.meshery.io/u/${item.user.username}`,
      posts: item.post_count || 0,
      likes: item.likes_received || 0,
      solutions: item.solutions || 0,
      score: computeScore(item)
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.username.localeCompare(b.username);
    })
    .map((user, index) => ({
      ...user,
      rank: index + 1
    }));
}

async function buildAllPeriods() {
  const periods = {};

  for (const period of PERIODS) {
    const items = await fetchUsers(period);
    periods[period] = buildLeaderboard(items);
  }

  if (!periods.all.length) {
    throw new Error('all-time period empty — refusing to overwrite');
  }

  return periods;
}

async function saveJSON(periods) {
  const output = {
    last_updated: new Date().toISOString(),
    default_period: 'weekly',
    periods
  };

  const outputPath = path.join(__dirname, '../../_data/leaderboard.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));

  for (const [period, users] of Object.entries(periods)) {
    console.log(`Saved ${users.length} users for period=${period}`);
  }
}

async function main() {
  const start = performance.now();
  try {
    const periods = await buildAllPeriods();
    await saveJSON(periods);
    console.log(`Leaderboard build completed in ${((performance.now() - start) / 1000).toFixed(2)}s`);
  } catch (err) {
    console.error(`Leaderboard build failed after ${((performance.now() - start) / 1000).toFixed(2)}s:`, err.message);
    process.exit(1);
  }
}

main();
