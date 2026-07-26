# HTTP 單一 Byte Range 邊界研究

- 查證日期：2026-07-26
- 狀態：完成；RFC 契約與本專案 fail-closed 政策已分開記錄
- 適用範圍：本站同源下載端點的單一 `Range` request、`If-Range` 與上游 Range 轉送

## 問題

當 representation 長度為 10 bytes 時，`Range: bytes=0-10` 與
`Range: bytes=5-999` 的 first position 都仍落在 representation 內。本專案原先將
requested last position 大於或等於長度的情形全部回覆 `416`，需要確認這是否符合
HTTP byte range 的標準語意，以及它對續傳、上游 request 與回應 headers 的影響。

## 研究順序與證據

先依專案規則使用 ask-bridge，參數為：

```text
ask-bridge --provider chatgpt --model high --timeout 1500 --headless=true <focused-prompt>
```

ask-bridge 的回覆只作為待核對線索。後續直接以 RFC Editor 的官方
[RFC 9110 §14.1.2 Byte Ranges](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.1.2)
確認：只要有效 int-range 的 first position 小於目前 representation 長度，該 range
即為 satisfiable；requested last position 缺少或大於等於目前長度時，實際 end 是
`length - 1`。因此 total 為 10 時，`0-10` 應正規化為 `0-9`，`5-999` 應正規化為
`5-9`；`10-10` 與 `20-30` 才因 first position 不小於長度而 unsatisfiable。

另依官方
[RFC 9110 §13.1.5 If-Range](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5)，
`If-Range` 不符合時必須忽略 `Range`，按一般完整 GET 回覆，而不是先解析或拒絕該
Range。

本次沒有使用 Web Search；官方 RFC 頁面是 ask-bridge 線索後的直接一手來源核對。

## 結論與實作契約

- `bytes=0-10`、total 10：正規化為 `0-9`，回覆 `206`。
- `bytes=5-999`、total 10：正規化為 `5-9`，回覆 `206`。
- `bytes=10-10` 或 `bytes=20-30`、total 10：本專案回覆 `416`，並只帶安全的
  `Content-Range: bytes */10`。
- `bytes=-3`、total 10：維持 `7-9`；`bytes=0-` 維持 `0-9`。
- `If-Range` 不符合可靠 validator：忽略 Range，使用完整 `200` transfer。
- 正規化後的 interval 是唯一可交給上游與 transfer plan 的 interval；上游
  `Range`、回應 `Content-Range` 與 `Content-Length` 必須互相一致。
- 同一 header 的 multi-range 維持拒絕，避免第一版引入 multipart transfer。
- `9-8` 是無效 specifier。RFC 允許伺服器忽略或拒絕無效 Range，但沒有規定此情況
  必須使用哪個 status；本專案為一致且可測的 fail-closed 政策而維持 `416`，不得把
  這項選擇描述為 RFC 的強制要求。
- 超出 JavaScript safe integer 的任意大十進位仍視為無效，不能在正規化時 overflow
  或失去精度。

## 適用範圍與未確認事項

本結論只處理 RFC 9110 的單一 `bytes` range、既有 `If-Range` 行為與本站的安全
回應契約；不新增 multipart ranges，也不改變來源 representation validator、完成
區間合併或 Durable Object lifecycle。不同來源 CDN 對合法 canonical Range 的實際
可用性仍需由既有受控 upstream 與部署後驗證確認，不能由 RFC 契約推論特定 CDN
一定正確支援 Range。
