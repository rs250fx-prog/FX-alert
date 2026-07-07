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
const expandedAnomalyPairs = new Set(); // 開いているアノマリーパネルのpairを記憶

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
  listenToAlerts();
  listenToHistory();
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

    const row = document.createElement("div");
    row.className = "board-row";
    row.innerHTML = `
      <div class="pair-name">${PAIR_LABELS[pair] || pair}</div>
      <div class="pair-price">${price.toFixed(decimals)}</div>
      <div class="pair-delta ${deltaClass}">${deltaText}</div>
      <button class="anomaly-toggle" data-pair="${pair}">
        曜日アノマリー ${expandedAnomalyPairs.has(pair) ? "▲" : "▼"}
      </button>
      <div class="anomaly-panel ${expandedAnomalyPairs.has(pair) ? "is-open" : ""}" data-pair-panel="${pair}">
        ${renderAnomalyPanelContent(pair)}
      </div>
    `;
    row.querySelector(".anomaly-toggle").addEventListener("click", () => toggleAnomalyPanel(pair));
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

function toggleAnomalyPanel(pair) {
  if (expandedAnomalyPairs.has(pair)) {
    expandedAnomalyPairs.delete(pair);
  } else {
    expandedAnomalyPairs.add(pair);
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
