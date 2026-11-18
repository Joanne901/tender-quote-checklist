# 詢價確認表

投標前的廠商詢價追蹤：寄出詢價信 → 電話確認收信 → 期限內追蹤 → 收到報價 → 回填彙整表，每一步勾選並自動記錄日期。

- 網址：https://joanne901.github.io/tender-quote-checklist/
- 沒有設定雲端時：資料只存在目前的瀏覽器（單機模式）。
- 設定 Supabase 之後：團隊成員用 Email 登入，在電腦、手機都看到同一份進度，有人勾選其他人的畫面會即時更新。

## 啟用雲端同步（Supabase，一次性設定，約 10 分鐘）

1. **建立專案**：到 <https://supabase.com> 註冊並登入，按 **New project**。
   名稱隨意（例如 `tender-quote`），設定一組資料庫密碼（自己保存，網頁不會用到），Region 選 **Northeast Asia (Tokyo)** 或 **Southeast Asia (Singapore)**。
2. **建立資料表**：左側 **SQL Editor** → **New query**，把本儲存庫的 [`supabase-setup.sql`](supabase-setup.sql) 全部貼上，
   **把最後一行的 `your-email@example.com` 改成你自己的 Email（小寫）**，按 **Run**。
3. **設定登入網址**：左側 **Authentication** → **URL Configuration**
   - Site URL：`https://joanne901.github.io/tender-quote-checklist/`
   - Redirect URLs：新增同一個網址
4. **讓登入信附上驗證碼**（建議，手機上比較好用）：**Authentication** → **Emails**（Email Templates）→ **Magic Link**，
   在內容中加一行 `驗證碼：{{ .Token }}`，儲存。
5. **取得連線設定**：**Project Settings** → **API**（或 Data API），複製
   - **Project URL**
   - **anon public** 金鑰（不要用 service_role 那把）

   填進 [`config.js`](config.js) 的 `url` 與 `anonKey` 後上傳（或交給 Claude 幫你填好並推上 GitHub）。

完成後打開網址，右上角會出現「登入以跨裝置同步」。用第 2 步填的 Email 登入，第一次登入時可選擇把這台電腦原有的資料上傳到雲端。

### 加入同事

登入後點右上角的同步狀態 →「團隊成員」→ 輸入同事的 Email → 加入團隊。同事打開網址、用那個 Email 登入即可。不在名單內的人就算登入也看不到任何資料。

### 注意事項

- `anon public` 金鑰本來就是公開用的，放在網頁裡沒有問題；資料安全由資料庫權限規則把關（只有成員能讀寫）。**`service_role` 金鑰絕對不要放進來。**
- Supabase 免費方案：專案若連續 7 天完全沒人使用會被暫停，到 Supabase 後台按 Restore 即可恢復，資料不會遺失。
- 免費方案內建寄信每小時有數量限制，小團隊日常登入夠用；登入一次後會保持登入狀態，不需每次收信。
- 仍可隨時從「匯出與備份」下載完整備份 JSON。

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `index.html`、`style.css` | 頁面與樣式 |
| `model.js` | 資料規則（進度判斷、驗證、案件操作） |
| `app.js` | 畫面互動 |
| `sync.js` | Supabase 雲端同步、登入、團隊成員 |
| `config.js` | Supabase 連線設定 |
| `supabase-setup.sql` | 資料庫建立腳本 |
