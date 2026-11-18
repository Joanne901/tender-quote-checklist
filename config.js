// Supabase 連線設定（Project Settings → API Keys）。
// anonKey 是「公開」金鑰，本來就會出現在網頁裡；資料安全靠資料庫的權限規則（只有團隊成員能讀寫）。
// 兩個值都留空時，系統維持「只存在此瀏覽器」的單機模式。
window.SUPABASE_CONFIG = {
  url: 'https://msxcrtugmbzleqsatbmi.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zeGNydHVnbWJ6bGVxc2F0Ym1pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5NjQ2OTQsImV4cCI6MjExMDU0MDY5NH0.69j4nTNVSw4kN3M00W9F9SlX0iUFInKllLq27iHtlnc'
};
