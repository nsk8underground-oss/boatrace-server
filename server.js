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
// AI予想モデル: 先頭から順に試し、無料枠上限・一時過負荷なら次へ（モデルごとに枠が独立）
const PREDICT_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'];

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

// 全場ダッシュボード: 本日の開催場ごとの「次のレース」締切時刻と共有予想の有無
app.get('/api/dashboard', async (req, res) => {
  try {
    const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const hd = `${jst.getFullYear()}${String(jst.getMonth()+1).padStart(2,'0')}${String(jst.getDate()).padStart(2,'0')}`;
    const nowMin = jst.getHours() * 60 + jst.getMinutes();

    const mem = raceCache.get(`dash:${hd}`);
    if (mem && Date.now() < mem.exp) return res.json(mem.data);

    // 開催場一覧: Redis 10分キャッシュ → トップページのスクレイピング
    let open = [];
    const rawOpen = await redisCmd('GET', `openvenues:${hd}`);
    if (rawOpen) { try { open = JSON.parse(rawOpen); } catch {} }
    if (!open.length) {
      const idxHtml = await fetchHtml('https://www.boatrace.jp/owpc/pc/race/').catch(() => null);
      const $ = cheerio.load(idxHtml || '');
      const found = new Map();
      $('a[href*="jcd="]').each((_, el) => {
        const m = ($(el).attr('href') || '').match(/jcd=(\d{2})/);
        if (m && VENUES[m[1]] && !found.has(m[1])) found.set(m[1], VENUES[m[1]]);
      });
      open = [...found.entries()].map(([jcd, name]) => ({ jcd, name }));
      if (open.length) redisCmd('SET', `openvenues:${hd}`, JSON.stringify(open), 'EX', '600');
    }

    const venues = await Promise.all(open.map(async ({ jcd, name }) => {
      // 締切時刻表は当日中は変わらないためRedisに1日キャッシュ
      let schedule = null;
      const raw = await redisCmd('GET', `sched:${jcd}:${hd}`);
      if (raw) { try { schedule = JSON.parse(raw); } catch {} }
      if (!schedule) {
        try {
          const html = await fetchHtml(`${BASE}/racelist?jcd=${jcd}&hd=${hd}&rno=1`);
          if (html) {
            const rl = parseRacelist(html, jcd, hd, '1');
            if (rl.schedule?.length) {
              schedule = rl.schedule;
              redisCmd('SET', `sched:${jcd}:${hd}`, JSON.stringify(schedule), 'EX', '86400');
            }
          }
        } catch {}
      }
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
        if (await lookupSharedPredict(`v4_${jcd}_${hd}_${next.rno}_0_${ex}`)) { shared = true; break; }
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
    const [rlRes, oddsRes, beforeRes] = await Promise.allSettled([
      fetchHtml(`${BASE}/racelist?${q}`),
      fetchParsedOdds([`oddstf?${q}`, `odds1t?${q}`], parseOdds1t),
      fetchHtml(`${BASE}/beforeinfo?${q}`),
    ]);
    const rl = rlRes.status === 'fulfilled' && rlRes.value ? parseRacelist(rlRes.value, jcd, hd, rno) : null;
    if (!rl || rl.racers.length === 0) return res.status(404).json({ error: '出走データがありません。開催日・場コードを確認してください。平和島=04 / 芦屋=21' });
    const odds   = oddsRes.status === 'fulfilled' ? oddsRes.value : { odds: {} };
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
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
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
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const generationConfig = {
        temperature: 0.7,
        maxOutputTokens: 4096, // 8点×2+シナリオ2本。少なすぎるとJSONが途中で切れて全滅する
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
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
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

// 生成結果を共有キャッシュ（メモリ60分 + Redis 60分）に保存
function storePredict(cacheKey, result) {
  if (!cacheKey) return;
  for (const [k, v] of predictCache) if (Date.now() >= v.exp) predictCache.delete(k);
  predictCache.set(cacheKey, { data: result, exp: Date.now() + 3600000 });
  redisCmd('SET', `predict:${cacheKey}`, JSON.stringify(result), 'EX', '3600');
}

// AI予想エンドポイント（Gemini）
app.post('/api/predict', async (req, res) => {
  const { prompt, cacheKey, by } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'promptが必要です' });
  if (prompt.length > 8000) return res.status(400).json({ error: 'promptが長すぎます（8000文字以内）' });

  // 共有キャッシュにあればGemini不要（APIキー未設定でも返せる）
  if (cacheKey) {
    const hit = await lookupSharedPredict(cacheKey);
    if (hit) return res.json({ ...hit, cached: true });
  }

  const r = await callGemini(prompt);
  if (!r.ok) return res.status(r.status).json(r.body);
  const result = { content: [{ text: r.jsonText }], model: r.model, at: new Date().toISOString(), by: String(by || '').slice(0, 12) };
  storePredict(cacheKey, result);
  res.json(result);
});

/* ======================== X (Twitter) AUTO POST ======================== */
const X_API_KEY       = process.env.X_API_KEY || '';
const X_API_SECRET    = process.env.X_API_SECRET || '';
const X_ACCESS_TOKEN  = process.env.X_ACCESS_TOKEN || '';
const X_ACCESS_SECRET = process.env.X_ACCESS_SECRET || '';
const CRON_SECRET     = process.env.CRON_SECRET || '';
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
  const url = 'https://api.twitter.com/2/tweets';
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
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: d.detail || d.title || JSON.stringify(d).slice(0, 200) };
    return { ok: true, id: d.data?.id };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'X APIタイムアウト' : e.message };
  }
}

// 自動投稿用の予想プロンプト（フロントと同じJSONスキーマ＝生成結果をアプリでもそのまま共有できる）
function buildAutoPrompt(venue, rno, racers, weather, odds3t) {
  const lines = racers.map(r =>
    `${r.lane}号艇:${r.name || '不明'}(${r.cls || '—'}/${r.branch || '—'}) ` +
    `全国${r.allRate || 0}/当地${r.localRate || 0}/2連${r.all2Rate || 0}% F/L:${r.fl || '0/0'} avgST:${r.avgST || 0.18} ` +
    `単勝:${r.odds != null ? r.odds.toFixed(1) + '倍' : '不明'} モーター:${r.motorGrade || '未評価'}(2連${r.motor2Rate || 0}%) ` +
    `展示:${r.exhibitTime || '不明'} 展示ST:${r.exhibitST || '不明'}`
  ).join('\n');
  const top = Object.entries(odds3t || {}).sort((a, b) => a[1] - b[1]).slice(0, 10)
    .map(([k, v], i) => `${i + 1}番人気:${k}(${v}倍)`).join(' ');
  const oddsLine = top ? `\n【3連単オッズ上位10＝市場の人気】\n${top}\n` : '';

  return `ボートレース専門予想師として以下の最新データを分析し、JSON形式のみで回答してください。

【${venue} 第${rno}レース】
天候:${weather.sky || '不明'} 風速:${weather.wind ?? '不明'}m/s 水温:${weather.water ?? '不明'}℃ 波高:${weather.wave ?? '不明'}cm

【出走表（boatrace.jp 実データ）】
${lines}
${oddsLine}
以下のJSON形式のみで回答（バッククォート不要）:
{
  "analysis": "280文字以内の総合分析",
  "tenkai_main": "本線展開シナリオ130文字以内。どの艇がどう決まればmatoi8点が的中するか具体的に",
  "tenkai_ana": "穴展開シナリオ130文字以内。どんな波乱が起きればana8点が飛び出すか具体的に",
  "main_conf": 本線が的中する信頼度を0〜100の数字で,
  "ana_conf": 穴展開が起きる可能性を0〜100の数字で,
  "wind_effect": "90文字以内",
  "tide_effect": "90文字以内",
  "motor_comment": "80文字以内",
  "focus": "注目艇番号（数字のみ）",
  "focus_reason": "80文字以内",
  "matoi": ["本線①","本線②","本線③","本線④","本線⑤","本線⑥","本線⑦","本線⑧"],
  "ana":   ["穴①","穴②","穴③","穴④","穴⑤","穴⑥","穴⑦","穴⑧"]
}
matoiは三連単の的中重視フォーメーション8点（本命軸から相手を広げた買い目構成）、
anaは高配当を狙う穴フォーメーション8点（本線と重複しない並び。オッズ50倍以上を意識）。
オッズ情報がある場合: 市場の人気と実力データに乖離がある並びは「過小評価された妙味」として
積極的に評価し、特にana8点に活かすこと。
全て "艇番-艇番-艇番" 形式（例: "1-2-3"）で記載。matoi内・ana内で重複なし。
main_confとana_confの合計が100になる必要はない（それぞれ独立した確度）。`;
}

// 1レース分のデータを集めて予想を取得（共有キャッシュ優先・なければ生成して共有キャッシュに保存）
async function getOrCreatePrediction(jcd, hd, rno, budgetMs) {
  const venue = VENUES[jcd] || '';
  const q = `jcd=${jcd}&hd=${hd}&rno=${rno}`;
  const [rlR, beforeR, o1R, o3R] = await Promise.allSettled([
    fetchHtml(`${BASE}/racelist?${q}`),
    fetchHtml(`${BASE}/beforeinfo?${q}`),
    fetchParsedOdds([`oddstf?${q}`, `odds1t?${q}`], parseOdds1t),
    fetchParsedOdds([`odds3t?${q}`], parseOdds3t),
  ]);
  const rl = rlR.status === 'fulfilled' && rlR.value ? parseRacelist(rlR.value, jcd, hd, rno) : null;
  if (!rl || !rl.racers.length) return { error: '出走データなし' };
  const before = beforeR.status === 'fulfilled' && beforeR.value ? parseBeforeinfo(beforeR.value) : { weather: {}, exhibit: {} };
  const odds1  = o1R.status === 'fulfilled' ? (o1R.value.odds || {}) : {};
  const odds3t = o3R.status === 'fulfilled' ? (o3R.value.odds || {}) : {};

  const hasEx = Object.keys(before.exhibit).length > 0;
  const cacheKey = `v4_${jcd}_${hd}_${rno}_0_ex${hasEx ? 1 : 0}`;
  const cached = await lookupSharedPredict(cacheKey);
  if (cached) {
    try { return { pred: JSON.parse(cached.content[0].text), venue, cached: true, schedule: rl.schedule }; } catch {}
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
    exhibitTime: before.exhibit[r.lane]?.exhibitTime ?? null,
    exhibitST: before.exhibit[r.lane]?.st ?? null,
    motorGrade: motors[r.motorNo]?.grade || '',
  }));

  const prompt = buildAutoPrompt(venue, rno, racers, before.weather || {}, odds3t);
  const g = await callGemini(prompt, budgetMs);
  if (!g.ok) return { error: g.body?.error || '予想生成失敗' };
  const result = { content: [{ text: g.jsonText }], model: g.model, at: new Date().toISOString(), by: 'AI BOT' };
  storePredict(cacheKey, result);
  try { return { pred: JSON.parse(g.jsonText), venue, cached: false, schedule: rl.schedule }; }
  catch { return { error: '予想の解析に失敗' }; }
}

