# Threads username-redacted 公開貼文解析

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

## 可重現證據

1. 受控 HTTP 重現：初始合法 canonical post 在固定 markup User-Agent 下回傳 exact `302`
   與上述唯一 Location；修正前的 baseline 產生 `THREADS_REDIRECT_INVALID`，不會呼叫 renderer。
2. Production failure event 證明 Browser Run 確實被呼叫，但解析停在
   `RENDERED_RESPONSE_INVALID`；事件未保存 request ID 或上游內容。
3. 匿名 `/media` 重現：canonical selector 與 `og:url` selector 各只有一筆，兩者皆為同一
   username-redacted、同 shortcode identity，且 `video[src]` 已可見。證據未保存媒體 URL。
4. Chromium 119 markup 重現會先取滿 10 個 `static.cdninstagram.com` 資產；只更換 markup
   User-Agent 不能完整解決此 response shape，因此本次不改 User-Agent 或通用 extractor。
5. 本機流程證據：`resolve()` 成功後才保存 `resolveId` 與候選；`preview()` 必須先取得這些
   值才能建立 preview session。因此新增預覽不會改變 upstream markup 或 rendered identity。

## 風險檢視

主 Agent 已依專案規則以 ask-bridge（ChatGPT high）做一次 advisory。結論是：redirect gate
必須維持首個 response、exact status 與 exact 原始 Location，特別避免 URL parser 將顯式
預設 port 正規化後誤收；rendered identity 必須逐筆計數、要求兩來源一致並 byte-for-byte
綁定 shortcode。此 advisory 只用於檢查放寬風險，不作為 production 事實或測試證據。

現有程式碼、受控重現與 advisory 已足以界定本次修正，未使用 Web Search。

## 適用範圍

- 只涵蓋免登入、匿名可見，且同時符合上述 exact redirect 與 rendered identity 的公開貼文。
- 不擴張 Threads/CDN host allowlist，不加入 cookie、登入、client headers 或額外 Browser Run
  欄位，不改變 media probe、vault、preview 或 download 的既有驗證。
- Username-redacted 分支只證明同 Threads origin 與同 shortcode，不宣稱仍能驗證原 username。

## 未確認事項

- `invalid_post` redirect 與 username-redacted metadata 是否為 Threads 的穩定或正式契約，
  尚未確認。
- 上游產生這兩個形狀的根本原因，以及是否與地區、實驗分流或反自動化策略有關，尚未確認。
- Shortcode 是否具備永久、全域唯一性，以及所有相同 redirect 都能由 Browser Run 恢復，
  尚未確認。
- 部署後指定貼文能否通過 production media probe、vault 與實際下載，仍須由 exact revision 的
  production 驗證確認。
