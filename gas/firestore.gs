// Firestore REST API（v1）を UrlFetchApp で叩くための最小限のヘルパー群。
// firebase-admin が使えないGAS環境で、Admin SDKのFirestore操作の代替として使う。
//
// 参考: https://firestore.googleapis.com/v1/{database=projects/*/databases/*}/documents

var PROJECT_ID_ = "fx-alert-4334a";
var DATABASE_PATH_ = "projects/" + PROJECT_ID_ + "/databases/(default)";
var DOCUMENTS_PATH_ = DATABASE_PATH_ + "/documents";
var BASE_URL_ = "https://firestore.googleapis.com/v1/" + DOCUMENTS_PATH_;

// ---------------------------------------------------------------
// 低レベルHTTPヘルパー
// ---------------------------------------------------------------

function fsPost_(suffix, body) {
  var res = UrlFetchApp.fetch(BASE_URL_ + suffix, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + getAccessToken_() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error("Firestore " + suffix + " 失敗: " + code + " " + res.getContentText());
  }
  return res;
}

// ---------------------------------------------------------------
// ドキュメント単体取得・書き込み
// ---------------------------------------------------------------

// docPath例: "prices/USDJPY"。存在しない場合はnullを返す。
function fsGetDoc_(docPath) {
  var res = UrlFetchApp.fetch(BASE_URL_ + "/" + docPath, {
    method: "get",
    headers: { Authorization: "Bearer " + getAccessToken_() },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 404) return null;
  if (code !== 200) {
    throw new Error("Firestore GET失敗 (" + docPath + "): " + code + " " + res.getContentText());
  }
  return docToRecord_(JSON.parse(res.getContentText()));
}

// 複数writeをアトミックに実行する（Admin SDKのbatch.commit()相当）。
function fsCommit_(writes) {
  if (!writes || writes.length === 0) return null;
  var res = fsPost_(":commit", { writes: writes });
  return JSON.parse(res.getContentText());
}

// ドキュメント全体を置き換える（Admin SDKのbatch.set()相当。ドキュメントが無ければ作成する）。
function fsSetWrite_(docPath, obj) {
  return { update: { name: DOCUMENTS_PATH_ + "/" + docPath, fields: toFsFields_(obj) } };
}

// 指定フィールドのみ更新する（Admin SDKのbatch.update()相当）。
function fsUpdateWrite_(docPath, obj) {
  return {
    update: { name: DOCUMENTS_PATH_ + "/" + docPath, fields: toFsFields_(obj) },
    updateMask: { fieldPaths: Object.keys(obj) }
  };
}

// コレクション配下に自動採番IDでドキュメントを新規作成する（intradayPrices/history/fetchLogsの追記用）。
function fsCreateWrite_(collectionId, obj) {
  var docPath = collectionId + "/" + generateSortableDocId_();
  return { update: { name: DOCUMENTS_PATH_ + "/" + docPath, fields: toFsFields_(obj) } };
}

// 作成時刻順にソートされるドキュメントIDを生成する（13桁ゼロ埋めミリ秒 + UUID）。
// Firestoreコンソールのデフォルトのドキュメント一覧はドキュメントIDの文字列順に並ぶため、
// 完全ランダムなUUIDだけだと新しく書き込んだドキュメントが一覧のどこに出るか分からず、
// 「ちゃんと書き込まれ続けているか」を目視で追いにくい。時刻を先頭に付けることでID順=時系列順になる。
function generateSortableDocId_() {
  var millis = ("0000000000000" + new Date().getTime()).slice(-13);
  return millis + "_" + Utilities.getUuid();
}

// ---------------------------------------------------------------
// クエリ（where句のみ対応。orderByはドキュメント名固定でページングにのみ使う）
// ---------------------------------------------------------------

// 等価条件のフィールドフィルタを組み立てる。fsRunQuery_に渡す。
function fsEqualsFilter_(fieldPath, value) {
  return {
    fieldFilter: {
      field: { fieldPath: fieldPath },
      op: "EQUAL",
      value: toFsValue_(value)
    }
  };
}

// where句(省略可)付きで全件取得する。複合インデックスを避けるため、
// orderByはFirestoreが常に持つ__name__（ドキュメント名）のみを使い、
// データ側のソートは呼び出し側（GAS内）で行うこと。
function fsRunQuery_(collectionId, fieldFilter) {
  var pageSize = 300;
  var results = [];
  var cursorName = null;

  while (true) {
    var structuredQuery = {
      from: [{ collectionId: collectionId }],
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
      limit: pageSize
    };
    if (fieldFilter) structuredQuery.where = fieldFilter;
    if (cursorName) {
      structuredQuery.startAt = { values: [{ referenceValue: cursorName }], before: false };
    }

    var res = fsPost_(":runQuery", { structuredQuery: structuredQuery });
    var rows = JSON.parse(res.getContentText());

    var pageDocs = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].document) pageDocs.push(rows[i].document);
    }
    for (var j = 0; j < pageDocs.length; j++) {
      results.push(docToRecord_(pageDocs[j]));
    }

    if (pageDocs.length < pageSize) break; // 最終ページ
    cursorName = pageDocs[pageDocs.length - 1].name;
  }

  return results;
}

