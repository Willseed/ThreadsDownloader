# Threads username-redacted 與延遲候選公開貼文解析

- 日期：2026-07-27
- 範圍：匿名公開 Threads 貼文的靜態 markup resolver 與 Browser Run fallback
- 後續狀態：本文件前半記錄 Quick Action 失敗形成的歷史證據；固定 delay 方案已被後續
  可重現結果推翻，現行設計改用 exact Cloudflare Puppeteer session 與 DOM readiness。

## 結論

本次失敗不是預覽功能造成。前端只有在 `/api/resolve` 已回傳 `resolveId` 與候選後，
才允許建立 preview session；失敗發生在更早的 Threads 解析階段。

同一公開貼文出現兩個相連的上游形狀：固定 markup User-Agent 的第一個 response 是
精確 `302`，目標是 `https://www.threads.com/?error=invalid_post`；Browser Run 的匿名
`/media` 頁面則把 canonical 與 `og:url` 的 username 隱去為
`https://www.threads.com/@/post/<shortcode>`。既有 resolver 把前者歸為一般無效 redirect，
且 rendered resolver 只接受含 username 的完整 canonical，因此無法恢復。

修正只將「初始 canonical request 的第一個 response、exact `302`、literal 與解析結果都
是上述唯一 URL」分類為專用 internal error，並只讓該錯誤進入既有 Browser Run fallback。
Rendered identity 保留原本 exact canonical，另只接受 canonical link 與 `og:url` 各恰好
一筆、彼此完全一致、且 shortcode 完全相同的 username-redacted URL。其餘 redirect、
identity 或受限內容仍 fail closed。

Identity 修正後，指定貼文仍可能提早回傳零候選。Fresh 匿名 Browser Run 對 clean `/media`
與保留輸入 `xmt` query 都約 4.52--4.56 秒才同時出現三個不同的 rendered `video[src]`
candidate URL；這個 DOM candidate count 本身不證明有三個 media items。相同 production
Quick Action 設定卻約 2.35--2.68 秒便回 HTTP 200，identity
有效但候選為零。當時以固定五秒 hydration delay 取代該次未實現預期等待的
`waitForSelector`；後續相同 Quick Action 仍在約 2.65 秒返回有效 identity 與零候選，證明
固定 delay 也沒有形成真實等待。現行 adapter 因此在同一 Puppeteer Browser 內依序建立兩個
fresh incognito contexts/pages，直接輪詢 live DOM，並合併每個 independently exact-valid
snapshot 中依 context／DOM 順序、通過 CDN policy 且 canonical-deduped 的候選，不因第一頁
已有一個可播放候選就捨棄另一頁才出現的 rendition/version 候選。

保留 `xmt` 沒有改變候選數或 hydration 時點，因此 query stripping 不變；preview 必須等
resolve 成功後才能建立，亦不是此解析失敗原因。

## 可重現證據

1. 受控 HTTP 重現：初始合法 canonical post 在固定 markup User-Agent 下回傳 exact `302`
   與上述唯一 Location；修正前的 baseline 產生 `THREADS_REDIRECT_INVALID`，不會呼叫 renderer。
2. Production failure event 證明 Browser Run 確實被呼叫，但解析停在
   `RENDERED_RESPONSE_INVALID`；事件未保存 request ID 或上游內容。
3. Fresh 匿名 `/media` 重現：canonical selector 與 `og:url` selector 各只有一筆，兩者皆為
   同一 username-redacted、同 shortcode identity；clean 與保留 `xmt` 的 session 都在約
   4.52--4.56 秒出現三個不同的 rendered `video[src]` candidate URL。證據未保存媒體 URL 或
   query token，也不能由 candidate count 推得 media-item count。
4. Chromium 119 markup 重現會先取滿 10 個 `static.cdninstagram.com` 資產；只更換 markup
   User-Agent 不能完整解決此 response shape，因此本次不改 User-Agent 或通用 extractor。
5. 本機流程證據：`resolve()` 成功後才保存 `resolveId` 與候選；`preview()` 必須先取得這些
   值才能建立 preview session。因此新增預覽不會改變 upstream markup 或 rendered identity。
