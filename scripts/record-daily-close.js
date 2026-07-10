// GitHub Actions から1日1回実行されるスクリプト。
// 1. CurrencyFreaksから現在レートを取得し、「その日の終値」としてdailyClosesに記録
// 2. 蓄積されたdailyClosesから曜日別アノマリー統計を再計算してanomaliesに保存

const admin = require("firebase-admin");
const { fetchRates } = require("./lib/rates");
const { computeAndStoreAnomalies } = require("./lib/anomaly");

// 1日1回の実行なのでキーローテーションは不要。KEY_1を固定で使用する。
// （KEY_1の月間消費：check-rates分 約528回 + daily-close分 約30回 ≒ 560回で無料枠1,000回に余裕あり）
const CURRENCYFREAKS_API_KEY = process.env.CURRENCYFREAKS_API_KEY_1;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!CURRENCYFREAKS_API_KEY) {
  console.error("環境変数 CURRENCYFREAKS_API_KEY_1 が設定されていません");
  process.exit(1);
}
if (!FIREBASE_SERVICE_ACCOUNT) {
  console.error("環境変数 FIREBASE_SERVICE_ACCOUNT が設定されていません");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

function todayDateString() {
  // UTC基準でYYYY-MM-DDを作る（Actionsのcronで指定した実行時刻＝ほぼ日本の朝に対応する前日終値のイメージ）
  return new Date().toISOString().slice(0, 10);
}

async function recordDailyCloses(prices, date) {
  const batch = db.batch();
  for (const [pair, price] of Object.entries(prices)) {
    const ref = db.collection("dailyCloses").doc(`${pair}_${date}`);
    batch.set(ref, {
      pair,
      date,
      price,
      recordedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
  await batch.commit();
}

(async () => {
  try {
    const prices = await fetchRates(CURRENCYFREAKS_API_KEY);
    const date = todayDateString();
    console.log(`終値記録 (${date}):`, prices);
    await recordDailyCloses(prices, date);
    await computeAndStoreAnomalies(db, admin);
    console.log("完了");
  } catch (err) {
    console.error("実行中にエラーが発生しました:", err);
    process.exit(1);
  }
})();
