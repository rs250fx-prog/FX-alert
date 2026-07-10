/* global firebase, firebaseConfig, FCM_VAPID_KEY */

// ---------- Firebase init ----------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const PAIR_LABELS = {
  MXNJPY: "MXN/JPY",
  USDJPY: "USD/JPY",
  XAUUSD: "GOLD (XAU/USD)"
};
const PAIR_DECIMALS = {
  MXNJPY: 3,
  USDJPY: 3,
  XAUUSD: 2
};

const REPO_URL = "https://github.com/rs250fx-prog/FX-alert";
const WORKFLOW_URLS = {
  checkRates: `${REPO_URL}/actions/workflows/check-rates.yml`,
  dailyClose: `${REPO_URL}/actions/workflows/daily-close.yml`
};

let currentDirection = "above";
let pricesData = {}; // pair -> { price, deltaClass, deltaText, updatedAt }
let anomaliesData = {}; // pair -> { weekdayStats }
let intradayData = {}; // pair -> [{ price, millis }, ...] （直近24時間、時刻昇順）
const expandedPanel = new Map(); // pair -> "anomaly" | "chart"（アコーディオン式、片方だけ開く）

// ---------- Auth ----------
auth.onAuthStateChanged((user) => {
  if (user) {
    startApp();
  } else {
    auth.signInAnonymously().catch((err) => {
      console.error("anonymous sign-in failed", err);
      showToast("サインインに失敗しました");
    });
  }
});

function startApp() {
  listenToPrices();
  listenToAnomalies();
  listenToIntradayPrices();
  listenToAlerts();
  listenToHistory();
  listenToFetchLogs();
  setupNotifications();
}

// ---------- Tab navigation ----------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function switchView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
  document.getElementById(`view-${name}`).classList.add("is-active");
  document.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.view === name;
    t.classList.toggle("is-active", active);
    t.setAttribute("aria-selected", String(active));
  });
}

// ---------- Board (price) view ----------
const PAIR_ORDER = ["MXNJPY", "USDJPY", "XAUUSD"];
const WEEKDAY_ORDER = ["1", "2", "3", "4", "5"];

function listenToPrices() {
  db.collection("prices").onSnapshot((snap) => {
    if (snap.empty) return;

    snap.docs.forEach((doc) => {
      const pair = doc.id;
      const data = doc.data();
      const price = Number(data.price);
      const prev = typeof data.previousPrice === "number" ? data.previousPrice : null;

      let deltaClass = "delta-flat";
      let deltaText = "—";
      if (prev !== null) {
        if (price > prev) { deltaClass = "delta-up"; deltaText = "▲"; }
        else if (price < prev) { deltaClass = "delta-down"; deltaText = "▼"; }
        else { deltaText = "・"; }
      }
      pricesData[pair] = { price, deltaClass, deltaText, updatedAt: data.updatedAt };
    });

    renderBoard();
  }, (err) => console.error("prices listener error", err));
}

function listenToAnomalies() {
  db.collection("anomalies").onSnapshot((snap) => {
    snap.docs.forEach((doc) => {
      anomaliesData[doc.id] = doc.data();
    });
    renderBoard();
  }, (err) => console.error("anomalies listener error", err));
}

// 複合インデックスを避けるため where(pair) は使わず、timestamp降順のみで取得して
// クライアント側でpairごとに振り分ける（直近24時間分に絞る）。
const INTRADAY_FETCH_LIMIT = 1200; // 3銘柄 × 15分間隔 × 24時間 に十分な余裕を持たせた件数
function listenToIntradayPrices() {
  db.collection("intradayPrices")
    .orderBy("timestamp", "desc")
    .limit(INTRADAY_FETCH_LIMIT)
    .onSnapshot((snap) => {
      const cutoffMillis = Date.now() - 24 * 60 * 60 * 1000;
      const byPair = {};
      snap.docs.forEach((doc) => {
        const d = doc.data();
        if (!d.timestamp) return; // サーバータイムスタンプ反映前の一瞬はスキップ
        const millis = d.timestamp.toMillis();
        if (millis < cutoffMillis) return;
        const pair = d.pair;
        if (!byPair[pair]) byPair[pair] = [];
        byPair[pair].push({ price: Number(d.price), millis });
      });
      Object.keys(byPair).forEach((pair) => {
        byPair[pair].sort((a, b) => a.millis - b.millis); // 昇順（グラフの左→右）に並べ直す
      });
      intradayData = byPair;
      renderBoard();
    }, (err) => console.error("intradayPrices listener error", err));
}

