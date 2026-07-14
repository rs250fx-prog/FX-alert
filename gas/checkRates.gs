// GAS の時間主導トリガーから15分ごとに実行されるメイン処理。
// 旧 scripts/check-rates.js（GitHub Actions版）の完全移植。
//
// 1. 市場クローズ判定（JST 土曜09:00〜月曜06:59は何もしない）
// 2. 実行時刻の「分」から4アカウント分のAPIキーをローテーション選択
// 3. CurrencyFreaksから為替・金のレートを取得
// 4. Firestoreの prices コレクションを更新（アプリのボード表示用）
// 5. intradayPrices に値動き履歴を1件ずつ追記
// 6. alerts を全件チェックし、条件を満たしたものを通知
// 7. 通知したら notified=true、条件が外れたら notified=false に戻す
// 8. 通知内容を history コレクションに記録
// 9. 成功/失敗を問わず fetchLogs に1件記録する
//
// APIキーのローテーション:
//   GitHub Actions版は「:03/:18/:33/:48固定スロット」だったが、
//   GASの時間主導トリガーは分単位のオフセットを指定できないため、
//   「実行時刻の分を15で割った商 % 4」でキーを選ぶ方式に変更する。
//   各キーが毎時1回ずつ使われる性質（消費量の均等配分）は現行と同じ。

var PAIR_LABELS_ = {
  MXNJPY: "MXN/JPY",
  USDJPY: "USD/JPY",
  XAUUSD: "GOLD (XAU/USD)"
};

// GASはファイル間のトップレベルvar初期化順序を保証しないため、
// firestore.gs の PROJECT_ID_ に依存するこの値は呼び出し時に都度組み立てる。
function fcmSendUrl_() {
  return "https://fcm.googleapis.com/v1/projects/" + PROJECT_ID_ + "/messages:send";
}

// checkRates トリガーのエントリ関数。
// skipMarketCheck に true を渡すと市場クローズ判定を無視して強制実行する（手動テスト用）。
function checkRates(skipMarketCheck) {
  var now = new Date();
  if (!skipMarketCheck && isMarketClosed_(now)) {
    Logger.log("市場クローズ時間帯のためスキップします");
    return;
  }

  var keyNumber = selectApiKeyNumber_(now);

  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty("CURRENCYFREAKS_API_KEY_" + keyNumber);
    if (!apiKey) {
      throw new Error("スクリプトプロパティ CURRENCYFREAKS_API_KEY_" + keyNumber + " が設定されていません");
    }

    Logger.log("使用キー: KEY_" + keyNumber);
    var prices = fetchRates_(apiKey);
    Logger.log("取得したレート: " + JSON.stringify(prices));

    updatePrices_(prices);

    // intradayPrices（値動きグラフ用の補助データ）はここで失敗しても、
    // 本体機能であるアラート判定・通知まで道連れで止めない。
    // 失敗時はLoggerに出した上で、成功ログのmessageにも失敗した旨を残す。
    var intradayError = null;
    try {
      recordIntradayPrices_(prices);
    } catch (intradayErr) {
      intradayError = intradayErr;
      Logger.log("intradayPricesの書き込みに失敗しました（処理は継続します）: " + intradayErr);
    }

    var tokens = getTokens_();
    evaluateAlerts_(prices, tokens);

    var message =
      "USDJPY " + prices.USDJPY.toFixed(3) + " / MXNJPY " + prices.MXNJPY.toFixed(3) + " / XAUUSD " + prices.XAUUSD.toFixed(2);
    if (intradayError) {
      message += " ※intradayPrices書き込み失敗: " + String((intradayError && intradayError.message) || intradayError).slice(0, 200);
    }
    writeFetchLog_("success", keyNumber, message);
    Logger.log("完了");
  } catch (err) {
    Logger.log("実行中にエラーが発生しました: " + err);
    writeFetchLog_("error", keyNumber, String((err && err.message) || err).slice(0, 500));
  }
}

// JST基準で市場クローズ時間帯（土曜09:00〜月曜06:59）かどうかを判定する。
function isMarketClosed_(now) {
  var dow = Number(Utilities.formatDate(now, "Asia/Tokyo", "u")); // 1=月 ... 7=日
  var hour = Number(Utilities.formatDate(now, "Asia/Tokyo", "HH"));
  if (dow === 6 && hour >= 9) return true; // 土曜09:00以降
  if (dow === 7) return true; // 日曜終日
  if (dow === 1 && hour < 7) return true; // 月曜06:59まで
  return false;
}

// 実行時刻の「分」から使用するAPIキー番号（1〜4）を選ぶ。
function selectApiKeyNumber_(now) {
  var minute = Number(Utilities.formatDate(now, "Asia/Tokyo", "m"));
  var keyIndex = Math.floor(minute / 15) % 4;
  return keyIndex + 1;
}

// CurrencyFreaksから現在レートを取得し、MXN/JPY・USD/JPY・GOLD(XAU/USD)に変換する。
// 旧 scripts/lib/rates.js と同じ変換ロジック。
function fetchRates_(apiKey) {
  var url = "https://api.currencyfreaks.com/v2.0/rates/latest?apikey=" + encodeURIComponent(apiKey) + "&symbols=JPY,MXN,XAU";
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error("CurrencyFreaks APIエラー: " + code + " " + res.getContentText());
  }
  var data = JSON.parse(res.getContentText());
  var jpyPerUsd = parseFloat(data.rates.JPY);
  var mxnPerUsd = parseFloat(data.rates.MXN);
  var xauPerUsd = parseFloat(data.rates.XAU); // troy oz per USD（非常に小さい値）

  return {
    USDJPY: jpyPerUsd,
    MXNJPY: jpyPerUsd / mxnPerUsd,
    XAUUSD: 1 / xauPerUsd
  };
}

