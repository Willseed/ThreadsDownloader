# Threads username-redacted 與延遲 carousel 公開貼文解析

- 日期：2026-07-27
- 範圍：匿名公開 Threads 貼文的靜態 markup resolver 與 Browser Run fallback

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

Identity 修正後，指定貼文仍可能提早回傳零候選。Fresh 匿名 Browser Run 證明它是三影片
carousel：clean `/media` 與保留輸入 `xmt` query 都約 4.52--4.56 秒才同時出現三個不同
`video[src]`；相同 production Quick Action 設定卻約 2.35--2.68 秒便回 HTTP 200，identity
有效但候選為零。故本次以固定五秒 hydration delay 取代該次未實現預期等待的
`waitForSelector`，並回傳所有依 DOM 順序、通過 CDN policy 且 canonical-deduped 的候選，
不再捨棄 carousel 的第二、第三支影片。

保留 `xmt` 沒有改變候選數或 hydration 時點，因此 query stripping 不變；preview 必須等
resolve 成功後才能建立，亦不是此解析失敗原因。

## 可重現證據

1. 受控 HTTP 重現：初始合法 canonical post 在固定 markup User-Agent 下回傳 exact `302`
   與上述唯一 Location；修正前的 baseline 產生 `THREADS_REDIRECT_INVALID`，不會呼叫 renderer。
2. Production failure event 證明 Browser Run 確實被呼叫，但解析停在
   `RENDERED_RESPONSE_INVALID`；事件未保存 request ID 或上游內容。
3. Fresh 匿名 `/media` 重現：canonical selector 與 `og:url` selector 各只有一筆，兩者皆為
   同一 username-redacted、同 shortcode identity；clean 與保留 `xmt` 的 session 都在約
   4.52--4.56 秒出現三個不同 `video[src]`。證據未保存媒體 URL 或 query token。
4. Chromium 119 markup 重現會先取滿 10 個 `static.cdninstagram.com` 資產；只更換 markup
   User-Agent 不能完整解決此 response shape，因此本次不改 User-Agent 或通用 extractor。
5. 本機流程證據：`resolve()` 成功後才保存 `resolveId` 與候選；`preview()` 必須先取得這些
   值才能建立 preview session。因此新增預覽不會改變 upstream markup 或 rendered identity。
6. Production Quick Action 對同一貼文在約 2.35--2.68 秒回 HTTP 200，canonical／Open Graph
   identity 仍有效一致但 media selectors 為空；這與 fresh session 的 4.5 秒後 hydration
   對照，證明不能依賴該次 `waitForSelector` 執行到宣告的五秒上限。
7. 三個 hydrated videos 的尺寸、classes 與可安全觀察 attributes 相同，沒有可重現證據可
   正確單選。受控 regression 因此要求三個 unique candidates 依 DOM 順序全數保留，unsafe
   URL 過濾、跨 `video`／`source` dedup 與 downstream 八候選 probe 上限維持不變。

## 風險檢視

主 Agent 已依專案規則以 ask-bridge（ChatGPT high）做一次 advisory。結論是：redirect gate
必須維持首個 response、exact status 與 exact 原始 Location，特別避免 URL parser 將顯式
預設 port 正規化後誤收；rendered identity 必須逐筆計數、要求兩來源一致並 byte-for-byte
綁定 shortcode。此 advisory 只用於檢查放寬風險，不作為 production 事實或測試證據。

現有程式碼、受控重現、fresh anonymous evidence 與既有 advisory 已足以界定本次修正；
延遲 carousel 細項沒有再次外部研究，也未使用 Web Search。

## 適用範圍

- 只涵蓋免登入、匿名可見，且同時符合上述 exact redirect 與 rendered identity 的公開貼文；
  multi-video 行為的直接證據限於指定三影片 carousel。
- 不擴張 Threads/CDN host allowlist，不加入 cookie、登入、client headers 或額外 Browser Run
  欄位，不改變 media probe、vault、preview 或 download 的既有驗證。
- Username-redacted 分支只證明同 Threads origin 與同 shortcode，不宣稱仍能驗證原 username。
- 固定五秒 delay、八秒 action limit、四秒 navigation limit 與兩秒 response read limit，讓
  rendered resolver 的精確 worst-case budget 為 14 秒；workflow 相應要求 render／retry 前
  至少保留 40 秒 lease，probe 最多處理前八個候選。

## 未確認事項

- `invalid_post` redirect 與 username-redacted metadata 是否為 Threads 的穩定或正式契約，
  尚未確認。
- 上游產生這兩個形狀的根本原因，以及是否與地區、實驗分流或反自動化策略有關，尚未確認。
- Shortcode 是否具備永久、全域唯一性，以及所有相同 redirect 都能由 Browser Run 恢復，
  尚未確認。
- 五秒是否足以涵蓋其他地區、其他 carousel 或未來 Threads hydration 行為，尚未確認。
- Full-page media selectors 沒有穩定 post-scoped contract；三個觀察候選屬於指定 carousel，
  但其他頁面形狀是否可能混入非貼文影片尚未確認。
- 部署後指定貼文能否通過 production media probe、vault 與實際下載，仍須由 exact revision 的
  production 驗證確認。
