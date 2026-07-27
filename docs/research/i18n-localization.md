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

## zh-CN 細項查核（2026-07-27）

### 證據與範圍

- 本輪僅研究新語言 `zh-CN` 的 UI、ARIA、API 錯誤、法務文案與 README 用詞；沒有重複研究已充分確認的 runtime signal service、typed catalog 或 route metadata 架構。
- 依使用者指定，以 `ask-bridge 0.2.9 --provider chatgpt --model medium --timeout 1500 --headless=true` 附上完整 `zh-TW` catalog 與 `README.zh-TW.md` 查核簡體中文本地化。回覆為外部 AI 產生的候選建議，不是官方語言規範、法律意見或測試結果；最終以 typed catalog 契約、本機測試與不改變現有法務語意為驗收依據。
- 本輪沒有使用 Web Search；需要查核的是附件中的語言細節，ask-bridge 與可重現的本機契約已足夠。

### 結論

1. 面向使用者的主要用詞固定為「视频版本」、「安全验证」、「会话」、「Threads 帖子网址」、「隐私与数据处理」與「著作权与下架通知」。公開 UI 使用「视频版本」，隱私技術說明才使用「解析候选项」與「元数据」。
2. 「下载」與「打开或下载」不可替代「交由浏览器处理」的安全語意；簡體文案不承諾檔案一定已下載或儲存。
3. API error code 保持封閉映射，並統一使用「稍后重试」、「会话」、「访问」、「下载源」等用詞；不使用 API 回傳的原始 `message`。
4. 法務翻譯保留「公開可見不等於授權」、非商業目的不必然合法、不繞過存取限制、非官方隸屬、不作全加密或即時物理刪除聲明，也不新增特定法域的法定程序、安全港條件或處理時限。
5. 隱私頁以「哈希值」、「不透明标识符」、「密封保存」、「断点续传」與「超额并发」呈現現有技術界線，不將雜湊或密封擴大解釋為加密。
6. README 三語導覽一律使用 `English | 繁體中文 | 简体中文`，當前語言以粗體顯示；`README.zh-CN.md` 是完整翻譯，必須保留無需登入、不處理受限內容、不繞過限制、僅下載有權使用內容、無法保證所有公開貼文皆可解析，以及不在公開 issue 發布私人內容或帳號資料等限制。

### 尚未確認

- 「法律／按需查看」是依現有 eyebrow 角色的翻譯；尚未透過實際畫面使用性測試比較是否應簡化為「法律信息」。
- 隱私頁以「定时任务」呈現 Durable Objects Alarm 的使用者層級意義；若未來需對技術讀者精確暴露 Alarm 機制，可再評估使用「定时器」或英文技術名稱。
- 本輪未改變既有 locale URL、SSR/prerender、`hreflang` 與 `Intl.NumberFormat` 未確認事項。
