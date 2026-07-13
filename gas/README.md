# GAS移行版（レートチェック定期実行基盤）

GitHub Actionsのcron scheduleは無料枠だとベストエフォートで、15分間隔を指定しても
実際は2〜3時間に1回程度しか発火しない。そのため定期実行の基盤をGoogle Apps Script (GAS) の
**時間主導トリガー**に移行した。GASは無料かつ定時性が高い（数分程度のズレはあるが、数時間飛ぶことはない）。

PWA本体（index.html / app.js / style.css / firestore.rules）は無変更。GASはFirestoreに
書き込むだけで、アプリ側は今まで通りFirestoreを購読しているだけなので影響はない。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `appsscript.json` | GASプロジェクトのマニフェスト（タイムゾーン=Asia/Tokyo） |
| `auth.gs` | サービスアカウントJSONからJWTを組み立ててアクセストークンを取得（50分キャッシュ） |
| `firestore.gs` | Firestore REST API（v1）を叩く最小限のヘルパー（get/commit/query/型変換） |
| `checkRates.gs` | **`checkRates`** — 15分ごとのレート取得・prices更新・アラート判定・通知 |
| `dailyClose.gs` | **`dailyClose`** — 1日1回の終値記録・曜日別アノマリー再計算 |
| `testUtils.gs` | 手動実行用の動作確認関数（`testAuth` / `testFetchRates` / `testCheckRatesOnce`） |

## セットアップ手順

### 1. GASプロジェクトを作成

[script.google.com](https://script.google.com/) で新規プロジェクトを作成し、上記6ファイルの内容を
そのままコピペする（ファイル名はコピペ元と合わせておくとわかりやすい）。
`appsscript.json` は、GASエディタの「プロジェクトの設定」→「"appsscript.json" マニフェスト ファイルを
エディタで表示する」を有効にすると編集できるようになる。

### 2. スクリプトプロパティを登録

「プロジェクトの設定」→「スクリプト プロパティ」で以下を登録する（GitHub Actionsの
Secretsに設定していたものと同じ値）。

| プロパティ名 | 内容 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | サービスアカウントJSONの中身をまるごと1行の文字列で |
| `CURRENCYFREAKS_API_KEY_1` | CurrencyFreaks APIキー（1本目） |
| `CURRENCYFREAKS_API_KEY_2` | CurrencyFreaks APIキー（2本目） |
| `CURRENCYFREAKS_API_KEY_3` | CurrencyFreaks APIキー（3本目） |
| `CURRENCYFREAKS_API_KEY_4` | CurrencyFreaks APIキー（4本目） |

### 3. 動作確認（トリガー設定前に）

GASエディタの関数選択プルダウンから以下を選んで実行し、ログ（表示 → ログ）を確認する。

1. `testAuth` — アクセストークンが取得できるか（サービスアカウントJSONの形式・スコープ確認）
2. `testFetchRates` — CurrencyFreaksからレートが取れるか（KEY_1の疎通確認）
3. `testCheckRatesOnce` — `checkRates` を市場クローズ判定なしで1回実行し、実際に
   Firestoreの `prices` / `intradayPrices` / `fetchLogs` が更新されるか、アプリ側で確認する

初回実行時はGoogleアカウントの権限承認ダイアログが出るので許可する。

### 4. トリガーを設定

GASエディタ左メニューの「トリガー」（時計アイコン）→「トリガーを追加」で以下を2つ作成する。

| 実行する関数 | イベントのソース | 種類 | 詳細 |
|---|---|---|---|
| `checkRates` | 時間主導型 | 分ベースのタイマー | 15分おき |
| `dailyClose` | 時間主導型 | 日付ベースのタイマー | 午前6時〜7時 |

`checkRates` は内部で市場クローズ判定（JST 土曜09:00〜月曜06:59はスキップ）を行うため、
トリガー自体は24時間365日15分おきに動かしっぱなしでよい。

### 5. GitHub Actions側

`.github/workflows/check-rates.yml` と `daily-close.yml` から `schedule:` は削除済みで、
`workflow_dispatch` の手動実行フォールバックのみ残っている。`scripts/` 配下のNode.jsスクリプトも
バックフィル・緊急時の手動実行用にそのまま残してある。

## 実装メモ

- Firestore REST APIへの認証はサービスアカウントJWT自前実装（`auth.gs`）。npm不要でGAS単体で完結する。
- `firestore.gs` の `fsRunQuery_` は `where` 句のみで取得し、`orderBy` は常に `__name__`
  （ドキュメント名。複合インデックス不要）でページングにのみ使う。データのソート（`dailyCloses`の日付順など）は
  呼び出し側でJS配列としてソートする。`where` + データフィールドの `orderBy` を組み合わせる複合クエリは
  Firestoreの複合インデックス作成が必要になるため使っていない。
- 数値フィールドはすべて `doubleValue` で書き込む。アプリ側は `Number()` で読んでいるため互換。
- `updatedAt` 等のタイムスタンプ系フィールドは `timestampValue`（ISO 8601文字列）で書く。
  Firestore上は本物のtimestamp型になるため、アプリ側の `.toDate()` / `.toMillis()` はそのまま動く。
- APIキーのローテーションは「実行時刻の分を15で割った商 % 4」方式に変更（GASの時間主導トリガーは
  秒・分のオフセットを指定できないため、旧版の `:03/:18/:33/:48` 固定スロット方式は使えない）。
  各キーが1時間に1回ずつ使われる性質は変わらない。
