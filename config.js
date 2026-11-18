// Supabase 連線設定：建立專案後，到 Project Settings → API 複製這兩個值貼上。
// anonKey 是「公開」金鑰，本來就會出現在網頁裡；資料安全靠資料庫的權限規則（只有團隊成員能讀寫）。
// 兩個值都留空時，系統維持「只存在此瀏覽器」的單機模式。
window.SUPABASE_CONFIG = {
  url: '',
  anonKey: ''
};