function renderBoard() {
  const list = document.getElementById("boardList");
  const hint = document.getElementById("boardEmptyHint");
  const pairsWithData = PAIR_ORDER.filter((p) => pricesData[p]);

  if (pairsWithData.length === 0) {
    hint.style.display = "block";
    hint.textContent = "まだ価格データがありません。GitHub Actionsの初回実行をお待ちください。";
    return;
  }
  hint.style.display = "none";
  list.querySelectorAll(".board-row").forEach((el) => el.remove());

  pairsWithData.forEach((pair) => {
    const decimals = PAIR_DECIMALS[pair] ?? 3;
    const { price, deltaClass, deltaText } = pricesData[pair];
    const openPanel = expandedPanel.get(pair); // "anomaly" | "chart" | undefined

    const row = document.createElement("div");
    row.className = "board-row";
    row.innerHTML = `
      <div class="pair-name">${PAIR_LABELS[pair] || pair}</div>
      <div class="pair-price">${price.toFixed(decimals)}</div>
      <div class="pair-delta ${deltaClass}">${deltaText}</div>
      <div class="panel-toggle-row">
        <button class="anomaly-toggle" data-pair="${pair}" data-panel="anomaly">
          曜日アノマリー ${openPanel === "anomaly" ? "▲" : "▼"}
        </button>
        <button class="anomaly-toggle" data-pair="${pair}" data-panel="chart">
          価格推移 ${openPanel === "chart" ? "▲" : "▼"}
        </button>
      </div>
      <div class="anomaly-panel ${openPanel === "anomaly" ? "is-open" : ""}" data-pair-panel="${pair}">
        ${renderAnomalyPanelContent(pair)}
      </div>
      <div class="chart-panel ${openPanel === "chart" ? "is-open" : ""}" data-pair-chart-panel="${pair}">
        ${renderChartPanelContent(pair, decimals)}
      </div>
    `;
    row.querySelectorAll(".anomaly-toggle").forEach((btn) => {
      btn.addEventListener("click", () => togglePanel(pair, btn.dataset.panel));
    });
    list.appendChild(row);
  });

  const latest = pairsWithData
    .map((p) => pricesData[p].updatedAt)
    .filter(Boolean)
    .sort((a, b) => b.toMillis() - a.toMillis())[0];
  if (latest) {
    document.getElementById("lastUpdated").textContent =
      `最終更新 ${formatDateTime(latest.toDate())}`;
  }
}

function togglePanel(pair, panelName) {
  // 同じパネルをもう一度押したら閉じる。違うパネルを押したら排他的に切り替える。
  if (expandedPanel.get(pair) === panelName) {
    expandedPanel.delete(pair);
  } else {
    expandedPanel.set(pair, panelName);
  }
  renderBoard();
}

function renderAnomalyPanelContent(pair) {
  const data = anomaliesData[pair];
  if (!data || !data.weekdayStats) {
    return `<p class="anomaly-empty">データ集計中です。しばらく運用を続けると（毎日の終値記録が溜まると）表示されます。</p>`;
  }

  const stats = WEEKDAY_ORDER.map((wd) => data.weekdayStats[wd]).filter(Boolean);
  const maxAbs = Math.max(0.01, ...stats.map((s) => Math.abs(s.avgChangePct || 0)));

  const cols = stats
    .map((s) => {
      if (s.sampleCount === 0) {
        return `
          <div class="anomaly-col">
            <div class="anomaly-bar-track"><div class="anomaly-bar anomaly-bar-flat" style="height:2px"></div></div>
            <div class="anomaly-value">—</div>
            <div class="anomaly-winrate">—</div>
            <div class="anomaly-label">${s.label}</div>
          </div>`;
      }
      const isUp = s.avgChangePct >= 0;
      const heightPct = Math.max(6, (Math.abs(s.avgChangePct) / maxAbs) * 100);
      return `
        <div class="anomaly-col">
          <div class="anomaly-bar-track">
            <div class="anomaly-bar ${isUp ? "anomaly-bar-up" : "anomaly-bar-down"}" style="height:${heightPct}%"></div>
          </div>
          <div class="anomaly-value ${isUp ? "anomaly-value-up" : "anomaly-value-down"}">${isUp ? "+" : ""}${s.avgChangePct.toFixed(3)}%</div>
          <div class="anomaly-winrate">勝率${s.winRatePct.toFixed(0)}%</div>
          <div class="anomaly-label">${s.label}</div>
        </div>`;
    })
    .join("");

  const sampleCount = stats[0]?.sampleCount ?? 0;
  return `
    <div class="anomaly-grid">${cols}</div>
    <p class="anomaly-note">曜日別の平均変動率と、上昇した日の割合（勝率）。サンプル数は各曜日で約${Math.max(...stats.map((s) => s.sampleCount))}件。過去の傾向であり将来を保証するものではありません。</p>
  `;
}

