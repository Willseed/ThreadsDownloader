# Angular CLI 間接 Hono 漏洞暫時緩解研究

- 查證日期：2026-07-26
- 狀態：完成；exact override、clean install、audit 與完整相容性閘門均已驗證
- 適用專案：`Willseed/ThreadsDownloader`
- 目標執行環境：Node.js `24.18.0`、npm `11.16.0`

## 問題

目前 lockfile 解析出的漏洞鏈為：

```text
@angular/cli 22.0.8
└─ @modelcontextprotocol/sdk 1.29.0
   └─ @hono/node-server 1.19.15
```

`npm audit --json` 回報 3 個 moderate 節點，根因是
`@hono/node-server <2.0.5` 受
[GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9)
影響；問題沿 SDK 傳遞到直接 dev dependency `@angular/cli`。限制條件是不得降級
Angular、降低 audit threshold、使用 `npm audit fix --force`，或改用浮動 range。

## 研究順序

先依專案規則以 exact 參數使用 ask-bridge：

```text
ask-bridge --provider chatgpt --model high --timeout 1500 --headless=true <focused-prompt>
```

ask-bridge 的結論為：截至查證日期沒有穩定 Angular 22 修正版；SDK 宣告的
`@hono/node-server` range 不包含 2.x；Hono v2 的一般 public API 維持相容，但
Node.js 下限改為 20 且移除 `/vercel`；建議以 version-scoped npm override 精確
指定 `2.0.10`，並將其視為越過上游 semver 的暫時 workaround。這份回覆只作為
待驗證線索，不單獨作為實作證據。

後續沒有使用 Web Search，而是直接查詢 npm registry metadata、目前 lockfile 的
`npm audit --json`，以及鎖定 tag 的官方 GitHub package、source 與 release：

