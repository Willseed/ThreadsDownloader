# Turnstile Angular SPA 與 CSP 研究紀錄

- 查證日期：2026-07-25；窄版 reflow 追加查證：2026-07-25；Web Analytics CSP
  與 production lifecycle 故障追加查證：2026-07-27；flexible 橫幅版面決策：2026-07-27
- 狀態：完成
- 適用專案：Threads Downloader 的 Angular SPA、同源 Worker API 與回應 CSP

## 問題

1. Angular SPA 應如何載入、建立、重設與移除 Turnstile widget？
2. JSON API 流程應如何保存與失效 Turnstile token？
3. Turnstile 需要哪些 CSP 來源，是否需要 `connect-src`、
   `unsafe-inline` 或 `unsafe-eval`？
4. 前端 `action` 應使用什麼值，才能符合既有 Worker 驗證契約？
5. Cloudflare automatic Web Analytics 需要放行哪些 CSP 來源？

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
可能低於 300px，本專案當時採用：

```text
size = compact
```

此決策當時適用於 Managed widget、單欄窄版布局與 explicit rendering。容器保留
至少 150px 的 inline space、允許 `max-inline-size: 100%`，且不使用 transform、
scale 或 `overflow: hidden` 裁切 widget。沒有採用或推測不存在官方保證的自動尺寸
切換。

Cloudflare 官方文件沒有保證 widget 在所有互動狀態均符合 WCAG 400% zoom／
320 CSS px reflow，也未保證小於尺寸下限時會自動切換。正式可及性驗收仍需使用
320 CSS px viewport 對實際 Turnstile widget 狀態執行 E2E；此項目前尚未確認。

## 2026-07-27 flexible 橫幅版面決策

本次直接沿用上節已由 Cloudflare 官方
[Widget configurations](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/)
交叉確認的尺寸證據，沒有重複呼叫 ask-bridge，也沒有執行 Web Search query。官方
reference 記載 `normal` 固定為 `300px × 65px`、`flexible` 為容器寬度 100%、高度
`65px` 且最小寬度 `300px`，`compact` 則固定為 `150px × 140px`。

首頁已改為置中單欄表單；compact 在 390 CSS px 與桌面表單內會形成直式方塊，與
輸入框及主要按鈕的橫向視覺節奏不一致。因此 explicit render 改為：

```text
size = flexible
```

容器採 `inline-size: 100%`、`min-inline-size: 300px` 與
`min-block-size: 65px`，不使用 transform、scale 或裁切。為在 320 CSS px viewport
仍滿足官方 300px 最小寬度，只有最窄的 `max-width: 22rem` breakpoint 收斂
downloader page 與 form 的水平 padding；頁面本身仍維持 320px 最小寬度，不降低
既有控制項觸控目標，也不改變 Turnstile lifecycle 或驗證流程。

本地 Playwright fixture 依同一官方尺寸契約模擬寬 100%、最小 300px、高 65px，並
在 1280、390 與 320 CSS px viewport 驗證橫幅寬度、無水平 overflow、網址輸入首屏、
44px 控制項、焦點、reduced motion 與 axe。這些測試證明應用程式容器與 reflow
契約，不宣稱替代真實 Cloudflare iframe 在所有 challenge 狀態的正式可及性驗收。

## 2026-07-27 Cloudflare Web Analytics CSP 追加查證

本次沿用已完成的外部查證與正式頁證據，沒有重複呼叫 ask-bridge，也沒有執行 Web
Search query。交叉驗證的 Cloudflare 官方文件如下：

