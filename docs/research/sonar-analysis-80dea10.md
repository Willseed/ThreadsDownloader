# SonarCloud main analysis `80dea10` 稽核

## 結論與適用範圍

- 稽核日期：2026-07-26。
- 目標：`Willseed_ThreadsDownloader` 的 `main` analysis；UI 在開始稽核時顯示 commit
  `80dea103`，與指定 SHA 前綴 `80dea10` 相符。
- 該 analysis 的 Quality Gate 為 **Failed**，而且選取的 New Code 分頁顯示恰好
  2 個 failed conditions。
- 本次只使用已登入 Chrome 中的 SonarCloud 可見 UI，沒有使用 Web Search、API、
  token、帳號識別資訊或完整 opaque task ID，也沒有修改 SonarCloud 設定。
- 稽核進行期間，latest main analysis 前進到 `86644a90`。因此以下「目標 analysis」
  表格只採用 latest 尚為 `80dea103` 時直接顯示的資料；之後才讀到的 measures 與
  hotspot 狀態另列，不能回填成 `80dea10` 的歷史值。

## Quality Gate failed conditions

| Scope    | Condition          | Actual | Required |
| -------- | ------------------ | -----: | -------: |
| New Code | Reliability Rating |      D |        A |
| New Code | Security Rating    |      C |        A |

Coverage、Duplicated Lines (%) 與 New Security Hotspots 在該 summary 頁有顯示數值，
但不是這次 Gate 的 failed conditions。

## 目標 analysis 指標

| 指標                 |                             New Code | Overall Code | 證據範圍                                          |
| -------------------- | -----------------------------------: | -----------: | ------------------------------------------------- |
| Coverage             | 85.63%（UI 原值 85.62824752007558%） |        85.4% | `80dea103` summary／overview                      |
| Duplicated Lines (%) |                                0.29% |         0.6% | `80dea103` summary／overview                      |
| Security Hotspots    |                                0 new |     尚未確認 | `80dea103` summary；overall 頁於 SHA 漂移後才讀取 |
| Open Issues          |                                    — |           76 | target overview 與 issue list                     |
| Security Issues      |                                    — |            6 | target overview                                   |

Issue filter 同時顯示 Security 6、Reliability 42、Maintainability 43。這些是 impact
分類而非互斥 issue 類別，所以總和可以大於 76。

## SHA 漂移後的唯讀 measures

下列數值是在 UI 的 latest analysis 已變成 `86644a90` 後讀取，只能作為後續分析的
即時參考，不得視為 `80dea10` 的歷史 measures：

| 指標                     |                         New Code | Overall Code |
| ------------------------ | -------------------------------: | -----------: |
| Coverage                 | 85.72%（panel 四捨五入為 85.7%） |        85.5% |
| Lines to Cover           |                            4,881 |        5,642 |
| Uncovered Lines          |                              673 |          792 |
| Line Coverage            |                            86.2% |        86.0% |
| Uncovered Conditions     |                              540 |          633 |
| Condition Coverage       |                            85.1% |        84.8% |
| Duplicated Lines Density |   0.28%（panel 四捨五入為 0.3%） |         0.6% |
| Duplicated Lines         |                               88 |          100 |
| Duplicated Blocks        |                               10 |           11 |
| Duplicated Files         |              UI 未列 New Code 值 |            6 |

較新 analysis 的 6 個非零 duplication files 為：

- `apps/worker/src/security/resolved-media-grant.ts`：8.3%，25 lines。
- `apps/worker/src/ip-rate-limiter.ts`：4.8%，12 lines。
- `apps/worker/src/security/download-media-codec.ts`：4.2%，14 lines。
- `apps/worker/src/security/download-session-client.ts`：2.1%，25 lines。
- `packages/contracts/src/index.ts`：2.0%，12 lines。
- `apps/worker/src/session-coordinator.ts`：0.7%，12 lines。

其餘 92 個 components 在該頁被標示為 0.0%。

## Security Hotspots

- 目標 `80dea103` summary：New Security Hotspots 為 0。
- latest 已前進到 `86644a90` 後的 Hotspots 頁：To review 0、Fixed 0、Safe 0。
- SonarCloud UI 同頁明示 Security Hotspots 已 deprecated，新的相關 findings 會出現在
  Security Issues 或 Vulnerabilities。
