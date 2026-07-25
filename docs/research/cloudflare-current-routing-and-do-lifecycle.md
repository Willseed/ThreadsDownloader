# Cloudflare 現況、Route 與 Durable Objects lifecycle 研究紀錄

- 查證日期：2026-07-26
- 狀態：現況與文件結論完成；實際部署仍受人工核准閘門約束
- 適用專案：`threads.pylot.dev` 的 Cloudflare DNS、Workers Route、SSL/TLS，
  以及 Threads Downloader 的 Durable Objects 首次部署 lifecycle

## 問題

1. `threads.pylot.dev` 目前的 DNS、Workers Route、SSL/TLS 與 Durable Objects
   帳號現況為何？
2. 新增精確的 `threads.pylot.dev/*` Route 是否能與既有 wildcard Route 共存，
   且不影響其他 subdomain？
3. 精確 Route 是否仍會串接既有 `header-rule` Worker？
4. 目前 `wrangler.jsonc` 的頂層 `exports` 在首次部署時會產生什麼
   lifecycle 變更，是否可用一般 rollback 回到建立前？
5. 使用者已核准的 Route 變更與尚未核准的 Durable Objects 建立，邊界在哪裡？

## 研究順序與證據標準

本紀錄使用三層證據，且不把不同層級混寫為同一種事實：

1. 2026-07-26 由主要 agent 在 Cloudflare Dashboard 進行的唯讀觀察，作為目前
   zone、DNS、Route、SSL/TLS 與帳號能力的可重現快照。
2. Cloudflare 官方文件，作為 Route 優先順序、Worker 執行邊界、Durable
   Objects lifecycle 與 rollback 限制的規範證據。
3. ask-bridge 回覆只作為整理官方文件的輔助建議，不是事實來源；採用的結論仍
   必須能由上述 Dashboard 觀察或官方文件支持。

本次子委派曾依專案規則啟動：

```text
ask-bridge --provider chatgpt --model high --timeout 1500 \
  --headless=true <focused-prompt>
```

但 ask-bridge 共用同一個 browser/provider session，並行委派發生串話。本次子代理
的等待因此依主要 agent 指示取消，未完成輸出沒有被當作研究證據。本文採用的是
根代理在另一路收到、內容直接符合聚焦 prompt，且已逐項對照下列官方文件的完成
回覆。這次限制表示：同一共享 session 的並行 ask-bridge 委派不可視為彼此隔離或
可靠歸屬。全程沒有執行 Web Search query。

## 2026-07-26 Dashboard 唯讀現況

查證期間沒有修改 DNS、Route、SSL/TLS、Worker 或 Durable Objects：

