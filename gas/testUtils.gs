// GASエディタの関数選択プルダウンから手動実行して動作確認するための小さな関数群。
// 末尾アンダースコアを付けていない（＝プルダウンに表示される）のはこのファイルの関数だけ。

// スクリプトプロパティとサービスアカウントの設定だけを検証する。Firestoreへの書き込みは行わない。
function testAuth() {
  try {
    var token = getAccessToken_();
    Logger.log("アクセストークン取得成功: " + token.slice(0, 20) + "...(以下省略)");
  } catch (e) {
    Logger.log("アクセストークン取得失敗: " + e);
  }
}

// KEY_1でCurrencyFreaksからレートを取得するだけ試す。Firestoreへの書き込みは行わない。
function testFetchRates() {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty("CURRENCYFREAKS_API_KEY_1");
    if (!apiKey) {
      Logger.log("スクリプトプロパティ CURRENCYFREAKS_API_KEY_1 が設定されていません");
      return;
    }
    var prices = fetchRates_(apiKey);
    Logger.log("取得したレート: " + JSON.stringify(prices));
  } catch (e) {
    Logger.log("レート取得失敗: " + e);
  }
}

// checkRates本体を、市場クローズ判定をスキップして1回だけ実行する（休日・夜間でも動作確認できる）。
// Firestoreへの実書き込み・実通知が発生するので注意。
function testCheckRatesOnce() {
  checkRates(true);
}