- 因 Hotspots 全狀態頁是在 SHA 漂移後讀取，`80dea10` 的 Overall Hotspots 狀態仍為
  **尚未確認**。

## Open Issues（76/76）

Issue list 在單一頁一次載入全部 76 筆，沒有 issue-list pagination。檔案、行號與
message 都由該列表直接取得。僅在 detail UI 明確顯示 rule link 時才記錄 rule；已確認
12 筆，其餘 64 筆依專案規則標示「尚未確認」，沒有依 message 猜測 rule。

|   # | File                                                          |  Line | Rule             | Message                                                                                                      |
| --: | ------------------------------------------------------------- | ----: | ---------------- | ------------------------------------------------------------------------------------------------------------ |
|   1 | apps/web/src/app/features/downloader/downloader-page.ts       |  L409 | typescript:S6582 | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|   2 | apps/worker/src/index.ts                                      |   L94 | typescript:S7747 | `for…of` can iterate over iterable, it's unnecessary to convert to an array.                                 |
|   3 | apps/worker/src/index.ts                                      |  L208 | typescript:S7763 | Use `export…from` to re-export `SessionCoordinator`.                                                         |
|   4 | apps/worker/src/index.ts                                      |  L208 | typescript:S7763 | Use `export…from` to re-export `DownloadSession`.                                                            |
|   5 | apps/worker/src/ip-rate-limiter.ts                            |   L71 | typescript:S2871 | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|   6 | apps/worker/src/resolver/markup-tags.ts                       |   L84 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|   7 | apps/worker/src/resolver/markup-tags.ts                       |  L100 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|   8 | apps/worker/src/resolver/markup-tags.ts                       |  L117 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|   9 | apps/worker/src/resolver/markup-tags.ts                       |  L122 | typescript:S7758 | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  10 | apps/worker/src/resolver/media-probe.ts                       |   L85 | typescript:S2871 | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  11 | apps/worker/src/resolver/media-probe.ts                       |   L87 | typescript:S2871 | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  12 | apps/worker/src/resolver/media-probe.ts                       |  L281 | typescript:S2871 | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  13 | apps/worker/src/resolver/public-threads-markup.ts             |  L135 | 尚未確認         | Consider removing this 'try' statement as promise rejection is already captured by '.catch()' method.        |
|  14 | apps/worker/src/security/browser-session.ts                   |   L63 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  15 | apps/worker/src/security/browser-session.ts                   |   L73 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  16 | apps/worker/src/security/browser-session.ts                   |   L97 | 尚未確認         | Unnecessarily cloning an array.                                                                              |
|  17 | apps/worker/src/security/browser-session.ts                   |   L98 | 尚未確認         | Unnecessarily cloning an array.                                                                              |
|  18 | apps/worker/src/security/browser-session.ts                   |  L124 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  19 | apps/worker/src/security/client-ip.ts                         |   L34 | 尚未確認         | Use `.includes()` instead of `.some()` when checking value existence.                                        |
|  20 | apps/worker/src/security/cryptography.ts                      |   L40 | 尚未確認         | Invalid group length in numeric value.                                                                       |
|  21 | apps/worker/src/security/cryptography.ts                      |   L40 | 尚未確認         | Invalid group length in numeric value.                                                                       |
|  22 | apps/worker/src/security/cryptography.ts                      |   L73 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  23 | apps/worker/src/security/download-media-codec.ts              |   L59 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  24 | apps/worker/src/security/download-media-codec.ts              |   L60 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  25 | apps/worker/src/security/download-session-client.ts           |   L11 | 尚未確認         | './range-transfer.js' imported multiple times.                                                               |
|  26 | apps/worker/src/security/download-session-client.ts           |   L12 | 尚未確認         | './range-transfer.js' imported multiple times.                                                               |
|  27 | apps/worker/src/security/download-session-client.ts           |  L181 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  28 | apps/worker/src/security/download-session-client.ts           |  L182 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  29 | apps/worker/src/security/download-session-client.ts           |  L450 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  30 | apps/worker/src/security/download-session-client.ts           |  L670 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  31 | apps/worker/src/security/download-session-client.ts           |  L745 | 尚未確認         | Prefer using nullish coalescing operator (`??`) instead of a ternary expression, as it is simpler to read.   |
|  32 | apps/worker/src/security/download-session-client.ts           |  L752 | 尚未確認         | Prefer using nullish coalescing operator (`??`) instead of a ternary expression, as it is simpler to read.   |
|  33 | apps/worker/src/security/download-session-client.ts           |  L759 | 尚未確認         | Prefer using nullish coalescing operator (`??`) instead of a ternary expression, as it is simpler to read.   |
|  34 | apps/worker/src/security/download-session-client.ts           |  L766 | 尚未確認         | Prefer using nullish coalescing operator (`??`) instead of a ternary expression, as it is simpler to read.   |
|  35 | apps/worker/src/security/download-session-client.ts           |  L773 | 尚未確認         | Prefer using nullish coalescing operator (`??`) instead of a ternary expression, as it is simpler to read.   |
|  36 | apps/worker/src/security/download-session-state.ts            |  L179 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  37 | apps/worker/src/security/download-session-state.ts            |  L509 | 尚未確認         | Prefer using nullish coalescing operator (`??`) instead of a ternary expression, as it is simpler to read.   |
|  38 | apps/worker/src/security/range-transfer.ts                    |   L92 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  39 | apps/worker/src/security/range-transfer.ts                    |  L124 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  40 | apps/worker/src/security/range-transfer.ts                    |  L160 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  41 | apps/worker/src/security/resolve-vault.ts                     |  L135 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  42 | apps/worker/src/security/resolve-vault.ts                     |  L136 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  43 | apps/worker/src/security/resolved-media-grant.ts              |   L63 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  44 | apps/worker/src/security/resolved-media-grant.ts              |   L64 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  45 | apps/worker/src/security/session-download-admission-client.ts |   L62 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  46 | apps/worker/src/security/session-download-admission-client.ts |   L63 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  47 | apps/worker/src/security/session-download-admission-client.ts |  L270 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  48 | apps/worker/src/security/session-download-admission-client.ts |  L341 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  49 | apps/worker/src/session-coordinator.ts                        |  L186 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  50 | apps/worker/src/session-coordinator.ts                        |  L188 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  51 | apps/worker/src/session-coordinator.ts                        |  L906 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  52 | apps/worker/src/session-coordinator.ts                        | L1024 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  53 | apps/worker/src/session-coordinator.ts                        | L1342 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  54 | apps/worker/src/session-coordinator.ts                        | L1436 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  55 | apps/worker/src/session-coordinator.ts                        | L1522 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  56 | apps/worker/src/session-coordinator.ts                        | L1609 | 尚未確認         | Prefer using an optional chain expression instead, as it's more concise and easier to read.                  |
|  57 | apps/worker/src/turnstile-replay.ts                           |   L27 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  58 | apps/worker/src/utils/base64url.ts                            |   L15 | 尚未確認         | Prefer `String.fromCodePoint()` over `String.fromCharCode()`.                                                |
|  59 | apps/worker/src/utils/base64url.ts                            |   L39 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  60 | apps/worker/src/workflows/resolve-public-media.ts             |   L99 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  61 | packages/contracts/src/index.ts                               |  L130 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  62 | packages/contracts/src/index.ts                               |  L131 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  63 | packages/contracts/src/index.ts                               |  L148 | 尚未確認         | Prefer `String#codePointAt()` over `String#charCodeAt()`.                                                    |
|  64 | scripts/check-bundle-secrets.mjs                              |  L134 | 尚未確認         | A path canonicalized from CLI-controlled data must be validated before use.                                  |
|  65 | scripts/check-bundle-secrets.mjs                              |  L198 | 尚未確認         | A path canonicalized from CLI-controlled data must be validated before use.                                  |
|  66 | scripts/check-bundle-secrets.mjs                              |  L249 | 尚未確認         | Prefer top-level await over using a promise chain.                                                           |
|  67 | scripts/check-deploy-readiness.mjs                            |   L42 | 尚未確認         | A path canonicalized from CLI-controlled data must be validated before use.                                  |
|  68 | scripts/check-deploy-readiness.mjs                            |   L55 | 尚未確認         | A path canonicalized from CLI-controlled data must be validated before use.                                  |
|  69 | scripts/check-deploy-readiness.mjs                            |   L71 | 尚未確認         | A path canonicalized from CLI-controlled data must be validated before use.                                  |
|  70 | scripts/check-deploy-readiness.mjs                            |   L85 | 尚未確認         | A path canonicalized from CLI-controlled data must be validated before use.                                  |
|  71 | scripts/check-wrangler-exposure.mjs                           |   L58 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  72 | scripts/check-wrangler-exposure.mjs                           |   L59 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  73 | scripts/check-wrangler-exposure.mjs                           |  L155 | 尚未確認         | Provide a compare function to avoid sorting elements alphabetically.                                         |
|  74 | scripts/check-wrangler-exposure.mjs                           |  L155 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  75 | scripts/check-wrangler-exposure.mjs                           |  L162 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |
|  76 | scripts/check-wrangler-exposure.mjs                           |  L165 | 尚未確認         | Provide a compare function that depends on "String.localeCompare", to reliably sort elements alphabetically. |

