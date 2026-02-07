#!/usr/bin/env node
/**
 * Dashmon Smoke Test
 * - Fails fast (non-zero exit) on integrity problems
 * - Uses Node 18+ global fetch
 *
 * Env:
 *   SMOKE_BASE_URL         default: http://127.0.0.1:3000
 *   SMOKE_CANONICAL_BASE   default: https://dashmon.online
 *
 * Optional auth checks (only if local auth exists in your build):
 *   SMOKE_IDENTIFIER
 *   SMOKE_PASSWORD
 *   SMOKE_SIGNUP=1 (optional) to create the user first (fresh DB)
 *   SMOKE_EMAIL, SMOKE_USERNAME (optional for signup)
 */

const BASE_URL = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const CANONICAL_BASE = (process.env.SMOKE_CANONICAL_BASE || 'https://dashmon.online').replace(/\/+$/, '');

function ok(msg) { console.log('✔ ' + msg); }
function warn(msg) { console.warn('⚠ ' + msg); }
function die(msg, err) {
  console.error('SMOKE FAIL: ' + msg);
  if (err) console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function http(path, opts = {}, cookieJar) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = Object.assign({}, opts.headers || {});
  if (cookieJar && cookieJar.cookie) headers['cookie'] = cookieJar.cookie;

  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
  // capture set-cookie for session
  const setCookie = res.headers.get('set-cookie');
  if (cookieJar && setCookie) {
    // keep only the first cookie token (session id)
    cookieJar.cookie = setCookie.split(';')[0];
  }
  return res;
}

async function httpGetText(path, cookieJar) {
  const res = await http(path, { method: 'GET' }, cookieJar);
  const text = await res.text();
  return { res, text };
}

async function healthCheck() {
  const { res, text } = await httpGetText('/api/health');
  assert(res.status === 200, `/api/health expected 200, got ${res.status} body=${text.slice(0,200)}`);
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  assert(json && json.ok === true, '/api/health expected JSON { ok: true }');
  ok('Health endpoint');
}