6. Production Quick Action 對同一貼文在約 2.35--2.68 秒回 HTTP 200，canonical／Open Graph
   identity 仍有效一致但 media selectors 為空；這與 fresh session 的 4.5 秒後 hydration
   對照，證明不能依賴該次 `waitForSelector` 執行到宣告的五秒上限。
7. 後續本機唯讀檢查在既有 logged-in Threads 頁面找到 shortcode exact 綁定 media object：
   numeric `media_type` 2、`carousel_media` null、direct `video_versions` 恰好三筆，每筆 keys
   都只有 `type`、`url`，type markers 分別為 101、102、103。當下 DOM 只有一個 video，且
   literal／current URL 都未與 script 中三個 URL byte-exact 相等。這個 bounded shape 與單一
   影片的三個 rendition/version candidates 一致，不支持三個 media items／carousel 的舊說法；
   script 與 DOM URL 的轉換仍未確認，檢查也未保留 cookie、media URL、query token 或 raw
   script value。因沒有可重現的安全 quality ranking，受控 regression
   仍要求 unique candidates 依 DOM 順序全數保留；unsafe URL 過濾、跨 `video`／`source`
   dedup 與 downstream 八候選 probe 上限維持不變。
8. 固定 delay 修正後的 Quick Action 仍約 2.646 秒返回，identity 有效但候選為零；該 provider
   interface 無法作為五秒 hydration 的執行證據。
9. Fresh same-binding proof 使用 exact `@cloudflare/puppeteer@1.1.0`、`nodejs_compat` 與
   1920x1080 viewport；不攔截時約 1.867 秒取得一個候選，套用 production allowlist 時約
   575 ms 取得一個候選。兩次 identity 都各恰好一筆且相同；網路請求只落在既有 Threads、
   static CDN 與 media allowlist；六個 `data:` scripts 不經網路，且 Puppeteer 1.1.0 明確不支援
   interception，因此只可視為 handler no-op，不能宣稱被 abort。沒有 request/control failure。
   Remote Chrome 使用其 default major 128，因此 production page 不覆寫 User-Agent；成功 proof
   也未關閉 cache 或 bypass service worker，production 保留相同 defaults。
10. 另一個相同設定的 fresh browser 導航 HTTP 200，卻在約 161 ms 到八秒的 17 次取樣都維持
    零候選。它與前一輪成功形成直接 nondeterminism 證據：empty 不可 settled；非空須總觀察
    至少五秒且連續穩定三秒，八秒未 ready 後應 bounded close 該 context，再在同一 Browser
    建立第二個 fresh context，不得因 page empty 重新 acquire。
11. Exact same-browser proof 在一個 connected Browser 內依序建立兩個 fresh incognito
    contexts/pages，沿用 production allowlist、1920x1080 viewport、JavaScript、cache／service
    worker defaults；兩頁分別約 6.079 與 5.077 秒得到 matching redacted identity 與一個允許
    候選，兩個 contexts 與 Browser 都成功 closed。
12. 只輸出 typed phase 與 count 的 pre-redesign direct-import 診斷先遇到一次 ordinary launch/connect
    rejection，第二次 fresh launch 在總計 16.497 秒得到 exact full identity 與三個允許候選；
    候選數量不代表 media-item 數量。
    沒有保留 provider ID、media URL、query token、request ID 或 raw error。這支持 ordinary
    launch/connect rejection 的一次 bounded retry，但 absolute timeout 因可能仍有 partial
    acquisition，不得同時再 acquire。
13. 後續 current exact-adapter one-request proof 在 16.095 秒得到 username-redacted identity 與
    aggregate 兩個 allowed candidates；candidate count 仍不代表 media-item count。該次只有一次
    launch，兩個 contexts 與 Browser 都 closed，disconnect 與 readiness timeout 都是零，cleanup
    audit 通過。證據沒有保留 provider ID、media URL、query token、request ID、raw error 或其他
    sensitive value。這證明現行 adapter extraction 與 lifecycle，但不證明 resolve、vault、
    download 或 media decode 已完成。

## 風險檢視

主 Agent 已依專案規則以 ask-bridge（ChatGPT high）做一次 advisory。結論是：redirect gate
必須維持首個 response、exact status 與 exact 原始 Location，特別避免 URL parser 將顯式
預設 port 正規化後誤收；rendered identity 必須逐筆計數、要求兩來源一致並 byte-for-byte
綁定 shortcode。此 advisory 只用於檢查放寬風險，不作為 production 事實或測試證據。

