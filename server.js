const express      = require('express');
const cheerio      = require('cheerio');
const cors         = require('cors');
const basicAuth    = require('express-basic-auth');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const predictCache = new Map();
const raceCache    = new Map();

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const REDIS_ENABLED = !!(UPSTASH_URL && UPSTASH_TOKEN);

// Redis障害でAPI全体を落とさないため、失敗時は null を返す
async function redisCmd(...args) {
  if (!REDIS_ENABLED) return null;
  try {
    const r = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const d = await r.json();
    return d.result ?? null;
  } catch {
    return null;
  }
}

// パスワード設定（環境変数 SITE_PASSWORD で変更可。デフォルト: boatrace2026）
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'boatrace2026';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// パスワード保護（全ページに適用）
app.use(basicAuth({
  authorizer: (user, pass) =>
    basicAuth.safeCompare(user, 'guest') & basicAuth.safeCompare(pass, SITE_PASSWORD),
  challenge: true,
  realm: 'BoatRace Dashboard',
}));

app.use(express.json());
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
const BASE = 'https://www.boatrace.jp/owpc/pc/race';
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

function parseBeforeinfo(html) {
  const $ = cheerio.load(html);
  const weather = {};

  // 天候: テーブルセル形式（隣接td）とテキスト形式の両方に対応
  $('td, th').each((_, el) => {
    const label = $(el).text().trim();
    const val   = $(el).next('td').text().trim();
    if (label === '天候' && val) weather.sky = val;
    if (label === '風速' && val) { const n = parseFloat(val); if (!isNaN(n)) weather.wind = n; }
    if (label === '風向' && val) weather.windDir = val;
    if (label === '水温' && val) { const n = parseFloat(val); if (!isNaN(n)) weather.water = n; }
    if (label === '波高' && val) { const n = parseFloat(val); if (!isNaN(n)) weather.wave = n; }
  });
  // フォールバック: コロン区切りテキスト形式（0m/s・0cm は有効値なので == null で判定）
  const bodyText = $.text();
  if (!weather.sky)          weather.sky     = (bodyText.match(/天候\s*[:：]?\s*([晴曇雨雪][^\s\d]*)/) || [])[1] || '';
  if (weather.wind == null)  weather.wind    = parseFloat((bodyText.match(/風速\s*[:：]?\s*([\d.]+)/) || [])[1]) || 0;
  if (!weather.windDir)      weather.windDir = (bodyText.match(/風向\s*[:：]?\s*([北南東西][^\s\d]{0,4})/) || [])[1] || '';
  if (weather.water == null) weather.water   = parseFloat((bodyText.match(/水温\s*[:：]?\s*([\d.]+)/) || [])[1]) || 0;
  if (weather.wave == null)  weather.wave    = parseFloat((bodyText.match(/波高\s*[:：]?\s*([\d.]+)/) || [])[1]) || 0;

  const exhibitMap = {};
  $('tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 4) return;

    const c0 = cells.eq(0).text().trim();
    const lane = parseInt(c0);
    if (isNaN(lane) || lane < 1 || lane > 6) return;

    // 列構成を自動検出:
    //   4列: 艇番|進入|タイム|ST        → indices 0,1,2,3
    //   5列以上: 艇番|選手名|進入|タイム|ST → indices 0,2,3,4
    let courseIdx = 1, timeIdx = 2, stIdx = 3;
    if (cells.length >= 5) {
      const c1 = cells.eq(1).text().replace(/\s+/g, '').trim();
      // c1が数字1桁（コース番号）でなければ選手名列とみなす
      if (!/^\d$/.test(c1)) {
        courseIdx = 2; timeIdx = 3; stIdx = 4;
      }
    }

    const course      = parseInt(cells.eq(courseIdx).text().trim()) || lane;
    const exhibitTime = parseFloat(cells.eq(timeIdx).text().trim())  || null;
    const st          = parseFloat(cells.eq(stIdx).text().trim())    || null;

    // 有効な展示タイム（5〜8秒）が取れた行のみ採用
    if (exhibitTime && exhibitTime > 5 && exhibitTime < 9) {
      exhibitMap[lane] = { lane, course, exhibitTime, st };
    }
  });

  return { weather, exhibit: exhibitMap, fetchedAt: new Date().toISOString() };
}

