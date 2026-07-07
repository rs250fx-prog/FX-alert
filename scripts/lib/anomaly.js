// dailyCloses（各銘柄の日次終値）から曜日別の平均変動率・勝率(上昇した日の割合)を計算し、
// Firestoreの anomalies/{pair} に保存する。バックフィル後・毎日の終値記録後の両方から呼ばれる。

const PAIRS = ["MXNJPY", "USDJPY", "XAUUSD"];
const WEEKDAY_NAMES = { 1: "月", 2: "火", 3: "水", 4: "木", 5: "金" };

async function computeAndStoreAnomalies(db, admin) {
  for (const pair of PAIRS) {
    const snap = await db
      .collection("dailyCloses")
      .where("pair", "==", pair)
      .orderBy("date", "asc")
      .get();

    const rows = snap.docs.map((d) => d.data());
    if (rows.length < 2) {
      console.log(`[anomaly] ${pair}: データ不足のためスキップ (${rows.length}件)`);
      continue;
    }

    // 曜日(1=月...5=金) ごとに変動率(%)を集計
    const buckets = { 1: [], 2: [], 3: [], 4: [], 5: [] };

    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1];
      const curr = rows[i];
      if (!prev.price || !curr.price) continue;

      // date は "YYYY-MM-DD"。UTC正午として解釈し、曜日判定のタイムゾーンずれを避ける。
      const weekday = new Date(`${curr.date}T12:00:00Z`).getUTCDay(); // 0=日 ... 6=土
      if (weekday < 1 || weekday > 5) continue; // 土日はスキップ

      const pctChange = ((curr.price - prev.price) / prev.price) * 100;
      buckets[weekday].push(pctChange);
    }

    const weekdayStats = {};
    for (const [wd, changes] of Object.entries(buckets)) {
      if (changes.length === 0) {
        weekdayStats[wd] = { label: WEEKDAY_NAMES[wd], avgChangePct: null, winRatePct: null, sampleCount: 0 };
        continue;
      }
      const avgChangePct = changes.reduce((a, b) => a + b, 0) / changes.length;
      const winRatePct = (changes.filter((c) => c > 0).length / changes.length) * 100;
      weekdayStats[wd] = {
        label: WEEKDAY_NAMES[wd],
        avgChangePct: Number(avgChangePct.toFixed(4)),
        winRatePct: Number(winRatePct.toFixed(1)),
        sampleCount: changes.length
      };
    }

    await db.collection("anomalies").doc(pair).set({
      pair,
      weekdayStats,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`[anomaly] ${pair}: 更新完了`);
  }
}

module.exports = { computeAndStoreAnomalies };
