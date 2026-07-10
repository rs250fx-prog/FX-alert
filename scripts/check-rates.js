// GitHub Actions から15分ごと（平日のみ）に実行されるスクリプト。
// 1. 実行時刻（分）から4アカウント分のAPIキーを時刻スロット方式で選択
// 2. CurrencyFreaksから為替・金のレートを取得
// 3. Firestoreの prices コレクションを更新（アプリのボード表示用）
// 4. Firestoreの alerts を全件チェックし、条件を満たしたものを通知
// 5. 通知したら notified=true、条件が外れたら notified=false に戻す
// 6. 通知内容を history コレクションに記録
//
// APIキーのローテーション（fx-alert-spec.md 11章）：
//   毎時 :03 → KEY_1 / :18 → KEY_2 / :33 → KEY_3 / :48 → KEY_4
//   各キーは1時間に1回しか呼ばれないため、4キー・15分間隔でも
//   1キーあたりの消費量は「60分ごと・1キー」構成時と同じ。
//   状態をFirestore等に持たず、実行時刻の「分」だけから一意にキーを決めるので
//   1回の実行がスキップされても他のスロットに影響しない。

const admin = require("firebase-admin");
const { fetchRates } = require("./lib/rates");

const API_KEYS = [
  process.env.CURRENCYFREAKS_API_KEY_1,
  process.env.CURRENCYFREAKS_API_KEY_2,
  process.env.CURRENCYFREAKS_API_KEY_3,
  process.env.CURRENCYFREAKS_API_KEY_4
];
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

function selectApiKeyBySlot(date) {
  const minute = date.getUTCMinutes();
  // :03, :18, :33, :48 の15分刻みスロットに応じてキーを固定的に割り当てる。
  // スロットからズレた時刻に実行された場合は直近の過去スロットに丸める。
  const slotIndex = Math.floor(((minute - 3 + 60) % 60) / 15) % 4;
  return { key: API_KEYS[slotIndex], slotIndex };
}

if (API_KEYS.some((k) => !k)) {
  console.error("環境変数 CURRENCYFREAKS_API_KEY_1〜_4 のいずれかが設定されていません");
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

async function recordIntradayPrices(prices) {
  // 直近24時間の値動きグラフ表示用に、実行のたびに1件ずつ追記していく。
  // 削除処理は行わず蓄積する方針（重くなった場合は別途手動掃除スクリプトで対応）。
  const batch = db.batch();
  for (const [pair, price] of Object.entries(prices)) {
    const ref = db.collection("intradayPrices").doc();
    batch.set(ref, {
      pair,
      price,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  }
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

// 実行の成否を fetchLogs に1件記録する（設定画面のログリスト表示用）。
// ログ書き込み自体の失敗で本処理を落とさないよう、エラーは握りつぶしてコンソールにだけ出す。
async function writeFetchLog(status, keyIndex, message) {
  try {
    await db.collection("fetchLogs").add({
      status, // "success" | "error"
      keyIndex, // 使用したKEY番号（1〜4）
      message,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (logErr) {
    console.error("fetchLogsへの書き込みに失敗しました:", logErr);
  }
}

(async () => {
  const { key, slotIndex } = selectApiKeyBySlot(new Date());
  const keyNumber = slotIndex + 1;
  try {
    console.log(`使用キー: KEY_${keyNumber}`);
    const prices = await fetchRates(key);
    console.log("取得したレート:", prices);
    await updatePrices(prices);
    await recordIntradayPrices(prices);
    const tokens = await getTokens();
    await evaluateAlerts(prices, tokens);
    await writeFetchLog(
      "success",
      keyNumber,
      `USDJPY ${prices.USDJPY.toFixed(3)} / MXNJPY ${prices.MXNJPY.toFixed(3)} / XAUUSD ${prices.XAUUSD.toFixed(2)}`
    );
    console.log("完了");
  } catch (err) {
    console.error("実行中にエラーが発生しました:", err);
    await writeFetchLog("error", keyNumber, String(err?.message || err).slice(0, 500));
    process.exit(1);
  }
})();
