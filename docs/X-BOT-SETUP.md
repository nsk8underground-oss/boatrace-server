# X（旧Twitter）自動投稿BOT セットアップ手順

AI予想を X に自動投稿するBOTの設定方法です。**追加費用はかかりません**（X APIの無料枠 + GitHub Actionsの無料枠）。

設定が終わるまでBOTは何もしません。途中で止めても既存アプリの動作には影響しません。

---

## 1. X の開発者アカウントを作る

1. https://developer.x.com/ で開発者ポータルにログイン（投稿させたいアカウントで）
2. Project + App を作成
3. App の **User authentication settings** を開く
   - App permissions: **Read and write** ← 必ずこれ。Read only だと投稿できません
   - Type of App: **Web App / Automated App or Bot**
   - Callback URL / Website URL: 自分のサイトURLで可（未使用）
4. **Keys and tokens** タブで以下4つを発行・コピー
   - API Key（＝Consumer Key）
   - API Key Secret
   - Access Token
   - Access Token Secret

> ⚠️ 権限を「Read and write」に変更した場合、**Access Token を再発行**しないと古い権限のままです。

---

## 2. Vercel に環境変数を追加

Vercel のプロジェクト → Settings → Environment Variables に以下を追加し、**再デプロイ**します。

| 変数名 | 値 |
|---|---|
| `X_API_KEY` | 手順1の API Key |
| `X_API_SECRET` | 手順1の API Key Secret |
| `X_ACCESS_TOKEN` | 手順1の Access Token |
| `X_ACCESS_SECRET` | 手順1の Access Token Secret |
| `CRON_SECRET` | 自分で決めた長いランダム文字列（他人に推測されない値） |

`CRON_SECRET` は自動投稿エンドポイントの合言葉です。これが未設定だとエンドポイントは常に401を返し、BOTは動きません。

---

## 3. GitHub にシークレットを追加

リポジトリ → Settings → Secrets and variables → Actions → **New repository secret**

| 名前 | 値 |
|---|---|
| `APP_URL` | `https://<あなたのVercelドメイン>`（末尾のスラッシュ不要） |
| `CRON_SECRET` | 手順2と**同じ値** |
| `SITE_PASSWORD` | サイトのBasic認証パスワード |

---

## 4. 動作確認（投稿せずに本文だけ見る）

リポジトリの **Actions** タブ → 「X 自動投稿」→ **Run workflow**

- mode: `races`
- dryRun: **true**（既定）

実行ログに投稿予定の本文が表示されます。問題なければ dryRun を `false` にして手動実行すると、実際に投稿されます。

ブラウザから直接確認することもできます:

```
https://<あなたのドメイン>/api/auto-post?mode=races&dryRun=1&secret=<CRON_SECRET>
```

---

## 5. 自動運転の内容

| いつ | 何をするか |
|---|---|
| JST 10:00〜20:00 の毎時 | 締切15〜90分前のレースから未投稿の1件を選び、予想を投稿 |
| JST 21:30 | その日投稿した予想の結果まとめ（的中率・回収率）を投稿 |

- 1日の投稿上限は **8件**（X無料枠の月間上限に対して余裕を持たせています）
- 同じレースを二重投稿しないよう記録しています
- アプリ側で既に生成済みの予想があればそれを使い、Gemini APIを消費しません

### 調整したいとき

`.github/workflows/x-auto-post.yml` の `cron` 行を編集すると頻度を変えられます。
投稿本数の上限はエンドポイントに `&cap=6` のように付けて変更できます。

---

## 注意点

- **予想は参考情報です。** 投稿本文に断定的な表現（「必ず当たる」等）を足さないでください。景品表示法上の問題になり得ます
- 実績は加工せず、実際の数字をそのまま投稿する運用を推奨します
- GitHub の scheduled workflow はリポジトリが60日間活動がないと自動停止します。また混雑時は実行が数分ずれることがあります
- X APIの無料枠の条件は変更されることがあります。開発者ポータルで最新の上限を確認してください