// ---------- 価格推移パネル（直近24時間・折れ線グラフ） ----------
const CHART_WIDTH = 300;
const CHART_HEIGHT = 90;
const CHART_PAD_X = 4;
const CHART_PAD_Y = 8;
const CHART_AXIS_LABEL_COUNT = 5; // 時刻軸ラベルの表示数

function formatHHMM(millis) {
  // 端末のタイムゾーン設定に依らず日本時間で表示する
  return new Date(millis).toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function renderChartPanelContent(pair, decimals) {
  const points = intradayData[pair] || [];

  if (points.length < 2) {
    return `<p class="anomaly-empty">データ収集中です。しばらく運用を続けると（15分ごとの記録が溜まると）表示されます。</p>`;
  }

  const prices = points.map((p) => p.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = Math.max(maxPrice - minPrice, 1e-9); // 完全に横一直線の場合のゼロ割回避

  const minMillis = points[0].millis;
  const maxMillis = points[points.length - 1].millis;
  const spanMillis = Math.max(maxMillis - minMillis, 1);

  const xFor = (millis) =>
    CHART_PAD_X + ((millis - minMillis) / spanMillis) * (CHART_WIDTH - CHART_PAD_X * 2);
  const yFor = (price) =>
    CHART_HEIGHT - CHART_PAD_Y - ((price - minPrice) / range) * (CHART_HEIGHT - CHART_PAD_Y * 2);
  // オーバーレイ要素（時刻ラベル・高安マーカー）はコンテナ幅に対する%位置とpx高さで配置する
  // （chart-svgの高さはCSSで90pxに固定しているため、y座標はそのままpx換算できる）
  const xPctFor = (millis) => ((millis - minMillis) / spanMillis) * 100;

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(p.millis).toFixed(1)} ${yFor(p.price).toFixed(1)}`)
    .join(" ");

  const firstPrice = points[0].price;
  const lastPrice = points[points.length - 1].price;
  const isUp = lastPrice >= firstPrice;
  const lineClass = isUp ? "chart-line-up" : "chart-line-down";
  const changePct = ((lastPrice - firstPrice) / firstPrice) * 100;

  const lastX = xFor(points[points.length - 1].millis);
  const lastY = yFor(lastPrice);

  // 24h高値・安値のポイント（複数該当する場合は最初に出現した方を採用）
  const highPoint = points.find((p) => p.price === maxPrice);
  const lowPoint = points.find((p) => p.price === minPrice);

  // マーカーHTMLを生成。ラベルがグラフ領域からはみ出して時刻軸ラベル等と重ならないよう、
  // 左右の端では端揃えに、上下の端ではラベルの上下位置を反転させる。
  const EDGE_X_PCT = 12;       // 左右の端とみなす%位置
  const EDGE_Y_PX = 24;        // 上下の端とみなすpx位置
  const markerHtml = (point, kind) => {
    const xPct = xPctFor(point.millis);
    const y = yFor(point.price);

    const classes = ["chart-marker", `chart-marker-${kind}`];
    if (xPct < EDGE_X_PCT) classes.push("label-align-left");
    else if (xPct > 100 - EDGE_X_PCT) classes.push("label-align-right");

    // high は通常ラベルを点の上に出すが、上端に近いときは下に反転。
    // low は通常ラベルを点の下に出すが、下端に近いとき（時刻軸と重なる位置）は上に反転。
    if (kind === "high" && y < EDGE_Y_PX) classes.push("label-flip");
    if (kind === "low" && y > CHART_HEIGHT - EDGE_Y_PX) classes.push("label-flip");

    return `
      <div class="${classes.join(" ")}" style="left:${xPct.toFixed(1)}%; top:${y.toFixed(1)}px;">
        <span class="chart-marker-label">${formatHHMM(point.millis)}</span>
      </div>`;
  };

  // 時刻軸ラベル（開始〜終了を等間隔でCHART_AXIS_LABEL_COUNT個）
  const axisLabelsHtml = Array.from({ length: CHART_AXIS_LABEL_COUNT }, (_, i) => {
    const ratio = i / (CHART_AXIS_LABEL_COUNT - 1);
    const millis = minMillis + spanMillis * ratio;
    return `<span>${formatHHMM(millis)}</span>`;
  }).join("");

  return `
    <div class="chart-summary">
      <span class="chart-summary-value ${isUp ? "anomaly-value-up" : "anomaly-value-down"}">
        ${isUp ? "+" : ""}${changePct.toFixed(2)}%
      </span>
      <span class="chart-summary-range">24h High ${maxPrice.toFixed(decimals)} / Low ${minPrice.toFixed(decimals)}</span>
    </div>
    <div class="chart-canvas">
      <svg class="chart-svg" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" preserveAspectRatio="none">
        <path d="${pathD}" class="${lineClass}" fill="none" />
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" class="${lineClass}-dot" />
      </svg>
      ${markerHtml(highPoint, "high")}
      ${markerHtml(lowPoint, "low")}
    </div>
    <div class="chart-axis-labels">${axisLabelsHtml}</div>
    <p class="anomaly-note">直近24時間の推移（15分間隔の記録ベース、時刻は日本時間）。取得タイミングによって間隔が空くことがあります。</p>
  `;
}

// ---------- Alerts view ----------
function listenToAlerts() {
  db.collection("alerts").orderBy("createdAt", "desc").onSnapshot((snap) => {
    const list = document.getElementById("alertsList");
    const hint = document.getElementById("alertsEmptyHint");
    list.querySelectorAll(".alert-card").forEach((el) => el.remove());

    if (snap.empty) {
      hint.style.display = "block";
      return;
    }
    hint.style.display = "none";

    snap.forEach((doc) => {
      const a = doc.data();
      const decimals = PAIR_DECIMALS[a.pair] ?? 3;
      const arrow = a.direction === "above" ? "≥" : "≤";
      const card = document.createElement("div");
      card.className = "alert-card";
      card.innerHTML = `
        <div class="alert-status ${a.notified ? "is-armed" : ""}" title="${a.notified ? "通知済み（再度条件を割ったら再通知）" : "監視中"}"></div>
        <div class="alert-main">
          <div class="alert-pair">${PAIR_LABELS[a.pair] || a.pair}</div>
          <div class="alert-cond">${arrow} ${Number(a.target).toFixed(decimals)}</div>
        </div>
        <button class="alert-delete" data-id="${doc.id}">削除</button>
      `;
      card.querySelector(".alert-delete").addEventListener("click", () => deleteAlert(doc.id));
      list.appendChild(card);
    });
  }, (err) => console.error("alerts listener error", err));
}

function deleteAlert(id) {
  db.collection("alerts").doc(id).delete().catch((err) => {
    console.error("delete alert failed", err);
    showToast("削除に失敗しました");
  });
}

// ---------- History view ----------
function listenToHistory() {
  db.collection("history").orderBy("notifiedAt", "desc").limit(50).onSnapshot((snap) => {
    const list = document.getElementById("historyList");
    const hint = document.getElementById("historyEmptyHint");
    list.querySelectorAll(".history-item").forEach((el) => el.remove());

    if (snap.empty) {
      hint.style.display = "block";
      return;
    }
    hint.style.display = "none";

    snap.forEach((doc) => {
      const h = doc.data();
      const decimals = PAIR_DECIMALS[h.pair] ?? 3;
      const arrow = h.direction === "above" ? "を上抜け" : "を下抜け";
      const item = document.createElement("div");
      item.className = "history-item";
      const when = h.notifiedAt ? formatDateTime(h.notifiedAt.toDate()) : "";
      item.innerHTML = `
        <div class="history-time">${when}</div>
        <div class="history-text">${PAIR_LABELS[h.pair] || h.pair} が ${Number(h.target).toFixed(decimals)}${arrow}（実勢 ${Number(h.price).toFixed(decimals)}）</div>
      `;
      list.appendChild(item);
    });
  }, (err) => console.error("history listener error", err));
}

// ---------- Fetch logs (settings view) ----------
// 15分間隔×24時間で最大96件程度なので、余裕を持って120件取得し、
// クライアント側で24時間以内のものだけに絞る。
function listenToFetchLogs() {
  db.collection("fetchLogs")
    .orderBy("timestamp", "desc")
    .limit(120)
    .onSnapshot((snap) => {
      const list = document.getElementById("fetchLogList");
      const hint = document.getElementById("fetchLogEmptyHint");
      list.querySelectorAll(".fetchlog-item").forEach((el) => el.remove());

      const cutoffMillis = Date.now() - 24 * 60 * 60 * 1000;
      const logs = snap.docs
        .map((doc) => doc.data())
        .filter((d) => d.timestamp && d.timestamp.toMillis() >= cutoffMillis);

      if (logs.length === 0) {
        hint.style.display = "block";
        return;
      }
      hint.style.display = "none";

      logs.forEach((log) => {
        const isSuccess = log.status === "success";
        const item = document.createElement("div");
        item.className = `fetchlog-item ${isSuccess ? "is-success" : "is-error"}`;
        const when = formatDateTime(log.timestamp.toDate());
        item.innerHTML = `
          <span class="fetchlog-status">${isSuccess ? "✓" : "✗"}</span>
          <span class="fetchlog-time">${when}</span>
          <span class="fetchlog-key">KEY_${log.keyIndex}</span>
          <span class="fetchlog-message">${isSuccess ? "成功" : `失敗 ${log.message || ""}`}</span>
        `;
        list.appendChild(item);
      });
    }, (err) => console.error("fetchLogs listener error", err));
}

// ---------- Add alert sheet ----------
const sheet = document.getElementById("addSheet");
const backdrop = document.getElementById("sheetBackdrop");

document.getElementById("fab").addEventListener("click", openSheet);
document.getElementById("cancelAlertBtn").addEventListener("click", closeSheet);
backdrop.addEventListener("click", closeSheet);

document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    currentDirection = btn.dataset.dir;
  });
});

function openSheet() {
  document.getElementById("targetInput").value = "";
  currentDirection = "above";
  document.querySelectorAll(".seg-btn").forEach((b, i) => b.classList.toggle("is-active", i === 0));
  sheet.classList.add("is-open");
  backdrop.classList.add("is-open");
}
function closeSheet() {
  sheet.classList.remove("is-open");
  backdrop.classList.remove("is-open");
}

document.getElementById("saveAlertBtn").addEventListener("click", () => {
  const pair = document.getElementById("pairSelect").value;
  const target = parseFloat(document.getElementById("targetInput").value);
  if (!target || target <= 0) {
    showToast("指定値を入力してください");
    return;
  }
  db.collection("alerts").add({
    pair,
    target,
    direction: currentDirection,
    notified: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(() => {
    closeSheet();
    showToast("アラートを追加しました");
    switchView("alerts");
  }).catch((err) => {
    console.error("add alert failed", err);
    showToast("追加に失敗しました");
  });
});

// ---------- Settings view: confirm modal ----------
const confirmSheet = document.getElementById("confirmSheet");
const confirmBackdrop = document.getElementById("confirmBackdrop");
let pendingConfirmAction = null;

function openConfirm(title, onConfirm) {
  document.getElementById("confirmTitle").textContent = title;
  pendingConfirmAction = onConfirm;
  confirmSheet.classList.add("is-open");
  confirmBackdrop.classList.add("is-open");
}
function closeConfirm() {
  confirmSheet.classList.remove("is-open");
  confirmBackdrop.classList.remove("is-open");
  pendingConfirmAction = null;
}
document.getElementById("confirmCancelBtn").addEventListener("click", closeConfirm);
confirmBackdrop.addEventListener("click", closeConfirm);
document.getElementById("confirmExecBtn").addEventListener("click", () => {
  const action = pendingConfirmAction;
  closeConfirm();
  if (action) action();
});

document.getElementById("btnUpdatePrices").addEventListener("click", () => {
  openConfirm("今すぐ価格を更新しますか？", () => {
    window.open(WORKFLOW_URLS.checkRates, "_blank");
  });
});

document.getElementById("btnRecomputeAnomaly").addEventListener("click", () => {
  openConfirm("曜日アノマリーを再計算しますか？", () => {
    window.open(WORKFLOW_URLS.dailyClose, "_blank");
  });
});

// ---------- Push notifications ----------
function setupNotifications() {
  if (!("Notification" in window) || !firebase.messaging.isSupported()) {
    console.warn("このブラウザはプッシュ通知に対応していません");
    return;
  }
  if (!navigator.serviceWorker) return;

  navigator.serviceWorker.register("firebase-messaging-sw.js").then((registration) => {
    if (Notification.permission === "granted") {
      registerFcmToken(registration);
    } else if (Notification.permission !== "denied") {
      // Ask on first meaningful interaction rather than immediately on load.
      const askOnce = () => {
        Notification.requestPermission().then((perm) => {
          if (perm === "granted") registerFcmToken(registration);
        });
        document.removeEventListener("click", askOnce);
      };
      document.addEventListener("click", askOnce, { once: true });
    }
  }).catch((err) => console.error("service worker registration failed", err));
}

function registerFcmToken(registration) {
  const messaging = firebase.messaging();
  messaging.getToken({ vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: registration })
    .then((token) => {
      if (!token) return;
      db.collection("tokens").doc(token).set({
        token,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        userAgent: navigator.userAgent
      }).catch((err) => console.error("save token failed", err));
    })
    .catch((err) => console.error("getToken failed", err));
}

// ---------- Helpers ----------
function formatDateTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

let toastTimer;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2400);
}
