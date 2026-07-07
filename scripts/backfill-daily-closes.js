// 【1回だけ手動実行】過去の日次終値をStooq（無料・APIキー不要）から取得し、
// Firestoreの dailyCloses に投入した上で、曜日別アノマリー統計を計算する。
//
// 実行方法（ローカルのPCで）：
//   cd scripts
//   npm install
//   set FIREBASE_SERVICE_ACCOUNT_PATH=C:\path\to\serviceAccount.json   (Windowsの場合。Macは export)
//   node backfill-daily-closes.js
//
// BACKFILL_YEARS 環境変数で遡る年数を変更できます（デフォルト2年）。

const fs = require("fs");
const admin = require("firebase-admin");
const { computeAndStoreAnomalies } = require("./lib/anomaly");

const BACKFILL_YEARS = Number(process.env.BACKFILL_YEARS || 2);
const SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

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

// StooqのシンボルとFirestore上のペア名の対応。MXNJPYは直接シンボルが無いことがあるため
// USDJPY と USDMXN から計算する。
const STOOQ_SYMBOLS = ["usdjpy", "usdmxn", "xauusd"];

function formatDateForStooq(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

async function fetchStooqSeries(symbol, d1, d2) {
  const url = `https://stooq.com/q/d/l/?s=${symbol}&d1=${d1}&d2=${d2}&i=d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; fx-alert-backfill/1.0)" }
  });
  const text = await res.text();

  if (!text.startsWith("Date,")) {
    throw new Error(
      `Stooqからの応答が想定と異なります（symbol=${symbol}）。手動でブラウザから ${url} を開いて内容を確認してください。\n先頭: ${text.slice(0, 120)}`
    );
  }

  const lines = text.trim().split("\n").slice(1); // ヘッダー行を除く
  const series = new Map(); // date -> close
  for (const line of lines) {
    const [date, , , , close] = line.split(",");
    if (date && close && close !== "") {
      series.set(date, parseFloat(close));
    }
  }
  return series;
}

(async () => {
  try {
    const d2 = new Date();
    const d1 = new Date();
    d1.setFullYear(d1.getFullYear() - BACKFILL_YEARS);
    const d1Str = formatDateForStooq(d1);
    const d2Str = formatDateForStooq(d2);

    console.log(`Stooqから ${d1Str} 〜 ${d2Str} の日次データを取得します...`);

    const seriesByStooqSymbol = {};
    for (const symbol of STOOQ_SYMBOLS) {
      console.log(`  取得中: ${symbol}`);
      seriesByStooqSymbol[symbol] = await fetchStooqSeries(symbol, d1Str, d2Str);
    }

    const usdjpy = seriesByStooqSymbol["usdjpy"];
    const usdmxn = seriesByStooqSymbol["usdmxn"];
    const xauusd = seriesByStooqSymbol["xauusd"];

    // 3系列すべてに存在する日付だけを使う
    const commonDates = [...usdjpy.keys()].filter((d) => usdmxn.has(d) && xauusd.has(d)).sort();

    console.log(`共通する取引日: ${commonDates.length}日分`);
    if (commonDates.length === 0) {
      throw new Error("共通の日付が見つかりませんでした。Stooqのシンボル名を確認してください。");
    }

    const docs = [];
    for (const date of commonDates) {
      const usdjpyClose = usdjpy.get(date);
      const usdmxnClose = usdmxn.get(date);
      const xauusdClose = xauusd.get(date);
      const mxnjpyClose = usdjpyClose / usdmxnClose;

      docs.push({ id: `USDJPY_${date}`, pair: "USDJPY", date, price: usdjpyClose });
      docs.push({ id: `XAUUSD_${date}`, pair: "XAUUSD", date, price: xauusdClose });
      docs.push({ id: `MXNJPY_${date}`, pair: "MXNJPY", date, price: mxnjpyClose });
    }

    console.log(`Firestoreに ${docs.length}件書き込みます...`);

    // Firestoreのbatchは1回500件までなので分割
    const chunkSize = 450;
    for (let i = 0; i < docs.length; i += chunkSize) {
      const chunk = docs.slice(i, i + chunkSize);
      const batch = db.batch();
      for (const d of chunk) {
        const ref = db.collection("dailyCloses").doc(d.id);
        batch.set(ref, {
          pair: d.pair,
          date: d.date,
          price: d.price,
          recordedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      await batch.commit();
      console.log(`  ${Math.min(i + chunkSize, docs.length)} / ${docs.length} 件完了`);
    }

    console.log("アノマリー統計を計算しています...");
    await computeAndStoreAnomalies(db, admin);

    console.log("バックフィル完了！アプリのボードタブでアノマリー分析が見られるようになります。");
  } catch (err) {
    console.error("バックフィル中にエラーが発生しました:", err);
    process.exit(1);
  }
})();