function parseOdds1t(html) {
  const $ = cheerio.load(html);
  const odds = {};
  $('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 2) return;
    const lane = parseInt(cells.eq(0).text().trim());
    const odd  = parseFloat(cells.eq(1).text().trim());
    if (!isNaN(lane) && lane >= 1 && lane <= 6 && !isNaN(odd)) odds[lane] = odd;
  });
  return { odds, fetchedAt: new Date().toISOString() };
}

function parseOdds3t(html) {
  const $ = cheerio.load(html);
  const odds = {};
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

function parseOdds2t(html) {
  const $ = cheerio.load(html);
  const odds = {};
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

function parseOdds3f(html) {
  const $ = cheerio.load(html);
  const odds = {};
  $('tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').toArray();
    if (cells.length < 2) return;
    const boats = [];
    let oddsVal = null;
    cells.forEach(td => {
      const raw = $(td).text().trim();
      // 小数点を含むセルはオッズ値。数字分解すると組番と誤認する（例: 45.6 → 4,5,6）
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

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/api/venues', (_, res) => res.json(Object.entries(VENUES).map(([jcd, name]) => ({ jcd, name }))));

app.get('/api/today', async (req, res) => {
  const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const hd = `${jst.getFullYear()}${String(jst.getMonth()+1).padStart(2,'0')}${String(jst.getDate()).padStart(2,'0')}`;
  try {
    const html = await fetchHtml('https://www.boatrace.jp/owpc/pc/race/');
    const $ = cheerio.load(html || '');
    const found = new Map();
    $('a[href*="jcd="]').each((_, el) => {
      const m = ($(el).attr('href') || '').match(/jcd=(\d{2})/);
      if (m && VENUES[m[1]] && !found.has(m[1])) found.set(m[1], VENUES[m[1]]);
    });
    res.json({ venues: [...found.entries()].map(([jcd,name])=>({jcd,name})), hd });
  } catch (e) {
    res.json({ venues: [], hd, error: e.message });
  }
});

app.get('/api/odds', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });
  try {
    const html = await fetchHtml(`${BASE}/odds1t?jcd=${jcd}&hd=${hd}&rno=${rno}`);
    if (!html) return res.json({ odds: {} });
    res.json(parseOdds1t(html));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/odds2t', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });
  try {
    const html = await fetchHtml(`${BASE}/odds2t?jcd=${jcd}&hd=${hd}&rno=${rno}`);
    if (!html) return res.json({ odds: {} });
    res.json(parseOdds2t(html));
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

function parseRaceResult(html) {
  const $ = cheerio.load(html);
  const order = [];
  const payouts = [];
  const PAYOUT_TYPES = ['3連単','3連複','2連単','2連複','拡連複','単勝','複勝'];
  const COMBO_RE = /^[1-6]([-=][1-6]){0,2}$/;
  let curPayType = null; // rowspan継続行用（複勝・拡連複の2行目以降）

  $('tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;

    // 着順行: "1着" or "1" が最初のセル
    let isRankRow = false;
    for (let ci = 0; ci < Math.min(cells.length, 3); ci++) {
      const t = cells.eq(ci).text().trim();
      const rankM = t.match(/^([1-6])着?$/);
      if (!rankM) continue;
      const rank = parseInt(rankM[1]);
      // 次のセルから艇番を探す（1〜6の数字単独のセル）
      for (let li = ci + 1; li < Math.min(cells.length, ci + 4); li++) {
        const lv = parseInt(cells.eq(li).text().replace(/\s+/g, ''));
        if (lv >= 1 && lv <= 6) { order.push({ rank, lane: lv }); isRankRow = true; break; }
      }
      break;
    }
    if (isRankRow) { curPayType = null; return; }

    // 払戻行: 式別名が最初のセル。複勝・拡連複は同一行内または rowspan 継続行に複数の払戻がある
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
    // 式別セルがない行: 直前の rowspan 式別の継続行として扱う
    if (!type && curPayType) { type = curPayType; startIdx = 0; }
    if (!type) return;

    const remaining = cells.toArray().slice(startIdx);
    for (let i = 0; i < remaining.length - 1; i++) {
      const combo  = $(remaining[i]).text().replace(/\s+/g, '');
      if (!COMBO_RE.test(combo)) continue;
      const payRaw = $(remaining[i + 1]).text().replace(/[,¥円\s]/g, '');
      const pay    = parseInt(payRaw);
      if (!isNaN(pay) && pay > 0) {
        payouts.push({ type, combo, pay });
        i++; // 払戻金セルはスキップして次のペアへ
      }
    }
  });

  // 重複除去（着順）
  const seen = new Set();
  const uniqOrder = order.filter(o => { const k = o.rank; if (seen.has(k)) return false; seen.add(k); return true; });
  return { order: uniqOrder.sort((a,b) => a.rank - b.rank), payouts, fetchedAt: new Date().toISOString() };
}

app.get('/api/result', async (req, res) => {
  const { jcd, hd, rno = '1' } = req.query;
  const err = validateParams(jcd, hd);
  if (err) return res.status(400).json({ error: err });
  try {
    const html = await fetchHtml(`${BASE}/raceresult?jcd=${jcd}&hd=${hd}&rno=${rno}`);
    if (!html) return res.json({ order: [], payouts: [] });
    res.json(parseRaceResult(html));
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

app.post('/api/motors', async (req, res) => {
  const { jcd, motorNo, grade, note, racerName, motor2Rate } = req.body;
  if (!jcd || !motorNo) return res.status(400).json({ error: 'jcd and motorNo required' });
  if (grade && !['S','A','B','C','D'].includes(grade)) return res.status(400).json({ error: '無効なグレード' });
  try {
    const val = JSON.stringify({ grade: grade || '', note: String(note || '').slice(0, 200), racerName: String(racerName || '').slice(0, 50), motor2Rate: motor2Rate || null, updatedAt: new Date().toISOString() });
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
    const [rlRes, oddsRes, beforeRes] = await Promise.allSettled([
      fetchHtml(`${BASE}/racelist?jcd=${jcd}&hd=${hd}&rno=${rno}`),
      fetchHtml(`${BASE}/odds1t?jcd=${jcd}&hd=${hd}&rno=${rno}`),
      fetchHtml(`${BASE}/beforeinfo?jcd=${jcd}&hd=${hd}&rno=${rno}`),
    ]);
    const rl = rlRes.status === 'fulfilled' && rlRes.value ? parseRacelist(rlRes.value, jcd, hd, rno) : null;
    if (!rl || rl.racers.length === 0) return res.status(404).json({ error: '出走データがありません。開催日・場コードを確認してください。平和島=04 / 芦屋=21' });
    const odds   = oddsRes.status === 'fulfilled' && oddsRes.value ? parseOdds1t(oddsRes.value) : { odds: {} };
    const before = beforeRes.status === 'fulfilled' && beforeRes.value ? parseBeforeinfo(beforeRes.value) : { weather: {}, exhibit: {} };
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
    const r = await fetch('https://www.boatrace.jp/owpc/pc/race/racelist?jcd=04&hd=20260520&rno=1', {
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
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': GEMINI_API_KEY } });
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

// AI予想エンドポイント（Gemini）
app.post('/api/predict', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'サーバーに GEMINI_API_KEY が設定されていません' });
  }
  const { prompt, cacheKey } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'promptが必要です' });
  if (prompt.length > 8000) return res.status(400).json({ error: 'promptが長すぎます（8000文字以内）' });

  if (cacheKey) {
    const hit = predictCache.get(cacheKey);
    if (hit && Date.now() < hit.exp) return res.json({ ...hit.data, cached: true });
    // 共有キャッシュ（Redis）: 全ユーザー・全インスタンスで同じ予想を返す
    const shared = await redisCmd('GET', `predict:${cacheKey}`);
    if (shared) {
      try {
        const data = JSON.parse(shared);
        predictCache.set(cacheKey, { data, exp: Date.now() + 600000 });
        return res.json({ ...data, cached: true });
      } catch {}
    }
  }

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1200,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: `Gemini: ${data.error.message}` });
    const text = data.candidates?.[0]?.content?.parts
      ?.filter(p => !p.thought)
      .map(p => p.text || '').join('') || '';
    if (!text) return res.status(500).json({ error: 'Geminiから空のレスポンスが返りました' });
    try {
      JSON.parse(text);
    } catch {
      return res.status(500).json({ error: 'GeminiのレスポンスがJSON形式ではありません' });
    }
    const result = { content: [{ text }] };
    if (cacheKey) {
      for (const [k, v] of predictCache) if (Date.now() >= v.exp) predictCache.delete(k);
      predictCache.set(cacheKey, { data: result, exp: Date.now() + 600000 });
      redisCmd('SET', `predict:${cacheKey}`, JSON.stringify(result), 'EX', '600');
    }
    res.json(result);
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Gemini APIがタイムアウトしました(25秒)' : e.message;
    res.status(500).json({ error: msg });
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
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
