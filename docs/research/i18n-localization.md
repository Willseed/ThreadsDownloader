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

## en 細項查核（2026-07-27）

### 證據與範圍

- 本輪只查核英文 catalog 的 UI、ARIA、API 錯誤、metadata、法務文案、locale selector 名稱與 canonical `README.md`；未重複研究 runtime signal service、typed catalog、fallback 或 route metadata 架構。
- 依使用者指定，以 `ask-bridge 0.2.9 --provider chatgpt --model medium --timeout 1500 --headless=true` 附上完整英文 catalog 草稿與 `README.md`。回覆是外部 AI 的語言審閱候選，不是官方規範、法律意見、伺服器契約或測試證據；採用項目再以現有 worker 映射、typed catalog 與本機測試驗證。
- 本輪沒有使用 Web Search；附件中的英文一致性可由 ask-bridge 輔助審閱，行為與契約則可由現有程式碼和測試重現確認。

### 結論

1. 英文 selector 使用 BCP 47 language tag `en`、`ltr` 與原生名稱 `English`；主要 UI 固定使用 `video version`、`security check`、`secure session`、`public post` 與 `download job`。
2. Turnstile 容器實際是具 `aria-label` 的驗證群組，因此對輔助科技使用 `Security verification`；可見文字仍保留較自然的 `security check`。動態 handoff 不承諾檔案已儲存，只說明控制權已交給瀏覽器。
3. API error code 維持封閉本地映射。`MEDIA_NOT_FOUND` 以 `supported video version` 描述服務能力，避免把技術可取得與法律可下載混為一談；`DOWNLOAD_EXPIRED` 指示開始新的下載，不強迫重新解析。
4. ask-bridge 建議移除 `THREADS_BOT_BLOCKED` 與 `INTERNAL_ERROR` 的 `temporarily`，但現有 worker 明確將前者由暫時阻擋頁面映射為 503，並以固定暫時錯誤訊息產生後者；本輪依可重現程式證據保留該用詞，不把 AI 建議視為伺服器事實。
5. 法務英文保留公開可見不等於授權、研究或非商業目的不當然構成授權或合法、不得繞過限制、非官方隸屬，以及不宣稱全加密、完全無紀錄、立即物理刪除或任何特定法域程序。
6. `README.md` 維持唯一 canonical 英文完整版與 `English | 繁體中文 | 简体中文` 對稱導覽；權利確認納入適用法律下的預定使用，安全驗證步驟避免承諾一定自動完成，疑難排解文字與英文 UI 對齊。

### 尚未確認

- locale 仍未進入 URL，且 SSR/prerender、`hreflang` 與 crawler 可讀的每語言 metadata 仍未確認；runtime metadata 不取代伺服器或預渲染 SEO 產物。
- 影片時間與檔案大小仍沿用既有固定格式，尚未決定是否以 `Intl.NumberFormat('en')` 處理數字分隔與小數。
- 隱私頁的資料流、Cloudflare 接收者與保存期限沿用目前程式碼及既有已測法務契約；本輪只審閱英文表述，未重新驗證 production 設定。
- SpaceX 沿用既有非隸屬名單；本輪未重新研究列名原因，也未改變既定法務範圍。

## es 細項查核（2026-07-27）

### 證據與範圍

- 本輪只研究 `es` 的中性／國際西班牙文 UI、ARIA、API 錯誤、metadata、法務、隱私、著作權、技術詞與 README；沒有重複研究 runtime signal service、typed catalog、fallback 或 route metadata 架構。
- 依使用者指定，以 `ask-bridge 0.2.9 --provider chatgpt --model medium --timeout 1500 --headless=true` 查核。第一次附加四個對照檔時，送出按鈕未啟用，未取得回覆且不視為完成；依 skill 保留失敗後，縮減為 `es.ts` 與 `README.es.md` 單次重試成功。有效回覆是外部 AI 的語言候選，不是官方規範、法律意見、伺服器契約或測試證據。
- 本輪沒有使用 Web Search；語言自然度由 ask-bridge 輔助審閱，catalog 完整性、API code 封閉映射、DOM metadata 與 route 行為由本機型別及測試驗證。

### 結論

1. locale 使用 `es`、`ltr` 與原生名稱 `Español`；為兼顧國際可讀性，全文一致使用 `video`，主要 UI 固定使用 `versión de video`、`verificación de seguridad`、`sesión segura`、`publicación pública` 與 `trabajo de descarga`。
2. metadata 使用 `resuelve`，避免把解析版本誤寫成保證取得或下載；`same-origin` 依情境固定表達為 `del mismo origen`、`desde el mismo origen` 與 `solicitudes del mismo origen`。
3. ask-bridge 找到隱私草稿的否定範圍反轉；最終使用「本服務不聲稱資料不由第三方處理」，保留 Cloudflare 與其他接收者的既有界線。
4. 技術詞保留 `hash`、`hash con clave`、`intervalos de bytes` 與解析層 `candidatos`，不改寫成加密或匿名化；sealed URL 描述為「以密封形式保存」，lease 描述為有期限的執行／傳輸權，不誤作一般租賃。
5. 著作權流程以 `puerto seguro («safe harbor»)` 保留概念名稱，同時明確否認任何特定法域制度已適用；其他法務文案保留公開可見不等於授權、研究或非商業目的不當然合法、不繞過限制、非官方隸屬，以及不宣稱全加密、完全無紀錄或立即物理刪除。
6. 四份 README 使用一致的 `English | 繁體中文 | 简体中文 | Español` 導覽並將當前語言加粗；`README.es.md` 完整保留免登入範圍、受限內容排除、不繞過限制、權利要求、無法保證每則貼文，以及不得在公開 issue 發布私人內容或帳號資訊等 canonical 限制。

