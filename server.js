const express      = require('express');
const crypto       = require('crypto');
const cheerio      = require('cheerio');
const cors         = require('cors');
const basicAuth    = require('express-basic-auth');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const predictCache = new Map();
const raceCache    = new Map();

// 環境変数の値は、貼り付け時に前後の空白・改行や引用符（"..." や “...” のような
// 自動変換されたカーリークォート）が混入しやすい。そのままだとHTTPヘッダに載せられず
// 「Cannot convert argument to a ByteString」で無言のまま全滅するため、ここで取り除く。
// トークン類は引用符を含まない値なので、前後の引用符は常に不要とみなしてよい
function cleanEnv(v) {
  return String(v ?? '')
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .trim();
}

// Upstash REST は https のみ。スキーム欠落や http 指定、末尾スラッシュを補正する。
// ただしローカル開発・テスト用のスタブ（localhost）は http のまま残す
function normalizeUpstashUrl(v) {
  let u = cleanEnv(v);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (/^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u)) {
    u = u.replace(/^http:\/\//i, 'https://');
  }
  return u.replace(/\/+$/, '');
}

const UPSTASH_URL   = normalizeUpstashUrl(process.env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);

const REDIS_ENABLED = !!(UPSTASH_URL && UPSTASH_TOKEN);

// Redis障害でAPI全体を落とさないため、失敗時は null を返す
// Upstash REST を1回叩く。診断で使えるようステータスと本文もそのまま返す
async function redisRaw(args, ms = 5000) {
  if (!REDIS_ENABLED) return { ok: false, error: 'UPSTASH の環境変数が未設定' };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: c.signal,
    });
    clearTimeout(t);
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, result: d ? d.result : undefined, body: text.slice(0, 200) };
  } catch (e) {
    clearTimeout(t);
    // fetch failed だけでは原因が分からないため、下位の理由（DNS/接続/TLS）も返す
    const c = e.cause;
    const detail = c ? String(c.code || c.message || c).slice(0, 140) : undefined;
    return { ok: false, error: e.name === 'AbortError' ? `timeout(${ms}ms)` : e.message, detail };
  }
}

// 接続レベルの失敗コードを日本語の原因に対応づける
function netCause(detail) {
  const d = String(detail || '');
  if (/ENOTFOUND|EAI_AGAIN/i.test(d)) return 'ホスト名が解決できません（データベースが削除済み、またはURLの綴り違い）';
  if (/ECONNREFUSED/i.test(d))        return '接続を拒否されました（URLまたはポートが誤り）';
  if (/CERT|TLS|SSL/i.test(d))        return 'TLS証明書のエラー';
  if (/ETIMEDOUT|ECONNRESET/i.test(d))return '接続がタイムアウト/切断されました';
  return null;
}

// 障害時もAPI全体を落とさないため null を返す（呼び出し側はキャッシュ無しとして動作する）
async function redisCmd(...args) {
  const r = await redisRaw(args);
  return r.ok ? (r.result ?? null) : null;
}

// パスワード設定（環境変数 SITE_PASSWORD で変更可。デフォルト: boatrace2026）
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'boatrace2026';
const GEMINI_API_KEY = cleanEnv(process.env.GEMINI_API_KEY);
// AI予想モデル: 先頭から順に試し、無料枠上限・一時過負荷なら次へ（モデルごとに枠が独立）
const PREDICT_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];

// Vercelのrewriteは転送先(/server.js)でリクエストパスを上書きすることがあり、
// そうなるとExpressが全ルートを見失う（全APIが "Cannot GET /server.js" になる）。
// vercel.json の destination に元パスを __path として埋めているので、ここで復元する。
// パスが保持される環境では同じ値に戻すだけなので影響はない。
app.use((req, res, next) => {
  const qIdx = req.url.indexOf('?');
  if (qIdx === -1) return next();
  let params;
  try { params = new URLSearchParams(req.url.slice(qIdx + 1)); } catch { return next(); }
  const orig = params.get('__path');
  // 置換が効かず "/$1" のような文字列が来た場合は無視して素通しする
  if (!orig || !orig.startsWith('/') || orig.includes('$')) return next();
  params.delete('__path');
  const rest = params.toString();
  req.url = orig + (rest ? '?' + rest : '');
  // express.static は originalUrl を見てリダイレクト先を決めるため、こちらも揃える
  req.originalUrl = req.url;
  next();
});

// ---- Basic認証の総当たり対策 ----
// パスワードが短いと総当たりが現実的に成立してしまうので、
// 間違いが続いたIPを一定時間締め出す。
// 認証に成功する通常アクセスではRedisに一切触らないため、表示速度には影響しない。
const AUTH_FAIL_MAX  = 8;     // この回数まちがえたら
const AUTH_BLOCK_SEC = 600;   // この秒数だけ締め出す
const authFails  = new Map(); // ip -> { n, exp }  失敗回数（このインスタンス内）
const authBlocks = new Map(); // ip -> 解除時刻(ms)

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

function authBlockedUntil(ip) {
  const t = authBlocks.get(ip);
  if (!t) return 0;
  if (t <= Date.now()) { authBlocks.delete(ip); return 0; }
  return t;
}

// 認証失敗を数える。パスワードを送ってきた場合だけ数える。
// （未入力の初回アクセスも401になるので、それを数えると誰もログインできなくなる）
async function noteAuthFailure(req) {
  if (!req.headers.authorization) return;
  const ip  = clientIp(req);
  const now = Date.now();
  if (authFails.size > 2000) { for (const [k, v] of authFails) if (v.exp <= now) authFails.delete(k); }
  const rec = authFails.get(ip);
  let total = (rec && rec.exp > now) ? rec.n + 1 : 1;
  authFails.set(ip, { n: total, exp: now + AUTH_BLOCK_SEC * 1000 });
  // Vercelは同じ相手でも実行インスタンスが変わるため、回数はRedisで共有する
  if (REDIS_ENABLED) {
    try {
      const key = `authfail:${ip}`;
      const v = await redisCmd('INCR', key);
      if (v === 1) await redisCmd('EXPIRE', key, AUTH_BLOCK_SEC);
      if (typeof v === 'number' && v > total) total = v;
    } catch {}
  }
  if (total >= AUTH_FAIL_MAX) authBlocks.set(ip, now + AUTH_BLOCK_SEC * 1000);
}

// パスワード保護（全ページに適用）
const siteAuth = basicAuth({
  authorizer: (user, pass) =>
    basicAuth.safeCompare(user, 'guest') & basicAuth.safeCompare(pass, SITE_PASSWORD),
  challenge: true,
  realm: 'BoatRace Dashboard',
  unauthorizedResponse: req => { noteAuthFailure(req).catch(() => {}); return 'Unauthorized'; },
});

// 自動投稿だけは、正しい CRON_SECRET があれば Basic認証を免除する。
// 外部のcronサービスはBasic認証を設定できないものが多いため。
// このエンドポイント自体は CRON_SECRET（64文字）で保護されている
app.use((req, res, next) => {
  if (req.path === '/api/auto-post' && CRON_SECRET) {
    const s = req.get('x-cron-secret') || (req.query && req.query.secret) || '';
    if (s === CRON_SECRET) return next();
  }
  const until = authBlockedUntil(clientIp(req));
  if (until) {
    res.set('Retry-After', String(Math.ceil((until - Date.now()) / 1000)));
    return res.status(429).type('text/plain; charset=utf-8')
      .send('パスワードの誤りが続いたため、しばらくアクセスを制限しています。時間をおいて再度お試しください。');
  }
  return siteAuth(req, res, next);
});

// モーター評価表の画像取り込みで数百KB〜数MBのbase64を受けるため上限を上げる
// （Vercelの受信上限は4.5MBなので、それを超えない範囲にとどめる）
app.use(express.json({ limit: '4mb' }));
// index.html と sw.js はブラウザにキャッシュさせない（バージョン更新を確実に届けるため）
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

const VENUES = {
  '01':'桐生','02':'戸田','03':'江戸川','04':'平和島','05':'多摩川',
  '06':'浜名湖','07':'蒲郡','08':'常滑','09':'津','10':'三国',
  '11':'びわこ','12':'住之江','13':'尼崎','14':'鳴門','15':'丸亀',
  '16':'児島','17':'宮島','18':'徳山','19':'下関','20':'若松',
  '21':'芦屋','22':'福岡','23':'唐津','24':'大村'
};
// 外部サービスの宛先。テスト時（NODE_ENV=test）だけローカルのスタブに差し替えられる。
// 本番では環境変数を見ないので、設定ミスで外部通信が別の宛先へ向くことはない
const testOrigin = (name, prod) =>
  (process.env.NODE_ENV === 'test' && process.env[name]) ? process.env[name] : prod;
const ORIGIN_BOATRACE = testOrigin('TEST_ORIGIN_BOATRACE', 'https://www.boatrace.jp');
const ORIGIN_GEMINI   = testOrigin('TEST_ORIGIN_GEMINI',   'https://generativelanguage.googleapis.com/v1beta');
const ORIGIN_X        = testOrigin('TEST_ORIGIN_X',        'https://api.twitter.com');

const BASE = `${ORIGIN_BOATRACE}/owpc/pc/race`;
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

async function fetchHtml(url, retries = 3) {
  // Vercelの実行時間制限（30秒）内に必ず収まるよう、リトライ込みの合計時間に上限を設ける
  const deadline = Date.now() + 20000;
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(15000, deadline - Date.now())));
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'ja,en;q=0.9',
          'Accept': 'text/html',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 404) return null;
      if (res.status === 403) throw Object.assign(new Error('HTTP 403 (アクセス拒否)'), { noRetry: true });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (e.noRetry || i === retries || Date.now() >= deadline) throw e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
}

function validateParams(jcd, hd) {
  if (!VENUES[jcd]) return '無効な場コード';
  if (!/^\d{8}$/.test(hd)) return '無効な日付';
  return null;
}

function parseRacelist(html, jcd, hd, rno) {
  const $ = cheerio.load(html);

  const grade = $('h3').first().text().replace(/\s+/g, ' ').trim();

  // 締切時刻の取得（td数13行の最初のtdが"締切予定時刻"の行）
  const schedule = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.first().text().trim() === '締切予定時刻') {
      tds.each((i, td) => {
        const t = $(td).text().trim();
        if (/^\d{2}:\d{2}$/.test(t)) schedule.push({ rno: i, time: t });
      });
    }
  });

  const racers = [];

  // クラスに is-fs12 を含む tbody を対象にする（先頭スペースがあるため includes で判定）
  $('tbody').each((_, tbody) => {
    const tbodyCls = $(tbody).attr('class') || '';
    if (!tbodyCls.includes('is-fs12')) return;

    // td数が24のメイン行を取得
    const mainRow = $('tr', tbody).filter((_, tr) => {
      return $(tr).find('td').length === 24;
    }).first();

    if (!mainRow.length) return;

    const cells = mainRow.find('td');

    // cells[0]: 艇番（全角数字 "１"〜"６"）→ 半角に変換
    const laneRaw = cells.eq(0).text().trim();
    const laneHalf = laneRaw.replace(/[１２３４５６]/g, c =>
      String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
    );
    const lane = parseInt(laneHalf);
    if (isNaN(lane) || lane < 1 || lane > 6) return;

    // cells[1]: 写真（空）
    // cells[2]: "4030 / A1 森高 一真 香川/香川 47歳/51.0kg"
    const infoText = cells.eq(2).text().replace(/\s+/g, ' ').trim();

    const regNo = (infoText.match(/(\d{4})/) || [])[1] || '';
    const cls   = (infoText.match(/(A1|A2|B1|B2)/) || [])[1] || '';

    const ageMatch = infoText.match(/(\d+)歳\s*\/\s*([\d.]+)kg/);
    const age    = ageMatch ? parseInt(ageMatch[1])    : 0;
    const weight = ageMatch ? parseFloat(ageMatch[2])  : 0;

    // 級別の後ろから年齢の前まで: "森高 一真 香川/香川"
    const afterCls = infoText.replace(/^\d{4}\s*\/\s*(A1|A2|B1|B2)\s*/, '');
    const branchAgeMatch = afterCls.match(/^(.+?)\s+([^\s]+\/[^\s]+)\s+\d+歳/);
    const name   = branchAgeMatch ? branchAgeMatch[1].trim() : '';
    const branch = branchAgeMatch ? branchAgeMatch[2].split('/')[0] : '';

    // cells[3]: "F0 L0 0.14"
    const flText = cells.eq(3).text().replace(/\s+/g, ' ').trim();
    const fCount = parseInt((flText.match(/F(\d+)/) || ['','0'])[1]);
    const lCount = parseInt((flText.match(/L(\d+)/) || ['','0'])[1]);
    const avgST  = parseFloat((flText.match(/0\.\d{2}/) || ['0.18'])[0]);

    // cells[4]: 全国勝率/2連率/3連率
    // cells[5]: 当地勝率/2連率/3連率
    // cells[6]: モーターNo/2連率/3連率
    // cells[7]: ボートNo/2連率/3連率
    function extractNums(cell) {
      return ($(cell).text().match(/[\d.]+/g) || []).map(Number);
    }
    const natl  = extractNums(cells.eq(4));
    const local = extractNums(cells.eq(5));
    const motor = extractNums(cells.eq(6));
    const boat  = extractNums(cells.eq(7));

    racers.push({
      lane,
      regNo,
      cls,
      name,
      branch,
      age,
      weight,
      fl: `${fCount}/${lCount}`,
      avgST,
      allRate:    natl[0]  || 0,
      all2Rate:   natl[1]  || 0,
      all3Rate:   natl[2]  || 0,
      localRate:  local[0] || 0,
      local2Rate: local[1] || 0,
      local3Rate: local[2] || 0,
      motorNo:    String(motor[0] || ''),
      motor2Rate: motor[1] || 0,
      motor3Rate: motor[2] || 0,
      boatNo:     String(boat[0] || ''),
      boat2Rate:  boat[1]  || 0,
      boat3Rate:  boat[2]  || 0,
    });
  });

  return {
    jcd,
    venue: VENUES[jcd] || '',
    hd,
    rno: parseInt(rno),
    grade,
    schedule,
    racers,
    fetchedAt: new Date().toISOString(),
  };
}

// 全角数字→半角（boatrace.jpは艇番・着順に全角数字を使う）
function normDigits(s) {
  return String(s || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function parseBeforeinfo(html) {
  const $ = cheerio.load(html);
  const weather = {};

  // boatrace.jp 実ページの気象ウィジェット（.weather1）
  const wUnit = cls => $(`.weather1_bodyUnit.${cls} .weather1_bodyUnitLabelData`).first().text().trim();
  {
    const sky = $('.weather1_bodyUnit.is-weather .weather1_bodyUnitLabelTitle').first().text().trim();
    if (sky) weather.sky = sky;
    const wind = parseFloat(wUnit('is-wind'));   if (!isNaN(wind)) weather.wind  = wind;
    const wtr  = parseFloat(wUnit('is-water'));  if (!isNaN(wtr))  weather.water = wtr;
    const wave = parseFloat(wUnit('is-wave'));   if (!isNaN(wave)) weather.wave  = wave;
    // 風向はアイコンのクラス番号（is-wind1〜16 = 北から時計回り、17 = 無風）
    const wd = ($('.weather1_bodyUnit.is-windDirection .weather1_bodyUnitImage').attr('class') || '').match(/is-wind(\d+)/);
    if (wd) {
      const DIRS = ['北','北北東','北東','東北東','東','東南東','南東','南南東','南','南南西','南西','西南西','西','西北西','北西','北北西'];
      const i = parseInt(wd[1]);
      if (i >= 1 && i <= 16) weather.windDir = DIRS[i - 1];
    }
  }
  // テーブルセル形式（label/value 隣接td）
  $('td, th').each((_, el) => {
    const label = $(el).text().trim();
    const val   = $(el).next('td').text().trim();
    if (label === '天候' && val && !weather.sky) weather.sky = val;
    if (label === '風速' && val && weather.wind == null)  { const n = parseFloat(val); if (!isNaN(n)) weather.wind = n; }
    if (label === '風向' && val && !weather.windDir) weather.windDir = val;
    if (label === '水温' && val && weather.water == null) { const n = parseFloat(val); if (!isNaN(n)) weather.water = n; }
    if (label === '波高' && val && weather.wave == null)  { const n = parseFloat(val); if (!isNaN(n)) weather.wave = n; }
  });
  // フォールバック: テキスト形式（0m/s・0cm は有効値なので == null で判定）
  const bodyText = $.text();
  if (!weather.sky)          weather.sky     = (bodyText.match(/天候\s*[:：]?\s*([晴曇雨雪][^\s\d]*)/) || [])[1] || '';
  if (weather.wind == null)  weather.wind    = parseFloat((bodyText.match(/風速\s*[:：]?\s*([\d.]+)/) || [])[1]) || 0;
  if (!weather.windDir)      weather.windDir = (bodyText.match(/風向\s*[:：]?\s*([北南東西][^\s\d]{0,4})/) || [])[1] || '';
  if (weather.water == null) weather.water   = parseFloat((bodyText.match(/水温\s*[:：]?\s*([\d.]+)/) || [])[1]) || 0;
  if (weather.wave == null)  weather.wave    = parseFloat((bodyText.match(/波高\s*[:：]?\s*([\d.]+)/) || [])[1]) || 0;

  const entries = {};
  const getEntry = lane => entries[lane] || (entries[lane] = { lane, course: null, exhibitTime: null, st: null });

  // スタート展示テーブル（実ページ）: 表示順 = 進入コース順。艇番とSTを取得
  $('.table1_boatImage1').each((i, el) => {
    const lane = parseInt(normDigits($(el).find('.table1_boatImage1Number').first().text().trim()));
    if (!(lane >= 1 && lane <= 6)) return;
    const en = getEntry(lane);
    en.course = i + 1;
    const stTxt = normDigits($(el).find('.table1_boatImage1TimeInner, .table1_boatImage1Time').first().text().trim());
    const m = stTxt.match(/F?\.(\d{2})/);
    if (m) en.st = parseFloat('0.' + m[1]);
  });

  // 展示タイム: 艇番で始まる行から展示タイム形式（5.00〜8.49・小数2桁）の最初のセルを探す。
  // 実ページは 枠|写真|選手名|体重|展示タイム|チルト|... の構成で列位置が変わりうるため、
  // 固定インデックスではなく値の形式で判定する（体重52.0kg・チルト-0.5・調整重量0.0は範囲外）
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 3) return;
    const lane = parseInt(normDigits(cells.eq(0).text().trim()));
    if (isNaN(lane) || lane < 1 || lane > 6) return;
    if (entries[lane]?.exhibitTime != null) return;

    let exhibitTime = null, courseFb = null, stFb = null;
    for (let i = 1; i < cells.length; i++) {
      const t = normDigits(cells.eq(i).text().replace(/\s+/g, ''));
      if (exhibitTime == null && /^[5-8]\.\d{2}$/.test(t)) {
        const v = parseFloat(t);
        if (v >= 5 && v < 8.5) { exhibitTime = v; continue; }
      }
      if (courseFb == null && i <= 2 && /^[1-6]$/.test(t)) { courseFb = parseInt(t); continue; }
      if (stFb == null && /^F?0?\.\d{2}$/.test(t)) { const m = t.match(/\.(\d{2})$/); stFb = parseFloat('0.' + m[1]); }
    }
    if (exhibitTime != null || stFb != null) {
      const en = getEntry(lane);
      if (en.exhibitTime == null) en.exhibitTime = exhibitTime;
      if (en.course == null && courseFb != null) en.course = courseFb;
      if (en.st == null && stFb != null) en.st = stFb;
    }
  });

  const exhibitMap = {};
  Object.values(entries).forEach(en => {
    if (en.exhibitTime == null && en.st == null) return;
    if (en.course == null) en.course = en.lane;
    exhibitMap[en.lane] = en;
  });

  return { weather, exhibit: exhibitMap, fetchedAt: new Date().toISOString() };
}