## 可原子分組的修復建議

1. **CLI canonical-path security contract（rows 64–65、67–70）**：先在
   `check-bundle-secrets.mjs` 與 `check-deploy-readiness.mjs` 建立同一個可測試的
   canonicalization boundary，補 traversal、symlink 與 root escape 測試。這 6 筆與
   Security Rating C 的數量吻合，但 rule 尚未確認，所以只能列為優先候選，不能宣稱
   一定是 Gate 的全部成因。
2. **Deterministic alphabetical comparison（25 筆）**：依 module 分成 worker
   resolver/security、session state、contracts 與 CI scripts 幾個可獨立測試的 commit；
   使用 `localeCompare` 前先鎖定 locale、case 與 byte-stability 契約。Row 73 的訊息要求
   「avoid sorting alphabetically」，語意相反，必須獨立處理，不能機械套用同一修復。
3. **Unicode code-point APIs（rows 6–9、14–15、18、22、29、36、38–39、58–59、63）**：
   依 codec/parser boundary 分組，把 `charCodeAt`/`fromCharCode` 改動與 surrogate-pair、
   non-BMP、malformed input 測試放在同一原子變更。
4. **Optional/nullish simplification（rows 1、30–40、47–56 中對應訊息）**：依
   downloader page、session client/state、range、admission 與 coordinator 分開；先證明
   `null`、`undefined`、空字串及 0 的既有語意不變。
