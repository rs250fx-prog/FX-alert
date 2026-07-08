// 【任意・手動実行】intradayPrices（価格推移グラフ用の時系列データ）を間引く/削除するスクリプト。
//
// 運用方針として intradayPrices は自動削除せず蓄積し続けているため、
// データ量やFirestoreの使用量が気になってきたタイミングで、自分の判断で実行してください。
// デフォルトでは「指定日数より古いデータ」を削除します。
//
// 実行方法（ローカルのPCで）：
//   cd scripts
//   set FIREBASE_SERVICE_ACCOUNT_PATH=C:\path\to\serviceAccount.json   (Windowsの場合。Macは export)
//   set OLDER_THAN_DAYS=30   (任意。省略時は30日より古いものを削除)
//   node cleanup-intraday-prices.js
//
// 何件削除されるかを確認したいだけの場合は DRY_RUN=1 を指定してください（実際の削除は行われません）。
//   set DRY_RUN=1
//   node cleanup-intraday-prices.js

const fs = require("fs");
const admin = require("firebase-admin");

const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const OLDER_THAN_DAYS = Number(process.env.OLDER_THAN_DAYS || 30);
const DRY_RUN = process.env.DRY_RUN === "1";

if (!SERVICE_ACCOUNT_PATH && !SERVICE_ACCOUNT_JSON) {
  console.error(
    "FIREBASE_SERVICE_ACCOUNT_PATH（jsonファイルのパス）か FIREBASE_SERVICE_ACCOUNT（json文字列）のどちらかを設定してください"
  );
  process.exit(1);
}

const credentialJson = SERVICE_ACCOUNT_PATH
  ? JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"))
  : JSON.parse(SERVICE_ACCOUNT_JSON);

admin.initializeApp({ credential: admin.credential.cert(credentialJson) });
const db = admin.firestore();

(async () => {
  try {
    const cutoff = admin.firestore.Timestamp.fromMillis(
      Date.now() - OLDER_THAN_DAYS * 24 * 60 * 60 * 1000
    );

    console.log(
      `${OLDER_THAN_DAYS}日より古い intradayPrices を検索します（基準時刻: ${cutoff.toDate().toISOString()}）...`
    );

    const snap = await db
      .collection("intradayPrices")
      .where("timestamp", "<", cutoff)
      .get();

    console.log(`対象件数: ${snap.size}件`);

    if (snap.empty) {
      console.log("削除対象はありませんでした。");
      return;
    }

    if (DRY_RUN) {
      console.log("DRY_RUN=1 のため、実際の削除は行いません。");
      return;
    }

    // Firestoreのbatchは1回500件までなので分割
    const docs = snap.docs;
    const chunkSize = 450;
    for (let i = 0; i < docs.length; i += chunkSize) {
      const chunk = docs.slice(i, i + chunkSize);
      const batch = db.batch();
      chunk.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      console.log(`  ${Math.min(i + chunkSize, docs.length)} / ${docs.length} 件削除完了`);
    }

    console.log("掃除完了。");
  } catch (err) {
    console.error("実行中にエラーが発生しました:", err);
    process.exit(1);
  }
})();