function parseOdds1t(html) {
  const $ = cheerio.load(html);
  const odds = {};
  // 艇番で始まる行から最初の小数セル（単勝オッズ形式 "3.2"）を探す。
  // 実ページ（oddstf）は 枠|選手名|単勝|複勝レンジ の構成で列位置が固定でないため形式で判定
  $('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (cells.length < 2) return;
    const lane = parseInt(normDigits($(cells[0]).text().trim()));
    if (!(lane >= 1 && lane <= 6) || odds[lane] != null) return;
    for (let i = 1; i < cells.length; i++) {
      const t = $(cells[i]).text().trim();
      if (/^\d{1,3}\.\d$/.test(t)) { odds[lane] = parseFloat(t); break; }
    }
  });
  return { odds, fetchedAt: new Date().toISOString() };
}

// 実ページの3連単オッズは6列グリッド:
//   1着=1〜6号艇の列グループ × [2着(rowspan=4) | 3着 | オッズ]
//   新2着グループ行=18セル、継続行=12セル
function parseOdds3t(html) {
  const $ = cheerio.load(html);
  const odds = {};
  const cur2 = [0, 0, 0, 0, 0, 0];
  let gridSeen = false;
  $('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (cells.length === 18) {
      gridSeen = true;
      for (let g = 0; g < 6; g++) {
        const c2 = parseInt(normDigits($(cells[g*3]).text().trim()));
        const c3 = parseInt(normDigits($(cells[g*3+1]).text().trim()));
        const v  = parseFloat($(cells[g*3+2]).text().trim());
        if (c2 >= 1 && c2 <= 6) cur2[g] = c2;
        if (c3 >= 1 && c3 <= 6 && !isNaN(v) && v > 0 && cur2[g]) odds[`${g+1}-${cur2[g]}-${c3}`] = v;
      }
    } else if (cells.length === 12 && gridSeen) {
      for (let g = 0; g < 6; g++) {
        const c3 = parseInt(normDigits($(cells[g*2]).text().trim()));
        const v  = parseFloat($(cells[g*2+1]).text().trim());
        if (c3 >= 1 && c3 <= 6 && !isNaN(v) && v > 0 && cur2[g]) odds[`${g+1}-${cur2[g]}-${c3}`] = v;
      }
    }
  });
  if (Object.keys(odds).length) return { odds };

  // フォールバック: 1行1組番の簡易形式（rowspanで1着継続）
  const boats = [1, 2, 3, 4, 5, 6];
  let curFirst = 0;
  $('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (!cells.length) return;
    let ci = 0;
    const fc = $(cells[0]);
    const fcVal = parseInt(fc.text().trim());
    if (fc.attr('rowspan') && fcVal >= 1 && fcVal <= 6) { curFirst = fcVal; ci = 1; }
    if (!curFirst) return;
    const scVal = parseInt($(cells[ci])?.text().trim());
    if (!scVal || scVal < 1 || scVal > 6 || scVal === curFirst) return;
    ci++;
    boats.filter(b => b !== curFirst && b !== scVal).forEach(third => {
      const v = parseFloat($(cells[ci])?.text().trim());
      if (!isNaN(v) && v > 0) odds[`${curFirst}-${scVal}-${third}`] = v;
      ci++;
    });
  });
  return { odds };
}

// 実ページの2連単オッズ: 1着=1〜6号艇の列グループ × [2着 | オッズ] = 12セル/行
function parseOdds2t(html) {
  const $ = cheerio.load(html);
  const odds = {};
  $('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (cells.length !== 12) return;
    for (let g = 0; g < 6; g++) {
      const c2 = parseInt(normDigits($(cells[g*2]).text().trim()));
      const v  = parseFloat($(cells[g*2+1]).text().trim());
      if (c2 >= 1 && c2 <= 6 && c2 !== g+1 && !isNaN(v) && v > 0 && odds[`${g+1}-${c2}`] == null) odds[`${g+1}-${c2}`] = v;
    }
  });
  if (Object.keys(odds).length) return { odds };

  // フォールバック: 1行1組番の簡易形式
  let curFirst = 0;
  $('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (!cells.length) return;
    let ci = 0;
    const fc = $(cells[0]);
    const fcVal = parseInt(fc.text().trim());
    if (fc.attr('rowspan') && fcVal >= 1 && fcVal <= 6) { curFirst = fcVal; ci = 1; }
    if (!curFirst) return;
    const scVal = parseInt($(cells[ci])?.text().trim());
    if (!scVal || scVal < 1 || scVal > 6 || scVal === curFirst) return;
    ci++;
    const v = parseFloat($(cells[ci])?.text().trim());
    if (!isNaN(v) && v > 0) odds[`${curFirst}-${scVal}`] = v;
  });
  return { odds };
}

// 実ページの3連複オッズ: 1艇目=1〜4号艇の列グループ × [2艇目(rowspan) | 3艇目 | オッズ]
//   新グループ行=12セル、継続行=8セル。キーは昇順ソート
function parseOdds3f(html) {
  const $ = cheerio.load(html);
  const odds = {};
  const cur2 = [0, 0, 0, 0];
  let gridSeen = false;
  $('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (cells.length === 12) {
      gridSeen = true;
      for (let g = 0; g < 4; g++) {
        const c2 = parseInt(normDigits($(cells[g*3]).text().trim()));
        const c3 = parseInt(normDigits($(cells[g*3+1]).text().trim()));
        const v  = parseFloat($(cells[g*3+2]).text().trim());
        if (c2 >= 1 && c2 <= 6) cur2[g] = c2;
        if (c3 >= 1 && c3 <= 6 && !isNaN(v) && v > 0 && cur2[g]) odds[[g+1, cur2[g], c3].sort((a,b)=>a-b).join('-')] = v;
      }
    } else if (cells.length === 8 && gridSeen) {
      for (let g = 0; g < 4; g++) {
        const c3 = parseInt(normDigits($(cells[g*2]).text().trim()));
        const v  = parseFloat($(cells[g*2+1]).text().trim());
        if (c3 >= 1 && c3 <= 6 && !isNaN(v) && v > 0 && cur2[g]) odds[[g+1, cur2[g], c3].sort((a,b)=>a-b).join('-')] = v;
      }
    }
  });
  if (Object.keys(odds).length) return { odds };

  // フォールバック: 1行1組番の汎用スキャン
  $('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (cells.length < 2) return;
    const boats = [];
    let oddsVal = null;
    cells.forEach(td => {
      const raw = $(td).text().trim();
      if (raw.includes('.')) {
        const v = parseFloat(raw);
        if (!isNaN(v) && v >= 1.0) oddsVal = v;
        return;
      }
      const nums = raw.replace(/[=×\s]/g, '').split('').map(Number).filter(n => n >= 1 && n <= 6);
      if (nums.length >= 3 && boats.length === 0) { nums.slice(0,3).forEach(n => boats.push(n)); return; }
      const n = parseInt(raw);
      if (!isNaN(n) && n >= 1 && n <= 6 && boats.length < 3) boats.push(n);
    });
    if (boats.length === 3 && oddsVal) odds[boats.slice().sort((a,b)=>a-b).join('-')] = oddsVal;
  });
  return { odds };
}

// 複数の候補URLを順に試し、オッズが取れた最初の結果を返す
// （単勝は oddstf、2連単は odds2tf が実際のパスのため旧パスと両対応）
async function fetchParsedOdds(paths, parser) {
  for (const p of paths) {
    try {
      const html = await fetchHtml(`${BASE}/${p}`);
      if (!html) continue;
      const r = parser(html);
      if (Object.keys(r.odds).length) return r;
    } catch {}
  }
  return { odds: {} };
}

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// 診断: Redis(Upstash)が実際に読み書きできているかを往復テストで確認する。
// 環境変数が設定されていても、URL/トークンの不一致や上限超過で無言のまま失敗しうる
app.get('/api/redis-health', async (req, res) => {
  const host = (() => { try { return new URL(UPSTASH_URL || '').host; } catch { return null; } })();
  if (!REDIS_ENABLED) {
    return res.json({ ok: false, cause: 'UPSTASH_REDIS_REST_URL / TOKEN が未設定', urlHost: host });
  }
  const key = `healthcheck:${Date.now()}`;
  const val = `v${Math.random().toString(36).slice(2)}`;
  const setR = await redisRaw(['SET', key, val, 'EX', '60']);
  const getR = await redisRaw(['GET', key]);
  await redisRaw(['DEL', key]);
  const roundTrip = getR.result === val;
  const net = netCause(setR.detail);
  res.json({
    ok: roundTrip,
    cause: roundTrip ? undefined
      : /ByteString/.test(setR.error || '') ? '環境変数の値に引用符など不正な文字が含まれています'
      : net ? net
      : !setR.ok ? `書き込み失敗 (HTTP ${setR.status || '-'})`
      : !getR.ok ? `読み取り失敗 (HTTP ${getR.status || '-'})`
      : '書き込んだ値が読み戻せない',
    fix: roundTrip ? undefined
      : /ByteString/.test(setR.error || '') ? 'Vercelの環境変数から前後の引用符（" や “ ”）を削除して再デプロイしてください'
      : net ? 'Upstashのコンソールでデータベースが存在するか確認し、REST API の URL と TOKEN を取り直してください'
      : setR.status === 401 ? 'UPSTASH_REDIS_REST_TOKEN が URL と同じデータベースのものか確認してください'
      : 'Upstash側の利用上限に達していないか確認してください',
    urlHost: host,
    urlProtocol: (() => { try { return new URL(UPSTASH_URL).protocol; } catch { return null; } })(),
    set: { ok: setR.ok, status: setR.status, error: setR.error, detail: setR.detail, body: setR.body },
    get: { ok: getR.ok, status: getR.status, error: getR.error, detail: getR.detail, matched: roundTrip },
    note: 'Redisが使えないと、投稿履歴・重複防止・キャッシュ共有が機能しません',
  });
});
app.get('/api/venues', (_, res) => res.json(Object.entries(VENUES).map(([jcd, name]) => ({ jcd, name }))));

function todayHd() {
  const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return `${jst.getFullYear()}${String(jst.getMonth()+1).padStart(2,'0')}${String(jst.getDate()).padStart(2,'0')}`;
}

// HTML全体から jcd=NN を拾う。<a href> に限定するとページ構造の変更で検出できなくなるため、
// 生のHTMLに対して正規表現をかける
function extractJcds(html) {
  const found = new Map();
  for (const m of String(html || '').matchAll(/jcd=(\d{2})/g)) {
    if (VENUES[m[1]] && !found.has(m[1])) found.set(m[1], VENUES[m[1]]);
  }
  return [...found.entries()].map(([jcd, name]) => ({ jcd, name }));
}

const TODAY_INDEX_URLS = hd => [`${BASE}/index?hd=${hd}`];

// 単発取得（リトライなし）。詳細な結果を返すので診断にも使う。
// boatrace.jp は応答が遅いことがあるため、既定のタイムアウトは長めに取る
async function fetchOnce(url, ms = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const started = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.9', 'Accept': 'text/html' },
      signal: c.signal,
    });
    clearTimeout(t);
    const body = r.ok ? await r.text() : '';
    return { ok: r.ok, status: r.status, html: r.ok ? body : null, ms: Date.now() - started };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, html: null, ms: Date.now() - started, error: e.name === 'AbortError' ? `timeout(${ms}ms)` : e.message };
  }
}

async function fetchQuick(url, ms = 12000) {
  return (await fetchOnce(url, ms)).html;
}

// 全場の出走表を並列で叩き、選手データがある場を開催中と判定する。
// ページ構造に依存しないため、一覧ページの作りが変わっても影響を受けない
async function probeOpenVenues(hd, ms = 15000) {
  const results = await Promise.allSettled(Object.keys(VENUES).map(async jcd => {
    const r = await fetchOnce(`${BASE}/racelist?jcd=${jcd}&hd=${hd}&rno=1`, ms);
    // 出走表の選手行（tbody.is-fs12）があれば開催中
    return r.html && r.html.includes('is-fs12') ? jcd : null;
  }));
  return results
    .filter(x => x.status === 'fulfilled' && x.value)
    .map(x => ({ jcd: x.value, name: VENUES[x.value] }));
}

// プロセス内キャッシュ（同じインスタンスに来た次のリクエストで再取得を避ける）。
// Redis未設定でも効くので、キャッシュの効き目を Redis の有無に依存させない
function memGet(key) {
  const hit = raceCache.get(key);
  return hit && Date.now() < hit.exp ? hit.data : null;
}
function memSet(key, data, ttlMs) {
  raceCache.set(key, { data, exp: Date.now() + ttlMs });
}

// 本日の開催場一覧（メモリ → Redis → 一覧ページ → 全場プローブ の順に試す）
async function getOpenVenues(hd) {
  const mkey = `openvenues:${hd}`;
  const mem = memGet(mkey);
  if (mem) return mem;

  try {
    const cached = JSON.parse(await redisCmd('GET', mkey) || '[]');
    if (Array.isArray(cached) && cached.length) { memSet(mkey, cached, 600000); return cached; }
  } catch {}

  // 一覧ページは構造変更で取れなくなっているため短めに切り上げ、確実なプローブへ回す
  for (const url of TODAY_INDEX_URLS(hd)) {
    const found = extractJcds(await fetchQuick(url, 3000));
    if (found.length) {
      memSet(mkey, found, 600000);
      await redisCmd('SET', mkey, JSON.stringify(found), 'EX', '600');
      return found;
    }
  }

  const probed = await probeOpenVenues(hd, 12000);
  // 当日の開催場は途中で増減しないので長めにキャッシュしてプローブの頻度を下げる。
  // await しないと関数終了時に書き込みが破棄され、毎回プローブし直すことになる
  if (probed.length) {
    memSet(mkey, probed, 10800000);
    await redisCmd('SET', mkey, JSON.stringify(probed), 'EX', '10800');
  }
  return probed;
}

// 1場ぶんの締切時刻表（メモリ → Redis → 出走表の取得）
async function getSchedule(jcd, hd) {
  const mkey = `sched:${jcd}:${hd}`;
  const mem = memGet(mkey);
  if (mem) return mem;
  try {
    const cached = JSON.parse(await redisCmd('GET', mkey) || 'null');
    if (cached && cached.length) { memSet(mkey, cached, 86400000); return cached; }
  } catch {}
  const html = await fetchQuick(`${BASE}/racelist?jcd=${jcd}&hd=${hd}&rno=1`, 15000);
  if (!html) return null;
  const rl = parseRacelist(html, jcd, hd, '1');
  if (!rl.schedule?.length) return null;
  memSet(mkey, rl.schedule, 86400000);
  await redisCmd('SET', mkey, JSON.stringify(rl.schedule), 'EX', '86400');
  return rl.schedule;
}

app.get('/api/today', async (req, res) => {
  const hd = todayHd();
  try {
    res.json({ venues: await getOpenVenues(hd), hd });
  } catch (e) {
    res.json({ venues: [], hd, error: e.message });
  }
});