5. **Module/iteration cleanup（rows 2–4、25–26）**：`index.ts` re-export/iterable 與
   `download-session-client.ts` duplicate import 是兩個可獨立驗證的小 commit。
6. **Cryptography numeric literal（rows 20–21）**：只調整 numeric grouping 並用既有
   vector 測試證明值未改變。
7. **Browser-session cloning（rows 16–17）**：先確認回傳 ownership 與 mutation
   boundary，再決定移除 clone；兩筆應與對應 state tests 同一 commit。
8. **單筆控制流程與 API idiom（rows 13、19、66）**：promise rejection、
   `.includes()` 與 top-level await 分屬不同 module，應各自提交，不混成 style commit。
9. **Coverage hardening（非 failed condition）**：目標 Gate 並非 coverage 失敗；若要
   增補測試，應先保護 `turnstile-replay.ts`、`ip-rate-limiter.ts`、
   `session-coordinator.ts` 與部署安全 scripts 的高風險狀態/路徑契約，不為百分比過度設計。
10. **Duplication（較新 SHA 才取得 file breakdown）**：只把上述 6 個非零 files 當成
    `86644a90` 的候選重構清單；開始修改前必須重新對當下 analysis 查證，不能用它解釋
    `80dea10` 的歷史 Gate。

## 未確認事項

- 64 筆未展開 detail UI 的 rule key 尚未確認；不得依 message 反推。
- `80dea10` 的 Overall Hotspots 三種狀態與完整 per-file coverage/duplication breakdown
  尚未確認，因 UI 在讀取這些頁面前已切換到較新 analysis。
- Issue list 是由目標 analysis 導航後取得，但 SonarCloud latest UI 沒有把清單鎖到
  immutable analysis ID；若需法證級重現，必須使用能明確選取歷史 analysis 的官方 UI
  或可信匯出資料重新核對。
- 修復後需要新一輪 CI analysis；既有 failed Quality Gate 不會因本地修改自動更新。
