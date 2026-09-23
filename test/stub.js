// boatrace.jp / Upstash Redis / Gemini / X API の代わりになるローカルスタブ。
// 外部に一切つながずに server.js を本物のHTTP経路で動かすために使う。
//   start() でポートを取り、TEST_ORIGIN_* と UPSTASH_REDIS_REST_URL をそこへ向ける。
const http = require('http');

function createStub() {
  const store = new Map();
  const hash  = new Map();
  const list  = new Map();

  // Upstash REST が返すのと同じ形の結果を作る（対応コマンドは server.js が使うものだけ）
  function redis(args) {
    const [cmdRaw, ...rest] = args;
    const cmd = String(cmdRaw).toUpperCase();
    const k = rest[0];
    switch (cmd) {
      case 'GET': return store.has(k) ? store.get(k) : null;
      case 'SET': {
        // NX（既にあれば失敗）を実Redisと同じく扱う。失敗時は null
        const nx = rest.slice(2).some(a => String(a).toUpperCase() === 'NX');
        if (nx && store.has(k)) return null;
        store.set(k, String(rest[1]));
        return 'OK';
      }
      // 実Redisの DEL は型を問わずキーを消す
      case 'DEL': { const n = (store.delete(k) | hash.delete(k) | list.delete(k)) ? 1 : 0; return n; }
      case 'EXPIRE': return 1;
      case 'INCR': { const v = parseInt(store.get(k) || '0', 10) + 1; store.set(k, String(v)); return v; }
      case 'HGETALL': { const h = hash.get(k); if (!h) return []; const o = []; for (const [f, v] of h) o.push(f, v); return o; }
      case 'HSET': {
        if (!hash.has(k)) hash.set(k, new Map());
        let n = 0;
        for (let i = 1; i < rest.length; i += 2) {
          if (rest[i + 1] === undefined) break;
          hash.get(k).set(String(rest[i]), String(rest[i + 1])); n++;
        }
        return n;
      }
      case 'HDEL': { const h = hash.get(k); if (!h) return 0; let n = 0; for (let i = 1; i < rest.length; i++) if (h.delete(String(rest[i]))) n++; return n; }
      case 'SADD': { if (!list.has(k)) list.set(k, []); const a = list.get(k); let n = 0; for (let i = 1; i < rest.length; i++) if (!a.includes(String(rest[i]))) { a.push(String(rest[i])); n++; } return n; }
      case 'SMEMBERS': return list.get(k) || [];
      case 'RPUSH': { if (!list.has(k)) list.set(k, []); for (let i = 1; i < rest.length; i++) list.get(k).push(String(rest[i])); return list.get(k).length; }
      case 'LRANGE': case 'LTRIM': {
        const a = list.get(k) || [];
        let st = parseInt(rest[1], 10), en = parseInt(rest[2], 10);
        if (st < 0) st = Math.max(0, a.length + st);
        if (en < 0) en = a.length + en;
        const slice = a.slice(st, en + 1);
        if (cmd === 'LTRIM') { list.set(k, slice); return 'OK'; }
        return slice;
      }
      default: return null;
    }
  }

  const state = {
    gemini: { analysis: 'stub', tenkai_main: 'x', cands: [] },
    results: {},                 // rno -> { combo, pay }
    hasExhibit: false,
    failTweets: false,
    tideStations: ['TK'],       // 気象庁にこの地点だけがある状態にする
    resultFailFirst: 0,         // 結果ページの最初のN回だけ失敗させる（取り直しの確認用）
    geminiCalls: 0,
    lastPrompt: '',
    tweets: [],
  };

  function racelistHtml() {
    const fw = n => String.fromCharCode(n.charCodeAt(0) + 0xfee0);
    let html = '<html><body><h3>スタブ一般戦</h3>';
    for (let lane = 1; lane <= 6; lane++) {
      const tds = [
        `<td>${fw(String(lane))}</td>`, '<td></td>',
        `<td>403${lane} / A1 スタブ 太郎${lane} 香川/香川 40歳/52.0kg</td>`,
        '<td>F0 L0 0.15</td>', '<td>6.50 45.0 60.0</td>', '<td>6.20 44.0 58.0</td>',
        `<td>${50 + lane} 40.0 55.0</td>`, `<td>${70 + lane} 38.0 52.0</td>`,
      ];
      while (tds.length < 24) tds.push('<td></td>');
      html += `<table><tbody class=" is-fs12"><tr>${tds.join('')}</tr></tbody></table>`;
    }
    return html + '</body></html>';
  }

  // 展示タイムが載った直前情報（枠|写真|選手名|体重|展示タイム|チルト）
  function beforeinfoHtml() {
    if (!state.hasExhibit) return '<html><body></body></html>';
    let rows = '';
    for (let l = 1; l <= 6; l++) {
      rows += `<tr><td>${l}</td><td>${7 - l}</td><td>スタブ 太郎${l}</td><td>52.0kg</td><td>${(6.70 + l * 0.02).toFixed(2)}</td><td>-0.5</td></tr>`;
    }
    const wx = '<table><tr><td>天候</td><td>晴</td></tr><tr><td>風向</td><td>北東</td></tr><tr><td>風速</td><td>3</td></tr></table>';
    return `<html><body>${wx}<table>${rows}</table></body></html>`;
  }

  // 市場（＝人気）は1号艇本命。控除率25%ぶんだけ配当が絞られたオッズを作る
  const MARKET_W = [0.45, 0.20, 0.14, 0.11, 0.06, 0.04];
  const MARKET_ODDS = (() => {
    const p = trifectaProbs(MARKET_W), o = {};
    for (const k in p) o[k] = Math.max(1.1, Math.round(0.75 / p[k] * 10) / 10);
    return o;
  })();

  function odds3tHtml() {
    const byFirst = [[], [], [], [], [], []];
    for (const k in MARKET_ODDS) { const [a, b, c] = k.split('-').map(Number); byFirst[a - 1].push([b, c, MARKET_ODDS[k]]); }
    for (const l of byFirst) l.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let rows = '';
    for (let i = 0; i < 20; i++) {
      let tds = '';
      for (let g = 0; g < 6; g++) { const e = byFirst[g][i]; tds += `<td>${e[0]}</td><td>${e[1]}</td><td>${e[2].toFixed(1)}</td>`; }
      rows += `<tr>${tds}</tr>`;
    }
    return `<html><body><table><tbody>${rows}</tbody></table></body></html>`;
  }

  // 気象庁の潮位表と同じ固定長テキストを1年ぶん作る。
  // 潮位は半日周期（約12時間25分）の正弦波で、地点記号と日付は本物と同じ桁に置く
  function tideYearTxt(year, code) {
    const p = (v, w) => String(v).padStart(w, '0');
    const lines = [];
    const d = new Date(Date.UTC(year, 0, 1));
    for (let day = 0; day < 366 && d.getUTCFullYear() === year; day++) {
      const phase = (day * 0.8) % (2 * Math.PI);   // 日ごとに満潮の時刻がずれる
      const level = m => Math.round(120 + 80 * Math.sin((m / 745) * 2 * Math.PI + phase));
      let s = '';
      for (let h = 0; h < 24; h++) s += String(level(h * 60)).padStart(3, ' ');
      s += p(year % 100, 2) + p(d.getUTCMonth() + 1, 2) + p(d.getUTCDate(), 2) + code;
      // 満潮・干潮は正弦波の式から直接求める（1分刻みで山を探すと丸め誤差で偽の山を拾う）。
      //   sin((m/745)*2π + phase) が最大 = 引数 π/2 + 2πk、最小 = 3π/2 + 2πk
      const at = target => {
        const out = [];
        for (let k = -1; k <= 3; k++) {
          const m = Math.round(745 * (target + 2 * Math.PI * k - phase) / (2 * Math.PI));
          if (m >= 0 && m <= 1439) out.push({ m, v: level(m) });
        }
        return out.sort((a, b) => a.m - b.m).slice(0, 4);
      };
      const highs = at(Math.PI / 2), lows = at(3 * Math.PI / 2);
      const slot = arr => {
        let out = '';
        for (let i = 0; i < 4; i++) {
          out += arr[i] ? p(Math.floor(arr[i].m / 60), 2) + p(arr[i].m % 60, 2) + String(arr[i].v).padStart(3, ' ')
                        : '9999999';
        }
        return out;
      };
      lines.push(s + slot(highs) + slot(lows));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return lines.join('\n') + '\n';
  }

  function resultHtml(combo, pay) {
    const rows = combo.split('-').map((l, i) => `<tr><td>${i + 1}</td><td>${l}</td><td>スタブ 太郎</td></tr>`).join('');
    return `<html><body><table>${rows}</table>
    <table><tr><td>3連単</td><td>${combo}</td><td>¥${pay.toLocaleString()}</td><td>1</td></tr></table></body></html>`;
  }

  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const body = cb => { let b = ''; req.on('data', c => b += c); req.on('end', () => cb(b)); };
    const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const html = h => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(h); };

    if (req.method === 'POST' && u.pathname === '/redis') {
      return body(b => { let a = []; try { a = JSON.parse(b); } catch {} json({ result: redis(a) }); });
    }
    if (u.pathname === '/__seed') {
      return body(b => {
        const d = JSON.parse(b || '{}');
        for (const [k, v] of Object.entries(d.kv || {})) store.set(k, v);
        for (const k of d.del || []) { store.delete(k); hash.delete(k); list.delete(k); }
        if (d.gemini)     state.gemini  = d.gemini;
        if (d.results)    state.results = d.results;
        if (d.hasExhibit  !== undefined) state.hasExhibit = !!d.hasExhibit;
        if (d.failTweets  !== undefined) state.failTweets = !!d.failTweets;
        if (d.tideStations) state.tideStations = d.tideStations;
        if (d.resultFailFirst !== undefined) state.resultFailFirst = d.resultFailFirst | 0;
        if (d.resetCalls) { state.geminiCalls = 0; state.tweets.length = 0; }
        res.writeHead(200).end('ok');
      });
    }
    if (u.pathname === '/__stat') {
      return json({ geminiCalls: state.geminiCalls, lastPrompt: state.lastPrompt, tweets: state.tweets.slice() });
    }
    // 気象庁の潮位表（/kaiyou/data/db/tide/suisan/txt/<年>/<地点>.txt）
    const tm = u.pathname.match(/\/tide\/suisan\/txt\/(\d{4})\/([A-Z0-9]{2})\.txt$/);
    if (tm) {
      if (!state.tideStations.includes(tm[2])) { res.writeHead(404).end('nf'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(tideYearTxt(parseInt(tm[1], 10), tm[2]));
    }
    if (u.pathname.endsWith('/racelist'))   return html(racelistHtml());
    if (u.pathname.endsWith('/beforeinfo')) return html(beforeinfoHtml());
    if (u.pathname.endsWith('/odds3t'))     return html(odds3tHtml());
    if (u.pathname.endsWith('/oddstf'))     return html('<html><body></body></html>');
    if (u.pathname.endsWith('/raceresult')) {
      // 開催ピーク時の boatrace.jp のように、最初の何回かだけ失敗させる
      if (state.resultFailFirst > 0) { state.resultFailFirst--; res.writeHead(503).end('busy'); return; }
      const r = state.results[u.searchParams.get('rno')];
      if (!r) { res.writeHead(404).end('no result'); return; }
      return html(resultHtml(r.combo, r.pay));
    }
    if (u.pathname === '/2/tweets') {
      return body(b => {
        if (state.failTweets) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ title: 'stub failure' })); }
        state.tweets.push(b);
        json({ data: { id: String(1000 + state.tweets.length) } });
      });
    }
    if (u.pathname.startsWith('/gemini/models')) {
      return body(b => {
        state.geminiCalls++;
        try { state.lastPrompt = JSON.parse(b).contents[0].parts.map(p => p.text || '[image]').join(''); } catch {}
        json({ candidates: [{ content: { parts: [{ text: JSON.stringify(state.gemini) }] } }] });
      });
    }
    res.writeHead(404).end('nf');
  });

  return {
    listen: () => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port))),
    close: () => new Promise(r => srv.close(r)),
    marketOdds: MARKET_ODDS,
  };
}

// 1着→2着→3着を順に引く単純なモデル。テストで「市場の見立て」「AIの見立て」を作るのに使う
function trifectaProbs(w) {
  const p = {};
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) for (let c = 0; c < 6; c++) {
    if (a === b || b === c || a === c) continue;
    p[`${a + 1}-${b + 1}-${c + 1}`] = w[a] * (w[b] / (1 - w[a])) * (w[c] / (1 - w[a] - w[b]));
  }
  return p;
}

// 上位n組を cands 形式（{c,p}）で返す
function topCands(w, n = 22) {
  return Object.entries(trifectaProbs(w)).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([c, p]) => ({ c, p: +(p * 100).toFixed(1) }));
}

module.exports = { createStub, trifectaProbs, topCands };