// 診断: 開催場の検出がどの段階で失敗しているかを確認する
// 診断: boatrace.jp の各URLに対する到達性を並列で確認する。
// ステータス・所要時間・エラー内容まで返すので、404なのか遅延なのかを切り分けられる
app.get('/api/debug-fetch', async (req, res) => {
  const hd = req.query.hd || todayHd();
  const ms = Math.min(parseInt(req.query.ms) || 15000, 20000);
  const targets = {
    'racelist(住之江)': `${BASE}/racelist?jcd=12&hd=${hd}&rno=1`,
    'racelist(平和島)': `${BASE}/racelist?jcd=04&hd=${hd}&rno=1`,
    'index?hd=':        `${BASE}/index?hd=${hd}`,
    'index':            `${BASE}/index`,
    'race/':            `${ORIGIN_BOATRACE}/owpc/pc/race/`,
    'top':              `${ORIGIN_BOATRACE}/`,
  };
  const entries = Object.entries(targets);
  const results = await Promise.all(entries.map(async ([name, url]) => {
    const r = await fetchOnce(url, ms);
    return [name, {
      status: r.status,
      ok: r.ok,
      ms: r.ms,
      error: r.error,
      htmlLen: r.html ? r.html.length : 0,
      hasRaceData: r.html ? r.html.includes('is-fs12') : false,
      jcdHits: r.html ? (r.html.match(/jcd=\d{2}/g) || []).length : 0,
      title: r.html ? ((r.html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim().slice(0, 60) : '',
    }];
  }));
  res.json({ hd, timeoutMs: ms, results: Object.fromEntries(results) });
});

app.get('/api/debug-today', async (req, res) => {
  const hd = req.query.hd || todayHd();
  const steps = [];
  for (const url of TODAY_INDEX_URLS(hd)) {
    const html = await fetchQuick(url);
    steps.push({
      url,
      fetched: html != null,
      htmlLen: html ? html.length : 0,
      title: html ? ((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim() : '',
      jcdHits: html ? (html.match(/jcd=\d{2}/g) || []).length : 0,
      venues: extractJcds(html).map(v => v.jcd),
    });
  }
  let probe = null;
  if (req.query.probe === '1') probe = (await probeOpenVenues(hd)).map(v => `${v.jcd}:${v.name}`);
  res.json({ hd, steps, probe });
});

// 全場ダッシュボード: 本日の開催場ごとの「次のレース」締切時刻と共有予想の有無
app.get('/api/dashboard', async (req, res) => {
  try {
    const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const hd = `${jst.getFullYear()}${String(jst.getMonth()+1).padStart(2,'0')}${String(jst.getDate()).padStart(2,'0')}`;
    const nowMin = jst.getHours() * 60 + jst.getMinutes();

    const mem = raceCache.get(`dash:${hd}`);
    if (mem && Date.now() < mem.exp) return res.json(mem.data);

    const open = await getOpenVenues(hd);

    const venues = await Promise.all(open.map(async ({ jcd, name }) => {
      // 締切時刻表は当日中は変わらないためメモリ＋Redisに1日キャッシュ
      const schedule = await getSchedule(jcd, hd);
      if (!schedule || !schedule.length) return { jcd, name, status: 'unknown' };

      // 次のレース = 締切+12分を過ぎていない最初のレース
      let next = null;
      for (const r of schedule) {
        const [h, m] = (r.time || '0:0').split(':').map(Number);
        if (nowMin < h * 60 + m + 12) { next = r; break; }
      }
      if (!next) return { jcd, name, status: 'ended' };

      // そのレースの共有予想があるか（展示反映後ex1を優先して確認）
      let shared = false;
      for (const ex of ['ex1', 'ex0']) {
        if (await lookupSharedPredict(`v6_${jcd}_${hd}_${next.rno}_0_${ex}`)) { shared = true; break; }
      }
      const [h, m] = next.time.split(':').map(Number);
      return { jcd, name, status: 'open', nextRno: next.rno, nextTime: next.time, minsLeft: h * 60 + m - nowMin, shared };
    }));

    const data = { hd, venues, fetchedAt: new Date().toISOString() };
    raceCache.set(`dash:${hd}`, { data, exp: Date.now() + 60000 });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/odds', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });
  try {
    const q = `jcd=${jcd}&hd=${hd}&rno=${rno}`;
    res.json(await fetchParsedOdds([`oddstf?${q}`, `odds1t?${q}`], parseOdds1t));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/odds2t', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });
  try {
    const q = `jcd=${jcd}&hd=${hd}&rno=${rno}`;
    res.json(await fetchParsedOdds([`odds2tf?${q}`, `odds2t?${q}`], parseOdds2t));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/odds3f', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });
  try {
    const html = await fetchHtml(`${BASE}/odds3f?jcd=${jcd}&hd=${hd}&rno=${rno}`);
    if (!html) return res.json({ odds: {} });
    res.json(parseOdds3f(html));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/before', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });
  try {
    const html = await fetchHtml(`${BASE}/beforeinfo?jcd=${jcd}&hd=${hd}&rno=${rno}`);
    if (!html) return res.json({ weather: {}, exhibit: {} });
    res.json(parseBeforeinfo(html));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/odds3t', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });
  try {
    const html = await fetchHtml(`${BASE}/odds3t?jcd=${jcd}&hd=${hd}&rno=${rno}`);
    if (!html) return res.json({ odds: {} });
    res.json(parseOdds3t(html));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 組番の正規化: "４-３-５"(全角) / "4=3=5" / "435"(spanが連結された場合) → "4-3-5"
function normCombo(raw) {
  const t = normDigits(raw).replace(/\s+/g, '');
  if (/^[1-6]([-=][1-6]){1,2}$/.test(t)) return t.replace(/=/g, '-');
  if (/^[1-6]{2,3}$/.test(t)) return t.split('').join('-');
  if (/^[1-6]$/.test(t)) return t; // 単勝・複勝
  return null;
}

function parseRaceResult(html) {
  const $ = cheerio.load(html);
  const order = [];
  const payouts = [];
  const PAYOUT_TYPES = ['3連単','3連複','2連単','2連複','拡連複','単勝','複勝'];
  let curPayType = null; // rowspan継続行用（複勝・拡連複の2行目以降）

  $('tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;

    // 払戻行: 式別名が先頭2セル以内。複勝・拡連複は同一行内または rowspan 継続行に複数の払戻がある
    let type = null;
    let startIdx = 0;
    for (let ci = 0; ci < Math.min(cells.length, 2); ci++) {
      const t0 = cells.eq(ci).text().trim();
      if (!PAYOUT_TYPES.includes(t0)) continue;
      type = t0;
      startIdx = ci + 1;
      curPayType = cells.eq(ci).attr('rowspan') ? t0 : null;
      break;
    }
    if (type) {
      const remaining = cells.toArray().slice(startIdx);
      for (let i = 0; i < remaining.length - 1; i++) {
        const combo = normCombo($(remaining[i]).text());
        if (!combo) continue;
        const payRaw = normDigits($(remaining[i + 1]).text()).replace(/[,¥円\s]/g, '');
        const pay    = parseInt(payRaw);
        if (!isNaN(pay) && pay > 0) {
          payouts.push({ type, combo, pay });
          i++; // 払戻金セルはスキップして次のペアへ
        }
      }
      return;
    }
    // 式別セルがない行: 直前の rowspan 式別の継続行として扱う
    if (curPayType && cells.length >= 2) {
      const combo = normCombo(cells.eq(0).text());
      const payRaw = normDigits(cells.eq(1).text()).replace(/[,¥円\s]/g, '');
      const pay = parseInt(payRaw);
      if (combo && !isNaN(pay) && pay > 0) {
        payouts.push({ type: curPayType, combo, pay });
        return;
      }
    }

    // 着順行: 先頭セルが着順（"１"全角 / "1" / "1着"）。人気列などの誤検出を防ぐため先頭セルのみ判定
    if (cells.length < 3) return;
    const t0 = normDigits(cells.eq(0).text().trim());
    const rankM = t0.match(/^([1-6])着?$/);
    if (!rankM) return;
    const rank = parseInt(rankM[1]);
    for (let li = 1; li < Math.min(cells.length, 4); li++) {
      const lv = parseInt(normDigits(cells.eq(li).text().replace(/\s+/g, '')));
      if (lv >= 1 && lv <= 6) { order.push({ rank, lane: lv }); curPayType = null; break; }
    }
  });

  // 重複除去（同一rankの2件目以降と、同一laneの重複を除去）
  const seenRank = new Set(), seenLane = new Set();
  let uniqOrder = order.filter(o => {
    if (seenRank.has(o.rank) || seenLane.has(o.lane)) return false;
    seenRank.add(o.rank); seenLane.add(o.lane);
    return true;
  }).sort((a, b) => a.rank - b.rank);

  // 3連単の組番は1〜3着そのもの — 着順テーブルのパースに失敗/不整合でも組番から確実に復元する
  const tri = payouts.find(p => p.type === '3連単' && /^[1-6]-[1-6]-[1-6]$/.test(p.combo));
  if (tri) {
    const lanes = tri.combo.split('-').map(Number);
    const top3 = lanes.map((lane, i) => ({ rank: i + 1, lane }));
    const rest = uniqOrder.filter(o => o.rank >= 4 && !lanes.includes(o.lane));
    uniqOrder = top3.concat(rest);
  }

  return { order: uniqOrder, payouts, fetchedAt: new Date().toISOString() };
}

app.get('/api/result', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });
  const ck = `result:${jcd}_${hd}_${rno}`;
  try {
    // 確定済みレース結果は変わらないためキャッシュ（メモリ→Redis 7日）
    const mem = raceCache.get(ck);
    if (mem && Date.now() < mem.exp) return res.json(mem.data);
    const shared = await redisCmd('GET', ck);
    if (shared) {
      try {
        const data = JSON.parse(shared);
        raceCache.set(ck, { data, exp: Date.now() + 3600000 });
        return res.json(data);
      } catch {}
    }
    const html = await fetchHtml(`${BASE}/raceresult?jcd=${jcd}&hd=${hd}&rno=${rno}`);
    if (!html) return res.json({ order: [], payouts: [] });
    const parsed = parseRaceResult(html);
    if (parsed.order.length >= 3 && parsed.payouts.length) {
      raceCache.set(ck, { data: parsed, exp: Date.now() + 3600000 });
      redisCmd('SET', ck, JSON.stringify(parsed), 'EX', '604800');
    }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ======================== SHARED MOTORS ======================== */
app.get('/api/motors', async (req, res) => {
  const { jcd } = req.query;
  if (!jcd) return res.status(400).json({ error: 'jcd required' });
  try {
    const raw = await redisCmd('HGETALL', `motors:${jcd}`);
    if (!raw) return res.json({});
    const result = {};
    // HGETALL returns alternating [key, val, ...] array
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) {
        try { result[raw[i]] = JSON.parse(raw[i + 1]); } catch { result[raw[i]] = raw[i + 1]; }
      }
    } else if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        try { result[k] = JSON.parse(v); } catch { result[k] = v; }
      }
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// モーター評価表（順位/機番/使用者/前検タイム/2連率/優出/優勝/評価/出足/伸び/短評）を
// 貼り付けから取り込む。列がタブ区切りでも空白区切りでも読めるようにしている
const MOTOR_GRADES = ['SS', 'S', 'A+', 'A-', 'A', 'B+', 'B-', 'B', 'C+', 'C-', 'C', 'D', 'E'];
// 出足・伸びの記号。サイトによって ◉ や ◆ なども使われるので広めに取る
const MARK_RE = /^[◎◉⦿○◯●◍▲△▼▽■□◆◇☆★✕✖×☓＋+－ー–—-]$/;

// 1行ぶんの妥当性を確認して整える。読めない値は null を返し、呼び出し側で件数に数える
function normalizeMotorRow(r) {
  const motorNo = parseInt(String(r.motorNo ?? r.no ?? '').replace(/[^\d]/g, ''));
  if (!Number.isInteger(motorNo) || motorNo < 1 || motorNo > 999) return null;
  const grade = String(r.grade ?? '').trim().toUpperCase().replace(/[＋]/g, '+').replace(/[－ー]/g, '-');
  if (!MOTOR_GRADES.includes(grade)) return null;
  const deashi = String(r.deashi ?? '').trim();
  const nobi   = String(r.nobi ?? '').trim();
  const rate2  = parseFloat(String(r.motor2Rate ?? r.rate2 ?? '').replace(/[^\d.]/g, ''));
  return {
    motorNo: String(motorNo),
    grade,
    deashi: MARK_RE.test(deashi) ? deashi : '',
    nobi:   MARK_RE.test(nobi)   ? nobi   : '',
    motor2Rate: Number.isFinite(rate2) ? rate2 : null,
    racerName: String(r.racerName ?? r.racer ?? '').trim().slice(0, 50),
    note: String(r.note ?? '').trim().slice(0, 200),
  };
}

function parseMotorTable(text) {
  const rows = [], errors = [];
  // 評価は長いものから順に試す（A+ を A と誤認しないため）
  const gradeAlt = MOTOR_GRADES.slice().sort((a, b) => b.length - a.length)
    .map(g => g.replace(/[+]/g, '\\+')).join('|');
  // 順位・前検タイム・優出/優勝は列が無い表もあるので任意にする。
  // 機番・登番/氏名・2連率・評価・出足・伸びが揃っている行だけを取り込む。
  // 登番と氏名の間は空白が無いことがある（平和島の公式ページは "5393藤原　駿(B2)"）ため \s* にする
  const lineRe = new RegExp(
    '^\\s*(?:(\\d{1,3})\\s+)?(\\d{1,3})\\s+(\\d{3,5})\\s*(.+?)\\s*[（(](A1|A2|B1|B2)[）)]\\s+' +  // [順位] 機番 登番 氏名 (級別)
    '(?:([\\d.]+)\\s+)?([\\d.]+)\\s*%\\s+(?:(\\d+)\\s+(\\d+)\\s+)?' +                             // [前検タイム] 2連率 [優出 優勝]
    '(' + gradeAlt + ')\\s+(\\S)\\s+(\\S)\\s*(.*)$');                                                     // 評価 出足 伸び 短評

  for (const raw of String(text || '').split(/\r?\n/)) {
    // 全角の空白とタブを半角スペースに寄せてから判定する
    const line = raw.replace(/[\t\u3000]+/g, ' ').replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/順位|機番|おかぺん|今節使用者/.test(line)) continue;   // 見出し行
    const m = line.match(lineRe);
    if (!m) { errors.push(line.slice(0, 60)); continue; }
    const [, , motorNo, , name, cls, , rate2, , , grade, deashi, nobi, note] = m;
    if (!MARK_RE.test(deashi) || !MARK_RE.test(nobi)) { errors.push(line.slice(0, 60)); continue; }
    rows.push({
      motorNo: String(parseInt(motorNo)),
      grade,
      deashi,
      nobi,
      motor2Rate: parseFloat(rate2),
      racerName: `${name.trim()}(${cls})`.slice(0, 50),
      note: note.trim().slice(0, 200),
    });
  }
  // 同じ機番が複数行あれば後勝ち
  const uniq = new Map();
  for (const r of rows) uniq.set(r.motorNo, r);
  return { rows: [...uniq.values()], errors };
}

// モーター評価の公式ページ。場ごとに増やせるようにしておく
const MOTOR_SOURCES = {
  '04': 'https://www.heiwajima.gr.jp/01motor/motor_assessment.htm',   // 平和島
};

// 古い日本語サイトは Shift_JIS のことがあるので、文字コードを見てから読む
function decodeHtml(buf, contentType) {
  const head = Buffer.from(buf).subarray(0, 4096).toString('latin1');
  const hit = (contentType || '').match(/charset=["']?([\w-]+)/i)
           || head.match(/<meta[^>]+charset=["']?([\w-]+)/i)
           || head.match(/charset=["']?([\w-]+)/i);
  let enc = (hit ? hit[1] : 'utf-8').toLowerCase();
  if (/^(shift[-_]?jis|sjis|x-sjis|windows-31j|ms932|cp932)$/.test(enc)) enc = 'shift_jis';
  else if (/^euc[-_]?jp$/.test(enc)) enc = 'euc-jp';
  try { return { text: new TextDecoder(enc).decode(buf), charset: enc }; }
  catch { return { text: new TextDecoder('utf-8').decode(buf), charset: `${enc}→utf-8(代替)` }; }
}

// 公式ページを取得して表の各行をタブ区切りに直し、貼り付けと同じパーサーに通す。
// 表の構造が変わって読めなくなったときのために、生の行も返す
async function fetchMotorAssessment(jcd, budgetMs = 15000) {
  const url = MOTOR_SOURCES[jcd];
  if (!url) return { ok: false, error: `${VENUES[jcd] || jcd} は取得先が未登録です`, unsupported: true };
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), budgetMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.9' }, signal: c.signal });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: `取得に失敗しました (HTTP ${r.status})`, url };
    const { text, charset } = decodeHtml(await r.arrayBuffer(), r.headers.get('content-type'));
    const $ = cheerio.load(text);
    const lines = [];
    $('tr').each((_, tr) => {
      const cells = $(tr).find('td,th').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
      if (cells.length >= 5) lines.push(cells.join('\t'));
    });
    const { rows, errors } = parseMotorTable(lines.join('\n'));
    return { ok: true, url, charset, lineCount: lines.length, lines, rows, errors };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === 'AbortError' ? `タイムアウトしました(${budgetMs}ms)` : e.message, url };
  }
}

// 取り込んだ行を保存する（貼り付け・画像・公式取得で共通）
async function saveMotorRows(jcd, rows, by, src) {
  const args = ['HSET', `motors:${jcd}`];
  const at = new Date().toISOString();
  for (const r of rows) {
    args.push(r.motorNo, JSON.stringify({
      grade: r.grade, note: r.note, racerName: r.racerName, motor2Rate: r.motor2Rate,
      deashi: r.deashi, nobi: r.nobi, by: String(by || '').slice(0, 12), src, updatedAt: at,
    }));
  }
  return redisRaw(args, 8000);
}

// 公式ページからの取り込み。dryRun=1 なら保存せず結果だけ返す。
// debug=1 で表の生の行も返す（構造が変わって読めなくなったときの調査用）
app.all('/api/motors/fetch', async (req, res) => {
  const jcd = String(req.query.jcd || req.body?.jcd || '');
  if (!VENUES[jcd]) return res.status(400).json({ error: '無効な場コード' });
  const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
  const debug  = req.query.debug === '1';

  const got = await fetchMotorAssessment(jcd);
  if (!got.ok) return res.status(got.unsupported ? 400 : 502).json({ error: got.error, url: got.url, sources: Object.keys(MOTOR_SOURCES).map(k => `${k}=${VENUES[k]}`) });

  const base = {
    venue: VENUES[jcd], url: got.url, charset: got.charset,
    tableRows: got.lineCount, parsed: got.rows.length, skipped: got.errors.length,
  };
  if (debug) base.sample = got.lines.slice(0, 8);
  if (!got.rows.length) {
    return res.status(502).json({ ...base, error: '表として読み取れませんでした', hint: 'debug=1 を付けると読み取った行を確認できます', sample: got.lines.slice(0, 8) });
  }
  if (dryRun) return res.json({ ok: true, dryRun: true, ...base, rows: got.rows });

  const w = await saveMotorRows(jcd, got.rows, req.body?.by || '公式取得', 'official');
  if (!w.ok) return res.status(500).json({ ...base, error: '保存に失敗しました', detail: w.error || `HTTP ${w.status}` });
  res.json({ ok: true, ...base, saved: got.rows.length, rows: got.rows, shared: REDIS_ENABLED });
});

// 画像からの取り込み。表のスクリーンショットしか無い場合に使う。
// 読み取り結果は保存せず返すだけで、確認したうえで /api/motors/bulk に rows を渡して保存する。
// OCRは読み違えるので、人が目で確かめる手順を必ず挟む
const OCR_PROMPT = `この画像はボートレースのモーター評価表です。各行を読み取り、JSONのみで回答してください。

{"rows":[{"motorNo":23,"rate2":50.0,"grade":"A-","deashi":"▲","nobi":"○","racer":"藤原 駿(B2)","note":"短評をそのまま"}]}

- motorNo は「機番」列の数字。順位の列と取り違えないこと
- grade は「評価」列（SS/S/A+/A/A-/B+/B/B-/C/D のいずれか）
- deashi は「出足」列、nobi は「伸び」列の記号をそのまま（◎ ◉ ○ ▲ △ など）
- rate2 は「2連率」の数字（%は除く）
- note は「短評」列の文字。画像で切れている部分は無理に補わず、読める範囲だけ
- 読み取れない行は含めないこと。推測で埋めないこと`;

app.post('/api/motors/ocr', async (req, res) => {
  const { jcd, images } = req.body || {};
  if (!jcd || !VENUES[jcd]) return res.status(400).json({ error: '無効な場コード' });
  const list = Array.isArray(images) ? images : (images ? [images] : []);
  if (!list.length) return res.status(400).json({ error: '画像が必要です' });
  if (list.length > 4) return res.status(400).json({ error: '画像は4枚までです' });

  // data URL から MIME と base64 を取り出す
  const parts = [{ text: OCR_PROMPT }];
  let bytes = 0;
  for (const img of list) {
    const m = String(img || '').match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: '画像の形式が不正です（PNG/JPEG/WEBP）' });
    bytes += m[2].length * 3 / 4;
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  if (bytes > 3.5 * 1024 * 1024) return res.status(400).json({ error: '画像が大きすぎます。枚数を減らすか縮小してください' });

  const g = await callGemini(parts, 40000);
  if (!g.ok) return res.status(g.status || 500).json(g.body || { error: '画像の読み取りに失敗しました' });

  let raw;
  try { raw = JSON.parse(g.jsonText); } catch { return res.status(500).json({ error: '読み取り結果を解析できませんでした' }); }
  const src = Array.isArray(raw) ? raw : (raw.rows || []);
  const rows = [], skipped = [];
  const seen = new Set();
  for (const r of src) {
    const v = normalizeMotorRow(r);
    if (!v) { skipped.push(JSON.stringify(r).slice(0, 60)); continue; }
    if (seen.has(v.motorNo)) continue;   // 同じ機番が複数枚に写っていれば先勝ち
    seen.add(v.motorNo);
    rows.push(v);
  }
  if (!rows.length) return res.status(400).json({ error: '表として読み取れませんでした', hint: '表がはっきり写っている画像にしてください', errors: skipped.slice(0, 5) });
  res.json({ ok: true, venue: VENUES[jcd], parsed: rows.length, rows, skipped: skipped.length, model: g.model, images: list.length });
});

// 貼り付け一括取り込み。dryRun=true なら保存せず解析結果だけ返す
app.post('/api/motors/bulk', async (req, res) => {
  const { jcd, text, rows: given, dryRun, by } = req.body || {};
  if (!jcd || !VENUES[jcd]) return res.status(400).json({ error: '無効な場コード' });
  // text（貼り付け）か rows（画像読み取り後に確認済み）のどちらかを受け取る
  if (!Array.isArray(given)) {
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text または rows が必要です' });
    if (text.length > 60000) return res.status(400).json({ error: 'テキストが長すぎます' });
  } else if (given.length > 200) {
    return res.status(400).json({ error: 'rows が多すぎます' });
  }

  const { rows, errors } = Array.isArray(given)
    ? (() => {
        const ok = [], ng = [];
        for (const r of given) { const v = normalizeMotorRow(r); if (v) ok.push(v); else ng.push(JSON.stringify(r).slice(0, 60)); }
        return { rows: ok, errors: ng };
      })()
    : parseMotorTable(text);
  if (!rows.length) {
    return res.status(400).json({ error: '表として読み取れませんでした', hint: '表をそのまま選択してコピーし、貼り付けてください', errors: errors.slice(0, 5) });
  }
  if (dryRun) return res.json({ ok: true, dryRun: true, venue: VENUES[jcd], parsed: rows.length, rows, skipped: errors.length, errors: errors.slice(0, 5) });

  try {
    const r = await saveMotorRows(jcd, rows, by, Array.isArray(given) ? 'image' : 'paste');
    if (!r.ok) return res.status(500).json({ error: '保存に失敗しました', detail: r.error || `HTTP ${r.status}`, shared: REDIS_ENABLED });
    res.json({ ok: true, venue: VENUES[jcd], saved: rows.length, skipped: errors.length, errors: errors.slice(0, 5), shared: REDIS_ENABLED });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/motors', async (req, res) => {
  const { jcd, motorNo, grade, note, racerName, motor2Rate, by } = req.body;
  if (!jcd || !motorNo) return res.status(400).json({ error: 'jcd and motorNo required' });
  if (grade && !['S','A','B','C','D'].includes(grade)) return res.status(400).json({ error: '無効なグレード' });
  try {
    const val = JSON.stringify({ grade: grade || '', note: String(note || '').slice(0, 200), racerName: String(racerName || '').slice(0, 50), motor2Rate: motor2Rate || null, by: String(by || '').slice(0, 12), updatedAt: new Date().toISOString() });
    await redisCmd('HSET', `motors:${jcd}`, String(motorNo), val);
    // shared=false は Redis 未設定（ローカル環境など）で共有保存されなかったことを示す
    res.json({ ok: true, shared: REDIS_ENABLED });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/motors', async (req, res) => {
  const { jcd, motorNo } = req.body;
  if (!jcd || !motorNo) return res.status(400).json({ error: 'jcd and motorNo required' });
  try {
    await redisCmd('HDEL', `motors:${jcd}`, String(motorNo));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/all', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });

  const ck = `${jcd}_${hd}_${rno}`;
  const hit = raceCache.get(ck);
  if (hit && Date.now() < hit.exp) return res.json(hit.data);

  try {
    const q = `jcd=${jcd}&hd=${hd}&rno=${rno}`;
    // すべて並列・単発取得にして所要時間を最長1本ぶん(18秒)に抑える。
    // fetchParsedOdds は複数URLを順に試すため最大40秒かかり、
    // フロント側の35秒タイムアウトに間に合わないことがあった。
    // 単勝オッズのURLは2種あるので、順に試さず両方を並列で投げて取れた方を使う
    const [rlH, o1H, o1Halt, beforeH] = await Promise.all([
      fetchQuick(`${BASE}/racelist?${q}`, 18000),
      fetchQuick(`${BASE}/oddstf?${q}`, 8000),
      fetchQuick(`${BASE}/odds1t?${q}`, 8000),
      fetchQuick(`${BASE}/beforeinfo?${q}`, 18000),
    ]);
    const rl = rlH ? parseRacelist(rlH, jcd, hd, rno) : null;
    if (!rl || rl.racers.length === 0) return res.status(404).json({ error: '出走データがありません。開催日・場コードを確認してください。平和島=04 / 芦屋=21' });
    let odds = { odds: {} };
    for (const h of [o1H, o1Halt]) {
      if (!h) continue;
      const p = parseOdds1t(h);
      if (Object.keys(p.odds).length) { odds = p; break; }
    }
    const before = beforeH ? parseBeforeinfo(beforeH) : { weather: {}, exhibit: {} };
    rl.racers = rl.racers.map(r => ({ ...r,
      odds: odds.odds[r.lane] || null,
      exhibitTime: before.exhibit[r.lane]?.exhibitTime || null,
      exhibitST:   before.exhibit[r.lane]?.st || null,
      course:      before.exhibit[r.lane]?.course || r.lane,
    }));
    const responseData = { ...rl, weather: before.weather };
    for (const [k, v] of raceCache) if (Date.now() >= v.exp) raceCache.delete(k);
    raceCache.set(ck, { data: responseData, exp: Date.now() + 120000 });
    res.json(responseData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ping-boatrace', async (req, res) => {
  const timeout = parseInt(req.query.timeout) || 20000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const start = Date.now();
    const r = await fetch(`${BASE}/racelist?jcd=04&hd=20260520&rno=1`, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    clearTimeout(timer);
    res.json({ status: r.status, ok: r.ok, reachable: true, ms: Date.now() - start });
  } catch (e) {
    res.json({ reachable: false, error: e.message, timeout_ms: timeout });
  }
});

app.get('/api/debug', async (req, res) => {
  const { jcd = '21', hd = '20260519', rno = '1' } = req.query;
  try {
    const html = await fetchHtml(`${BASE}/racelist?jcd=${jcd}&hd=${hd}&rno=${rno}`);
    if (!html) return res.json({ error: 'HTMLが取得できませんでした' });

    const $ = cheerio.load(html);

    const result = {
      title: $('title').text(),
      h3_texts: $('h3').map((_, el) => $(el).text().trim()).get(),
      tbody_count: $('tbody').length,
      tbody_classes: $('tbody').map((_, el) => $(el).attr('class') || 'no-class').get(),
      tr_classes_sample: $('tr').slice(0, 20).map((_, el) => ({
        class: $(el).attr('class') || 'no-class',
        td_count: $(el).find('td').length,
        first_td: $(el).find('td').first().text().trim().slice(0, 30)
      })).get(),
      lane_rows: [],
    };

    $('tr').each((_, tr) => {
      const firstTd = $(tr).find('td').first().text().trim();
      if (['1','2','3','4','5','6'].includes(firstTd)) {
        result.lane_rows.push({
          tr_class: $(tr).attr('class') || 'no-class',
          tbody_class: $(tr).closest('tbody').attr('class') || 'no-class',
          td_count: $(tr).find('td').length,
          td_texts: $(tr).find('td').slice(0, 8).map((_, td) => $(td).text().replace(/\s+/g,' ').trim().slice(0, 40)).get()
        });
      }
    });

    // tbody.is-fs12 の最初のtr（td_count多い行）の全セルを確認
    result.main_rows = [];
    $('tbody.is-fs12').each((i, tbody) => {
      const firstTr = $('tr', tbody).first();
      result.main_rows.push({
        tbody_index: i,
        tr_class: firstTr.attr('class') || 'no-class',
        td_count: firstTr.find('td').length,
        all_tds: firstTr.find('td').map((_, td) => $(td).text().replace(/\s+/g,' ').trim().slice(0, 50)).get()
      });
    });

    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// 利用可能モデル一覧（診断用）
app.get('/api/list-models', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY未設定' });
  try {
    const r = await fetch(`${ORIGIN_GEMINI}/models`, { headers: { 'x-goog-api-key': GEMINI_API_KEY } });
    const d = await r.json();
    const names = (d.models || []).map(m => m.name);
    res.json({ models: names, raw_error: d.error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug-before', async (req, res) => {
  const { jcd = '04', hd, rno = '1' } = req.query;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const date = hd || today;
  try {
    const html = await fetchHtml(`${BASE}/beforeinfo?jcd=${jcd}&hd=${date}&rno=${rno}`);
    if (!html) return res.json({ error: 'HTML取得失敗' });
    const $ = cheerio.load(html);
    const rows = [];
    $('tr').each((_, tr) => {
      const cells = $(tr).find('td');
      if (!cells.length) return;
      const first = cells.first().text().trim();
      if (['1','2','3','4','5','6'].includes(first)) {
        rows.push({ cellCount: cells.length, cells: cells.map((_,td) => $(td).text().replace(/\s+/g,' ').trim().slice(0,20)).get().slice(0,7) });
      }
    });
    const parsed = parseBeforeinfo(html);
    res.json({ rows, parsed, htmlLen: html.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug-result', async (req, res) => {
  const { jcd = '04', hd, rno = '1' } = req.query;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const date = hd || today;
  try {
    const html = await fetchHtml(`${BASE}/raceresult?jcd=${jcd}&hd=${date}&rno=${rno}`);
    if (!html) return res.json({ error: 'HTML取得失敗' });
    const $ = cheerio.load(html);
    const rows = [];
    $('tr').each((_, tr) => {
      const cells = $(tr).find('td');
      if (!cells.length) return;
      rows.push({
        cellCount: cells.length,
        rowspan: cells.first().attr('rowspan') || null,
        cells: cells.map((_, td) => $(td).text().replace(/\s+/g, ' ').trim().slice(0, 25)).get().slice(0, 6),
      });
    });
    res.json({ rows: rows.slice(0, 40), parsed: parseRaceResult(html), htmlLen: html.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI診断: ブラウザで /api/ai-health を開くと全モデルの状態が分かる
app.get('/api/ai-health', async (req, res) => {
  if (!GEMINI_API_KEY) return res.json({ ok: false, cause: 'GEMINI_API_KEY未設定', fix: 'Vercelの環境変数にGEMINI_API_KEYを設定してください' });
  const models = [];
  for (const model of PREDICT_MODELS) {
    try {
      const generationConfig = { maxOutputTokens: 50, responseMimeType: 'application/json' };
      if (model.startsWith('gemini-2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(`${ORIGIN_GEMINI}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: '{"ok":true} とだけJSONで回答してください' }] }],
          generationConfig,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const d = await r.json();
      if (d.error) {
        const msg = d.error.message || '';
        let cause = 'その他のエラー';
        if (/api key|API_KEY/i.test(msg)) cause = 'APIキーが無効';
        else if (/quota/i.test(msg)) {
          const m = msg.match(/retry in ([\d.]+)s/i);
          const sec = m ? Math.ceil(parseFloat(m[1])) : 0;
          cause = (sec > 300 || /per day|PerDay/i.test(msg)) ? '1日の無料枠を使い切り' : '1分あたりの無料枠上限';
        }
        else if (/high demand|overloaded|try again later/i.test(msg)) cause = 'モデルが一時的に混雑（時間をおけば解消）';
        models.push({ model, ok: false, cause, geminiError: msg.slice(0, 200) });
      } else {
        models.push({ model, ok: true });
      }
    } catch (e) {
      models.push({ model, ok: false, cause: '接続エラー', detail: e.message });
    }
  }
  const anyOk = models.some(m => m.ok);
  res.json({
    ok: anyOk,
    message: anyOk ? '利用可能なモデルがあります。AI予想は動作するはずです' : '全モデルが利用不可です',
    fix: anyOk ? undefined : 'APIキー無効ならVercelの環境変数を更新。無料枠切れなら夕方のリセット待ちか従量課金の有効化',
    models,
  });
});

// 共有予想の検索（メモリ→Redis）。見つからなければ null
async function lookupSharedPredict(cacheKey) {
  const hit = predictCache.get(cacheKey);
  if (hit && Date.now() < hit.exp) return hit.data;
  const shared = await redisCmd('GET', `predict:${cacheKey}`);
  if (shared) {
    try {
      const data = JSON.parse(shared);
      predictCache.set(cacheKey, { data, exp: Date.now() + 3600000 });
      return data;
    } catch {}
  }
  return null;
}

// 共有予想の読み取り専用API: 他ユーザーが生成済みの予想があれば返す（Gemini APIは消費しない）
app.get('/api/predict-shared', async (req, res) => {
  const key = req.query.key;
  if (!key || typeof key !== 'string' || key.length > 200) return res.status(400).json({ error: 'key required' });
  try {
    const data = await lookupSharedPredict(key);
    if (data) return res.json({ found: true, ...data, cached: true });
    res.json({ found: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Gemini呼び出し（モデル自動フォールバック付き）
// 成功: { ok:true, jsonText, model } / 失敗: { ok:false, status, body }
// budgetMs は全モデル試行の合計上限（Vercelの30秒制限内に収めるため）
// prompt には文字列のほか、画像を含む parts 配列（Gemini の contents.parts）も渡せる
async function callGemini(prompt, budgetMs = 26000) {
  if (!GEMINI_API_KEY) {
    return { ok: false, status: 500, body: { error: 'サーバーに GEMINI_API_KEY が設定されていません' } };
  }
  try {
    // モデルごとに無料枠が独立しているため、混雑時は別モデルへ自動フォールバック
    const deadline = Date.now() + budgetMs;
    let lastQuota = null;
    let lastTransient = false;
    for (const model of PREDICT_MODELS) {
      const budget = deadline - Date.now();
      if (budget < 3000) { lastTransient = true; break; }
      const url = `${ORIGIN_GEMINI}/models/${model}:generateContent`;
      const generationConfig = {
        // 確率の見積もりに使うので低めにする。0.7だと同じレースでも実行ごとに p がぶれ、
        // 期待値の選定にノイズが乗る
        temperature: 0.2,
        maxOutputTokens: 4096, // 候補20点前後+シナリオ2本。少なすぎるとJSONが途中で切れて全滅する
        responseMimeType: 'application/json',
      };
      // thinkingConfig は 2.5系のみ対応（2.0系に送ると400エラー）
      if (model.startsWith('gemini-2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(20000, budget));
      let response, data;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }],
            generationConfig,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        data = await response.json();
      } catch (e) {
        clearTimeout(timer);
        // タイムアウトは一時的な問題として次のモデルへ
        if (e.name === 'AbortError') { lastTransient = true; continue; }
        throw e;
      }

      if (data.error) {
        const msg = data.error.message || '';
        // 無料枠のレート制限: 次のモデルで再挑戦
        if (response.status === 429 || data.error.status === 'RESOURCE_EXHAUSTED' || /quota/i.test(msg)) {
          const m = msg.match(/retry in ([\d.]+)s/i);
          const retryAfter = m ? Math.ceil(parseFloat(m[1])) : 60;
          const daily = retryAfter > 300 || /per day|PerDay/i.test(msg);
          lastQuota = { retryAfter, daily };
          continue;
        }
        // 一時的な過負荷（503 / high demand / overloaded）も次のモデルへ
        if (response.status === 503 || data.error.status === 'UNAVAILABLE' || /high demand|overloaded|try again later/i.test(msg)) {
          lastTransient = true;
          continue;
        }
        // モデル廃止・未対応も次のモデルへ
        if (response.status === 404 || /not found|not supported/i.test(msg)) continue;
        if (/api key|API_KEY/i.test(msg)) {
          return { ok: false, status: 500, body: { error: 'Gemini APIキーが無効です。Vercelの環境変数 GEMINI_API_KEY に正しいキーが設定されているか確認してください' } };
        }
        return { ok: false, status: 500, body: { error: `Gemini: ${msg}` } };
      }

      const text = data.candidates?.[0]?.content?.parts
        ?.filter(p => !p.thought)
        .map(p => p.text || '').join('') || '';
      if (!text) return { ok: false, status: 500, body: { error: 'Geminiから空のレスポンスが返りました' } };
      // JSONとして壊れていたら {} の範囲を抽出して修復を試みる
      let jsonText = text;
      try {
        JSON.parse(jsonText);
      } catch {
        const jm = text.match(/\{[\s\S]*\}/);
        jsonText = null;
        if (jm) { try { JSON.parse(jm[0]); jsonText = jm[0]; } catch {} }
        if (!jsonText) {
          const reason = data.candidates?.[0]?.finishReason;
          return { ok: false, status: 500, body: {
            error: reason === 'MAX_TOKENS'
              ? 'AIの回答が途中で切れました。もう一度お試しください'
              : 'GeminiのレスポンスがJSON形式ではありません。もう一度お試しください',
          } };
        }
      }
      return { ok: true, jsonText, model };
    }
    // 全モデルが利用不可
    if (lastQuota) {
      return { ok: false, status: 429, body: {
        error: lastQuota.daily
          ? '本日のAI無料枠を使い切りました。日本時間の夕方頃にリセットされます。Google AI Studioで従量課金を有効にすると解消できます'
          : 'AI予想が混み合っています（無料APIの利用上限）',
        quota: true, daily: !!lastQuota.daily, retryAfter: lastQuota.retryAfter || 60,
      } };
    }
    if (lastTransient) {
      // Gemini側の一時過負荷: 少し待っての自動再試行をフロントに促す
      return { ok: false, status: 429, body: { error: 'AIモデルが一時的に混雑しています。しばらくすると自動で再試行します', quota: true, daily: false, retryAfter: 25 } };
    }
    return { ok: false, status: 500, body: { error: 'AIモデルにアクセスできませんでした。/api/ai-health で状態を確認してください' } };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Gemini APIがタイムアウトしました' : e.message;
    return { ok: false, status: 500, body: { error: msg } };
  }
}

// 生成結果を共有キャッシュ（メモリ60分 + Redis 60分）に保存。
// Redis への書き込みは await する。応答を返したあとの非同期処理は Vercel で
// 破棄されることがあり（getOpenVenues で実際に起きた）、共有予想が保存されない原因になる
async function storePredict(cacheKey, result) {
  if (!cacheKey) return;
  for (const [k, v] of predictCache) if (Date.now() >= v.exp) predictCache.delete(k);
  predictCache.set(cacheKey, { data: result, exp: Date.now() + 3600000 });
  await redisCmd('SET', `predict:${cacheKey}`, JSON.stringify(result), 'EX', '3600');
}

// AI予想エンドポイント（Gemini）
// プロンプト・キャッシュキー・オッズはすべてサーバーが組み立てる。
// 以前はアプリから受け取っていたが、それだと任意の文面を共有キャッシュに書き込めてしまい、
// BOTの投稿内容まで他人に差し替えられる余地があった
app.post('/api/predict', async (req, res) => {
  const b = req.body || {};
  if (b.prompt && !b.jcd) {
    return res.status(400).json({ error: 'アプリの更新が必要です。ページを再読み込みしてください' });
  }
  const jcd = String(b.jcd || '');
  const hd  = String(b.hd || '');
  const rno = parseInt(b.rno, 10);
  if (!VENUES[jcd])            return res.status(400).json({ error: '会場コードが不正です' });
  if (!/^\d{8}$/.test(hd))     return res.status(400).json({ error: '日付が不正です' });
  if (!(rno >= 1 && rno <= 12)) return res.status(400).json({ error: 'レース番号が不正です' });
  // 選択肢はアプリのセレクトボックス由来。改行や長文でプロンプトを乗っ取られないよう切り詰める
  const oneLine = v => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 20);
  const ff = parseInt(b.fixedFirst, 10);

  try {
    const got = await getOrCreatePrediction(jcd, hd, rno, 26000, {
      fixedFirst: (ff >= 1 && ff <= 6) ? ff : 0,
      wind: oneLine(b.wind),
      tide: oneLine(b.tide),
      by:   oneLine(b.by).slice(0, 12),
      exhibit: b.exhibit,
    });
    if (got.error) return res.status(got.status || 500).json(got.body || { error: got.error });
    res.json({ ...got.envelope, cached: !!got.cached, odds3t: got.odds3t || {} });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 買い目診断（自分で決めた3連単1点をAIに見てもらう）。
// こちらもプロンプトはサーバーで組み立てる
app.post('/api/advise', async (req, res) => {
  const b = req.body || {};
  const jcd = String(b.jcd || '');
  const hd  = String(b.hd || '');
  const rno = parseInt(b.rno, 10);
  const combo = normTrifecta(b.combo);
  if (!VENUES[jcd])             return res.status(400).json({ error: '会場コードが不正です' });
  if (!/^\d{8}$/.test(hd))      return res.status(400).json({ error: '日付が不正です' });
  if (!(rno >= 1 && rno <= 12)) return res.status(400).json({ error: 'レース番号が不正です' });
  if (!combo)                   return res.status(400).json({ error: '買い目が不正です' });

  const cacheKey = `pick_${jcd}_${hd}_${rno}_${combo}`;
  try {
    const hit = await lookupSharedPredict(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });

    const q = `jcd=${jcd}&hd=${hd}&rno=${rno}`;
    const [rlH, beforeH, o1H] = await Promise.all([
      fetchQuick(`${BASE}/racelist?${q}`, 15000),
      fetchQuick(`${BASE}/beforeinfo?${q}`, 12000),
      fetchQuick(`${BASE}/oddstf?${q}`, 8000),
    ]);
    const rl = rlH ? parseRacelist(rlH, jcd, hd, rno) : null;
    if (!rl || !rl.racers.length) return res.status(502).json({ error: '出走データを取得できませんでした' });
    const before = beforeH ? parseBeforeinfo(beforeH) : { weather: {}, exhibit: {} };
    const odds1  = o1H ? (parseOdds1t(o1H).odds || {}) : {};
    let motors = {};
    try {
      const raw = await redisCmd('HGETALL', `motors:${jcd}`);
      if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) { try { motors[raw[i]] = JSON.parse(raw[i + 1]); } catch {} }
    } catch {}

    const lines = rl.racers.map(r => {
      const ex = before.exhibit[r.lane] || {};
      const o  = odds1[r.lane];
      return `${r.lane}号艇:${r.name || '不明'}(${r.cls || '—'}) 全国${r.allRate || 0}/当地${r.localRate || 0} ` +
        `単勝${o != null ? o.toFixed(1) + '倍' : '不明'} モーター:${motors[r.motorNo]?.grade || '未評価'} ` +
        `展示:${ex.exhibitTime ?? '?'} ST:${ex.st ?? '?'}`;
    }).join('\n');

    const prompt = `ボートレース専門予想師として、以下の買い目を分析してください。

【${VENUES[jcd]} 第${rno}レース】
【買い目】3連単 ${combo}

【出走データ】
${lines}

以下のJSON形式のみで回答：
{
  "verdict": "有力/ありえる/難しい のいずれか",
  "verdict_reason": "50文字以内の判定理由",
  "strengths": "この買い目の強み（60文字以内）",
  "risks": "この買い目のリスク（60文字以内）",
  "advice": "購入前に確認すべきポイント（80文字以内）",
  "expected_odds": "推定オッズ帯（例：10〜30倍）"
}`;

    const g = await callGemini(prompt, 26000);
    if (!g.ok) return res.status(g.status).json(g.body);
    const result = { content: [{ text: g.jsonText }], model: g.model, at: new Date().toISOString(), by: '' };
    await storePredict(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ======================== X (Twitter) AUTO POST ======================== */
// 環境変数への貼り付け時に改行や空白が混入すると署名が壊れて401になるため trim する
const X_API_KEY       = cleanEnv(process.env.X_API_KEY);
const X_API_SECRET    = cleanEnv(process.env.X_API_SECRET);
const X_ACCESS_TOKEN  = cleanEnv(process.env.X_ACCESS_TOKEN);
const X_ACCESS_SECRET = cleanEnv(process.env.X_ACCESS_SECRET);
const CRON_SECRET     = cleanEnv(process.env.CRON_SECRET);
const X_ENABLED = !!(X_API_KEY && X_API_SECRET && X_ACCESS_TOKEN && X_ACCESS_SECRET);

// RFC3986 パーセントエンコード（OAuth署名は encodeURIComponent より厳格）
function pctEnc(s) {
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// OAuth 1.0a (HMAC-SHA1) 署名値の計算（RFC 5849）。allParams には oauth_* とクエリを全て含める
function oauth1Signature(method, url, allParams, consumerSecret, tokenSecret) {
  const paramStr = Object.keys(allParams).sort().map(k => `${pctEnc(k)}=${pctEnc(allParams[k])}`).join('&');
  const base = [method.toUpperCase(), pctEnc(url), pctEnc(paramStr)].join('&');
  const key = `${pctEnc(consumerSecret)}&${pctEnc(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

// Authorization ヘッダを生成。
// X API v2 の POST /2/tweets は JSON ボディを署名に含めない（クエリパラメータのみ）
function oauth1Header(method, url, queryParams = {}) {
  const oauth = {
    oauth_consumer_key: X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  oauth.oauth_signature = oauth1Signature(method, url, { ...queryParams, ...oauth }, X_API_SECRET, X_ACCESS_SECRET);
  return 'OAuth ' + Object.keys(oauth).sort().map(k => `${pctEnc(k)}="${pctEnc(oauth[k])}"`).join(', ');
}

// Xの重み付き文字数（日本語などは2文字分。上限280）
function xLen(str) {
  let n = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    const light = (c <= 4351) || (c >= 8192 && c <= 8205) || (c >= 8208 && c <= 8223) || (c >= 8242 && c <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}

async function postToX(text) {
  if (!X_ENABLED) return { ok: false, error: 'X credentials not set' };
  const url = `${ORIGIN_X}/2/tweets`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': oauth1Header('POST', url) },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const raw = await r.text();
    let d = {};
    try { d = JSON.parse(raw); } catch {}
    if (!r.ok) {
      // 401: アプリ権限がRead onlyのまま、または権限変更後にアクセストークンを再発行していない
      // 402: X側の利用枠（クレジット）切れ。時間や課金プランの問題でコード側では解決できない
      const hint = r.status === 401
        ? 'Xアプリの権限をRead and writeにした上で、アクセストークンを再発行してVercelの環境変数を更新してください（/api/x-health で詳細確認）'
        : r.status === 402
        ? 'X APIの利用枠（クレジット）を使い切っています。X開発者ポータルで残量と契約プランを確認してください'
        : r.status === 429
        ? 'X APIのレート制限です。しばらく待つと解消します'
        : undefined;
      return { ok: false, status: r.status, error: d.detail || d.title || raw.slice(0, 300), hint };
    }
    return { ok: true, id: d.data?.id };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'X APIタイムアウト' : e.message };
  }
}

// 診断: X認証情報の状態と、読み取りAPIが通るかどうかを確認する。
// 読み取りが通るのに投稿が401なら書き込み権限の問題、読み取りも401なら認証情報自体の問題
app.get('/api/x-health', async (req, res) => {
  const fp = v => v ? { set: true, len: v.length } : { set: false };
  const env = {
    X_API_KEY: fp(X_API_KEY),
    X_API_SECRET: fp(X_API_SECRET),
    X_ACCESS_TOKEN: fp(X_ACCESS_TOKEN),
    X_ACCESS_SECRET: fp(X_ACCESS_SECRET),
    CRON_SECRET: fp(CRON_SECRET),
  };
  // アクセストークンは「数字-英数字」の形式。ここが崩れていれば貼り付けミス
  env.X_ACCESS_TOKEN.looksValid = /^\d+-[A-Za-z0-9]+$/.test(X_ACCESS_TOKEN);
  if (!X_ENABLED) {
    return res.json({ ok: false, cause: 'X認証情報が未設定', fix: 'Vercelの環境変数に4つすべて設定して再デプロイしてください', env });
  }
  const url = `${ORIGIN_X}/2/users/me`;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch(url, { headers: { Authorization: oauth1Header('GET', url) }, signal: c.signal });
    clearTimeout(t);
    const raw = await r.text();
    let d = {};
    try { d = JSON.parse(raw); } catch {}
    if (r.ok) {
      return res.json({
        ok: true,
        message: '認証情報は有効です。投稿が401なら書き込み権限の問題です',
        account: d.data ? `@${d.data.username}` : null,
        fix: 'X開発者ポータルでApp permissionsをRead and writeにし、アクセストークンを再発行してVercelを更新',
        env,
      });
    }
    return res.json({
      ok: false,
      status: r.status,
      cause: r.status === 401 ? '認証情報が無効（キーの取り違え・貼り付けミス・再発行が必要）' : 'X APIエラー',
      xResponse: raw.slice(0, 300),
      env,
    });
  } catch (e) {
    res.json({ ok: false, cause: '接続エラー', detail: e.message, env });
  }
});

// 自動投稿用の予想プロンプト（フロントと同じJSONスキーマ＝生成結果をアプリでもそのまま共有できる）
// ===== 期待値ベースの買い目選定 =====
// 「オッズが安い＝人気＝当たりやすい」で選ぶと、控除率25%のぶんだけ必ず負ける。
// AIには人気を見せずに各組の的中確率だけを見積もらせ、実際のオッズと突き合わせて
// 期待値（確率×オッズ）が1.0を超える買い目だけを採用する。
const EV_MIN_MAIN  = 1.05;   // 本線に採用する最低期待値
const EV_MIN_ANA   = 1.20;   // 穴は当たりが薄くブレるので高めに要求する
const ANA_MIN_ODDS = 30;     // これ以上を穴として扱う
// 買い目は多いほど期待値の合計は増えるが、読み手が実際に買える点数でないと意味がない。
// 「点数が多い」という指摘を受けて、期待値の高い順に本線4点・穴2点の計6点(¥600)までに絞る
const MAX_MAIN     = 4;      // 本線の最大点数
const MAX_ANA      = 2;      // 穴の最大点数
const EXHIBIT_GRACE_LEAD = 25;   // 締切がこれ以内なら展示が無くても投稿する（分）
const RESULT_WAIT_MIN    = 60;   // 締切からこれだけ経った未確定は待たずに投稿する（分）
const SKIP_POST_CAP      = 2;    // 1日に投稿する「見送り」の上限（買い目の投稿枠とは別勘定）
const EV_SUM_LIMIT = 150;    // 確率の合計がこれを超える出力は見積もり自体を信用しない

// ホーム場。開催していればこの場のレースを優先して投稿する。
// URLに &home=04,21 を付けて一時的に変えられる（&home=none で優先なし）
const HOME_JCDS = ['04'];    // 04=平和島

// 両プロンプト（BOT側・アプリ側）で同じ出力形式にする。
// 共有キャッシュを双方で使い回すため、形式がずれると片方が壊れる
const EV_PROMPT_RULES = `【重要・予想の方針】
オッズ（市場の人気）はこのプロンプトでは渡しません。人気は他人の予想であって的中確率の根拠ではなく、
人気順に買うと控除率25%のぶんだけ回収率が必ず100%を下回ります。
あなたの仕事は「当てにいく買い目を選ぶこと」ではなく、選手・モーター・展示・コース・気象から
各組の的中確率を正直に見積もることです。サーバー側でその確率と実際のオッズを突き合わせ、
期待値（確率×オッズ）が1.0を超える組だけを買い目として採用します。
的中確率を高く見せようとして人気サイドに寄せる必要はありません。薄いと思う組は薄いままにしてください。

以下のJSON形式のみで回答（バッククォート不要）:
{
  "analysis": "280文字以内の総合分析",
  "tenkai_main": "最有力の展開シナリオ130文字以内。どの艇がどう決まるのが本線か具体的に",
  "tenkai_ana": "波乱の展開シナリオ130文字以内。何が起きれば高配当になるか具体的に",
  "wind_effect": "90文字以内",
  "tide_effect": "90文字以内",
  "motor_comment": "80文字以内",
  "focus": "注目艇番号（数字のみ）",
  "focus_reason": "80文字以内",
  "cands": [{"c":"1-2-3","p":18},{"c":"1-3-2","p":9}]
}
candsは3連単の候補を18〜24組。cは "艇番-艇番-艇番" 形式、pは的中確率(%)の見積もり（小数可）。
3連単の各組は同時に起こらないので、pの合計は100を超えないこと。
p が 1 未満になるほど薄い組は入れないこと。同じ組を重複させないこと。
堅い組だけを並べず、条件から見て起こりうる波乱の組も確率相応の p で入れること。`;

// 取り込んだモーター評価（評価・出足・伸び・短評）をプロンプト1行ぶんに整える。
// 評価が無いモーターは公式の2連率だけを渡す
function motorLine(r) {
  const mi = r.motorInfo || {};
  const parts = [`${r.motorGrade || '未評価'}(2連${r.motor2Rate || 0}%)`];
  if (mi.deashi) parts.push(`出足${mi.deashi}`);
  if (mi.nobi)   parts.push(`伸び${mi.nobi}`);
  if (mi.note)   parts.push(`短評:${String(mi.note).slice(0, 70)}`);
  return parts.join(' ');
}

// opts: { fixedFirst, wind, tide } — アプリから1着固定や風向・潮位の指定があれば足す。
// プロンプト本体はサーバーだけが組み立てる（アプリから文面を受け取ると共有キャッシュを汚せるため）
function buildAutoPrompt(venue, rno, racers, weather, opts = {}) {
  const lines = racers.map(r =>
    `${r.lane}号艇:${r.name || '不明'}(${r.cls || '—'}/${r.branch || '—'}) ` +
    `全国${r.allRate || 0}/当地${r.localRate || 0}/2連${r.all2Rate || 0}% F/L:${r.fl || '0/0'} avgST:${r.avgST || 0.18} ` +
    `モーター:${motorLine(r)} ` +
    `コース:${r.course ?? '未定'} 展示:${r.exhibitTime || '不明'} 展示ST:${r.exhibitST || '不明'}`
  ).join('\n');

  const sel = (opts.wind || opts.tide)
    ? `\n選択条件 — 風向:${opts.wind || '指定なし'} / 潮位:${opts.tide || '指定なし'}` : '';
  const fix = opts.fixedFirst
    ? `\n【1着固定】${opts.fixedFirst}号艇を1着に固定。candsは全て${opts.fixedFirst}-?-? の形式にすること。` : '';

  // 進入コース（スタート展示で確定）と風向は展開を最も左右する。
  // 取れているのに渡さないと、展示待ちをした意味が半分無くなる
  return `ボートレース専門予想師として以下の最新データを分析し、JSON形式のみで回答してください。

【${venue} 第${rno}レース】
天候:${weather.sky || '不明'} 風向:${weather.windDir || '不明'} 風速:${weather.wind ?? '不明'}m/s 水温:${weather.water ?? '不明'}℃ 波高:${weather.wave ?? '不明'}cm
（コースは展示で確定した進入。「未定」は枠なり想定）${sel}${fix}

【出走表（boatrace.jp 実データ）】
${lines}

${EV_PROMPT_RULES}`;
}

// AIの確率見積もりと実オッズから買い目を決める。
// pred を書き換えて返す（matoi / ana / main_conf / ana_conf / ev_* を設定）
function applyEV(pred, odds3t) {
  const odds = odds3t && typeof odds3t === 'object' && Object.keys(odds3t).length ? odds3t : null;

  // 候補の正規化。表記ゆれ・重複・壊れた確率を落とす
  const rows = [];
  for (const c of Array.isArray(pred.cands) ? pred.cands : []) {
    const combo = normTrifecta(c && (c.c ?? c.combo));
    const p = Number(c && (c.p ?? c.prob));
    if (!combo || !isFinite(p) || p <= 0) continue;
    if (rows.some(r => r.combo === combo)) continue;
    rows.push({ combo, p });
  }

  // 候補が無い（旧形式のキャッシュや生成失敗）ときは従来の matoi / ana をそのまま使う
  if (!rows.length) {
    pred.ev_mode = 'none';
    return pred;
  }

  // 3連単の各組は排反なので確率の合計は100%を超えない。
  // 超えていたらAIが確率を盛っているので、比率を保って縮める（期待値の水増しを防ぐ）
  const sum = rows.reduce((s, r) => s + r.p, 0);
  const k = sum > 100 ? 100 / sum : 1;
  for (const r of rows) {
    r.p = r.p * k;
    r.odds = odds ? (odds[r.combo] ?? null) : null;
    r.ev = r.odds ? r.p / 100 * r.odds : null;
  }
  pred.ev_scaled = k < 1 ? Math.round(sum) : undefined;

  const byP  = (a, b) => b.p - a.p;
  const byEV = (a, b) => b.ev - a.ev;
  // 合計が100%を大きく超える出力は確率の見積もり自体が信用できない。
  // 縮めれば数字は整うが、それで出した期待値を根拠にするのは誠実ではないので、
  // 期待値は名乗らず確率順に並べるだけにする
  const unreliable = sum > EV_SUM_LIMIT;
  const usable = unreliable ? [] : rows.filter(r => r.ev != null);

  let main, ana;
  if (usable.length) {
    // 期待値が基準を超えた買い目だけを採用する。
    // そのうち当たりやすい順に本線、残りの高配当 side を穴として足す
    const qual = usable.filter(r => r.ev >= EV_MIN_MAIN);
    // 期待値で絞ったうえで、そのなかで当たりやすい順に本線を採る。
    // 期待値順で採ると本線が最も人気薄の並びばかりになり、穴との区別がなくなるため
    main = qual.slice().sort(byP).slice(0, MAX_MAIN);
    const inMain = new Set(main.map(r => r.combo));
    ana = qual.filter(r => !inMain.has(r.combo) && r.odds >= ANA_MIN_ODDS && r.ev >= EV_MIN_ANA)
              .sort(byEV).slice(0, MAX_ANA);
    pred.ev_mode = 'ev';
  } else {
    // オッズが取れなかった / 確率が信用できないときは期待値を出せない。
    // 確率順に並べるだけにとどめ、期待値は表示しない
    const sorted = rows.slice().sort(byP);
    main = sorted.slice(0, MAX_MAIN);
    ana  = sorted.slice(MAX_MAIN, MAX_MAIN + MAX_ANA);
    pred.ev_mode = unreliable ? 'unreliable' : 'noodds';
  }

  // 期待値（1点100円あたりの期待回収）と的中確率を、選んだ買い目から実際に計算する
  const stats = list => {
    if (!list.length) return { conf: 0, ev: null };
    const conf = Math.round(list.reduce((s, r) => s + r.p, 0));
    const haveOdds = list.every(r => r.ev != null);
    return { conf, ev: haveOdds ? +(list.reduce((s, r) => s + r.ev, 0) / list.length).toFixed(2) : null };
  };
  const sm = stats(main), sa = stats(ana);

  pred.matoi = main.map(r => r.combo);
  pred.ana   = ana.map(r => r.combo);
  pred.main_conf = sm.conf;
  pred.ana_conf  = sa.conf;
  pred.ev_main = pred.ev_mode === 'ev' ? sm.ev : null;
  pred.ev_ana  = pred.ev_mode === 'ev' ? sa.ev : null;
  // 期待値1.0超えが1点も無いレースは「見送り」を出す。
  // 無理に買い目を出すことが回収率を下げるいちばんの原因なので、ここは正直に返す
  pred.ev_skip = pred.ev_mode === 'ev' && !main.length && !ana.length;
  pred.ev_detail = rows.filter(r => r.ev != null)
    .sort(byEV).slice(0, 24)
    .map(r => ({ c: r.combo, p: +r.p.toFixed(1), o: r.odds, ev: +r.ev.toFixed(2) }));
  return pred;
}

// 1レース分のデータを集めて予想を取得（共有キャッシュ優先・なければ生成して共有キャッシュに保存）
async function getOrCreatePrediction(jcd, hd, rno, budgetMs, opts = {}) {
  const venue = VENUES[jcd] || '';
  const q = `jcd=${jcd}&hd=${hd}&rno=${rno}`;
  // 4種を並列取得（所要時間は最も遅い1本ぶん）。
  // 開催ピーク時の boatrace.jp は10秒では返らないことがあるため、
  // 予想に必須の出走表・直前情報は長めに、無くても成立するオッズは短めにする
  const [rlH, beforeH, o1H, o3H] = await Promise.all([
    fetchQuick(`${BASE}/racelist?${q}`, 18000),
    fetchQuick(`${BASE}/beforeinfo?${q}`, 18000),
    fetchQuick(`${BASE}/oddstf?${q}`, 8000),
    fetchQuick(`${BASE}/odds3t?${q}`, 8000),
  ]);
  const rl = rlH ? parseRacelist(rlH, jcd, hd, rno) : null;
  if (!rl || !rl.racers.length) return { error: '出走データなし' };
  const before = beforeH ? parseBeforeinfo(beforeH) : { weather: {}, exhibit: {} };
  const odds1  = o1H ? (parseOdds1t(o1H).odds || {}) : {};
  const odds3t = o3H ? (parseOdds3t(o3H).odds || {}) : {};

  const hasEx = Object.keys(before.exhibit).length > 0;
  // 展示タイム・展示STが出る前に予想を出すと、いちばん効く直前情報が抜けたまま固定される。
  // 締切まで間があるうちは投稿せず、次の実行で展示が出てから出す（Geminiも消費しない）
  if (opts.needExhibit && !hasEx) return { wait: '展示情報がまだ出ていません' };

  // アプリで手入力した展示タイムは、公式にまだ出ていない枠にだけ補う。
  // この場合の結果はその人だけのものなので、共有キャッシュは読まず書かない
  const manual = {};
  if (opts.exhibit && typeof opts.exhibit === 'object') {
    for (let lane = 1; lane <= 6; lane++) {
      const m = opts.exhibit[lane] || opts.exhibit[String(lane)];
      if (!m || before.exhibit[lane]?.exhibitTime != null) continue;
      const t  = Number(m.exhibitTime), st = Number(m.st);
      const e = {};
      if (isFinite(t)  && t  >= 5 && t  <= 10) e.exhibitTime = +t.toFixed(2);
      if (isFinite(st) && st >= 0 && st <  2)  e.st          = +st.toFixed(2);
      if (Object.keys(e).length) manual[lane] = e;
    }
  }
  const usedManual = Object.keys(manual).length > 0;

  // v6: 進入コース・風向をプロンプトに加えたため、それ以前の予想は使い回さない
  const cacheKey = `v6_${jcd}_${hd}_${rno}_${opts.fixedFirst || 0}_ex${hasEx ? 1 : 0}`;
  const cached = usedManual ? null : await lookupSharedPredict(cacheKey);
  if (cached) {
    try { return { pred: JSON.parse(cached.content[0].text), venue, cached: true, envelope: cached, schedule: rl.schedule, odds3t }; } catch {}
  }

  // 共有モーター評価をマージ（みんなの評価をAIに渡す）
  let motors = {};
  try {
    const raw = await redisCmd('HGETALL', `motors:${jcd}`);
    if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) { try { motors[raw[i]] = JSON.parse(raw[i + 1]); } catch {} }
  } catch {}

  const racers = rl.racers.map(r => ({
    ...r,
    odds: odds1[r.lane] ?? null,
    exhibitTime: before.exhibit[r.lane]?.exhibitTime ?? manual[r.lane]?.exhibitTime ?? null,
    exhibitST: before.exhibit[r.lane]?.st ?? manual[r.lane]?.st ?? null,
    course: before.exhibit[r.lane]?.course ?? null,
    motorGrade: motors[r.motorNo]?.grade || '',
    motorInfo: motors[r.motorNo] || null,
  }));

  const prompt = buildAutoPrompt(venue, rno, racers, before.weather || {}, opts);
  const g = await callGemini(prompt, budgetMs);
  if (!g.ok) return { error: g.body?.error || '予想生成失敗', status: g.status, body: g.body };
  // 買い目はAIに選ばせず、AIの確率見積もりと実オッズの期待値で決める。
  // 確定後のJSONをキャッシュに入れるので、アプリ側も同じ買い目を見ることになる
  let pred;
  try { pred = applyEV(JSON.parse(g.jsonText), odds3t); }
  catch { return { error: '予想の解析に失敗' }; }
  const result = { content: [{ text: JSON.stringify(pred) }], model: g.model, at: new Date().toISOString(),
    by: opts.by === undefined ? 'AI BOT' : String(opts.by).slice(0, 12) };
  if (!usedManual) await storePredict(cacheKey, result);
  return { pred, venue, cached: false, envelope: result, schedule: rl.schedule, odds3t };
}

// 3連単の買い目表記を正規化する（全角や矢印など表記ゆれを 1-2-3 形式に揃える）。
// 3艇が重複する・6艇の範囲外など不正なものは null を返す
function normTrifecta(combo) {
  const s = String(combo ?? '')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－ｰー―‐‑–—→>]/g, '-');   // 全角ハイフンや矢印などの区切りを半角に揃える
  const m = s.match(/^\s*([1-6])\s*-\s*([1-6])\s*-\s*([1-6])\s*$/);
  if (!m) return null;
  const [, a, b, c] = m;
  if (a === b || b === c || a === c) return null;
  return `${a}-${b}-${c}`;
}

// 圧縮表記をもとの買い目に戻す（圧縮が正しいかを検証するために使う）
//   1-2-34 → 1-2-3, 1-2-4 ／ 1=2-3 → 1-2-3, 2-1-3
function expandTrifectaToken(token) {
  const m = String(token).match(/^([1-6])([-=])([1-6])-([1-6]+)$/);
  if (!m) return null;
  const [, a, sep, b, thirds] = m;
  const heads = sep === '=' ? [[a, b], [b, a]] : [[a, b]];
  const out = [];
  for (const [x, y] of heads) {
    for (const c of thirds) {
      if (c === x || c === y) return null;
      out.push(`${x}-${y}-${c}`);
    }
  }
  return out;
}

// 3連単の買い目をまとめて読みやすくする
//   1-2-3, 1-2-4 → 1-2-34（3着ちがいをまとめる）
//   1-2-3, 2-1-3 → 1=2-3 （1・2着の入れ替わり）
// 圧縮結果を展開し直してもとの買い目と一致しない場合は、
// 表記が買い目とずれる方が害が大きいので圧縮せずそのまま返す
function compressTrifecta(combos) {
  const raw = (combos || []).map(c => String(c).trim()).filter(Boolean);
  const list = [];
  for (const c of raw) {
    const t = normTrifecta(c);
    if (!t) return raw;                       // 想定外の表記が混ざるなら触らない
    if (!list.includes(t)) list.push(t);
  }
  if (!list.length) return raw;

  // 1着・2着が同じものをまとめ、3着を並べる
  const groups = new Map();
  for (const t of list) {
    const [a, b, c] = t.split('-');
    const k = `${a}-${b}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  // 1着・2着が入れ替わった組で3着が揃っているなら a=b にまとめる
  const out = [];
  const used = new Set();
  for (const [k, thirds] of groups) {
    if (used.has(k)) continue;
    used.add(k);
    const [a, b] = k.split('-');
    const sorted = [...thirds].sort().join('');
    const rk = `${b}-${a}`;
    const rev = groups.get(rk);
    if (rev && !used.has(rk) && [...rev].sort().join('') === sorted) {
      used.add(rk);
      out.push(`${a}=${b}-${sorted}`);
    } else {
      out.push(`${a}-${b}-${sorted}`);
    }
  }

  // 展開し直して一致を確認する
  const back = [];
  for (const tok of out) {
    const ex = expandTrifectaToken(tok);
    if (!ex) return raw;
    back.push(...ex);
  }
  const key = arr => [...new Set(arr)].sort().join(',');
  if (key(back) !== key(list)) return raw;
  return out;
}

// レース予想のツイート本文。
// 返り値の matoi / ana は「実際に本文へ載せた買い目」で、結果まとめの的中判定は
// これを使う。投稿していない買い目で的中と書いてしまうのを防ぐため
function buildRaceTweet(venue, rno, closeTime, pred) {
  // AIの出力には表記ゆれや重複が混ざることがある。1-2-3 形式に揃えて重複を除く。
  // 3連単として成立しないもの（艇番の重複や桁不足）は買えないので落とす。
  // ただし全部が想定外の形式なら、勝手に消さずそのまま載せる
  const clean = arr => {
    const raw = (arr || []).map(v => String(v).trim()).filter(Boolean);
    const seen = new Set(), out = [];
    for (const c of raw) {
      const k = normTrifecta(c);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out.length ? out : raw;
  };
  const allM = clean(pred.matoi);
  const allA = clean(pred.ana);
  const mc = parseInt(pred.main_conf) || 0;
  const ac = parseInt(pred.ana_conf) || 0;
  const tail = `\n#競艇 #ボートレース #${venue}`;
  // 期待値（1点100円あたりの期待回収）を見出しに出す。
  // 「人気だから買う」ではなく「期待値が1.0を超えたから買う」ことを読み手に示すため
  const evTag = ev => (ev ? ` 期待値${ev.toFixed(2)}` : '');
  // 買い目が無いほうの見出しは出さない（「★穴 的中率0%」だけが残るのを防ぐ）
  const block = (mark, conf, ev, combos) =>
    combos.length ? `${mark} 的中率${conf}%${evTag(ev)}\n${compressTrifecta(combos).join('　')}` : '';
  // 期待値1.0超えが1点も無いレースは買い目を出さない。
  // 無理に買うことが回収率を下げるいちばんの原因なので、見送りをそのまま伝える
  const skip = pred.ev_skip && !allM.length && !allA.length;
  // 何点でいくら必要かを明記する。読み手が実際に買える規模かどうかが分かるように
  const cost = n => (n ? ` 計${n}点¥${n * 100}` : '');
  const render = (nm, na) => [
    `🚤${venue} ${rno}R 締切${closeTime}${cost(nm + na)}`,
    skip ? '⚠️見送り\n人気サイドに配当が偏り、期待値1.0を超える買い目がありません' : '',
    block('◎本線', mc, pred.ev_main, allM.slice(0, nm)),
    block('★穴', ac, pred.ev_ana, allA.slice(0, na)),
  ].filter(Boolean).join('\n\n') + '\n';

  // 圧縮表記のおかげで全点そのまま載ることが多い。収まらないときだけ、
  // 優先度の低い末尾から削る（穴を先に削り、本線を残す）
  let nm = allM.length, na = allA.length;
  let head = render(nm, na);
  while (xLen(head) + xLen(tail) > 280 && nm + na > 2) {
    if (na > 1 && na >= nm) na--; else if (nm > 1) nm--; else na--;
    head = render(nm, na);
  }

  let tenkai = String(pred.tenkai_main || '').replace(/\s+/g, ' ').trim();
  const room = 280 - xLen(head) - xLen(tail) - 2;
  const text = (room > 20 && tenkai)
    ? head + '\n' + (() => { while (tenkai && xLen(tenkai) > room) tenkai = tenkai.slice(0, -1); return tenkai; })() + tail
    : head + tail;
  return { text, matoi: allM.slice(0, nm), ana: allA.slice(0, na) };
}

// 本日の投稿分の結果まとめツイート
// 本日の投稿分の結果まとめツイート。
// extra には買い目を出さなかった（見送り）件数と、まだ確定していない件数を渡す。
// これを書かないと「8レース投稿したのに5件しか出ていない」と食い違って見える
function buildResultTweet(hd, rows, extra = {}) {
  const md = `${parseInt(hd.slice(4, 6))}/${parseInt(hd.slice(6, 8))}`;
  const judged = rows.filter(r => r.result);
  const hits = judged.filter(r => r.hit === 'matoi' || r.hit === 'ana');
  const payout = hits.reduce((s, r) => s + (r.pay || 0), 0);
  // 投稿した買い目の点数はレースごとに異なるので、実際の点数から投資額を出す
  const points = judged.reduce((s, r) => s + (r.points || 0), 0);
  const invested = points * 100;
  const roi = invested ? Math.round(payout / invested * 100) : 0;
  // 日付をまたいで前日ぶんを投稿することがあるので、その日は「本日」と書かない
  const head = `📊${extra.today === false ? 'AI予想結果' : '本日のAI予想結果'} ${md}\n\n`;
  const notes = [];
  if (extra.noBet)   notes.push(`見送り${extra.noBet}件`);
  if (extra.pending) notes.push(`結果待ち${extra.pending}件`);
  const mkTail = omitted =>
    `\n的中 ${hits.length}/${judged.length}　回収率${roi}%\n` +
    `（計${points}点×100円 ¥${invested.toLocaleString()}→¥${payout.toLocaleString()}）` +
    (notes.length ? `\n${notes.join(' ・ ')}` : '') +
    (omitted ? `\n※文字数の都合で${omitted}件は省略` : '') +
    `\n\n#競艇 #ボートレース`;
  const lines = judged.map(r => {
    const mark = r.hit === 'matoi' ? '◎的中' : r.hit === 'ana' ? '★的中' : '―';
    return `${r.venue}${r.rno}R ${r.result} ${mark}${r.hit && r.hit !== 'none' && r.pay ? ` ¥${r.pay.toLocaleString()}` : ''}\n`;
  });
  // 全部載るならそのまま。載らないときは「省略」の一文ぶんも見込んで詰め直す
  const fit = reserve => {
    let body = '', n = 0;
    for (const line of lines) {
      if (xLen(head + body + line + mkTail(reserve)) > 280) break;
      body += line; n++;
    }
    return { body, n };
  };
  const all = fit(0);
  if (all.n === lines.length) return head + all.body + mkTail(0);
  const cut = fit(lines.length - all.n);
  return head + cut.body + mkTail(lines.length - cut.n);
}

// ===== 校正（キャリブレーション）の記録 =====
// 回収率は1本の高配当で数週間ぶれるため、それだけでは期待値方式の良否を判定できない。
// 「AIがp%と言った組は実際にp%当たるのか」は候補ごとに1レース24点たまるので、
// 少ないレース数で判定できる。投稿時の確率とオッズを残し、結果が出たら突き合わせる。
const CALIB_KEEP = 400;   // 保持するレース数

// オッズから市場の見立て（控除率を除いた実効確率）を逆算する。
// 全120組ぶん揃っていないと合計がずれるので、揃っている時だけ使う
function marketImplied(odds) {
  const vals = Object.values(odds || {}).filter(v => v > 0);
  if (vals.length < 100) return null;
  const overround = vals.reduce((s, v) => s + 1 / v, 0);
  if (!(overround > 0)) return null;
  return combo => (odds[combo] > 0 ? (1 / odds[combo]) / overround * 100 : null);
}

// 投稿時点の材料（候補の確率・実オッズ・実際に買った組）を残す。
// レースごとに別キーにして、読んで書き直す競合が起きないようにする
async function saveCalibSource(hd, jcd, rno, pred, odds3t, bought) {
  const cand = {};
  for (const d of pred.ev_detail || []) if (d && d.c) cand[d.c] = d.p;
  const odds = {};
  for (const [k, v] of Object.entries(odds3t || {})) if (v > 0) odds[k] = Math.round(v * 10) / 10;
  await redisCmd('SET', `calibsrc:${hd}:${jcd}:${rno}`,
    JSON.stringify({ cand, odds, bought, mode: pred.ev_mode || null }), 'EX', '259200');
}

// 結果が出たレースについて、確率と実際の当たりを突き合わせて記録する。
// 1日ぶんをまとめて1回だけ記録する（calibdone で二重記録を防ぐ）
async function recordCalibration(day, settled) {
  if (await redisCmd('GET', `calibdone:${day}`)) return { skipped: 'recorded' };
  const targets = settled.filter(x => x.result && x.jcd);
  if (!targets.length) return { skipped: 'no results' };

  const srcs = await Promise.all(targets.map(async x => {
    try { return JSON.parse(await redisCmd('GET', `calibsrc:${day}:${x.jcd}:${x.rno}`) || 'null'); }
    catch { return null; }
  }));

  const entries = [];
  for (let i = 0; i < targets.length; i++) {
    const x = targets[i], src = srcs[i];
    if (!src) continue;                       // v3.35以前の投稿には材料が無い
    const implied = marketImplied(src.odds);
    const bought = src.bought || [];
    const win = x.result;
    // 候補ごとの (確率, 当たったか)。校正バケットの材料
    const cands = Object.entries(src.cand || {}).map(([c, pv]) => [+(+pv).toFixed(2), c === win ? 1 : 0]);
    entries.push({
      hd: day, jcd: x.jcd, rno: x.rno, win, pay: x.pay || 0,
      mode: src.mode,
      aiP:  src.cand?.[win] ?? 0,                                  // AIが勝った組に付けた確率
      mktP: implied ? implied(win) : null,                          // 市場が同じ組に付けていた確率
      betP: bought.reduce((t, c) => t + (src.cand?.[c] ?? 0), 0),   // 買った組の合計確率（的中予測）
      betMktP: implied ? bought.reduce((t, c) => t + (implied(c) ?? 0), 0) : null,
      hit: bought.includes(win) ? 1 : 0,
      points: bought.length,
      cands,
    });
  }
  if (!entries.length) return { skipped: 'no source' };
  // 追記のみ（読んで書き直さないので、同時実行でも記録が消えない）
  await redisRaw(['RPUSH', 'calib:log', ...entries.map(e => JSON.stringify(e))], 8000);
  await redisCmd('LTRIM', 'calib:log', -CALIB_KEEP, -1);
  await redisCmd('SET', `calibdone:${day}`, String(entries.length), 'EX', '604800');
  return { recorded: entries.length };
}

// 校正の集計。「AIの確率は当たっているか」「市場より良いか」を返す
app.get('/api/calibration', async (req, res) => {
  try {
    const raw = await redisCmd('LRANGE', 'calib:log', 0, -1);
    const list = (Array.isArray(raw) ? raw : []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    // 同じレースが複数回記録されていれば新しい方を残す
    const uniq = new Map();
    for (const e of list) uniq.set(`${e.hd}:${e.jcd}:${e.rno}`, e);
    const races = [...uniq.values()];
    if (!races.length) return res.json({ races: 0, note: '記録がまだありません。投稿と結果まとめが1日ぶん動くと貯まります' });

    const bet = races.filter(r => r.points > 0);
    const hits = bet.filter(r => r.hit).length;
    const points = bet.reduce((s, r) => s + r.points, 0);
    const payout = bet.reduce((s, r) => s + (r.hit ? r.pay : 0), 0);

    // ブライアスコア（小さいほど良い）。AIの見立てと市場の見立てを同じ買い目で比べる
    const withMkt = bet.filter(r => r.betMktP != null);
    const brier = arr => arr.length ? +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(4) : null;
    const brierAI  = brier(bet.map(r => Math.pow(r.betP / 100 - r.hit, 2)));
    const brierMkt = brier(withMkt.map(r => Math.pow(r.betMktP / 100 - r.hit, 2)));

    // 勝った組に、AIと市場がそれぞれ何%を置いていたか（平均）
    const winCmp = races.filter(r => r.mktP != null);
    const mean = a => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : null;
    const aiOnWin  = mean(winCmp.map(r => r.aiP));
    const mktOnWin = mean(winCmp.map(r => r.mktP));

    // 校正バケット: 「p%と言った組」が実際に何%当たったか
    const EDGES = [0, 1, 2, 5, 10, 20, 100];
    const buckets = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], n: 0, sumP: 0, hits: 0 }));
    for (const r of races) {
      for (const [pv, h] of r.cands || []) {
        const b = buckets.find(b => pv >= b.lo && pv < b.hi) || buckets[buckets.length - 1];
        b.n++; b.sumP += pv; b.hits += h;
      }
    }

    res.json({
      races: races.length,
      bet: bet.length,
      skipped: races.length - bet.length,
      hit: hits,
      points,
      invested: points * 100,
      payout,
      roi: points ? Math.round(payout / (points * 100) * 100) : null,
      // 勝った組への見立て比較。AIが市場を下回り続けるなら期待値方式は価値を生んでいない
      winner: { n: winCmp.length, aiMeanP: aiOnWin, marketMeanP: mktOnWin,
        verdict: aiOnWin == null || mktOnWin == null ? null
          : aiOnWin > mktOnWin ? 'AIの見立てが市場より勝った組を高く評価できている'
          : 'AIの見立ては市場を上回れていない' },
      brier: { ai: brierAI, market: brierMkt,
        verdict: brierAI == null || brierMkt == null ? null
          : brierAI < brierMkt ? 'AIの確率のほうが正確' : '市場の確率のほうが正確' },
      calibration: buckets.filter(b => b.n).map(b => ({
        range: `${b.lo}〜${b.hi}%`,
        n: b.n,
        predicted: +(b.sumP / b.n).toFixed(2),
        actual: +(b.hits / b.n * 100).toFixed(2),
      })),
      note: '予測(predicted)と実績(actual)が近いほど確率の見積もりが正確。races が30を超えるまでは参考値',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 自動投稿エンドポイント（GitHub Actions などから定期実行）
//   mode=races   : 締切が近いレースの予想を投稿
//   mode=results : 本日投稿した予想の結果まとめを投稿
//   dryRun=1     : 投稿せず本文だけ返す（X未設定でも動作確認できる）
app.all('/api/auto-post', async (req, res) => {
  const secret = req.get('x-cron-secret') || req.query.secret || '';
  if (!CRON_SECRET || secret !== CRON_SECRET) return res.status(401).json({ error: 'invalid cron secret' });

  // Vercel の30秒制限内で必ず応答を返すための全体締切
  const tEnd = Date.now() + 55000;
  const timing = { redis: REDIS_ENABLED };
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const mode = req.query.mode === 'results' ? 'results'
             : req.query.mode === 'motors'  ? 'motors'
             : 'races';
  const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const hd = `${jst.getFullYear()}${String(jst.getMonth() + 1).padStart(2, '0')}${String(jst.getDate()).padStart(2, '0')}`;
  const nowMin = jst.getHours() * 60 + jst.getMinutes();

  try {
    // mode=motors: 公式ページのモーター評価を取り込む（1日1回の実行を想定）
    if (mode === 'motors') {
      const out = [];
      for (const jcd of Object.keys(MOTOR_SOURCES)) {
        const got = await fetchMotorAssessment(jcd, 15000);
        if (!got.ok) { out.push({ venue: VENUES[jcd], error: got.error }); continue; }
        if (!got.rows.length) { out.push({ venue: VENUES[jcd], error: '表として読み取れませんでした', tableRows: got.lineCount }); continue; }
        if (dryRun) { out.push({ venue: VENUES[jcd], parsed: got.rows.length, skipped: got.errors.length, charset: got.charset }); continue; }
        const w = await saveMotorRows(jcd, got.rows, 'cron', 'official');
        out.push({ venue: VENUES[jcd], saved: w.ok ? got.rows.length : 0, skipped: got.errors.length, charset: got.charset, error: w.ok ? undefined : (w.error || `HTTP ${w.status}`) });
      }
      return res.json({ ok: out.some(o => o.saved || o.parsed), dryRun: dryRun || undefined, results: out });
    }

    if (mode === 'results') {
      // 対象日を決める。定期実行は数時間遅れることがあり、23:30の枠が日付をまたいで
      // 起動すると当日ぶんを取り逃すため、当日に投稿がなければ前日ぶんを見る
      const prev = (() => {
        const d = new Date(`${hd.slice(0, 4)}-${hd.slice(4, 6)}-${hd.slice(6, 8)}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 1);
        return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      })();
      // 追記式のリストを優先して読む。v3.36以前に書かれたJSON形式も読めるようにしておく。
      // 念のため同じレースが複数回入っていれば先頭だけを使う
      const readLog = async d => {
        const rows = await redisCmd('LRANGE', `xlogl:${d}`, 0, -1);
        if (Array.isArray(rows) && rows.length) {
          const out = [], seen = new Set();
          for (const r of rows) {
            try {
              const e = JSON.parse(r);
              const k = `${e.jcd}:${e.rno}`;
              if (!seen.has(k)) { seen.add(k); out.push(e); }
            } catch {}
          }
          return out;
        }
        try { return JSON.parse(await redisCmd('GET', `xlog:${d}`) || '[]'); } catch { return []; }
      };
      let day  = hd;
      let log  = await readLog(hd);
      let done = !!(await redisCmd('GET', `xresult:${hd}`));
      // 当日に投稿が無い、または当日ぶんが投稿済みなら、未投稿の前日ぶんを対象にする
      if (!log.length || done) {
        const prevLog  = await readLog(prev);
        const prevDone = !!(await redisCmd('GET', `xresult:${prev}`));
        if (prevLog.length && !prevDone) { day = prev; log = prevLog; done = false; }
      }
      // 定期実行の遅延・欠落に備えて複数回試行するため、1日1回だけ投稿するよう記録で防ぐ
      if (!dryRun && done) return res.json({ ok: true, skipped: `${day} の結果まとめは投稿済み` });
      if (!log.length) return res.json({ ok: true, skipped: '対象となる投稿がありません', checkedDays: [hd, prev] });
      // 結果は全場ぶんを並列取得する（順次だと Vercel の制限を超える）。
      // 取得できなかったレースを黙って捨てると「8レース投稿したのに5件しか出ない」
      // という状態になるため、落ちた理由を state として必ず残す
      const settled = await Promise.all(log.slice(0, 8).map(async p => {
        const base = { venue: p.venue, rno: p.rno, jcd: p.jcd };
        // 判定は「投稿した買い目」だけで行う。v3.25以前の履歴は全点を保存していたが
        // 本文には本線4点・穴2点しか載せていなかったため、その範囲に絞る
        const legacy = !p.v;
        const mm = legacy ? (p.matoi || []).slice(0, 4) : (p.matoi || []);
        const aa = legacy ? (p.ana   || []).slice(0, 2) : (p.ana   || []);
        const bet = mm.length + aa.length > 0;
        // 見送りのレースも結果は取る。買わなかった判断が正しかったかを校正に残すため
        const html = await fetchQuick(`${BASE}/raceresult?jcd=${p.jcd}&hd=${day}&rno=${p.rno}`, 10000);
        const r = html ? parseRaceResult(html) : null;
        const final = !!(r && r.order && r.order.length >= 3);
        const tri = final ? r.order.slice(0, 3).map(o => o.lane).join('-') : null;
        const pay = final ? (r.payouts?.find(x => x.type === '3連単')?.pay || 0) : 0;
        // 買い目が無いレースは的中判定の対象外。未確定でも投稿を止める理由にはしない
        if (!bet) return { ...base, state: 'skip', result: tri, pay };
        if (!final) return { ...base, state: 'pending', why: html ? 'notfinal' : 'fetch', t: p.t };
        const hit = mm.includes(tri) ? 'matoi' : aa.includes(tri) ? 'ana' : 'none';
        return { ...base, state: 'judged', result: tri, pay, hit, points: mm.length + aa.length };
      }));
      const rows    = settled.filter(x => x.state === 'judged');
      const noBet   = settled.filter(x => x.state === 'skip');
      const pending = settled.filter(x => x.state === 'pending');
      const counts  = { posted: log.length, judged: rows.length, skip: noBet.length, pending: pending.length };

      // まだ確定していないレースがあるうちは投稿しない。投稿すると xresult でその日は
      // 打ち切られ、未確定ぶんが永久に集計から欠けてしまうため、次の枠で拾い直す。
      //
      // ただし「次の枠」は後続の実行があることが前提で、結果まとめを1日1回しか
      // 叩かない運用だと次が来ず、その日は永久に投稿されない。
      // 締切から十分たった未確定は確定しない（取得失敗など）とみなして投稿する。
      // 日付をまたいだ前日ぶんと、当日でも23時を過ぎた場合も同じ
      const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
      const stale = pending.length > 0 && pending.every(x => {
        const closed = toMin(x.t);
        return closed != null && nowMin - closed >= RESULT_WAIT_MIN;
      });
      const lastChance = day !== hd || nowMin >= 23 * 60 || stale;
      if (!dryRun && pending.length && !lastChance) {
        return res.json({ ok: true, skipped: `未確定${pending.length}件。次の枠で投稿します`, day, counts, pending, hint: '結果まとめの実行が1日1回だけだと次の枠が来ません。21:30/22:30/23:30 の3回に増やすと取りこぼしません' });
      }
      if (!rows.length) {
        const why = noBet.length && !pending.length ? '全レース見送りのため集計対象なし' : '確定した結果なし';
        return res.json({ ok: true, skipped: why, day, counts });
      }
      const text = buildResultTweet(day, rows, { noBet: noBet.length, pending: pending.length, today: day === hd });
      if (dryRun) return res.json({ ok: true, dryRun: true, day, text, xLen: xLen(text), counts, rows, noBet, pending });
      // 結果が出そろったこの時点で、確率と実際の当たりを突き合わせて記録する
      let calib = null;
      try { calib = await recordCalibration(day, settled); } catch (e) { calib = { error: e.message }; }
      const posted = await postToX(text);
      // 前日ぶんを投稿した場合もその日の記録として残す（二重投稿を防ぐ）
      if (posted.ok) await redisCmd('SET', `xresult:${day}`, '1', 'EX', '172800');
      return res.json({ ok: posted.ok, day, text, posted, counts, calib });
    }

    // mode=races: 締切15〜90分前のレースを1件だけ投稿（Vercelの30秒制限に収めるため）
    const minLead = parseInt(req.query.minLead) || 15;
    // 展示は締切のおよそ30〜40分前に出る。90分前まで対象にしていると、
    // 展示が出る前のレースばかり選ばれて予想の材料が足りなくなる
    const maxLead = parseInt(req.query.maxLead) || 45;
    const dailyCap = parseInt(req.query.cap) || 8;

    // 設定を直したあとの再開は最初に処理する。
    // 対象レースが見つかったときだけ解除する作りだと、レースが無い時間帯に
    // 実行しても解除されず、いつまでも停止したままになる
    const resumed = req.query.resume === '1' && !dryRun;
    if (resumed) await redisCmd('DEL', 'xhold');

    const cnt = parseInt(await redisCmd('GET', `xcount:${hd}`) || '0');
    if (cnt >= dailyCap) return res.json({ ok: true, skipped: `本日の投稿上限(${dailyCap}件)に到達` });

    // 開催場（ダッシュボードと同じ検出ロジック・キャッシュを共有）
    const tOpen = Date.now();
    const open = await getOpenVenues(hd);
    timing.openVenues = Date.now() - tOpen;
    if (!open.length) return res.json({ ok: true, skipped: '本日の開催なし', timing });

    // 締切時刻表は全場ぶんを並列で取得する。
    // 順番に取ると開催場が多い日（12場など）に Vercel の制限を大きく超えてしまう
    const tSched = Date.now();
    const scheds = await Promise.all(open.map(async ({ jcd, name }) => (
      { jcd, name, schedule: await getSchedule(jcd, hd) }
    )));
    timing.schedules = Date.now() - tSched;

    // ホーム場（既定は平和島）が開催していれば、その場のレースを先に選ぶ。
    // ホーム場に対象レースが無い時間帯は、従来どおり全場から締切の近い順に選ぶ
    const homeParam = String(req.query.home || '').trim();
    const homes = homeParam === 'none' ? []
      : homeParam ? homeParam.split(',').map(v => v.trim().padStart(2, '0')).filter(Boolean)
      : HOME_JCDS;

    // 締切が近い順に候補を並べ、未投稿の先頭1件を対象にする
    const cands = [];
    for (const { jcd, name, schedule } of scheds) {
      if (!schedule) continue;
      for (const r of schedule) {
        const [h, m] = (r.time || '0:0').split(':').map(Number);
        const lead = h * 60 + m - nowMin;
        if (lead >= minLead && lead <= maxLead) cands.push({ jcd, venue: name, rno: r.rno, time: r.time, lead });
      }
    }
    // ホーム場を優先し、そのなかで締切の近い順。ホーム場以外は後回しにする
    cands.sort((a, b) => (
      (homes.includes(a.jcd) ? 0 : 1) - (homes.includes(b.jcd) ? 0 : 1) || a.lead - b.lead
    ));
    if (!cands.length) return res.json({ ok: true, skipped: `締切${minLead}〜${maxLead}分前のレースなし`, timing });

    const tDedup = Date.now();
    // 同時に走った実行が同じレースを二重に処理しないよう、先に印を立てて確保する。
    // GETしてからSETする作りだと、間に別の実行が入って Gemini を二重に消費し、
    // 投稿数も二重に数えてしまう。NX は既に印があれば失敗するので、確保できるのは1実行だけ
    let target = null;
    for (const c of cands) {
      const key = `xposted:${hd}:${c.jcd}:${c.rno}`;
      if (dryRun) {                                  // 下見では印を立てない
        if (!await redisCmd('GET', key)) { target = c; break; }
        continue;
      }
      if (!REDIS_ENABLED) { target = c; break; }     // Redis無しでは確保できないので従来どおり
      // 途中で落ちても次の実行が拾えるよう、確保の印は短命にする（投稿できたら伸ばす）
      const claim = await redisRaw(['SET', key, 'processing', 'NX', 'EX', '600']);
      if (claim.ok && claim.result === 'OK') { target = c; break; }
    }
    timing.dedup = Date.now() - tDedup;
    if (target) target.home = homes.includes(target.jcd);
    if (!target) return res.json({ ok: true, skipped: '対象レースは投稿済み', homes, timing });

    // 確保しただけで投稿しなかった場合は印を外す。次の実行が同じレースを拾えるようにする
    const release = async () => {
      if (!dryRun && REDIS_ENABLED) await redisCmd('DEL', `xposted:${hd}:${target.jcd}:${target.rno}`);
    };

    // X側が投稿を受け付けない状態（認証エラー・クレジット切れ）が分かっているときは、
    // 予想生成に進まず打ち切る。投稿できないのにGeminiの無料枠を消費するのを防ぐ
    if (!dryRun && !resumed) {
      const hold = await redisCmd('GET', 'xhold');
      if (hold) {
        await release();
        return res.json({
          ok: true,
          skipped: `X投稿を一時停止中: ${hold}`,
          hint: '設定を修正済みなら URL に &resume=1 を付けて実行すると即座に再開します',
          target, timing,
        });
      }
    }

    // X の認証情報が無ければ投稿できないので、Gemini を消費する前に打ち切る
    if (!dryRun && !X_ENABLED) {
      await release();
      return res.json({ ok: false, skipped: 'X認証情報が未設定のため予想生成を行いません', hint: '/api/x-health で設定状況を確認してください', target, timing });
    }

    // 残り時間が足りなければ投稿せず終了する（次回の実行で拾う）。
    // この実行で開催場と締切時刻表はキャッシュされるので、次回は高速に処理できる。
    // データ取得に最大18秒＋AI生成に最低9秒を見込み、それを下回るなら見送る
    const remain = tEnd - Date.now();
    if (remain < 28000) {
      await release();
      return res.json({ ok: true, skipped: '準備に時間がかかったため次回の実行で投稿します', target, remainMs: remain, timing });
    }
    const tPred = Date.now();
    // 締切まで間があるレースは展示が出てから投稿する。
    // 締切が近い場合は、展示が取れなくても（取得失敗のこともある）そのまま出す
    const needExhibit = target.lead > EXHIBIT_GRACE_LEAD;
    const got = await getOrCreatePrediction(target.jcd, hd, target.rno, Math.min(20000, remain - 19000), { needExhibit });
    timing.predict = Date.now() - tPred;
    if (got.wait)  { await release(); return res.json({ ok: true, skipped: `${got.wait}（締切${target.lead}分前）。次の実行で投稿します`, target, timing }); }
    if (got.error) { await release(); return res.json({ ok: false, target, error: got.error, timing }); }

    const tw = buildRaceTweet(target.venue, target.rno, target.time, got.pred);
    const text = tw.text;
    const bought = tw.matoi.length + tw.ana.length;
    if (dryRun) return res.json({ ok: true, dryRun: true, target, text, xLen: xLen(text), points: bought, posting: { matoi: tw.matoi, ana: tw.ana }, predCached: got.cached, timing });

    // 見送りは買い目の投稿枠とは別勘定にする。枠を食い潰さない代わりに、
    // 見送りばかり並ぶのも困るので、見送り自体の1日の上限を設ける
    if (bought === 0) {
      const sc = parseInt(await redisCmd('GET', `xskip:${hd}`) || '0');
      if (sc >= SKIP_POST_CAP) {
        // 同じレースを毎回作り直さないよう、印は残したまま次のレースへ進める
        await redisCmd('SET', `xposted:${hd}:${target.jcd}:${target.rno}`, '1', 'EX', '86400');
        return res.json({ ok: true, skipped: `見送りの投稿上限(${SKIP_POST_CAP}件)に達しているため投稿しません`, target, timing });
      }
    }

    const posted = await postToX(text);
    // 同一内容の重複投稿をXは403で拒否する。これは「既に投稿済み」であって
    // 設定不備ではないので、成功と同じ扱いにして次のレースへ進める。
    // ここを止めてしまうと、無関係な重複ひとつで1時間BOTが停止してしまう
    const duplicate = !posted.ok && posted.status === 403 && /duplicate/i.test(posted.error || '');

    if (posted.ok || duplicate) {
      await redisCmd('SET', `xposted:${hd}:${target.jcd}:${target.rno}`, '1', 'EX', '86400');
      // 買い目を出したレースだけを1日の投稿上限に数える。見送りは別のカウンタ
      const counter = bought > 0 ? `xcount:${hd}` : `xskip:${hd}`;
      await redisCmd('INCR', counter);
      await redisCmd('EXPIRE', counter, '86400');
      // 履歴は追記のみ。読んで書き直すと、同時実行のときに1件消える
      await redisCmd('RPUSH', `xlogl:${hd}`,
        JSON.stringify({ v: 2, jcd: target.jcd, venue: target.venue, rno: target.rno, t: target.time, matoi: tw.matoi, ana: tw.ana }));
      await redisCmd('EXPIRE', `xlogl:${hd}`, '172800');
      // 校正の材料を残す（見送りのレースも、買わなかった判断が正しかったか測れる）
      try { await saveCalibSource(hd, target.jcd, target.rno, got.pred, got.odds3t, [...tw.matoi, ...tw.ana]); } catch {}
      await redisCmd('DEL', 'xhold');
    } else {
      // 投稿できなかったレースは確保を外し、次の実行で拾い直せるようにする
      await release();
      if (posted.status === 402 || posted.status === 401 || posted.status === 403) {
        // 認証や契約に起因する失敗は時間をおいても直らないため、1時間は生成を止める
        await redisCmd('SET', 'xhold', `HTTP${posted.status} ${posted.error || ''}`.slice(0, 120), 'EX', '3600');
      }
    }
    res.json({ ok: posted.ok || duplicate, duplicate: duplicate || undefined, points: bought, target, text, posted, timing });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== SLOT APIs (三ノ輪UNO) =====
async function slotGet(date) {
  const raw = await redisCmd('GET', `slot:daily:${date}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function slotSet(date, data) {
  await redisCmd('SET', `slot:daily:${date}`, JSON.stringify(data));
  await redisCmd('SADD', 'slot:dates', date);
}

app.get('/api/slot/records', async (req, res) => {
  try {
    const raw = await redisCmd('SMEMBERS', 'slot:dates');
    const dates = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const sorted = dates.sort().reverse().slice(0, 90);
    const records = await Promise.all(sorted.map(async d => {
      const r = await slotGet(d);
      return r ? { date: d, ...r } : { date: d, machines: [] };
    }));
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/slot/record', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const data = await slotGet(date);
    res.json(data || { date, machines: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/slot/record', async (req, res) => {
  const { date, machines, note } = req.body;
  if (!date || !Array.isArray(machines)) return res.status(400).json({ error: 'date and machines required' });
  try {
    await slotSet(date, { machines, note: note || '', updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/slot/record', async (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    await redisCmd('DEL', `slot:daily:${date}`);
    await redisCmd('SREM', 'slot:dates', date);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 診断: ホスティング側のルーティングでリクエストパスが失われた場合に、
// 素っ気ない404の代わりに受信内容を返して原因を特定できるようにする。
// （正常時はこのルートに到達しない）
app.all('/server.js', (req, res) => {
  const safe = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (/^(x-vercel|x-matched|x-forwarded|x-original|x-now|x-real)/i.test(k) &&
        !/auth|cookie|token|secret|key/i.test(k)) safe[k] = v;
  }
  res.status(500).json({
    error: 'ルーティングでリクエストパスが失われています',
    receivedUrl: req.url,
    method: req.method,
    headers: safe,
    hint: 'この内容をそのまま開発者に共有してください',
  });
});

// ルートアクセスでダッシュボードを返す
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// スロット X投稿画像 → Gemini Vision 解析
app.post('/api/slot/analyze-image', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY未設定' });
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64が必要です' });

  const prompt = `この画像はパチスロ店の告知画像またはX(Twitter)投稿のスクリーンショットです。
赤枠・金枠・虹枠（レインボー）で囲まれた台番号と機種名を特定してください。

枠色の判定基準:
- 赤枠: 赤色の枠で囲まれている
- 金枠: 金色・黄色の枠で囲まれている
- 虹枠: 虹色・レインボーカラーの枠で囲まれている

必ずJSONのみを返してください（説明文なし）:
{
  "machines": [
    {"no": "台番号（数字のみ）", "model": "機種名（読み取れない場合は空文字）", "hintType": "赤枠 または 金枠 または 虹枠"}
  ]
}
台番号・枠色が読み取れない場合: {"machines": []}`;

  try {
    const url = `${ORIGIN_GEMINI}/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
          { text: prompt },
        ]}],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 500,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    const text = data.candidates?.[0]?.content?.parts
      ?.filter(p => !p.thought).map(p => p.text || '').join('') || '';
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Gemini APIがタイムアウトしました' : e.message;
    res.status(500).json({ error: msg });
  }
});

// 三ノ輪UNO スロットダッシュボード
app.get('/slot', (req, res) => {
  res.sendFile(path.join(__dirname, 'minowa_uno_slot.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚤 ボートレースサーバー起動 → http://localhost:${PORT}`);
    console.log(`   平和島=04 / 芦屋=21\n`);
  });
}

module.exports = app;

// test/run.js から内部関数を直接確かめられるようにする（テスト実行時のみ）
if (process.env.NODE_ENV === 'test') {
  module.exports._internals = {
    compressTrifecta, expandTrifectaToken, normTrifecta,
    applyEV, buildRaceTweet, buildResultTweet, buildAutoPrompt, marketImplied,
  };
}
