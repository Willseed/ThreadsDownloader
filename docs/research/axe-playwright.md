# `@axe-core/playwright` 版本與適用範圍

## 結論

- 本專案固定使用 `@axe-core/playwright` `4.12.1`，不另外宣告直接相依 `axe-core`。
- npm registry metadata 顯示 `4.12.1` 的 peer dependency 是 `playwright-core >=1.0.0`，runtime dependency 是 `axe-core ~4.12.1`。本專案的 `@playwright/test` `1.61.1` 所使用的 `playwright-core` 符合該 peer 範圍。
- 這項結論只用於選擇本專案的自動化可及性測試工具版本；不代表第三方實際 Turnstile widget 已通過本專案的 WCAG 驗證。

## 查證紀錄

### `ask-bridge`

依專案研究規則，先以以下精確參數委派背景研究：

```text
--provider chatgpt --model high --timeout 1500 --headless=true
```

研究問題涵蓋最新穩定版、Playwright `1.61.1`／Node.js `24.18.0` 相容性、peer/dependency 與是否需要另外安裝 `axe-core`。回覆誤將 latest 判定為 `4.11.3`；因此該回覆只保留為探索紀錄，未作為版本事實來源。

### npm registry 直接證據（主要依據）

主代理直接執行：

```sh
npm view @axe-core/playwright dist-tags.latest
npm view @axe-core/playwright@4.12.1 version peerDependencies dependencies engines
```

所得 metadata：

```text
dist-tags.latest = 4.12.1
peerDependencies.playwright-core = >= 1.0.0
dependencies.axe-core = ~4.12.1
```

安裝後的 `package-lock.json` 亦固定 `@axe-core/playwright` `4.12.1`，並由其 dependency 帶入 `axe-core` `4.12.1`。未使用 Web Search。

## 適用範圍與尚未確認事項

- 已確認：registry dependency 契約與目前 lockfile 的實際解析版本。
- 已確認：本專案 E2E 使用 mock Turnstile，不會向 Cloudflare、Threads 或 CDN 發出真實請求。
- 尚未確認：Deque 是否以 Node.js `24.18.0` 作為正式 CI 測試矩陣；套件 manifest 未提供可據以宣稱該精確版本已獲官方認證的證據。
- 尚未確認：Cloudflare 實際 Turnstile widget 在所有瀏覽器、輔助技術與顯示模式下的 WCAG 結果。mock widget 的 axe 結果不得延伸成這項聲明。