### 適用範圍

- 上述用詞適用於目前 Angular SPA 的使用者介面、輔助科技標籤、錯誤提示、法務頁與獨立西文 README；不代表特定國家或地區的法律意見。
- API error 的持續時間與恢復建議沿用現有 worker 契約；本輪只在該證據範圍內翻譯，未重新研究 Threads、Cloudflare 或 production 設定。

### 尚未確認

- locale 仍未進入 URL，且 SSR/prerender、`hreflang` 與 crawler 可讀的每語言 metadata 仍未確認；metadata 長度也未在搜尋結果預覽中測試。
- `lease` 的使用者層級譯法採 `concesión temporal`；若未來向維護者暴露精確狀態機欄位，是否同時保留英文 `lease` 尚未確認。
- sealed authorization 與 sealed source URL 沿用既有技術界線；本輪未重新研究其密碼學實作，也不將其擴張為所有資料均已加密。
- `LEGAL / A SOLICITUD` 沿用目前 eyebrow 的按需開啟角色；尚未透過實際畫面使用性測試比較更長的 `DISPONIBLE AL ABRIR`。
- 影片時間與檔案大小仍沿用既有固定格式，尚未決定是否使用 `Intl.NumberFormat('es')`。

## ko 細項查核（2026-07-27）

### 證據與範圍

- 本輪只研究 `ko` 的韓國軟體 UI、존댓말、ARIA、API 錯誤、metadata、法務、隱私、著作權、外來語、韓文空格與 README；沒有重複研究 runtime signal service、typed catalog、fallback 或 route metadata 架構。
- 依使用者指定，以 `ask-bridge 0.2.9 --provider chatgpt --model medium --timeout 1500 --headless=true` 附 `ko.ts` 與 `README.ko.md` 查核。第一次命令雖正常結束，卻回傳另一個 `navigator.languages`／IP geolocation 研究，沒有審閱附件，因此視為交叉污染而非有效證據；確認無其他 ask-bridge 程序後，以 `--new` 和聚焦韓文輸出契約單次重試成功。
- 有效回覆只是外部 AI 的語言候選，不是官方韓文規範、法律意見、伺服器契約或測試結果。本輪沒有使用 Web Search；catalog 完整性、封閉 API code 映射、DOM metadata 與 route 行為由本機型別及測試驗證。

### 結論

1. locale 使用 `ko`、`ltr` 與原生名稱 `한국어`；主要 UI 固定使用 `동영상 버전`、`보안 인증`、`보안 세션`、`공개 게시물` 與 `다운로드 작업`，指示使用自然的 `-하세요`，說明與法務內容使用正式一致的 `-합니다`。
2. ARIA 採 `주요 탐색`、`언어 선택`、`본문으로 건너뛰기` 與動作優先的候選標籤，避免把 primary navigation 誤解為預設值；HTTP range error 明示 `바이트 범위`。
3. `URL`, `세션`, `토큰`, `해시`, `쿠키`, `메타데이터`, `동일 출처` 等外來語沿用韓國軟體常見寫法。Cookie 直接標示 `Path=/`；sealed URL 只描述為以密封形式保存，不擴張成所有資料均加密。
4. ask-bridge 建議把分析許可、預約資料與下載 lease 全部統一為 `리스`，但英文 catalog 與程式狀態顯示 resolve permit、reservation、stream lease 是不同概念；最終只在真正的下載／串流 lease 首次標示 `리스(lease)`，其餘維持 `허가` 與 `예약`，避免改變技術事實。
5. 法務韓文保留公開可見不等於授權、研究或非商業目的不當然構成許可或合法、不繞過限制、非官方隸屬，以及不宣稱全加密、完全無紀錄、立即物理刪除或特定法域程序。`세이프 하버` 只保留制度名稱並明確否認其已適用。
6. 五份 README 使用一致的 `English | 繁體中文 | 简体中文 | Español | 한국어` 導覽並將當前語言加粗；`README.ko.md` 完整保留免登入範圍、受限內容排除、不繞過限制、權利要求、研究／非商業目的界線、無法保證每則貼文，以及不得在公開 issue 發布 개인정보、私人內容或帳號資訊等限制。

### 適用範圍

- 上述用詞適用於目前 Angular SPA 的韓文 UI、輔助科技標籤、錯誤提示、法務頁與獨立 README，不代表韓國或其他法域的法律意見。
- API error 的持續時間與恢復建議沿用現有 worker 契約；本輪只在該證據範圍翻譯，未重新研究 Threads、Cloudflare 或 production 設定。

### 尚未確認

- locale 仍未進入 URL，且 SSR/prerender、`hreflang`、crawler 可讀的每語言 metadata 與韓文搜尋結果截斷效果仍未確認。
- `lease` 在實作中可能分別表示執行權、串流所有權或其他狀態；若未來向維護者暴露精確欄位，最終韓文技術詞仍需依狀態機審閱。
- `법률 정보` 簡化了原 eyebrow 的按需開啟角色；尚未透過實際畫面使用性測試比較是否應保留品牌式 `LEGAL / ON DEMAND`。
- Cookie 屬性、保存期限、Cloudflare 接收者與 SpaceX 非隸屬名單沿用現有已測契約；本輪只審閱韓文表述，未重新驗證 production 設定或列名原因。
- 影片時間與檔案大小仍沿用既有固定格式，尚未決定是否使用 `Intl.NumberFormat('ko')`。
