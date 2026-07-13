// GAS の時間主導トリガー（1日1回・午前6〜7時目安）から実行される日次処理。
// 旧 scripts/record-daily-close.js + scripts/lib/anomaly.js の完全移植。
//
// 1. CurrencyFreaksから現在レートを取得し、「その日の終値」としてdailyClosesに記録
// 2. 蓄積されたdailyClosesから曜日別アノマリー統計を再計算してanomaliesに保存
//
// 1日1回の実行なのでキーローテーションは不要。KEY_1を固定で使用する
// （fetchRates_ は checkRates.gs で定義済みのものをそのまま流用する）。

var PAIRS_ = ["MXNJPY", "USDJPY", "XAUUSD"];
var WEEKDAY_NAMES_ = { 1: "月", 2: "火", 3: "水", 4: "木", 5: "金" };

// dailyClose トリガーのエントリ関数。
// ここで投げた例外はGASのトリガー失敗通知メール（ユーザーのGoogleアカウント宛）で検知できるよう、
// ログ出力後に再スローする（checkRatesとは異なり15分おきではなく1日1回のため、失敗を握りつぶさない）。
function dailyClose() {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty("CURRENCYFREAKS_API_KEY_1");
    if (!apiKey) {
      throw new Error("スクリプトプロパティ CURRENCYFREAKS_API_KEY_1 が設定されていません");
    }

    var prices = fetchRates_(apiKey);
    var date = todayDateString_();
    Logger.log("終値記録 (" + date + "): " + JSON.stringify(prices));

    recordDailyCloses_(prices, date);
    computeAndStoreAnomalies_();
    Logger.log("完了");
  } catch (err) {
    Logger.log("実行中にエラーが発生しました: " + err);
    throw err;
  }
}

// UTC基準でYYYY-MM-DDを作る（Actions版と同じロジック。タイムゾーンはスクリプトの実行環境に依存しない）。
function todayDateString_() {
  return new Date().toISOString().slice(0, 10);
}

function recordDailyCloses_(prices, date) {
  var writes = Object.keys(prices).map(function (pair) {
    return fsSetWrite_("dailyCloses/" + pair + "_" + date, {
      pair: pair,
      date: date,
      price: prices[pair],
      recordedAt: fsServerTimestamp_()
    });
  });
  fsCommit_(writes);
}

// dailyCloses（各銘柄の日次終値）から曜日別の平均変動率・勝率(上昇した日の割合)を計算し、
// Firestoreの anomalies/{pair} に保存する。
function computeAndStoreAnomalies_() {
  PAIRS_.forEach(function (pair) {
    // 複合インデックスを避けるため where のみで取得し、date昇順ソートはGAS側で行う。
    var records = fsRunQuery_("dailyCloses", fsEqualsFilter_("pair", pair));
    var rows = records.map(function (r) {
      return r.data;
    });
    rows.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });

    if (rows.length < 2) {
      Logger.log("[anomaly] " + pair + ": データ不足のためスキップ (" + rows.length + "件)");
      return;
    }

    // 曜日(1=月...5=金) ごとに変動率(%)を集計
    var buckets = { 1: [], 2: [], 3: [], 4: [], 5: [] };

    for (var i = 1; i < rows.length; i++) {
      var prev = rows[i - 1];
      var curr = rows[i];
      if (!prev.price || !curr.price) continue;

      // date は "YYYY-MM-DD"。UTC正午として解釈し、曜日判定のタイムゾーンずれを避ける。
      var weekday = new Date(curr.date + "T12:00:00Z").getUTCDay(); // 0=日 ... 6=土
      if (weekday < 1 || weekday > 5) continue; // 土日はスキップ

      var pctChange = ((curr.price - prev.price) / prev.price) * 100;
      buckets[weekday].push(pctChange);
    }

    var weekdayStats = {};
    Object.keys(buckets).forEach(function (wd) {
      var changes = buckets[wd];
      if (changes.length === 0) {
        weekdayStats[wd] = { label: WEEKDAY_NAMES_[wd], avgChangePct: null, winRatePct: null, sampleCount: 0 };
        return;
      }
      var avgChangePct = changes.reduce(function (a, b) { return a + b; }, 0) / changes.length;
      var winRatePct = (changes.filter(function (c) { return c > 0; }).length / changes.length) * 100;
      weekdayStats[wd] = {
        label: WEEKDAY_NAMES_[wd],
        avgChangePct: Number(avgChangePct.toFixed(4)),
        winRatePct: Number(winRatePct.toFixed(1)),
        sampleCount: changes.length
      };
    });

    fsCommit_([
      fsSetWrite_("anomalies/" + pair, {
        pair: pair,
        weekdayStats: weekdayStats,
        updatedAt: fsServerTimestamp_()
      })
    ]);
    Logger.log("[anomaly] " + pair + ": 更新完了");
  });
}
