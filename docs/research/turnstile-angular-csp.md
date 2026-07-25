# Turnstile Angular SPA 與 CSP 研究紀錄

- 查證日期：2026-07-25；窄版 reflow 追加查證：2026-07-25
- 狀態：完成
- 適用專案：Threads Downloader 的 Angular SPA、同源 Worker API 與回應 CSP

## 問題

1. Angular SPA 應如何載入、建立、重設與移除 Turnstile widget？
2. JSON API 流程應如何保存與失效 Turnstile token？
3. Turnstile 需要哪些 CSP 來源，是否需要 `connect-src`、
   `unsafe-inline` 或 `unsafe-eval`？
4. 前端 `action` 應使用什麼值，才能符合既有 Worker 驗證契約？

## 研究順序與狀態

先依專案研究原則使用 ask-bridge，呼叫參數為：

```text
ask-bridge --provider chatgpt --model high --timeout 1500 \
  --headless=true --new --output <temporary-markdown> <focused-prompt>
```

ask-bridge 已成功完成並產生 Markdown 回覆，未發生登入、逾時或工具不可用。
臨時輸出位置、對話連結與完整 prompt 不納入專案紀錄；研究內容不含憑證、
site secret、token 或其他敏感資料。ask-bridge 回覆只作為待驗證的研究建議，
不是事實來源。

接著直接開啟下列 Cloudflare 官方文件交叉驗證，沒有執行 Web Search query：

| 官方文件                                                                                                                      | 交叉驗證章節                                                                                                                                 | 已確認證據                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Embed the widget](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)                            | Explicit rendering、Optional calls、Advanced SPA implementation、Widget lifecycle management、Security requirements                          | SPA 適用 explicit rendering；官方 script URL 與 `defer` 範例；`ready`、`render`、`reset`、`remove`；禁止 proxy/cache；Siteverify 必要且 token 為 300 秒、一次性  |
| [Widget configurations](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/) | Rendering methods、Callback configuration、Retry behavior、Refresh behavior、Custom data、Form integration、Complete configuration reference | success/error/expired/timeout callbacks；expired callback 不會自行 reset；`response-field` 可關閉；retry 與 refresh-expired 預設為 `auto`；action 長度與字元限制 |
| [Validate the token](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)                         | Mandatory server-side validation、Token characteristics、Enhanced validation with custom checks、Best practices                              | Siteverify 必須由伺服器執行；token 有效 300 秒且只能使用一次；應驗證指定的 action 與 hostname                                                                    |
| [Content Security Policy](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)                     | Content Security Policy、Pre-clearance support                                                                                               | allowlist 模式需允許 Turnstile 的 `script-src` 與 `frame-src`；只有 pre-clearance 額外明列 `connect-src 'self'`                                                  |

## 2026-07-25 窄版 reflow 追加查證

本次先依研究原則使用 ask-bridge，實際 CLI 參數為：

```text
ask-bridge --provider chatgpt --model high --timeout 1500 \
  --headless=true --new \
  --output /private/tmp/td-turnstile-responsive.md <focused-responsive-prompt>
```

第一次 sandbox 呼叫因
`Failed to write mcp_servers.json: Operation not permitted (os error 1)` 權限錯誤而失敗，
該次呼叫沒有產生可採信的研究回覆。隨後使用使用者既有核准的 escalated
ask-bridge，以相同參數重跑成功並產生完整回覆檔。ask-bridge 回覆只作為待驗證
建議，採用結論仍以 Cloudflare 官方文件為證據。接著直接開啟
[Widget configurations](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/)
交叉驗證，沒有執行 Web Search query。

官方 configuration reference 確認 explicit render 的 `size` 可使用 `normal`、
`flexible` 與 `compact`。其中 `compact` 是固定 `150px × 140px`，適用於 mobile
interfaces、sidebars 與水平空間受限的布局；`flexible` 雖為容器寬度 100%，仍有
300px 最小寬度。由於本頁在 320 CSS px viewport 扣除頁面與 challenge padding 後
可能低於 300px，本專案固定採用：

```text
size = compact
```

此決策適用於目前的 Managed widget、單欄窄版布局與 explicit rendering。容器保留
至少 150px 的 inline space、允許 `max-inline-size: 100%`，且不使用 transform、
scale 或 `overflow: hidden` 裁切 widget。沒有採用或推測不存在官方保證的自動尺寸
切換。

Cloudflare 官方文件沒有保證 widget 在所有互動狀態均符合 WCAG 400% zoom／
320 CSS px reflow，也未保證小於尺寸下限時會自動切換。正式可及性驗收仍需使用
320 CSS px viewport 對實際 Turnstile widget 狀態執行 E2E；此項目前尚未確認。

## 結論與專案決策

### Script 與 widget lifecycle

- Angular SPA 採 explicit rendering，直接且只載入一次：

  ```html
  <script
    src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    defer
  ></script>
  ```

