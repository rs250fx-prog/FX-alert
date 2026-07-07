# FX Board — 為替・金アラートPWA

MXN/JPY・USD/JPY・GOLD(XAU)の指定値到達をプッシュ通知するiPhone向けWebアプリです。
Xcode・Apple Developer登録・カード登録は一切不要、完全無料で運用できます。
曜日ごとの値動きの傾向（アノマリー分析）もボード画面から確認できます。

## 全体の仕組み

```
GitHub Actions（60分ごと・check-rates.yml）
  → CurrencyFreaksでレート取得
  → Firestoreの prices を更新
  → alerts をチェックし、条件を満たしたらFCMでプッシュ通知 & history に記録

GitHub Actions（1日1回・daily-close.yml）
  → その日の終値を dailyCloses に記録
  → 蓄積データから曜日別アノマリー統計を計算して anomalies に保存

あなたのiPhone（ホーム画面に追加したWebアプリ）
  → Firestoreの prices / alerts / history / anomalies をリアルタイム表示
  → 通知の許可 → FCMトークンをFirestoreに保存

（1回だけ手動）backfill-daily-closes.js
  → Stooq（無料・無登録）から過去2年分の日次終値を取得し dailyCloses に投入
  → これで運用開始直後からアノマリー分析が使えるようになる
```

---

## セットアップ手順

### 1. Firebaseの設定（既存プロジェクトを使用）

> ✅ `firebase-config.js` の `firebaseConfig` はいただいた値で編集済みです。以下の3〜4だけ残っています。