現有程式碼、受控重現、fresh anonymous evidence 與既有 advisory 已足以界定本次修正；
延遲候選細項沒有再次外部研究，也未使用 Web Search。

## 適用範圍

- 只涵蓋免登入、匿名可見，且同時符合上述 exact redirect 與 rendered identity 的公開貼文；
  三個已觀察 URL 只可描述為 rendition/version candidates，沒有 multi-item carousel 的直接證據。
- 不擴張 Threads/CDN host allowlist，不加入 cookie、登入、client headers 或額外 Browser Run
  欄位，不改變 media probe、vault、preview 或 download 的既有驗證。
- Username-redacted 分支只證明同 Threads origin 與同 shortcode，不宣稱仍能驗證原 username。
- 每次 launch/connect absolute deadline 為八秒；最多兩次 ordinary rejection acquisition。
  每個 context 用 20 秒 active-work deadline 包住 createContext/newPage、page setup、四秒
  navigation、八秒 DOM readiness、evaluate 與 dispose，再保留四秒 context close；兩個
  contexts 後另保留四秒 Browser close。Foreground renderer 上限是
  `2*8 + 2*(20+4) + 4 = 68` 秒。再加八秒 probe、兩次各八秒 vault 與兩秒 margin，fallback
  前至少保留 94 秒；這個 remaining-time gate 保證 renderer 68 加 post-render 26 不越過
  120 秒 session/IP permit expiry。Turnstile siteverify fetch 與 static resolver 各有八秒 local
  bound，規劃中的 bounded components 因而合計 110 秒、名義 allowance 十秒；但 permit DO calls、
  replay stub 與 CPU/scheduling 沒有相同 local wall bound，所以這不是 strict whole-request maximum。
- Fresh launch 設定 minimum 10 秒 `keep_alive` provider idle setting；它不證明 no-handle orphan
  的 exact closure time。Context 與 Browser close 各最多等待四秒，
  timeout 後 disconnect 且停止 enrichment，但已驗證允許候選不被 cleanup failure 抹除。
  Context active timeout 的 `waitUntil` cleanup 最多 18 秒；最晚 context2 可到 renderer-relative
  第 78 秒結束，比 68 秒 foreground 多十秒並可能與下一次 resolve 重疊。Absolute launch
  timeout 不再 acquire；pending launch 最多觀察 14 秒，若出現 Browser handle 再 close 四秒。
  始終沒有 handle 的 partial provider acquisition 無法主動取消，也不能描述成已 closed。
  Package 執行順序是 acquire→connect，因此 ordinary post-acquire connect rejection 也可能沒有
  handle；允許的一次 retry 可能短暫重疊第一個 provider session。這是為保留下載功能接受的
  provider-resource residual，不是 local cleanup guarantee。
- 上述 Puppeteer proof 只證明 same-binding adapter 選項、既有 allowlist 與 nondeterminism；
  不證明本次 revision 已部署，也不證明 production resolve、vault 或實際下載成功。

## 未確認事項

- `invalid_post` redirect 與 username-redacted metadata 是否為 Threads 的穩定或正式契約，
  尚未確認。
- 上游產生這兩個形狀的根本原因，以及是否與地區、實驗分流或反自動化策略有關，尚未確認。
- Shortcode 是否具備永久、全域唯一性，以及所有相同 redirect 都能由 Browser Run 恢復，
  尚未確認。
- Acquired Browser 內不同 fresh contexts 與不同 fresh acquisitions 為何在相同設定下分別出現
  一個、三個或八秒零候選，尚未確認；兩個 contexts 與一次 ordinary acquisition retry 能涵蓋
  多少地區、實際 multi-item carousel 或未來 Threads hydration 行為也尚未確認。
- Full-page media selectors 沒有穩定 post-scoped contract；三個觀察 URL 與 script 中三個
  `video_versions` URL 的 exact 對應尚未確認，其他頁面形狀是否可能混入非貼文影片也尚未確認。
- 部署後指定貼文能否通過 production media probe、vault 與實際下載，仍須由 exact revision 的
  production 驗證確認。