// レース予想のツイート本文（280重みに収まるよう展開文を自動短縮）
function buildRaceTweet(venue, rno, closeTime, pred) {
  const matoi = (pred.matoi || []).slice(0, 4).join(' ');
  const ana   = (pred.ana   || []).slice(0, 2).join(' ');
  const mc = parseInt(pred.main_conf) || 0;
  const ac = parseInt(pred.ana_conf) || 0;
  const head =
    `🚤${venue} ${rno}R 締切${closeTime}\n\n` +
    `◎本線 信頼度${mc}%\n${matoi}\n\n` +
    `★穴 信頼度${ac}%\n${ana}\n`;
  const tail = `\n#競艇 #ボートレース #${venue}`;
  let tenkai = String(pred.tenkai_main || '').replace(/\s+/g, ' ').trim();
  const room = 280 - xLen(head) - xLen(tail) - 2;
  if (room > 20 && tenkai) {
    while (tenkai && xLen(tenkai) > room) tenkai = tenkai.slice(0, -1);
    return head + '\n' + tenkai + tail;
  }
  return head + tail;
}

// 本日の投稿分の結果まとめツイート
function buildResultTweet(hd, rows) {
  const md = `${parseInt(hd.slice(4, 6))}/${parseInt(hd.slice(6, 8))}`;
  const judged = rows.filter(r => r.result);
  const hits = judged.filter(r => r.hit === 'matoi' || r.hit === 'ana');
  const payout = hits.reduce((s, r) => s + (r.pay || 0), 0);
  const invested = judged.length * 1600; // 16点×100円想定
  const roi = invested ? Math.round(payout / invested * 100) : 0;
  const head = `📊本日のAI予想結果 ${md}\n\n`;
  const tail = `\n的中 ${hits.length}/${judged.length}　回収率${roi}%\n（本線+穴 計16点×100円想定）\n\n#競艇 #ボートレース`;
  let body = '';
  for (const r of judged) {
    const mark = r.hit === 'matoi' ? '◎的中' : r.hit === 'ana' ? '★的中' : '―';
    const line = `${r.venue}${r.rno}R ${r.result} ${mark}${r.hit && r.hit !== 'none' && r.pay ? ` ¥${r.pay.toLocaleString()}` : ''}\n`;
    if (xLen(head + body + line + tail) > 280) break;
    body += line;
  }
  return head + body + tail;
}