| 官方文件                                                                                                                                                             | 已確認證據                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Web Analytics CSP FAQ](https://developers.cloudflare.com/web-analytics/faq/#what-do-i-need-to-add-to-my-content-security-policy-csp)                                | Web Analytics beacon script 由 `static.cloudflareinsights.com` 載入。        |
| [Automatic 與 manual setup FAQ](https://developers.cloudflare.com/web-analytics/faq/#i-am-proxying-my-site-through-cloudflare-should-i-manually-add-the-js-beacon)   | 經 Cloudflare proxy 的網站可由 automatic setup 注入 beacon，不需再手動加入。 |
| [Data origin and collection](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/)                                               | Web Analytics 收集的資料範圍與 beacon 傳輸用途。                             |
| [Cloudflare CSP product requirements](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/#product-requirements) | Web Analytics 的 CSP product requirement 與 Cloudflare 官方來源。            |
| [Web Analytics changelog](https://developers.cloudflare.com/web-analytics/changelog/)                                                                                | Beacon 會持續更新，因此 CSP 不應綁定特定 beacon 版本路徑。                   |

Automatic setup 實際注入的 script URL 形狀為：

```text
https://static.cloudflareinsights.com/beacon.min.js/<version>
```

官方 FAQ 說明 automatic setup 會 POST 到同源 `/cdn-cgi/rum`，因此目前
`connect-src 'self'` 已涵蓋這個傳輸，不需要額外放行
`https://cloudflareinsights.com`。manual setup 才可能直接使用
`https://cloudflareinsights.com/cdn-cgi/rum`；本專案目前不採 manual setup。

此外，直接下載並檢查當時由 Cloudflare 提供的 `2026.6.0` beacon，確認它處理
`data-cf-beacon` 的 `2024.11.0` 設定時使用相對 URL `/cdn-cgi/rum`。這項可重現
檢查只證明該版本快照的行為，不取代官方文件，也不構成固定 script 或設定版本的
依據。

因此 automatic setup 的最小 CSP 增量只有：

```text
script-src https://static.cloudflareinsights.com
```

此結論只適用於目前由 Cloudflare proxy 注入、以同源 `/cdn-cgi/rum` 傳輸的
automatic Web Analytics。它不適用於 manual setup、自訂 beacon、不同 proxy 路徑
或未來 Cloudflare 改變傳輸來源的情況；發生任一情況時必須依當時官方文件與實際
beacon 重新驗證。未確認事項是 Cloudflare 未來 beacon 版本是否會改變傳輸來源，
所以本案不寫死 beacon 版本，也不預先放寬 `connect-src`。

## 2026-07-27 production lifecycle 故障追加查證

本次先依研究原則使用 ask-bridge，沿用本文開頭記錄的 provider、model、timeout
與 headless 參數。研究完成後，再以 production 可重現現象、當時的官方 script
內容與 Cloudflare 官方文件交叉驗證；沒有執行 Web Search query。

Production `https://threads.pylot.dev/` 的 `/api/session` 成功，頁面工作階段狀態為
ready，且瀏覽器已載入精確的
`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`，但頁面沒有
Turnstile iframe，並顯示「安全驗證無法使用」。Console 同時出現：

```text
[Cloudflare Turnstile] turnstile.ready() would break if called *before* the Turnstile api.js script is loaded by visitors.
```

直接取得當時官方 `v0/api.js?render=explicit` 並跟隨 redirect 到版本化 script 後，
可重現檢查確認 `ready` 實作會在內部 `scriptWasLoadedAsync` 為真時先警告，再拋出
錯誤碼 `3857` 與下列錯誤：

```text
Remove async/defer from the Turnstile api.js script tag before using turnstile.ready().
```

這項 script 內容只證明故障當下的官方版本快照；專案仍使用 `v0` 動態 URL，不能
固定、proxy 或快取該版本化內容。

接著交叉驗證 Cloudflare 官方的
[client-side rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)、
[widget configurations](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/)、
[client-side errors](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/)
與 [CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)
文件。Explicit rendering 的基本與 onload 範例都是在 script 可用後直接呼叫
`turnstile.render()`；`turnstile.ready()` 只出現在同步 classic script 的 SPA 範例，
官方沒有提供動態 `async`／`defer` loader 再呼叫 `ready` 的契約。

故障實作以動態 script 的 `load` event 確認載入完成，卻在 event 後又呼叫
`turnstile.ready()`。script 本身明確設定 `defer = true`，因此命中上述 guard，
例外被前端 fail closed 轉成安全驗證無法使用。最小且有官方證據支持的修正是保留
既有 script `load`／`error`／timeout、API shape 驗證與 fail-closed 行為，在 `load`
完成後直接 `render`，不再使用 `ready` 或額外的 ready timeout。這不需要 inline
onload、query-string global callback、全域 callback 或 CSP 放寬。

同一 loader 的 concurrent pending 契約也必須先於早期 `window.turnstile` 偵測：
第一個 mount 正在等 script `load` 時，即使 API object 暫時已出現在 window，後續
mount 仍應共用 pending promise，不能在 load 前提早 render。這是同一載入完成邊界
的 race 修正，並由直接單元測試保護。

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
- Angular 動態 loader 監聽 script `load`、`error` 並設置 timeout；`load` 後驗證
  API shape 並直接呼叫 `render`，不使用 `turnstile.ready()`。保存 `render` 回傳的
  `widgetId`；需要新 token 時以該 ID 呼叫 `reset`，widget 不再需要時呼叫
  `remove`。
- Loader 有 pending 時必須先共用 pending，再檢查 window 上的 API；widget 已
  移除或容器已中斷連線時不得 render。這些是把官方 script 載入與 widget lifecycle
  映射到 Angular 的本地 race 防護，不是 Cloudflare 的 Angular 專屬規範。

### Widget 尺寸與窄版 reflow

- Explicit render 固定使用 `size: "flexible"`，讓官方 widget 在單欄表單內呈現寬
  100%、高 65px 的橫幅，且遵守 300px 最小寬度。
- 容器與最窄 breakpoint 必須保留至少 300px 可用 inline space；不得用 transform、
  scale、`overflow: hidden` 或其他裁切方式把官方 widget 塞入較窄空間。
- 320 CSS px viewport 的應用程式回歸測試必須同時保護無水平 overflow、網址輸入首屏、
  44px 控制項、焦點與 axe；不得以降低頁面 min-width 解決尺寸衝突。

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

automatic Web Analytics 另外只在既有 `script-src` 加入
`https://static.cloudflareinsights.com`。不加入 `https://cloudflareinsights.com`，
不改動 `connect-src 'self'`，也不加入 `unsafe-inline`、`unsafe-eval` 或其他寬鬆
fallback。完整相關 directive 為：

```text
script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com;
frame-src https://challenges.cloudflare.com;
connect-src 'self';
```

## 適用範圍

- 適用於瀏覽器端 Angular standalone SPA 的單一 Turnstile widget lifecycle。
- 適用於目前以 JSON 傳送 token、由 Worker 呼叫 Siteverify 的同源 API 流程。
- 適用於目前未啟用 pre-clearance、未 proxy/self-host Turnstile script 的部署。
- 適用於目前置中單欄首頁與 320 CSS px 以上 viewport 的 flexible Turnstile 橫幅布局。
- 適用於 Cloudflare proxy 的 automatic Web Analytics 注入與同源 `/cdn-cgi/rum`
  傳輸，不涵蓋 manual setup。
- 本紀錄不確認任何 Threads 上游未公開 API 語意，也不改變 Worker 已有的
  replay、hostname、challenge age 或錯誤處理契約。

## 尚未確認事項

1. Cloudflare 文件沒有明文說明 SRI 是否受支援或禁止，也未提供固定 hash。
   由於官方要求精確動態 URL 且禁止 proxy/cache，本案不替 `v0/api.js` 固定
   SRI hash；這是保守推論，不宣稱是官方禁令。
2. Cloudflare 沒有 Angular-specific hook 契約；`ngAfterViewInit`、
   `ngOnDestroy` 與 destroyed guard 的具體安排必須由本地測試確認。
3. 官方 explicit rendering 範例使用 `defer`；當時官方 script 另明確拒絕以
   `async`／`defer` 載入後呼叫 `ready`。本案沿用官方 `defer` 範例，但不再呼叫
   `ready`；未確認未來 script 內部實作是否會改變。
4. 官方沒有提供動態 loader 搭配 `ready` 的 callback 取消或排程契約；本案不依賴
   該 seam，script 永久載入失敗仍由既有 timeout/error 狀態 fail closed。
5. Turnstile 標準模式與 automatic Web Analytics 都沒有額外第三方 `connect-src`
   需求；若新增 pre-clearance、manual Web Analytics、WebSocket 或其他外部連線，
   必須針對新增範圍另行查證。
6. 本地 E2E fixture 已保護 flexible 容器尺寸與頁面 reflow，但真實 Cloudflare iframe
   在所有互動、錯誤與 challenge 狀態下的 320 CSS px／400% zoom 可及性仍尚未確認。