1. [Firebaseコンソール](https://console.firebase.google.com/) → プロジェクト `fx-alert-4334a` を開く
2. **Authentication** → 「Sign-in method」→ **匿名** を有効化（未設定なら）
3. ✅ 対応済み：**プロジェクトの設定 → Cloud Messaging** タブ → 「ウェブ構成」→「ウェブプッシュ証明書」で鍵ペアを生成し、`firebase-config.js` の `FCM_VAPID_KEY` に貼り付け済みです
4. ⬜ **未対応**：**プロジェクトの設定 → サービスアカウント** タブ → 「新しい秘密鍵の生成」→ JSONファイルをダウンロードし、後述のGitHub Secrets `FIREBASE_SERVICE_ACCOUNT` に中身をまるごと貼り付けてください（**他人に共有しないでください**）
5. **Firestore Database** → まだ無ければ「データベースを作成」（本番モードでOK、リージョンは `asia-northeast1` など任意）
6. **Firestore Database → ルール** タブ → このプロジェクトの `firestore.rules` の内容を貼り付けて公開

### 2. CurrencyFreaksのAPIキー

> ✅ APIキーはいただいたものを使います：`12dc0c54e7b946878bb1a3a18d5ab4ee`
> このキーはコードには埋め込んでいません。次の手順4でGitHub Secretsに登録してください。

### 3. GitHubリポジトリの作成

> ⚠️ 訂正：GitHub Pagesを無料で公開するには、個人の無料プランでは**リポジトリをPublicにする必要があります**（Privateのまま無料公開はできません）。APIキーやサービスアカウント鍵はコードに含めずGitHub Secretsで管理するので、Publicにしても問題ありません。

1. GitHubで新規リポジトリを作成（**Public**）
2. このプロジェクト一式（`firebase-config.js` を編集済みのもの）をpush

```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/あなたのユーザー名/リポジトリ名.git
git push -u origin main
```

### 4. GitHub Secretsの登録

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** で以下を登録：

| Name | 値 |
|---|---|
| `CURRENCYFREAKS_API_KEY` | `12dc0c54e7b946878bb1a3a18d5ab4ee` |
| `FIREBASE_SERVICE_ACCOUNT` | 手順1-4でダウンロードしたJSONファイルの中身全体 |

### 5. GitHub Pagesの有効化

**Settings → Pages** → Source を「Deploy from a branch」→ Branch を `main` / `/(root)` に設定して保存。
数分後に `https://あなたのユーザー名.github.io/リポジトリ名/` でアプリが公開されます。

### 6. 動作確認（手動実行）

**Actions** タブに2つのワークフローがあります。それぞれ「Run workflow」で手動実行して確認してください。

- **Check FX Rates**（60分ごと）→ 成功するとFirestoreの `prices` に3ペア分のドキュメントが作成されます
- **Record Daily Close & Anomalies**（1日1回）→ 成功すると `dailyCloses` に当日分、`anomalies` に集計結果が作成されます

### 7. 過去データのバックフィル（アノマリー分析用・1回だけ）

自分のPC（Windows11）で以下を実行します。Node.js 20以上が必要です（未インストールなら https://nodejs.org/ からLTS版を入れてください）。

```bash
cd fx-alert-pwa/scripts
npm install
set FIREBASE_SERVICE_ACCOUNT_PATH=C:\path\to\serviceAccount.json
node backfill-daily-closes.js
```

手順1-4でダウンロードしたサービスアカウントのJSONファイルのパスを `FIREBASE_SERVICE_ACCOUNT_PATH` に指定してください。
Stooq（無料・無登録）から過去2年分のUSD/JPY・USD/MXN・XAU/USDを取得し、MXN/JPYを計算して`dailyCloses`に投入、続けて曜日別アノマリー統計を計算します。実行が終わるとアプリのボード画面で各銘柄の「曜日アノマリー」を開けるようになります。

### 8. iPhoneでホーム画面に追加

1. Safariで公開URLを開く
2. 共有ボタン → 「ホーム画面に追加」
3. ホーム画面のアイコンから起動（これでPWAとして動作します）
4. アプリ内で何かをタップすると通知許可のダイアログが出るので「許可」を選択
   - これでこの端末のFCMトークンがFirestoreの `tokens` に保存されます

### 9. アラートを登録

「アラート」タブ →「＋」から、銘柄・方向（以上/以下）・指定値を入力して保存。
60分ごとの自動チェックで条件を満たすとプッシュ通知が届きます。

### 10. 曜日アノマリーを見る

「ボード」タブの各銘柄行にある「曜日アノマリー ▼」をタップすると、月〜金の平均変動率と勝率（上昇した日の割合）が棒グラフで表示されます。手順7のバックフィルを実行するまでは「データ集計中」と表示されます。

---

## 運用コストについて

- Firebase：Authentication（匿名）・Firestore・Cloud Messagingはすべて Spark（無料）プランの範囲内で完結。Blazeプランへの登録・カード登録は不要です。
- GitHub Actions：60分ごと(24回/日)＋1日1回(1回/日) の実行 × 30日 ≈ 750回/月。無料枠（Public repoは無制限、Privateでも2,000分/月）に対して余裕があります。
- CurrencyFreaks：`check-rates`が720回/月＋`record-daily-close`が30回/月 ＝ 合計約750回/月。無料枠1,000回/月以内に収まります（バックフィルは別枠のStooqを使うため、ここには含まれません）。

## トラブルシューティング

- **通知が届かない**：iPhoneの「設定 → 通知 → (Safariで追加したアプリ名)」で通知が許可されているか確認。iOS 16.4以降が必要です。
- **Actionsが失敗する**：Actionsのログで `CurrencyFreaks API error` が出ていないか確認（APIキー間違い・月間上限超過の可能性）。
- **ボードに価格が出ない**：Firestoreの `prices` コレクションにドキュメントがあるか、ブラウザのコンソールにエラーが出ていないか確認。
- **月をまたいでCurrencyFreaksの上限に達した場合**：翌月まで待つか、実行間隔を90分などに緩めてください（`.github/workflows/check-rates.yml` の cron を変更）。
- **「曜日アノマリー」がずっと「データ集計中」のまま**：手順7のバックフィルを実行したか確認してください。実行済みでも表示されない場合はFirestoreの `anomalies` コレクションにドキュメントがあるか確認してください。
- **バックフィルでStooqのエラーが出る**：エラーメッセージに表示されるURLをブラウザで直接開いてCSVが表示されるか確認してください。表示されない場合はStooq側の一時的なアクセス制限の可能性があるため、時間を置いて再実行してください。

## ファイル構成

```
index.html                             アプリ本体（3画面のPWA、ボードにアノマリー表示を含む）
style.css                              デザイン
app.js                                 Firestore連携・UI・FCM登録・アノマリー表示
firebase-config.js                     Firebaseプロジェクトの設定値（済） / ⬜VAPID鍵は未設定
firebase-messaging-sw.js               バックグラウンド通知用サービスワーカー
manifest.json                          PWAマニフェスト
icons/                                 アプリアイコン
firestore.rules                        ★Firebaseコンソールに貼るセキュリティルール
scripts/check-rates.js                 60分ごと：レート取得・アラート判定・通知
scripts/record-daily-close.js          1日1回：終値記録・アノマリー再計算
scripts/backfill-daily-closes.js       ★1回だけ手動実行：過去データの初期投入（Stooq）
scripts/lib/rates.js                   共通：CurrencyFreaksからレート取得
scripts/lib/anomaly.js                 共通：曜日別アノマリー統計の計算
scripts/package.json                   スクリプトの依存関係
.github/workflows/check-rates.yml      60分ごとの自動実行設定
.github/workflows/daily-close.yml      1日1回の自動実行設定
```
