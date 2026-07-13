// サービスアカウント(FIREBASE_SERVICE_ACCOUNT)からJWTを自前で組み立て、
// Google OAuth2トークンエンドポイントでアクセストークンに交換する。
// firestore.gs / checkRates.gs / dailyClose.gs から共通で利用する。
//
// スコープ:
//   https://www.googleapis.com/auth/datastore        … Firestore REST API
//   https://www.googleapis.com/auth/firebase.messaging … FCM送信API
//
// 発行したトークンは CacheService に約50分キャッシュし、
// 15分おきに実行されるcheckRatesが毎回トークンを発行しないようにする。

var TOKEN_SCOPES_ = [
  "https://www.googleapis.com/auth/datastore",
  "https://www.googleapis.com/auth/firebase.messaging"
].join(" ");

var TOKEN_URL_ = "https://oauth2.googleapis.com/token";
var TOKEN_CACHE_KEY_ = "fx_alert_access_token";
var TOKEN_CACHE_SECONDS_ = 50 * 60; // 50分（実際の有効期限は1時間）

// スクリプトプロパティ FIREBASE_SERVICE_ACCOUNT から取得したアクセストークンを返す。
// CacheServiceにヒットすればそれを返し、なければ新規発行してキャッシュする。
function getAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(TOKEN_CACHE_KEY_);
  if (cached) return cached;

  var token = issueAccessToken_();
  cache.put(TOKEN_CACHE_KEY_, token, TOKEN_CACHE_SECONDS_);
  return token;
}

// サービスアカウントJSONからJWTを組み立てて署名し、アクセストークンに交換する。
function issueAccessToken_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) {
    throw new Error("スクリプトプロパティ FIREBASE_SERVICE_ACCOUNT が設定されていません");
  }
  var serviceAccount = JSON.parse(raw);

  var nowSec = Math.floor(Date.now() / 1000);
  var header = { alg: "RS256", typ: "JWT" };
  var claimSet = {
    iss: serviceAccount.client_email,
    scope: TOKEN_SCOPES_,
    aud: TOKEN_URL_,
    iat: nowSec,
    exp: nowSec + 3600
  };

  var signingInput = base64UrlEncodeJson_(header) + "." + base64UrlEncodeJson_(claimSet);
  var signatureBytes = Utilities.computeRsaSha256Signature(signingInput, serviceAccount.private_key);
  var jwt = signingInput + "." + base64UrlEncodeBytes_(signatureBytes);

  var res = UrlFetchApp.fetch(TOKEN_URL_, {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    },
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error("アクセストークン取得に失敗しました: " + code + " " + res.getContentText());
  }

  var body = JSON.parse(res.getContentText());
  return body.access_token;
}

// オブジェクトをJSON文字列化してbase64url変換する。
function base64UrlEncodeJson_(obj) {
  return base64UrlEncodeBytes_(Utilities.newBlob(JSON.stringify(obj)).getBytes());
}

// バイト配列を base64url（パディングなし、+/を-_に置換）にエンコードする。
function base64UrlEncodeBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}