- [Angular CLI 22.0.8 npm metadata](https://registry.npmjs.org/@angular%2fcli/22.0.8)
- [Angular CLI npm dist-tags](https://registry.npmjs.org/-/package/@angular%2fcli/dist-tags)
- [MCP SDK 1.29.0 npm metadata](https://registry.npmjs.org/@modelcontextprotocol%2fsdk/1.29.0)
- [MCP SDK 1.29.0 官方 `package.json`](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.29.0/package.json)
- [MCP SDK 1.29.0 官方 `streamableHttp.ts`](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.29.0/src/server/streamableHttp.ts)
- [Hono Node Server 1.19.15 npm metadata](https://registry.npmjs.org/@hono%2fnode-server/1.19.15)
- [Hono Node Server 2.0.10 npm metadata](https://registry.npmjs.org/@hono%2fnode-server/2.0.10)
- [Hono Node Server 2.0.10 官方 `package.json`](https://raw.githubusercontent.com/honojs/node-server/v2.0.10/package.json)
- [Hono Node Server 2.0.10 官方 root exports](https://raw.githubusercontent.com/honojs/node-server/v2.0.10/src/index.ts)
- [Hono Node Server 2.0.0 release](https://github.com/honojs/node-server/releases/tag/v2.0.0)
- [Hono Node Server 2.0.5 security release](https://github.com/honojs/node-server/releases/tag/v2.0.5)
- [Hono Node Server 2.0.10 security release](https://github.com/honojs/node-server/releases/tag/v2.0.10)
- [npm 11 `package.json` overrides 文件](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides)

## 官方證據與結論

### 上游目前沒有同 major 的穩定修復

截至 2026-07-26，npm dist-tag `latest` 仍是 Angular CLI `22.0.8`，`next` 是
`22.1.0-rc.0`。22.0.8 metadata 直接固定 MCP SDK `1.29.0`；SDK 1.29.0 又宣告
`@hono/node-server: ^1.19.9`。依 semver，該 range 不會解析到已修復的 2.x。
因此目前沒有可直接升級的穩定 Angular 22 版本能移除此 audit chain。

### Hono v2 的相容與破壞邊界

Hono v2.0.0 官方 release 明確說明一般 public API 維持不變，但列出兩項 breaking
change：Node.js 最低版本提高到 20，以及移除 `@hono/node-server/vercel`。2.0.10
package exports 同時提供 root entry 的 ESM `dist/index.mjs` 與 CJS
`dist/index.cjs`，官方 root source 仍 export `getRequestListener`。

MCP SDK 1.29.0 的官方 `streamableHttp.ts` 只從 `@hono/node-server` root import
`getRequestListener`，沒有使用被移除的 `/vercel` subpath。專案 Node.js `24.18.0`
同時滿足 Angular CLI 22.0.8 的 `^24.15.0` 分支與 Hono v2 的 `>=20` 要求。

### 安全版本選擇

Hono v2.0.5 官方 release 修正 GHSA-frvp 的 Windows encoded-backslash path
traversal。v2.0.10 又修正
[GHSA-9mqv-5hh9-4cgg](https://github.com/honojs/node-server/security/advisories/GHSA-9mqv-5hh9-4cgg)
所述、發生在 aborted WebSocket handshake 的 unauthenticated memory-leak DoS。
因此不能只停在剛好讓目前 audit 通過的 2.0.5；暫時 workaround 應精確 pin
`2.0.10`。

## 實作

root `package.json` 已加入下列 exact、ancestor-scoped override，lockfile 只更新
該 dependency seam 的解析：

```json
{
  "overrides": {
    "@angular/cli@22.0.8": {
      "@modelcontextprotocol/sdk@1.29.0": {
        "@hono/node-server": "2.0.10"
      }
    }
  }
}
```

這不是上游宣告支援的升級路徑。SDK 的 range 明確停在 1.x，所以此 override
刻意越過上游 semver major，只能在完整相容性閘門全部通過後暫時採用。不得改成
`^2.0.10`、`~2.0.10`、`2.x` 或其他浮動 range。

## 驗證契約

實作後至少必須確認：

1. 實際 runtime 是 Node.js `24.18.0`，Angular CLI 仍是 `22.0.8`。
2. `npm ls` 與 `npm explain` 顯示該 dependency chain 只解析到 Hono `2.0.10`，
   且標示為 overridden；lockfile 不得殘留 1.19.15 或其他 Hono Node Server 版本。
3. MCP SDK 1.29.0 的官方 repository source 與安裝後 ESM/CJS dist 都不引用
   `@hono/node-server/vercel`，只使用 root API。
4. 以 ESM import 與 CJS require 分別載入 `getRequestListener`，確認兩個 package
   entry 都能解析為 function。
5. `npm audit --audit-level=low` 必須為 0，且 clean `npm ci` 後結果不變。
6. format、lint、typecheck、coverage、Durable Object、range、mock E2E、
   accessibility、Angular production build、bundle/Wrangler security scans 與 Worker
   dry run 全部通過。

任何相容性驗證失敗都必須停止，不得猜測或以降低門檻規避。

## 實際驗證結果

2026-07-26 在 Node.js `24.18.0`、npm `11.16.0` 完成下列驗證：

1. `npm install --package-lock-only --ignore-scripts` 的 lockfile diff 只將
   `@hono/node-server` 由 `1.19.15` 改為 `2.0.10`，並同步其 tarball URL、integrity
   與 Node engine；SDK 原始宣告的 `^1.19.9` 保留不動。
2. clean `npm ci` 成功。第一次 sandbox 執行因 registry DNS 被隔離而失敗，依規範
   核准外部網路後重新執行成功；這是執行環境限制，不是 dependency 相容失敗。
3. `npm ls --all --json` 與 `npm explain --json` 確認 tree 只有 Angular CLI
   `22.0.8` → MCP SDK `1.29.0` → Hono `2.0.10`，Hono 節點與 dependent edge 都標示
   `overridden`，沒有殘留其他 Hono Node Server 版本。
4. 以官方 `v1.29.0` tag 的完整 MCP SDK source tree 及 clean install 後的 ESM/CJS
   dist 搜尋，均未發現 `@hono/node-server/vercel`；source 與 dist 只從 package root
   使用 Hono。Hono 2.0.10 的 ESM import 與 CJS require 均能將
   `getRequestListener` 載入為 function。
5. `npm audit --audit-level=low` 回報 0 個漏洞，Angular CLI 實際安裝版本仍為
   `22.0.8`。
6. format、lint、typecheck、security tests、coverage、Durable Object、range、mock
   E2E、accessibility、Angular production build、bundle scan、Wrangler exposure、
   deploy readiness 與 Worker dry run 全部通過。兩項 Playwright 測試第一次在
   sandbox 因無權綁定 `127.0.0.1:4200` 而停止；依規範核准本機 port 後重跑均通過。

## 適用範圍

- 只適用於 Angular CLI `22.0.8` → MCP SDK `1.29.0` 這條 exact ancestor chain，
  以及 Node.js `24.18.0`。
- Hono 的 API 與安全結論是 2026-07-26 對 v2.0.10 tag、npm package metadata 與
  官方 release 的快照。
- Scoped override 不應影響其他 ancestor 下可能存在的 MCP SDK 或 Hono dependency；
  實際 lockfile tree 仍須在安裝後確認。
- 這是暫時的 supply-chain mitigation，不是正式取代 SDK 上游相容性聲明。

## 尚未確認事項

1. MCP SDK 維護者沒有在 1.29.0 dependency range 中宣告 Hono v2 相容性；官方
   Hono release 的 public API 聲明與 source inspection 不能取代完整執行測試。
2. 現有完整測試已通過，但不能證明 MCP SDK 所有未被本專案觸發的 runtime path
   都與 Hono v2 相容；若未來開始使用新的 MCP server 功能，必須補對應契約測試。
3. 未確認 SDK 或 Angular CLI 何時會發布正式支援的修復。上游一旦提供穩定方案，
   必須移除 override，回到其宣告的 dependency range 並重新驗證。
4. 未審計 Hono、SDK 或 Angular CLI 的完整供應鏈與所有程式碼；本結論只處理已知
   advisory、明確 import/export seam 與本專案可重現測試。