| 項目            | 唯讀觀察結果                                                                                                                                                                                                                                                   | 證據邊界                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Zone 方案       | Dashboard banner 顯示 Free                                                                                                                                                                                                                                     | 只代表查證當下的 zone 顯示，不推論未來方案或完整計費規則                          |
| DNS             | `threads.pylot.dev` 是 Proxied CNAME，target 為 `willseed.github.io`                                                                                                                                                                                           | 原需求明定不得修改 DNS；本次也未修改                                              |
| Workers Routes  | `*.pylot.dev/*` → `header-rule`；`tools.pylot.dev/*` → `link-header`                                                                                                                                                                                           | 不存在 `threads.pylot.dev/*` Route                                                |
| `header-rule`   | Dashboard 程式碼編輯器確認：fetch origin 後設定 `X-Frame-Options: SAMEORIGIN`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`，以及允許 `'unsafe-inline'`、`'unsafe-eval'` 與 `https:` 的寬鬆 CSP | 這是唯讀程式碼快照；exact Route 勝出後不會自動執行此 Worker                       |
| Workers         | 不存在名為 `threads-downloader` 的已部署 Worker                                                                                                                                                                                                                | 不代表首次部署一定成功                                                            |
| SSL/TLS         | 模式為 Full (strict)，自動模式停用                                                                                                                                                                                                                             | 本次未變更 SSL/TLS；憑證與 origin 細節不在本紀錄範圍                              |
| Durable Objects | Dashboard 可正常列出既有 SQLite namespaces，沒有 upgrade 提示，本期可計費使用量為 `$0.00`                                                                                                                                                                      | 支持帳號現況可使用 DO；不等於本專案四個 namespace 已建立、已核准或可無損 rollback |

## 官方文件與可採結論

| 官方文件                                                                                                              | 本案使用範圍                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)                             | Route pattern、同時匹配時的 specificity，以及官方 `www.example.com/*` 優先於 `*.example.com/*` 範例 |
| [Workers known issues](https://developers.cloudflare.com/workers/platform/known-issues/)                              | Worker-to-Worker、route 與請求執行限制的風險邊界                                                    |
| [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)            | 需要 Worker 間組合時應使用明確服務邊界，不把外部 Route 誤當成自動 middleware chain                  |
| [Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) | class 建立、刪除與 storage lifecycle；legacy migrations 的限制                                      |
| [Durable Objects get started](https://developers.cloudflare.com/durable-objects/get-started/)                         | Durable Object binding、class 與 namespace 的建立模型                                               |
| [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)                           | 現行頂層 `exports` 設定與 legacy `migrations` 的互斥邊界                                            |
| [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)                    | 一般 Worker version rollback 不會跨越或復原 Durable Object lifecycle migration                      |

## Route 結論與部署決策

### Specificity 與影響範圍

[Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
說明：若多個 pattern 同時匹配，會採用最具體的 pattern；官方例中
`www.example.com/*` 優先於 `*.example.com/*`。套用到本案：

- 新增 `threads.pylot.dev/*` 可與既有 `*.pylot.dev/*` 共存。
- `threads.pylot.dev/*` 比 wildcard 更具體，因此只會改變
  `threads.pylot.dev` 的 Worker 選擇。
- `tools.pylot.dev/*` 仍由其更具體的既有 Route 指向 `link-header`；其他沒有
  精確 Route 的 subdomain 仍匹配 `*.pylot.dev/*` → `header-rule`。
- 這個結論不需要、也不得藉機修改 `threads.pylot.dev` 的 Proxied CNAME。

上述「只影響 threads hostname」是由 Dashboard 現有 pattern 與官方
specificity 規則做出的本案推論；不是對未來新增 Route 的永久保證。

### Worker 不會自動串接，安全標頭由本專案自足

精確 Route 勝出後，`threads.pylot.dev` 的 request 會選擇該 Route 指向的 Worker，
不會再先後自動執行 wildcard 上的 `header-rule`。Cloudflare 的
[known issues](https://developers.cloudflare.com/workers/platform/known-issues/) 與
[best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
也不支持把多條外部 Route 當成 middleware chain；若確實需要 Worker 組合，必須
用明確、受支援的服務邊界設計。

Dashboard 程式碼編輯器已唯讀確認 `header-rule` 的行為。它 fetch origin 後設定
`X-Frame-Options: SAMEORIGIN`、`X-Content-Type-Options: nosniff`、
`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`，並加入允許
`'unsafe-inline'`、`'unsafe-eval'` 與廣泛 `https:` 來源的 CSP。

本專案 `apps/worker/src/index.ts` 已自行對所有 response 套用更嚴格的政策：

- CSP 使用 `frame-ancestors 'none'`，script 只允許 `'self'` 與 Cloudflare
  Turnstile，frame 只允許 Turnstile，connect 只允許 `'self'`；不允許
  `'unsafe-inline'` 或 `'unsafe-eval'`。
- 設定 `Cross-Origin-Resource-Policy: same-origin`、
  `Referrer-Policy: no-referrer`、一年 HSTS、`X-Content-Type-Options: nosniff`，並以
  `Permissions-Policy` 關閉 camera、geolocation 與 microphone。
- `applyResponsePolicy` 會移除所有 `access-control-*` headers，因此不會由 asset
  response 意外開啟 CORS。

`apps/worker/test/index.spec.ts` 的「adds the required security policy and never
enables CORS」測試精確保護 CSP、禁止 unsafe directives、HSTS、nosniff 與 CORS
移除契約。差異風險如下：

| 邊界            | `header-rule`                                          | `threads-downloader`                                            |
| --------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| Frame embedding | `X-Frame-Options: SAMEORIGIN`                          | CSP `frame-ancestors 'none'`，拒絕所有 framing                  |
| CSP script      | 允許 `'unsafe-inline'`、`'unsafe-eval'`、廣泛 `https:` | 只允許 self 與指定 Turnstile origin                             |
| Referrer        | `strict-origin-when-cross-origin`                      | `no-referrer`                                                   |
| 額外政策        | nosniff、Permissions Policy                            | nosniff、限制更明確的 Permissions Policy、CORP、HSTS、CORS 移除 |

因此 exact Route 不需要、也不得依賴 `header-rule` 串接；本專案應維持
`applyResponsePolicy` 的自足安全契約，也不應把 `header-rule` 的寬鬆 CSP 複製到
新 Worker。

### 管理方式與核准

- 原需求要求 Route 由 Cloudflare Dashboard 一次性管理，不把 Route 寫入專案
  設定或部署自動化。
- 使用者已核准建立 `threads.pylot.dev/*` exact Route。
- 使用者的「繼續完成剩餘工作」已授權一般部署；這與 exact Route 核准並行，
  一般 Worker deployment 的授權已明確存在。
- 上述授權不包含 DNS 或 SSL/TLS 變更；首次建立 Durable Objects namespaces
  另受下節的明文 conflict gate 約束。

## Durable Objects lifecycle 結論

專案目前 `wrangler.jsonc` 以 `durable_objects.bindings` 搭配頂層 `exports`
宣告四個 SQLite Durable Object class，且沒有 legacy
`migrations` block：

1. `DOWNLOAD_SESSIONS` → `DownloadSession`
2. `IP_RATE_LIMITS` → `IpRateLimiter`
3. `SESSIONS` → `SessionCoordinator`
4. `TURNSTILE_REPLAYS` → `TurnstileReplay`

依 [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
與
[Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)，
現行頂層 `exports` 可取代 legacy `migrations`，兩者互斥；首次 deploy
會依 exports provision 新的 SQLite namespaces，不另外產生 legacy migration。
因此本案應保留現有 exports，不新增 migrations。

這個首次 provision 仍是 Durable Object class lifecycle change。依
[Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)，
一般 Worker rollback 不能跨回 namespace/class 建立前的版本，即使新 namespace
尚未寫入業務資料。後續可透過新的部署與官方 lifecycle/tombstone 機制移除，
但永久刪除本身也是另一個不可逆 lifecycle boundary，不能描述成一般安全 rollback。

Dashboard 已證明帳號現況可使用 Durable Objects，不會消除上述首次建立風險。
所以首次建立這四個 namespaces 仍屬原需求中的「不可逆 migration」人工核准
閘門，部署前必須取得使用者明確核准。既有的一般部署授權與 exact Route 核准
都不能取代這個較高風險的明文 conflict gate；任何會 provision 四個 namespaces
的首次 deploy 必須在執行前停下取得專門核准。

## 適用範圍

- Dashboard 結果是 2026-07-26 的唯讀快照，只適用於當時的 `pylot.dev` zone。
- Route 推論只適用於已觀察到的三個 pattern 狀態：既有 wildcard、既有 tools
  exact Route，以及規劃中的 threads exact Route。
- Durable Objects 結論適用於目前 repository 的四個 SQLite exports，且以
  Cloudflare 現行文件描述的 exports lifecycle 為準。
- 本紀錄沒有建立 Route、部署 Worker、建立 namespace、修改 DNS、變更 SSL/TLS
  或驗證實際 production request。
- Route 必須保持 Dashboard 一次性管理；本紀錄不授權把它加入 CI、Wrangler
  設定或其他自動化。

## 尚未確認事項

1. Cloudflare Dashboard 對完全相同 Route pattern 重複建立時的實際拒絕、取代或
   衝突行為尚未確認；建立前必須再次唯讀確認 exact Route 仍不存在。
2. 專案鎖定之 Wrangler 精確版本最早從哪一版支持目前 exports schema 尚未
   確認；本地 config schema、單檔 dry-run 與實際部署前檢查是最後邊界。
3. 實際首次部署能否依預期建立四個 namespaces、所選 placement/location、
   production binding 與首次 request 行為尚未驗證。
4. 2026-07-26 之後 DNS、SSL/TLS、方案、既有 Routes、Worker 或帳號計費狀態是否
   被其他人修改尚未確認；執行前必須重新唯讀確認。
5. Dashboard 顯示 `$0.00` 只表示本期查證當下的可計費使用量，不代表未來使用
   永久免費，也不構成費用上限承諾。
6. 一般 rollback 不能跨回 namespace 建立前；任何後續 tombstone／永久刪除仍須
   另行評估並取得相應人工核准。