async function seoChecks() {
  // robots.txt
  const robots = await httpGetText('/robots.txt');
  assert(robots.res.status === 200, `robots.txt expected 200, got ${robots.res.status}`);
  assert(/User-agent:/i.test(robots.text), 'robots.txt missing User-agent');
  assert(/Sitemap:/i.test(robots.text), 'robots.txt missing Sitemap');
  assert(robots.text.includes(`${CANONICAL_BASE}/sitemap.xml`), 'robots.txt sitemap URL is not canonical');

  // sitemap.xml
  const sitemap = await httpGetText('/sitemap.xml');
  assert(sitemap.res.status === 200, `sitemap.xml expected 200, got ${sitemap.res.status}`);
  assert(/<urlset\b/i.test(sitemap.text), 'sitemap.xml missing <urlset>');

  const mustHave = [
    `${CANONICAL_BASE}/`,
    `${CANONICAL_BASE}/login.html`,
    `${CANONICAL_BASE}/about.html`,
    `${CANONICAL_BASE}/terms.html`,
    `${CANONICAL_BASE}/privacy.html`
  ];
  for (const u of mustHave) {
    assert(sitemap.text.includes(u), `sitemap.xml missing URL: ${u}`);
  }

  // homepage HTML checks
  const home = await httpGetText('/');
  assert(home.res.status === 200, `GET / expected 200, got ${home.res.status}`);
  assert(new RegExp(`<link\\s+rel=["']canonical["']\\s+href=["']${escapeRe(CANONICAL_BASE)}\\/?["']`, 'i').test(home.text),
    'Homepage missing/invalid canonical URL');
  assert(/<meta\s+name=["']description["']\s+content=["'][^"']{50,180}["']/i.test(home.text),
    'Homepage missing meta description (50-180 chars)');
  assert(/property=["']og:title["']/i.test(home.text), 'Homepage missing og:title');
  assert(/property=["']og:description["']/i.test(home.text), 'Homepage missing og:description');
  assert(new RegExp(`property=["']og:image["']\\s+content=["']${escapeRe(CANONICAL_BASE)}\\/og-image\\.png["']`, 'i').test(home.text),
    'Homepage missing/invalid og:image');
  assert(/name=["']twitter:card["']\s+content=["']summary_large_image["']/i.test(home.text),
    'Homepage missing twitter:card');
  assert(/application\/ld\+json/i.test(home.text) && /"@type"\s*:\s*"SoftwareApplication"/i.test(home.text),
    'Homepage missing SoftwareApplication JSON-LD');
  assert((home.text.match(/<svg[^>]*aria-label=/gi) || []).length >= 1, 'Homepage SVG icons missing aria-label');

  // about/terms/privacy canonical
  await mustCanonical('/about.html');
  await mustCanonical('/terms.html');
  await mustCanonical('/privacy.html');
  await mustCanonical('/login.html');

  // OG image reachable
  const og = await http('/og-image.png', { method: 'GET' });
  assert(og.status === 200, `og-image.png not reachable (HTTP ${og.status})`);

  ok('SEO files + metadata');
}

async function mustCanonical(path) {
  const { res, text } = await httpGetText(path);
  assert(res.status === 200, `${path} expected 200, got ${res.status}`);
  const full = `${CANONICAL_BASE}${path}`;
  assert(new RegExp(`<link\\s+rel=["']canonical["']\\s+href=["']${escapeRe(full)}["']`, 'i').test(text),
    `${path} missing canonical URL`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function maybeAuthChecks() {
  const id = process.env.SMOKE_IDENTIFIER;
  const pw = process.env.SMOKE_PASSWORD;
  if (!id || !pw) {
    warn('Auth checks skipped (set SMOKE_IDENTIFIER + SMOKE_PASSWORD to enable)');
    return;
  }
  const jar = {};

  // optional signup for fresh DBs
  if (String(process.env.SMOKE_SIGNUP || '') === '1') {
    const email = process.env.SMOKE_EMAIL || (id.includes('@') ? id : 'smoke@dashmon.online');
    const username = process.env.SMOKE_USERNAME || (!id.includes('@') ? id : null);

    const body = { email, password: pw };
    if (username) body.username = username;

    const res = await http('/auth/local/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }, jar);

    // If already exists, ignore (409)
    if (![200, 201, 204, 409].includes(res.status)) {
      const t = await res.text();
      throw new Error(`Signup failed HTTP ${res.status}: ${t.slice(0,200)}`);
    }
  }

  // login
  const loginRes = await http('/auth/local/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: id, password: pw })
  }, jar);

  const loginText = await loginRes.text();
  assert(loginRes.status === 200, `Login expected 200, got ${loginRes.status} body=${loginText.slice(0,200)}`);
  ok('Local login');

  // 2–3 authenticated endpoints (best-effort; skip if endpoint missing)
  await bestEffortJson('/api/projects', jar, (j) => Array.isArray(j) || typeof j === 'object');
  await bestEffortJson('/api/stores', jar, (j) => Array.isArray(j) || typeof j === 'object');
}

async function bestEffortJson(path, jar, shapeFn) {
  const res = await http(path, { method: 'GET', headers: { 'accept': 'application/json' } }, jar);
  if (res.status === 404) {
    warn(`Skipped ${path} (404 not found in this build)`);
    return;
  }
  const text = await res.text();
  assert(res.status === 200, `${path} expected 200, got ${res.status} body=${text.slice(0,200)}`);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`${path} did not return JSON`); }
  assert(shapeFn(json), `${path} returned unexpected shape`);
  ok(`API ${path}`);
}

async function main() {
  try {
    await healthCheck();
    await seoChecks();
    await maybeAuthChecks();
    console.log('✅ SMOKE PASS');
    process.exit(0);
  } catch (e) {
    die('Unhandled error', e);
  }
}

main();