// prices/{pair} を更新する。前回値を先に読んでからpreviousPriceに落とす（▲▼表示用）。
function updatePrices_(prices) {
  var writes = Object.keys(prices).map(function (pair) {
    var existing = fsGetDoc_("prices/" + pair);
    var previousPrice = existing ? existing.data.price : null;
    return fsSetWrite_("prices/" + pair, {
      price: prices[pair],
      previousPrice: previousPrice,
      updatedAt: fsServerTimestamp_()
    });
  });
  fsCommit_(writes);
}

// intradayPrices に3ペア分を自動採番IDで追記する（削除はせず蓄積する方針）。
function recordIntradayPrices_(prices) {
  var writes = Object.keys(prices).map(function (pair) {
    return fsCreateWrite_("intradayPrices", {
      pair: pair,
      price: prices[pair],
      timestamp: fsServerTimestamp_()
    });
  });
  fsCommit_(writes);
}

// 登録済みFCMトークン（ドキュメントID）一覧を返す。
function getTokens_() {
  return fsListAll_("tokens").map(function (rec) {
    return rec.id;
  });
}

// FCMへプッシュ通知を送る。無効化されたトークンはFirestoreから削除する。
function sendPush_(tokens, title, body, data) {
  if (!tokens || tokens.length === 0) {
    Logger.log("通知トークンが登録されていません（アプリを一度開いて通知を許可してください）");
    return;
  }

  tokens.forEach(function (token) {
    var payload = { message: { token: token, notification: { title: title, body: body }, data: data } };
    var res = UrlFetchApp.fetch(fcmSendUrl_(), {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + getAccessToken_() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200) return;

    var errorCode = extractFcmErrorCode_(res.getContentText());
    if ((code === 404 && errorCode === "UNREGISTERED") || (code === 400 && errorCode === "INVALID_ARGUMENT")) {
      deleteInvalidToken_(token);
    } else {
      Logger.log("push送信失敗 token=" + token + " code=" + code + " body=" + res.getContentText());
    }
  });
}

// FCMのエラーレスポンスから errorCode（UNREGISTERED / INVALID_ARGUMENT等）を取り出す。
function extractFcmErrorCode_(bodyText) {
  try {
    var parsed = JSON.parse(bodyText);
    var details = (parsed.error && parsed.error.details) || [];
    for (var i = 0; i < details.length; i++) {
      if (details[i].errorCode) return details[i].errorCode;
    }
    return (parsed.error && parsed.error.status) || "";
  } catch (e) {
    return "";
  }
}

function deleteInvalidToken_(token) {
  try {
    fsCommit_([{ delete: DOCUMENTS_PATH_ + "/tokens/" + token }]);
  } catch (e) {
    Logger.log("無効トークンの削除に失敗しました: " + token + " " + e);
  }
}

// alerts を全件チェックし、条件成立/解除を判定して通知・履歴・状態更新を行う。
function evaluateAlerts_(prices, tokens) {
  var alerts = fsListAll_("alerts");
  var writes = [];

  alerts.forEach(function (rec) {
    var alert = rec.data;
    var price = prices[alert.pair];
    if (typeof price !== "number" || isNaN(price)) return;

    var conditionMet = alert.direction === "above" ? price >= alert.target : price <= alert.target;

    if (conditionMet && !alert.notified) {
      writes.push(fsUpdateWrite_("alerts/" + rec.id, { notified: true }));

      var label = PAIR_LABELS_[alert.pair] || alert.pair;
      var arrow = alert.direction === "above" ? "↑" : "↓";
      var title = "🔔 " + label + " " + alert.target + arrow;
      var body = "設定価格：" + alert.target + "\n現在価格：" + price;
      sendPush_(tokens, title, body, { pair: alert.pair });

      writes.push(fsCreateWrite_("history", {
        pair: alert.pair,
        target: alert.target,
        direction: alert.direction,
        price: price,
        notifiedAt: fsServerTimestamp_()
      }));
    } else if (!conditionMet && alert.notified) {
      // 価格が指定値の反対側に戻ったら、再度クロスしたときに通知できるようリセット
      writes.push(fsUpdateWrite_("alerts/" + rec.id, { notified: false }));
    }
  });

  if (writes.length > 0) fsCommit_(writes);
}

// 実行の成否を fetchLogs に1件記録する（設定画面のログリスト表示用）。
// ログ書き込み自体の失敗で本処理を落とさないよう、エラーは握りつぶしてログにだけ出す。
function writeFetchLog_(status, keyIndex, message) {
  try {
    fsCommit_([
      fsCreateWrite_("fetchLogs", {
        status: status, // "success" | "error"
        keyIndex: keyIndex, // 使用したKEY番号（1〜4）
        message: message,
        timestamp: fsServerTimestamp_()
      })
    ]);
  } catch (logErr) {
    Logger.log("fetchLogsへの書き込みに失敗しました: " + logErr);
  }
}
