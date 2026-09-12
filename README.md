# 教學練習平台 MVP

教師出題 → 學生作答 → 自動 / 手動批改 → 學生看回饋。

## 技術

- 後端：Node.js + Express，SQLite（Node 內建 `node:sqlite`，免安裝原生模組）
- 前端：React 18（CDN，免打包）
- 驗證：自製 HMAC 簽章 token（存 sessionStorage，每分頁獨立登入），密碼用 scrypt 雜湊

## 執行

```bash
cd teaching-platform
npm install
npm start
# 開 http://localhost:3000
```

資料庫檔 `data.db` 會自動建立。刪掉它即可重置所有資料。

## 目前功能

| 角色 | 功能 |
|---|---|
| 共同 | 註冊 / 登入 / 登出，身分（教師 / 學生）分流 |
| 教師 | 發布單選 / 多選 / 簡答題、設定正解與截止日、查看每位學生作答、手動打分＋文字回饋 |
| 學生 | 看所有練習題、作答、重新作答、單選/多選即時自動批改、查看分數與老師回饋 |

## 檔案

- `server.js` — API 路由與權限中介層
- `db.js` — 資料表結構（users / assignments / submissions）
- `auth.js` — 密碼雜湊與 token 簽章
- `public/index.html` `public/app.js` — 前端單頁

## API 一覽

```
POST /api/auth/register     { email, password, name, role }
POST /api/auth/login        { email, password }  -> { token, user }
GET  /api/me
POST /api/assignments       (教師) { title, description, type, options, answerKey, dueDate }
GET  /api/assignments       教師=自己出的；學生=全部＋自己的作答狀態
GET  /api/assignments/:id   （學生看不到 answerKey）
POST /api/assignments/:id/submit        (學生) { content }
GET  /api/assignments/:id/submissions   (教師)
POST /api/submissions/:id/grade         (教師) { score, feedback }
GET  /api/my-submissions                (學生)
```

## 推上 GitHub 前

`.gitignore` 已經排除以下檔案，**不要手動把它們加回版控**：

- `data.db` / `data.db-shm` / `data.db-wal` — 裡面是真實帳號（email、密碼雜湊）與作答紀錄
- `.secret` — 自動產生的 token 簽章密鑰（`auth.js` 第一次啟動時會自動建立；沒設 `SECRET` 環境變數時使用）
- `node_modules/` — 用 `npm install` 重建即可，不用進版控

正式部署時請改用環境變數設定密鑰（例如 `SECRET=<隨機字串> npm start`），不要依賴自動產生的 `.secret` 檔案。

## 待強化（正式化前）

- token 加上有效期限與更新機制
- 前端表單驗證與錯誤提示更完整
- SQLite 換 PostgreSQL、加上 migration 工具
