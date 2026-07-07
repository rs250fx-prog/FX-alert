// GitHub Actions から60分ごとに実行されるスクリプト。
// 1. CurrencyFreaksから為替・金のレートを取得
// 2. Firestoreの prices コレクションを更新（アプリのボード表示用）
// 3. Firestoreの alerts を全件チェックし、条件を満たしたものを通知
// 4. 通知したら notified=true、条件が外れたら notified=false に戻す
// 5. 通知内容を history コレクションに記録

const admin = require("firebase-admin");
const { fetchRates } = require("./lib/rates");

const CURRENCYFREAKS_API_KEY = process.env.CURRENCYFREAKS_API_KEY;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!CURRENCYFREAKS_API_KEY) {
  console.error("環境変数 CURRENCYFREAKS_API_KEY が設定されていません");
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
const messaging = admin.messaging();

const PAIR_LABELS = {
  MXNJPY: "MXN/JPY",
  USDJPY: "USD/JPY",
  XAUUSD: "GOLD (XAU/USD)"
};

async function updatePrices(prices) {
  // 前回値を先に読み込んでから今回値を書き込む（▲▼表示をアプリ再起動後も正しく出すため）
  const pairs = Object.keys(prices);
  const existingSnaps = await Promise.all(
    pairs.map((pair) => db.collection("prices").doc(pair).get())
  );

  const batch = db.batch();
  pairs.forEach((pair, i) => {
    const price = prices[pair];
    const existing = existingSnaps[i].exists ? existingSnaps[i].data() : null;
    const previousPrice = existing ? existing.price : null;

    const ref = db.collection("prices").doc(pair);
    batch.set(ref, {
      price,
      previousPrice,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
  await batch.commit();
}

async function getTokens() {
  const snap = await db.collection("tokens").get();
  return snap.docs.map((d) => d.id);
}

async function sendPush(tokens, title, body, data) {
  if (tokens.length === 0) {
    console.warn("通知トークンが登録されていません（アプリを一度開いて通知を許可してください）");
    return;
  }
  const results = await Promise.allSettled(
    tokens.map((token) =>
      messaging.send({ token, notification: { title, body }, data })
    )
  );
  // 無効になったトークン（アプリ削除・許可取り消しなど）はFirestoreから掃除する
  await Promise.all(
    results.map((r, i) => {
      if (r.status === "rejected") {
        const code = r.reason?.errorInfo?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
          return db.collection("tokens").doc(tokens[i]).delete().catch(() => {});
        }
        console.error("push send failed", r.reason?.message || r.reason);
      }
      return Promise.resolve();
    })
  );
}

async function evaluateAlerts(prices, tokens) {
  const snap = await db.collection("alerts").get();
  const batch = db.batch();
  let batchHasWrites = false;

  for (const doc of snap.docs) {
    const alert = doc.data();
    const price = prices[alert.pair];
    if (typeof price !== "number" || Number.isNaN(price)) continue;

    const conditionMet =
      alert.direction === "above" ? price >= alert.target : price <= alert.target;

    if (conditionMet && !alert.notified) {
      batch.update(doc.ref, { notified: true });
      batchHasWrites = true;

      const label = PAIR_LABELS[alert.pair] || alert.pair;
      const arrowWord = alert.direction === "above" ? "以上" : "以下";
      const title = `🔔 ${label} ${alert.target}${arrowWord === "以上" ? "↑" : "↓"}`;
      const body = `設定価格：${alert.target}\n現在価格：${price}`;

      await sendPush(tokens, title, body, { pair: alert.pair });

      const historyRef = db.collection("history").doc();
      batch.set(historyRef, {
        pair: alert.pair,
        target: alert.target,
        direction: alert.direction,
        price,
        notifiedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else if (!conditionMet && alert.notified) {
      // 価格が指定値の反対側に戻ったら、再度クロスしたときに通知できるようリセット
      batch.update(doc.ref, { notified: false });
      batchHasWrites = true;
    }
  }

  if (batchHasWrites) await batch.commit();
}

(async () => {
  try {
    const prices = await fetchRates(CURRENCYFREAKS_API_KEY);
    console.log("取得したレート:", prices);
    await updatePrices(prices);
    const tokens = await getTokens();
    await evaluateAlerts(prices, tokens);
    console.log("完了");
  } catch (err) {
    console.error("実行中にエラーが発生しました:", err);
    process.exit(1);
  }
})();