// コレクション全件取得（alerts / tokens / dailyCloses等。内部的にfsRunQuery_でページング）。
function fsListAll_(collectionId) {
  return fsRunQuery_(collectionId, null);
}

// ---------------------------------------------------------------
// Firestore型付きJSON <-> 素のJSオブジェクト 相互変換
// ---------------------------------------------------------------

// admin.firestore.FieldValue.serverTimestamp()の代替。
// ISO文字列をtimestampValueとして書き込む（Firestore上は本物のtimestamp型になる）。
function fsServerTimestamp_() {
  return { __fsTimestamp: new Date().toISOString() };
}

function toFsValue_(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "object" && value.__fsTimestamp) return { timestampValue: value.__fsTimestamp };
  if (typeof value === "boolean") return { booleanValue: value };
  // 数値はすべてdoubleValueで統一する（現行Admin SDKもnumberで書いており、
  // アプリ側はNumber()で読むためdouble/integerどちらでも互換）。
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFsValue_) } };
  }
  if (typeof value === "object") {
    return { mapValue: { fields: toFsFields_(value) } };
  }
  throw new Error("toFsValue_: 未対応の値型です (" + typeof value + ")");
}

function toFsFields_(obj) {
  var fields = {};
  Object.keys(obj).forEach(function (key) {
    fields[key] = toFsValue_(obj[key]);
  });
  return fields;
}

function fromFsValue_(fsValue) {
  if (!fsValue || fsValue.nullValue !== undefined) return null;
  if (fsValue.booleanValue !== undefined) return fsValue.booleanValue;
  if (fsValue.doubleValue !== undefined) return fsValue.doubleValue;
  if (fsValue.integerValue !== undefined) return Number(fsValue.integerValue);
  if (fsValue.stringValue !== undefined) return fsValue.stringValue;
  if (fsValue.timestampValue !== undefined) return new Date(fsValue.timestampValue);
  if (fsValue.referenceValue !== undefined) return fsValue.referenceValue;
  if (fsValue.arrayValue !== undefined) {
    var arr = fsValue.arrayValue.values || [];
    return arr.map(fromFsValue_);
  }
  if (fsValue.mapValue !== undefined) {
    return fromFsFields_(fsValue.mapValue.fields || {});
  }
  return null;
}

function fromFsFields_(fields) {
  var obj = {};
  Object.keys(fields || {}).forEach(function (key) {
    obj[key] = fromFsValue_(fields[key]);
  });
  return obj;
}

// Firestore REST APIのdocumentレスポンス({name, fields, ...})を
// { id, path, data } の扱いやすい形に変換する。
function docToRecord_(doc) {
  var parts = doc.name.split("/");
  var id = parts[parts.length - 1];
  return { id: id, path: doc.name, data: fromFsFields_(doc.fields || {}) };
}
