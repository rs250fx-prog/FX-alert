// ここをFirebaseコンソール → プロジェクト設定 → 全般 → マイアプリ の
// 「SDK の設定と構成」に表示される値に置き換えてください。
// Webアプリが未登録の場合は「アプリを追加」→ Web(</>) で新規登録すると発行されます。
//
// この値はクライアントに公開される設定であり、それ自体は秘密情報ではありません
// (安全性はFirestoreのセキュリティルールで担保します)。

const firebaseConfig = {
  apiKey: "AIzaSyCPK1jkHjbVkd98VKfJ50xgjduELQ8tHMw",
  authDomain: "fx-alert-4334a.firebaseapp.com",
  projectId: "fx-alert-4334a",
  storageBucket: "fx-alert-4334a.firebasestorage.app",
  messagingSenderId: "936413499996",
  appId: "1:936413499996:web:d1a3c4fc5ebc4166374c99"
};

// Firebaseコンソール → プロジェクト設定 → Cloud Messaging → ウェブ構成 →
// 「ウェブプッシュ証明書」で生成した鍵ペアの「鍵ペア」文字列（設定済み）。
const FCM_VAPID_KEY = "BCx9Aa4eX3XXgL7CBGiyBVZBZk9WsQYZhZCkls17mBNps93UyBKBnAw831XCQJxyJT4zgK1rygxipmX__AcImFc";
