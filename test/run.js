// 外部につながない状態で server.js を本物のHTTP経路で動かし、
// 壊れると実害が大きいところだけを確かめる。
//   npm test
// 通信先（boatrace.jp / Gemini / X / Upstash）はすべて test/stub.js に向く。
const { spawn } = require('child_process');
const path = require('path');
const { createStub, topCands } = require('./stub');

/* ---------- 小道具 ---------- */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `期待 ${JSON.stringify(want)} / 実際 ${JSON.stringify(got)}`);
}

const jstNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
const hhmm = m => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 起動 ---------- */
async function main() {
  const stub = createStub();
  const sp = await stub.listen();
  const stubUrl = `http://127.0.0.1:${sp}`;

  const port = 3400 + Math.floor(Math.random() * 90);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    TEST_ORIGIN_BOATRACE: stubUrl,
    TEST_ORIGIN_GEMINI: `${stubUrl}/gemini`,
    TEST_ORIGIN_X: stubUrl,
    UPSTASH_REDIS_REST_URL: `${stubUrl}/redis`,
    UPSTASH_REDIS_REST_TOKEN: 'stub-token',
    GEMINI_API_KEY: 'stub-key',
    X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as',
    CRON_SECRET: 'testsecret',
    SITE_PASSWORD: 'testpass',
  };
  let serverLog = '';
  let child = null;
  const base = `http://127.0.0.1:${port}`;

  // サーバーは開催場・締切時刻・予想をメモリにもためる。
  // セクションごとに前提を作り直すため、そのつど起動しなおす
  async function restart() {
    if (child) { child.kill(); await sleep(150); }
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => serverLog += d);
    child.stderr.on('data', d => serverLog += d);
    for (let i = 0; i < 100; i++) {
      try { await fetch(`${base}/api/health`); return; } catch { await sleep(100); }
    }
    console.error('サーバーが起動しませんでした\n' + serverLog);
    process.exit(1);
  }
  await restart();
  const auth = 'Basic ' + Buffer.from('guest:testpass').toString('base64');
  const seed = d => fetch(`${stubUrl}/__seed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
  const stat = () => fetch(`${stubUrl}/__stat`).then(r => r.json());
  const redis = a => fetch(`${stubUrl}/redis`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) }).then(r => r.json()).then(r => r.result);
  const cron = q => fetch(`${base}/api/auto-post?secret=testsecret&${q}`).then(r => r.json());
  const getJ = (p, h) => fetch(base + p, { headers: { Authorization: auth, ...h } }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const postJ = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(b) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const j = jstNow();
  const hd = `${j.getFullYear()}${String(j.getMonth() + 1).padStart(2, '0')}${String(j.getDate()).padStart(2, '0')}`;
  const nowMin = j.getHours() * 60 + j.getMinutes();

  // 市場は1号艇本命。AIは4号艇を高く見る＝見立てがズレているので買い目が出る
  const AI_EDGE = topCands([0.28, 0.18, 0.14, 0.24, 0.09, 0.07]);
  // AIが市場とほぼ同じ見立て＝控除率のぶん期待値が1.0に届かず、見送りになるはず
  const AI_SAME = topCands([0.45, 0.20, 0.14, 0.11, 0.06, 0.04]);

  // サーバーはメモリにも予想を60分ためるので、Redisを消しても同じレース番号は使い回されてしまう。
  // セクションごとに別のレース番号を使って、前のセクションの予想を引きずらないようにする
  const seedDay = async (gemini, rnos, lead = 20) => {
    const del = [`xlog:${hd}`, `xlogl:${hd}`, `xcount:${hd}`, `xskip:${hd}`, `xresult:${hd}`, `calibdone:${hd}`, 'xhold'];
    for (let r = 1; r <= 12; r++) del.push(`xposted:${hd}:04:${r}`, `calibsrc:${hd}:04:${r}`);
    await seed({
      del,
      kv: {
        [`openvenues:${hd}`]: JSON.stringify([{ jcd: '04', name: '平和島' }]),
        [`sched:04:${hd}`]: JSON.stringify(rnos.map((r, i) => ({ rno: r, time: hhmm(nowMin + lead + i * 5) }))),
      },
      gemini: { analysis: 'テスト分析', tenkai_main: '4カドの攻め。', tenkai_ana: '差し。',
        wind_effect: 'w', tide_effect: 't', motor_comment: 'm', focus: '4', focus_reason: 'f', cands: gemini },
      hasExhibit: true, resetCalls: true,
    });
    await restart();
  };

  try {
    /* ============================================================ */
    console.log('\n【1】3連単の買い目表記の圧縮');
    const { compressTrifecta, expandTrifectaToken, applyEV, buildResultTweet } = require('../server.js')._internals;
    eq('1-2-3 と 1-2-4 は 1-2-34 にまとまる', compressTrifecta(['1-2-3', '1-2-4']), ['1-2-34']);
    eq('1-2-3 と 2-1-3 は 1=2-3 にまとまる', compressTrifecta(['1-2-3', '2-1-3']), ['1=2-3']);
    eq('まとめられない2点はそのまま', compressTrifecta(['1-2-3', '4-5-6']), ['1-2-3', '4-5-6']);
    // 圧縮した表記を展開して元に戻せること（戻せない圧縮は投稿してはいけない）
    for (const combos of [['1-2-3', '1-2-4', '1-2-5'], ['1-2-3', '2-1-3'], ['1-2-3', '1-3-2', '3-1-2']]) {
      const back = compressTrifecta(combos).flatMap(expandTrifectaToken).sort();
      eq(`往復して元の点数に戻る [${combos.join(',')}]`, back, combos.slice().sort());
    }

    /* ============================================================ */
    console.log('\n【2】期待値による買い目の選定');
    const odds = stub.marketOdds;
    const same = applyEV({ cands: AI_SAME.map(c => ({ ...c })) }, odds);
    check('市場と同じ見立てなら見送りになる', same.ev_skip === true && same.matoi.length === 0,
      `ev_skip=${same.ev_skip} matoi=${JSON.stringify(same.matoi)}`);
    const edge = applyEV({ cands: AI_EDGE.map(c => ({ ...c })) }, odds);
    check('見立てがズレていれば買い目が出る', edge.ev_mode === 'ev' && edge.matoi.length > 0, JSON.stringify(edge.matoi));
    check('本線は期待値1.05以上の中から選ばれる', edge.ev_detail.filter(d => edge.matoi.includes(d.c)).every(d => d.ev >= 1.05),
      JSON.stringify(edge.ev_detail.filter(d => edge.matoi.includes(d.c))));
    // 本線は「期待値順」ではなく「期待値を満たした中の確率順」。ここが逆だと的中率が落ちる
    const qual = edge.ev_detail.filter(d => d.ev >= 1.05).sort((a, b) => b.p - a.p);
    eq('本線は確率の高い順に並ぶ', edge.matoi, qual.slice(0, edge.matoi.length).map(d => d.c));
    check('オッズが無ければ期待値を名乗らない', applyEV({ cands: AI_EDGE.map(c => ({ ...c })) }, null).ev_mode === 'noodds');
    // 確率の合計を盛った出力は、縮めた数字を根拠にせず期待値を出さない
    const inflated = applyEV({ cands: AI_EDGE.map(c => ({ ...c, p: c.p * 6 })) }, odds);
    check('確率の合計が過大なら期待値を出さない', inflated.ev_mode === 'unreliable', inflated.ev_mode);

    /* ============================================================ */
    console.log('\n【3】/api/predict はアプリの文面を受け付けない');
    const legacy = await postJ('/api/predict', { prompt: '好きな文章', cacheKey: `v6_04_${hd}_12_0_ex1` });
    check('旧形式（prompt指定）は400で拒否される', legacy.status === 400, `status=${legacy.status} ${JSON.stringify(legacy.body)}`);
    eq('拒否しても共有キャッシュは書き換わらない', await redis(['GET', `predict:v6_04_${hd}_12_0_ex1`]), null);
    for (const [label, body] of [
      ['会場コードが不正', { jcd: '99', hd, rno: 1 }],
      ['日付が不正', { jcd: '04', hd: 'x', rno: 1 }],
      ['レース番号が不正', { jcd: '04', hd, rno: 99 }],
    ]) check(`${label}なら400`, (await postJ('/api/predict', body)).status === 400);

    await seedDay(AI_EDGE, [12]);
    const before3 = (await stat()).geminiCalls;
    const p1 = await postJ('/api/predict', { jcd: '04', hd, rno: 12, wind: '追い風', tide: '満潮', by: 'テスト' });
    check('正しい入力なら予想が返る', p1.status === 200 && !!p1.body.content, JSON.stringify(p1.body).slice(0, 200));
    const st3 = await stat();
    check('プロンプトはサーバーが組み立てている', st3.lastPrompt.includes('出走表（boatrace.jp 実データ）') && st3.lastPrompt.includes('選択条件 — 風向:追い風'),
      st3.lastPrompt.slice(0, 120));
    check('プロンプトにオッズは含めない', !/オッズ上位|人気順\d/.test(st3.lastPrompt));
    check('サーバー由来のキーで共有キャッシュに入る', !!(await redis(['GET', `predict:v6_04_${hd}_12_0_ex1`])));
    const p2 = await postJ('/api/predict', { jcd: '04', hd, rno: 12 });
    check('2回目はキャッシュが返りGeminiを呼ばない', p2.body.cached === true && (await stat()).geminiCalls === before3 + 1);
    check('表示用の3連単オッズも一緒に返る', Object.keys(p2.body.odds3t || {}).length > 50);

    // 買い目診断も同じ方針（アプリからは買い目だけを受け取る）
    check('買い目診断も文面は受け付けない', (await postJ('/api/advise', { prompt: 'x' })).status === 400);
    check('買い目が不正なら400', (await postJ('/api/advise', { jcd: '04', hd, rno: 1, combo: '1-1-1' })).status === 400);
    const adv = await postJ('/api/advise', { jcd: '04', hd, rno: 1, combo: '4-2-1' });
    check('買い目診断が返る', adv.status === 200 && !!adv.body.content, JSON.stringify(adv.body).slice(0, 150));
    check('診断のプロンプトもサーバーが作る', (await stat()).lastPrompt.includes('【買い目】3連単 4-2-1'));

    /* ============================================================ */
    console.log('\n【4】自動投稿が同じレースを二重に処理しない');
    await seedDay(AI_EDGE, [1, 2, 3, 4]);
    const b5 = await stat();
    const runs = await Promise.all([cron('mode=races'), cron('mode=races'), cron('mode=races')]);
    const picked = runs.map(r => r.target?.rno).filter(Boolean);
    check('3本同時に走らせても同じレースを選ばない', new Set(picked).size === picked.length, JSON.stringify(picked));
    const a5 = await stat();
    eq('Geminiの呼び出しは処理したレース数と同じ', a5.geminiCalls - b5.geminiCalls, picked.length);
    eq('履歴も処理したレース数ぶん残る', ((await redis(['LRANGE', `xlogl:${hd}`, 0, -1])) || []).length, picked.length);

    /* ============================================================ */
    console.log('\n【5】見送りは投稿枠を食わない');
    await seedDay(AI_SAME, [5, 6, 7, 8]);
    const kinds = [];
    for (let i = 0; i < 4; i++) {
      const r = await cron('mode=races');
      kinds.push(r.skipped ? `skipped:${r.skipped}` : (r.points === 0 ? '見送り' : `${r.points}点`));
    }
    check('見送りの投稿には上限がある', kinds.filter(k => k === '見送り').length <= 2, JSON.stringify(kinds));
    eq('見送りは買い目カウンタを増やさない', await redis(['GET', `xcount:${hd}`]), null);
    check('見送りは見送りカウンタで数える', parseInt(await redis(['GET', `xskip:${hd}`]) || '0', 10) > 0);

    /* ============================================================ */
    console.log('\n【6】結果まとめと校正の記録');
    await seedDay(AI_EDGE, [9, 10, 11]);
    const runs6 = [];
    for (let i = 0; i < 3; i++) runs6.push(await cron('mode=races'));
    const log = ((await redis(['LRANGE', `xlogl:${hd}`, 0, -1])) || []).map(r => JSON.parse(r));
    check('投稿履歴が3件たまる', log.length === 3, JSON.stringify(runs6).slice(0, 300));
    // 締切から60分以上前にして「結果待ち」を解除する（本番では夜に集計するため）
    for (const e of log) e.t = hhmm(nowMin - 120);
    await redis(['DEL', `xlogl:${hd}`]);
    for (const e of log) await redis(['RPUSH', `xlogl:${hd}`, JSON.stringify(e)]);
    await seed({
      // 1件だけAIが高く見た組が来る。残りは市場の本命と大穴
      results: { [log[0].rno]: { combo: log[0].matoi?.[0] || '4-1-2', pay: 4650 },
                 [log[1].rno]: { combo: '1-2-3', pay: 1150 },
                 [log[2].rno]: { combo: '6-5-4', pay: 98700 } },
    });
    const res = await cron('mode=results');
    check('結果がまとまる', res.ok !== false && !!res.text, JSON.stringify(res).slice(0, 200));
    eq('投稿したレースが全件まとまる', res.counts?.posted, 3);
    eq('3件とも結果が確定して判定される', res.counts?.judged, 3);
    check('校正の材料が記録される', !!(await redis(['GET', `calibsrc:${hd}:04:${log[0].rno}`])));
    const calib = await getJ('/api/calibration');
    check('/api/calibration が集計を返す', calib.status === 200 && calib.body.races >= 1, JSON.stringify(calib.body).slice(0, 200));
    check('買い目どおりに来たレースを的中として数える', (calib.body.hit || 0) >= 1, JSON.stringify(calib.body).slice(0, 300));
    check('AIと市場の見立てを比べている',
      typeof calib.body.brier?.ai === 'number' && typeof calib.body.brier?.market === 'number', JSON.stringify(calib.body.brier));
    // 2度集計しても二重に記録しない
    await redis(['DEL', `xresult:${hd}`]);
    const res2 = await cron('mode=results');
    eq('同じ日を2度集計しても記録は増えない', res2.calib?.added ?? 0, 0);

    /* ============================================================ */
    console.log('\n【7】結果ツイートの文面');
    const tw = buildResultTweet(hd, [
      { rno: 1, venue: '平和島', hit: true, combo: '1-2-3', pay: 1200, points: 4 },
      { rno: 2, venue: '平和島', hit: false, points: 4 },
    ], { noBet: 1, pending: 2, today: true });
    check('見送り件数が入る', /見送り1件/.test(tw), tw);
    check('結果待ち件数が入る', /結果待ち2件/.test(tw), tw);
    check('X の上限280（全角2文字）に収まる',
      [...tw].reduce((s, c) => s + (c.codePointAt(0) > 0x1100 ? 2 : 1), 0) <= 280, `長さ=${tw.length}`);
    /* ============================================================ */
    console.log('\n【8】Basic認証の総当たり対策');
    const badAuth = 'Basic ' + Buffer.from('guest:0000').toString('base64');
    let blocked = 0, lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${base}/api/health`, { headers: { Authorization: badAuth } });
      lastStatus = r.status;
      if (r.status === 429) blocked++;
    }
    check('まちがえ続けると429で締め出される', blocked > 0, `最後のstatus=${lastStatus}`);
    const okAfter = await fetch(`${base}/api/health`, { headers: { Authorization: auth } });
    check('締め出し中は正しいパスワードでも入れない', okAfter.status === 429, `status=${okAfter.status}`);
    // 締め出しはIP単位。cron は Basic認証の対象外なので影響を受けない
    check('自動投稿はCRON_SECRETで通る（締め出しの影響を受けない）',
      (await fetch(`${base}/api/auto-post?secret=testsecret&mode=results&dryRun=1`)).status !== 429);

  } catch (e) {
    fail++;
    console.log(`\n‼️ テスト実行中に例外: ${e.stack}`);
  }

  child.kill();
  await stub.close();

  console.log(`\n${'─'.repeat(50)}\n合格 ${pass} / 失敗 ${fail}`);
  if (fail) {
    console.log('失敗:\n  - ' + failures.join('\n  - '));
    if (serverLog.trim()) console.log('\nサーバーの出力:\n' + serverLog.split('\n').slice(-25).join('\n'));
  }
  process.exit(fail ? 1 : 0);
}

main();
