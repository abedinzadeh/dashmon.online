#!/usr/bin/env node

// Dashmon Smoke Test
// - GET /api/health
// - Login with local credentials (email or username) and keep session cookie
// - Validate a few core API endpoints

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const IDENTIFIER = process.env.SMOKE_IDENTIFIER || '';
const PASSWORD = process.env.SMOKE_PASSWORD || '';
const SIGNUP = ['1','true','yes'].includes(String(process.env.SMOKE_SIGNUP || '').toLowerCase());
const SIGNUP_EMAIL = process.env.SMOKE_EMAIL || (IDENTIFIER.includes('@') ? IDENTIFIER : '');
const SIGNUP_USERNAME = process.env.SMOKE_USERNAME || (!IDENTIFIER.includes('@') ? IDENTIFIER : '');

function fail(msg, extra) {
  console.error(`SMOKE FAIL: ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
}
function ok(msg) { console.log(`✔ ${msg}`); }
function assert(cond, msg) { if (!cond) fail(msg); }

// Minimal cookie jar for Node fetch
class CookieJar {
  constructor() { this.cookies = new Map(); }
  addFromSetCookie(setCookies) {
    if (!setCookies) return;
    const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
    for (const h of arr) {
      if (!h) continue;
      const part = String(h).split(';')[0];
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) this.cookies.set(k, v);
    }
  }
  header() {
    if (this.cookies.size === 0) return '';
    return Array.from(this.cookies.entries()).map(([k,v]) => `${k}=${v}`).join('; ');
  }
}

async function http(path, opts = {}, jar = null) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const headers = { ...(opts.headers || {}) };
  if (jar) {
    const cookie = jar.header();
    if (cookie) headers['Cookie'] = cookie;
  }
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });

  // Capture cookies (undici exposes getSetCookie)
  try {
    if (jar && typeof res.headers.getSetCookie === 'function') {
      jar.addFromSetCookie(res.headers.getSetCookie());
    } else if (jar) {
      const sc = res.headers.get('set-cookie');
      if (sc) jar.addFromSetCookie(sc);
    }
  } catch (_) {}

  return res;
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

async function main() {
  // 1) Health
  const healthRes = await http('/api/health');
  assert(healthRes.ok, `/api/health returned ${healthRes.status}`);
  const health = await readJson(healthRes);
  assert(health && health.ok === true, `/api/health payload missing ok:true (got: ${JSON.stringify(health).slice(0, 200)})`);
  ok('Health endpoint');

  // 1b) Public SEO integrity
  await seoChecks();
  ok('SEO files + metadata');

  // 2) Login
  assert(IDENTIFIER, 'SMOKE_IDENTIFIER is required (email or username)');
  assert(PASSWORD, 'SMOKE_PASSWORD is required');
  const jar = new CookieJar();

  if (SIGNUP) {
    const body = {
      email: SIGNUP_EMAIL || `smoke+${Date.now()}@example.com`,
      username: SIGNUP_USERNAME || undefined,
      password: PASSWORD
    };

    const signupRes = await http('/auth/local/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, jar);

    // 200 OK, or 409 already exists are both acceptable
    if (!(signupRes.ok || signupRes.status === 409)) {
      const data = await readJson(signupRes);
      fail(`Signup failed (${signupRes.status})`, data);
    }
    ok('Signup (optional)');
  }

  const loginRes = await http('/auth/local/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD })
  }, jar);

  if (!loginRes.ok) {
    const data = await readJson(loginRes);
    fail(`Login failed (${loginRes.status})`, data);
  }
  ok('Local login');

  // 3) /api/me
  const meRes = await http('/api/me', {}, jar);
  assert(meRes.ok, `/api/me returned ${meRes.status}`);
  const me = await readJson(meRes);
  assert(me && me.id && me.email && me.plan, `/api/me shape invalid: ${JSON.stringify(me).slice(0, 200)}`);
  ok('/api/me shape');

  // 4) /api/projects
  const projRes = await http('/api/projects', {}, jar);
  assert(projRes.ok, `/api/projects returned ${projRes.status}`);
  const projects = await readJson(projRes);
  assert(Array.isArray(projects), `/api/projects expected array, got: ${typeof projects}`);
  if (projects.length > 0) {
    const p = projects[0];
    assert(p.id && p.name !== undefined && p.devices !== undefined,
      `/api/projects[0] missing expected keys: ${JSON.stringify(p).slice(0, 200)}`);
  }
  ok('/api/projects shape');

  console.log('SMOKE PASS');
  process.exit(0);
}

main().catch((e) => fail('Unhandled error', e && e.stack ? e.stack : e));


async function seoChecks() {
  // SEO checks for public pages
  const robots = await httpGetText('/robots.txt');
  assert(robots.includes('User-agent:'), 'robots.txt missing User-agent');
  assert(robots.toLowerCase().includes('sitemap:'), 'robots.txt missing Sitemap');
  assert(robots.includes('https://dashmon.online/sitemap.xml'), 'robots.txt sitemap url is not canonical');

  const sitemap = await httpGetText('/sitemap.xml');
  assert(sitemap.includes('<urlset'), 'sitemap.xml missing <urlset>');
  assert(sitemap.includes('https://dashmon.online/'), 'sitemap.xml missing homepage URL');
  assert(sitemap.includes('https://dashmon.online/login.html'), 'sitemap.xml missing login URL');

  const homeHtml = await httpGetText('/');
  assert(/<meta\s+name=["']description["']\s+content=["'][^"']{50,180}["']\s*\/>?/i.test(homeHtml), 'Homepage missing meta description (50-180 chars)');
  assert(/<link\s+rel=["']canonical["']\s+href=["']https:\/\/dashmon\.online\/?["']\s*\/>?/i.test(homeHtml), 'Homepage missing/invalid canonical URL');
  assert(/property=["']og:title["']/i.test(homeHtml), 'Homepage missing og:title');
  assert(/property=["']og:description["']/i.test(homeHtml), 'Homepage missing og:description');
  assert(/property=["']og:image["']\s+content=["']https:\/\/dashmon\.online\/og-image\.png["']/i.test(homeHtml), 'Homepage missing/invalid og:image');
  assert(/name=["']twitter:card["']\s+content=["']summary_large_image["']/i.test(homeHtml), 'Homepage missing twitter:card');
  assert(/application\/ld\+json/i.test(homeHtml) && /"@type"\s*:\s*"SoftwareApplication"/i.test(homeHtml), 'Homepage missing SoftwareApplication JSON-LD');
  assert((homeHtml.match(/<svg[^>]*aria-label=/gi) || []).length >= 1, 'Homepage SVG icons missing aria-label');

  const loginHtml = await httpGetText('/login.html');
  assert(/<meta\s+name=["']description["']/i.test(loginHtml), 'Login page missing meta description');
  assert(/<link\s+rel=["']canonical["']\s+href=["']https:\/\/dashmon\.online\/login\.html["']/i.test(loginHtml), 'Login page missing canonical URL');

  // Verify OG image exists (served)
  const ogRes = await http('/og-image.png');
  assert(ogRes.status === 200, 'og-image.png not reachable (HTTP ' + ogRes.status + ')');
}

