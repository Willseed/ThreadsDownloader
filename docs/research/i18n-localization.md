# i18n 與本地化查核紀錄

## 問題與範圍

本輪查核 `apps/web` 在後續逐一加入 `zh-CN`、`en`、`es`、`ko`、`ja` 前，應如何建立可在單一 SPA 執行期切換的 i18n 基礎，並盤點 `zh-TW` 使用者介面、無障礙屬性、動態狀態、API 錯誤、法務文案、route title、HTML metadata 與 README 的翻譯邊界。

## 已查來源與證據性質

- 現有程式碼、Angular 設定、測試與 README：用來確認實際存在的文案、資料流、route 與高風險契約；這些是本輪實作的主要證據。
- `ask-bridge 0.2.9`：依使用者指定以 `--provider chatgpt --model medium --timeout 1500 --headless=true` 進行低風險架構與文案查核。有效回覆建議 typed catalog、signal service、具型別插值、封閉錯誤 code 映射、metadata 同步與 README 雙向語言導覽。回覆僅為 AI 產生的候選建議，不是事實來源、官方 Angular 規範或測試結果；採用的部分均再以本機型別檢查、建置與測試驗證。
- 第一次 ask-bridge 嘗試附加過多原始碼後長時間無產出，已中止且不將空白結果當作完成查核；後續用精簡問題及代表性附件成功取得回覆。
- 本輪不需要 Web Search。ask-bridge 的架構建議已足以作為候選輸入，實作正確性可由專案本身重現驗證。

## 結論

1. 本專案要求不重新載入的 runtime 切換，且每個語言獨立交付；因此使用無第三方依賴的 root signal service 與每語言 typed catalog。Angular compile-time i18n 的多建置產物模式不是本輪主要實作。
2. `MessageCatalog` 只從 `zh-TW` 的結構推導；字串葉節會放寬為 `string`，不會要求新語言複製繁中字面值。動態數量、request ID 與版本標籤使用具型別函式，不由元件固定拼接語序。
3. locale 僅接受 allowlist，未支援值回退到 `zh-TW`。locale 與 route 改變由同一服務同步 `<html lang>`、`dir`、title 與 description。
4. API 原始 `message` 不再直接進入下載頁狀態；已知的 `ApiErrorCode` 對應本地 catalog，非 API 原文的 client fallback 使用固定安全訊息。
5. URL、route path、API code、host allowlist、email 與安全規則不屬可翻譯文案，留在程式或設定。使用者可見的技術名稱（例如 Cloudflare Turnstile）仍納入 catalog。
6. 高風險測試集中保護：所有 locale 葉節 path 完全相同且無空字串、fallback 與 DOM metadata 同步、所有公開 API error code 都有本地訊息。不為每個 key 建立一個脆弱測試。
7. `zh-TW` 固定使用「影片版本」、「安全驗證」、「工作階段」、「隱私與資料處理」、「著作權與下架通知」。影片 metadata 的「時長」改為台灣介面較常見的「影片長度」；參考編號使用全形冒號，進行中狀態使用全形省略號。
8. `README.md` 保持英文 canonical，`README.zh-TW.md` 提供完整繁中版本；兩者標題下方有對稱的 `English | 繁體中文` 導覽，且章節、限制與連結語意對齊。README 不與 Angular catalog 共用來源。

## 適用範圍

上述結論適用於目前的 Angular 22 standalone、zoneless、純 client-side SPA 與獨立 Markdown README。本輪 catalog 只登錄 `zh-TW`；後續語言必須依相同結構加入並通過同一契約測試。

## 尚未確認

- 尚未決定 locale 是否進入 URL。未進入 URL 時無法直接分享特定語言，也沒有每語言 canonical URL 或 `hreflang`。
- 專案目前是 client-side 建置；未確認是否會引入 SSR、prerender 或需要社群 crawler 可讀的每語言 metadata。runtime title/description 不能代替伺服器或預渲染的 SEO 產物。
- 影片時間目前保持播放器式 `MM:SS` / `HH:MM:SS`，檔案大小保持 `B` / `KB` / `MB`。後續語言加入前，仍需決定小數與數字分隔是否由 `Intl.NumberFormat(locale)` 處理。
- 隱私頁列出的保存時間來自現有已測法務文案；本輪沒有重新進行 Cloudflare 或後端保存政策研究。