- `api.js` 必須由 Cloudflare 官方 URL 直接取得，不得 proxy、self-host、打包或
  固定快取。
- API 可用後以 `ready` 呼叫 `render`，並保存其回傳的 `widgetId`；需要新 token
  時以該 ID 呼叫 `reset`，widget 不再需要時呼叫 `remove`。
- Angular 實作必須防止元件已銷毀、延遲的 `ready` callback 卻再次 render 的
  race。這是把官方 SPA lifecycle 映射到 Angular 的本地安全措施，不是
  Cloudflare 的 Angular 專屬規範。

### Token 與 callback

- success callback 取得的 token 只能送到同源 Worker API；secret 只存在 Worker
  secret binding，不得進入前端 bundle。
- error、expired 與 timeout callback 都必須清除本地 token 並維持 fail closed；
  expired callback 不代表 widget 已自行 reset。
- token 最長有效 300 秒且一次性。每次受保護 request 結束後，包含失敗、逾時
  或無法判斷伺服器是否已消耗 token 的結果，都不得重用原 token；清除本地
  token，並在下次嘗試前取得新 token。這是依一次性契約採取的保守專案決策。
- 本案由 Angular `HttpClient` 傳送 JSON，不依賴 native form hidden field，因此
  設定 `response-field: false`。保留 `retry: "auto"` 與
  `refresh-expired: "auto"` 的官方預設，但 callback 仍需立即清除應用程式內的
  舊 token。

### Action 契約

前端固定使用：

```text
action = resolve
```

Cloudflare 只規定 action 最多 32 個字元，且限英數、`_`、`-`；它不替應用程式
決定名稱。ask-bridge 建議的其他名稱不適用於本專案。現有
`apps/worker/src/security/turnstile.ts` 已對 Siteverify 回應執行
`decoded.action === "resolve"` 的精確檢查，
`apps/worker/test/turnstile.spec.ts` 也以 `resolve` 保護成功與 mismatch 契約。
前端若使用其他 action，合法請求會被 Worker fail closed 拒絕。

Worker 仍必須要求 Siteverify `success === true`，並精確驗證預期 action 與部署
環境 hostname；client callback 成功不能替代伺服器驗證。

### CSP

目前不使用 pre-clearance。採 Cloudflare 官方 hostname allowlist 方案時，
Turnstile 所需的最小第三方增量是：

```text
script-src https://challenges.cloudflare.com
frame-src https://challenges.cloudflare.com
```

與本專案自己的來源合併後，相關 directive 應為：

```text
default-src 'self';
script-src 'self' https://challenges.cloudflare.com;
frame-src https://challenges.cloudflare.com;
connect-src 'self';
```

`connect-src 'self'` 是 Angular 呼叫同源 `/api/*` 的應用需求；標準 Turnstile
文件沒有要求 `connect-src https://challenges.cloudflare.com`。若日後啟用
pre-clearance，官方另要求 `connect-src` 包含 `'self'`，屆時應重新驗證完整
CSP。

Turnstile 官方 CSP 文件沒有要求 `unsafe-inline` 或 `unsafe-eval`，本案不得為
Turnstile 加入兩者。上列內容只描述 Turnstile 與同源 API 的必要部分，不取代
對 Angular assets、圖片、字型或其他未來資源所做的完整 CSP 盤點。

## 適用範圍

- 適用於瀏覽器端 Angular standalone SPA 的單一 Turnstile widget lifecycle。
- 適用於目前以 JSON 傳送 token、由 Worker 呼叫 Siteverify 的同源 API 流程。
- 適用於目前未啟用 pre-clearance、未 proxy/self-host Turnstile script 的部署。
- 本紀錄不確認任何 Threads 上游未公開 API 語意，也不改變 Worker 已有的
  replay、hostname、challenge age 或錯誤處理契約。

## 尚未確認事項

1. Cloudflare 文件沒有明文說明 SRI 是否受支援或禁止，也未提供固定 hash。
   由於官方要求精確動態 URL 且禁止 proxy/cache，本案不替 `v0/api.js` 固定
   SRI hash；這是保守推論，不宣稱是官方禁令。
2. Cloudflare 沒有 Angular-specific hook 契約；`ngAfterViewInit`、
   `ngOnDestroy` 與 destroyed guard 的具體安排必須由本地測試確認。
3. 官方 explicit rendering 範例使用 `defer`，但沒有證據證明 `async` 是必要或
   禁止；本案沿用官方 `defer` 範例。
4. 官方只示範 `turnstile.ready(callback)` 的用途，未完整定義 callback 取消、
   script 永久載入失敗或排程順序；實作需以 timeout/error 狀態 fail closed。
5. 標準模式沒有額外 `connect-src` 官方需求；若新增 pre-clearance、analytics、
   WebSocket 或其他外部連線，必須針對新增範圍另行查證。