// 自動投稿エンドポイント（GitHub Actions などから定期実行）
//   mode=races   : 締切が近いレースの予想を投稿
//   mode=results : 本日投稿した予想の結果まとめを投稿
//   dryRun=1     : 投稿せず本文だけ返す（X未設定でも動作確認できる）
app.all('/api/auto-post', async (req, res) => {
  const secret = req.get('x-cron-secret') || req.query.secret || '';
  if (!CRON_SECRET || secret !== CRON_SECRET) return res.status(401).json({ error: 'invalid cron secret' });

  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  const mode = req.query.mode === 'results' ? 'results' : 'races';
  const jst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const hd = `${jst.getFullYear()}${String(jst.getMonth() + 1).padStart(2, '0')}${String(jst.getDate()).padStart(2, '0')}`;
  const nowMin = jst.getHours() * 60 + jst.getMinutes();

  try {
    if (mode === 'results') {
      let log = [];
      try { log = JSON.parse(await redisCmd('GET', `xlog:${hd}`) || '[]'); } catch {}
      if (!log.length) return res.json({ ok: true, skipped: '本日の投稿なし' });
      const rows = [];
      for (const p of log.slice(0, 8)) {
        try {
          const html = await fetchHtml(`${BASE}/raceresult?jcd=${p.jcd}&hd=${hd}&rno=${p.rno}`);
          if (!html) continue;
          const r = parseRaceResult(html);
          if (!r.order || r.order.length < 3) continue;
          const tri = r.order.slice(0, 3).map(o => o.lane).join('-');
          const pay = r.payouts?.find(x => x.type === '3連単')?.pay || 0;
          const hit = (p.matoi || []).includes(tri) ? 'matoi' : (p.ana || []).includes(tri) ? 'ana' : 'none';
          rows.push({ venue: p.venue, rno: p.rno, result: tri, pay, hit });
        } catch {}
      }
      if (!rows.length) return res.json({ ok: true, skipped: '確定した結果なし' });
      const text = buildResultTweet(hd, rows);
      if (dryRun) return res.json({ ok: true, dryRun: true, text, xLen: xLen(text), rows });
      const posted = await postToX(text);
      return res.json({ ok: posted.ok, text, posted });
    }

    // mode=races: 締切15〜90分前のレースを1件だけ投稿（Vercelの30秒制限に収めるため）
    const minLead = parseInt(req.query.minLead) || 15;
    const maxLead = parseInt(req.query.maxLead) || 90;
    const dailyCap = parseInt(req.query.cap) || 8;

    const cnt = parseInt(await redisCmd('GET', `xcount:${hd}`) || '0');
    if (cnt >= dailyCap) return res.json({ ok: true, skipped: `本日の投稿上限(${dailyCap}件)に到達` });

    // 開催場と締切時刻表（ダッシュボードと同じRedisキャッシュを再利用）
    let open = [];
    try { open = JSON.parse(await redisCmd('GET', `openvenues:${hd}`) || '[]'); } catch {}
    if (!open.length) {
      const idxHtml = await fetchHtml('https://www.boatrace.jp/owpc/pc/race/').catch(() => null);
      const $ = cheerio.load(idxHtml || '');
      const found = new Map();
      $('a[href*="jcd="]').each((_, el) => {
        const m = ($(el).attr('href') || '').match(/jcd=(\d{2})/);
        if (m && VENUES[m[1]] && !found.has(m[1])) found.set(m[1], VENUES[m[1]]);
      });
      open = [...found.entries()].map(([jcd, name]) => ({ jcd, name }));
      if (open.length) redisCmd('SET', `openvenues:${hd}`, JSON.stringify(open), 'EX', '600');
    }
    if (!open.length) return res.json({ ok: true, skipped: '本日の開催なし' });

    // 締切が近い順に候補を並べ、未投稿の先頭1件を対象にする
    const cands = [];
    for (const { jcd, name } of open) {
      let schedule = null;
      try { schedule = JSON.parse(await redisCmd('GET', `sched:${jcd}:${hd}`) || 'null'); } catch {}
      if (!schedule) {
        try {
          const html = await fetchHtml(`${BASE}/racelist?jcd=${jcd}&hd=${hd}&rno=1`);
          if (html) {
            const rl = parseRacelist(html, jcd, hd, '1');
            if (rl.schedule?.length) {
              schedule = rl.schedule;
              redisCmd('SET', `sched:${jcd}:${hd}`, JSON.stringify(schedule), 'EX', '86400');
            }
          }
        } catch {}
      }
      if (!schedule) continue;
      for (const r of schedule) {
        const [h, m] = (r.time || '0:0').split(':').map(Number);
        const lead = h * 60 + m - nowMin;
        if (lead >= minLead && lead <= maxLead) cands.push({ jcd, venue: name, rno: r.rno, time: r.time, lead });
      }
    }
    cands.sort((a, b) => a.lead - b.lead);
    if (!cands.length) return res.json({ ok: true, skipped: `締切${minLead}〜${maxLead}分前のレースなし` });

    let target = null;
    for (const c of cands) {
      const done = await redisCmd('GET', `xposted:${hd}:${c.jcd}:${c.rno}`);
      if (!done) { target = c; break; }
    }
    if (!target) return res.json({ ok: true, skipped: '対象レースは投稿済み' });

    const got = await getOrCreatePrediction(target.jcd, hd, target.rno, 16000);
    if (got.error) return res.json({ ok: false, target, error: got.error });

    const text = buildRaceTweet(target.venue, target.rno, target.time, got.pred);
    if (dryRun) return res.json({ ok: true, dryRun: true, target, text, xLen: xLen(text), predCached: got.cached });

    const posted = await postToX(text);
    if (posted.ok) {
      await redisCmd('SET', `xposted:${hd}:${target.jcd}:${target.rno}`, '1', 'EX', '86400');
      await redisCmd('INCR', `xcount:${hd}`);
      await redisCmd('EXPIRE', `xcount:${hd}`, '86400');
      let log = [];
      try { log = JSON.parse(await redisCmd('GET', `xlog:${hd}`) || '[]'); } catch {}
      log.push({ jcd: target.jcd, venue: target.venue, rno: target.rno, matoi: got.pred.matoi || [], ana: got.pred.ana || [] });
      await redisCmd('SET', `xlog:${hd}`, JSON.stringify(log), 'EX', '172800');
    }
    res.json({ ok: posted.ok, target, text, posted });
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
