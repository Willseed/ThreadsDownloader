# GitHub Actions、SonarQube 與祕密掃描研究紀錄

- 查證日期：2026-07-26
- 狀態：完成
- 適用專案：`Willseed/ThreadsDownloader` 的 GitHub-hosted Actions、
  SonarQube Cloud 分析與 Gitleaks 祕密掃描

## 問題

1. 指定的六個 GitHub Actions release 是否存在、是否為目前最新 release，且
   exact tag 目前指向哪個 commit？
2. 這些 action 自身是否已使用 Node.js 24 runtime？
3. 各 action 的 token、祕密與授權需求為何？
4. SonarQube Cloud 能否由同一個 scanner step 等待並強制 Quality Gate？
5. `Willseed/ThreadsDownloader` 是否由 personal account 擁有，因而不需要
   `GITLEAKS_LICENSE`？

## 研究順序與證據標準

主要 agent 已依專案研究原則先使用 ask-bridge，參數為：

```text
ask-bridge --provider chatgpt --model high --timeout 1500 \
  --headless=true --new \
  --output /private/tmp/td-ci-actions-research.md <focused-prompt>
```

ask-bridge 成功產生候選版本、SHA 與授權摘要，但該回覆只作為待驗證線索，
不是版本或授權的事實來源。之後執行下列官方來源核對；全程沒有執行 Web
Search query：

1. 對各 action 官方 Git repository 執行 `git ls-remote`，同時查詢精確
   `refs/tags/<version>` 與 peeled ref，確認 tag 當下解析到的 commit。
2. 直接查詢各官方 repository 的 GitHub Releases REST API `releases/latest`，
   確認截至查證日期的 latest release tag 與發布時間。
3. 直接讀取以完整 commit SHA 固定的官方 `action.yml`、`README.md` 與
   Gitleaks EULA；不透過浮動 branch 或搜尋結果引用內容。
4. 直接查閱 GitHub 與 SonarSource 官方文件，核對 SHA pin、帳號類型、
   `GITHUB_TOKEN` 與 Quality Gate 參數。
5. 直接查詢 GitHub REST API 的 `repos/Willseed/ThreadsDownloader` 與
   `users/Willseed`。主要 agent 另於 2026-07-25 用 `gh repo view` 得到一致結果。

## Action 版本與 SHA

截至 2026-07-26，GitHub 官方 latest release API 與官方 tag ref 的結果如下。
六個精確 tag 都是 lightweight tag，因此 `git ls-remote` 沒有額外的 peeled
tag-object ref；表中的 SHA 就是 tag 當下直接指向的 commit。

| Action                                                                                                          | latest release | 發布日期（UTC） | 完整 commit SHA                                                                                                                                    | `runs.using` |
| --------------------------------------------------------------------------------------------------------------- | -------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| [`actions/checkout`](https://github.com/actions/checkout/releases/tag/v7.0.1)                                   | `v7.0.1`       | 2026-07-20      | [`3d3c42e5aac5ba805825da76410c181273ba90b1`](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1)                  | `node24`     |
| [`actions/setup-node`](https://github.com/actions/setup-node/releases/tag/v7.0.0)                               | `v7.0.0`       | 2026-07-14      | [`820762786026740c76f36085b0efc47a31fe5020`](https://github.com/actions/setup-node/commit/820762786026740c76f36085b0efc47a31fe5020)                | `node24`     |
| [`actions/upload-artifact`](https://github.com/actions/upload-artifact/releases/tag/v7.0.1)                     | `v7.0.1`       | 2026-04-10      | [`043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`](https://github.com/actions/upload-artifact/commit/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a)           | `node24`     |
| [`actions/download-artifact`](https://github.com/actions/download-artifact/releases/tag/v8.0.1)                 | `v8.0.1`       | 2026-03-11      | [`3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`](https://github.com/actions/download-artifact/commit/3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c)         | `node24`     |
| [`SonarSource/sonarqube-scan-action`](https://github.com/SonarSource/sonarqube-scan-action/releases/tag/v8.2.1) | `v8.2.1`       | 2026-07-15      | [`22918119ff8e1ca75a623e15c8296b6ea4fbe28f`](https://github.com/SonarSource/sonarqube-scan-action/commit/22918119ff8e1ca75a623e15c8296b6ea4fbe28f) | `node24`     |
| [`gitleaks/gitleaks-action`](https://github.com/gitleaks/gitleaks-action/releases/tag/v3.0.0)                   | `v3.0.0`       | 2026-05-30      | [`e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e`](https://github.com/gitleaks/gitleaks-action/commit/e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e)          | `node24`     |

`runs.using` 是由以下固定 SHA 的官方 `action.yml` 直接確認：

- [checkout `action.yml`](https://raw.githubusercontent.com/actions/checkout/3d3c42e5aac5ba805825da76410c181273ba90b1/action.yml)
- [setup-node `action.yml`](https://raw.githubusercontent.com/actions/setup-node/820762786026740c76f36085b0efc47a31fe5020/action.yml)
- [upload-artifact `action.yml`](https://raw.githubusercontent.com/actions/upload-artifact/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/action.yml)
- [download-artifact `action.yml`](https://raw.githubusercontent.com/actions/download-artifact/3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/action.yml)
- [SonarQube scan `action.yml`](https://raw.githubusercontent.com/SonarSource/sonarqube-scan-action/22918119ff8e1ca75a623e15c8296b6ea4fbe28f/action.yml)
- [Gitleaks `action.yml`](https://raw.githubusercontent.com/gitleaks/gitleaks-action/e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e/action.yml)

### Pin 決策

[GitHub Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)
明確說明：完整 commit SHA 是目前唯一不可變的 action release pin；tag 仍可被
移動或刪除。因此 workflow 應使用上表的 40 字元 SHA，並在同一行註解精確
release，例如：

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

`node24` 只描述 action 本身由 runner 執行的 JavaScript runtime，不會替專案選擇
Node.js。專案目前的 `.nvmrc`、`.node-version` 與 `package.json` 均固定
`24.18.0`，所以 `setup-node` 應使用精確 `24.18.0`，不應因 action runtime 為
`node24` 而改成浮動 `24.x`。官方 setup-node README 另指出 Node 24 action 至少
需要 Actions Runner `2.327.1`；這是 self-hosted runner 的相容性下限，不是專案
Node.js 版本。

## Token、祕密與授權需求

| Action                              | 本案一般用法                                                                                                                                        | 額外 token／授權邊界                                                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actions/checkout`                  | checkout 當前 repository 時，`token` 預設為 `${{ github.token }}`；官方建議最低 `contents: read`。不需自建 PAT。                                    | `${{ github.token }}` 只涵蓋當前 repository。若改為 checkout 其他 private/internal repository，需提供具最低必要權限的 PAT 或其他適當 token。完整歷史分析應另設 `fetch-depth: 0`。                                |
| `actions/setup-node`                | 從公開 Node distribution 安裝 Node 時，action 的 `token` 預設使用 `${{ github.token }}`，一般不需額外 secret。                                      | private Node mirror 才需 `mirror-token`；設定 private package registry 時，套件管理器可能需 `NODE_AUTH_TOKEN`。兩者不是本案公開 npm install 的必要條件。                                                         |
| `actions/upload-artifact`           | 固定 SHA 的 `action.yml` 沒有讓使用者提供 GitHub token 的 input；上傳目前 workflow artifact 不需自建 PAT。                                          | 若啟用 `include-hidden-files`，官方要求先驗證內容，避免意外上傳敏感檔；這是資料邊界，不是額外 token。                                                                                                            |
| `actions/download-artifact`         | 從當前 repository 的當前 workflow run 下載時，不需提供 `github-token`。                                                                             | 跨 workflow run 或跨 repository 時必須提供 `github-token`、`repository` 與 `run-id`；官方 README 範例要求 token 對目標 repository 具 `actions: read`。                                                           |
| `SonarSource/sonarqube-scan-action` | SonarQube Cloud 分析必須提供 repository/organization secret `SONAR_TOKEN`。Cloud 不需 `SONAR_HOST_URL`；該變數供自架 SonarQube Server。             | 一般 Cloud 掃描未要求額外 GitHub PAT。只有改用需驗證的 private scanner binary mirror 時，才需 `scannerBinariesAuthHeader`。不可停用預設的 scanner signature verification 來規避 runner 問題。                    |
| `gitleaks/gitleaks-action`          | 官方範例要求把每個 job 自動提供的 `GITHUB_TOKEN` 傳入 action；不是自建 PAT。當前 repository 由 personal account 擁有，因此不需 `GITLEAKS_LICENSE`。 | 若 repository owner 改為 Organization，EULA 要求 license key。官方 README 稱可申請 free organization key，但 EULA 同時存在不同購買 tier 與 repository 數量上限，因此不得宣稱 organization 使用永久、無限量免費。 |

GitHub 的
[GITHUB_TOKEN 文件](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)
與
[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
都要求以最低必要 job permissions 使用自動 token。上表沒有把內建
`GITHUB_TOKEN` 誤列為使用者必須另建的 PAT。

## Gitleaks owner 與授權判定

2026-07-26 的 GitHub REST API 回應為：

```json
{
  "full_name": "Willseed/ThreadsDownloader",
  "visibility": "public",
  "default_branch": "main",
  "owner": {
    "login": "Willseed",
    "id": 22499018,
    "node_id": "MDQ6VXNlcjIyNDk5MDE4",
    "type": "User"
  }
}
```

主要 agent 在 2026-07-25 以 `gh repo view` 也確認相同的 owner、public visibility
與 `main` default branch。GitHub 官方
[帳號類型文件](https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts)
指出 user account 可擁有 repository，而 managed user 不能建立 public content；
因此「public repository、owner type 為 `User`」支持本案目前是
personal-account-owned，而不是 organization-owned。這是由官方 metadata 與帳號
規則做出的本案判定；若 owner 或 visibility 改變，必須重新查證。

固定 v3.0.0 SHA 的
[Gitleaks README](https://raw.githubusercontent.com/gitleaks/gitleaks-action/e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e/README.md)
與
[EULA](https://raw.githubusercontent.com/gitleaks/gitleaks-action/e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e/LICENSE.txt)
都明定：Organization-owned repository 需要 license key，Personal-account-owned
repository 不需要。故本案目前不應建立或要求 `GITLEAKS_LICENSE` secret；使用
action 仍表示接受其 EULA，不能把「不需 key」解讀為 MIT 授權或沒有使用條款。

## SonarQube Cloud Quality Gate

固定 v8.2.1 SHA 的
[官方 README](https://raw.githubusercontent.com/SonarSource/sonarqube-scan-action/22918119ff8e1ca75a623e15c8296b6ea4fbe28f/README.md)
確認 `SONAR_TOKEN` 對所有掃描都是必要 secret，且建議 checkout 時
`fetch-depth: 0`，避免 shallow clone 降低分析關聯性。

[SonarQube Cloud 官方 analysis parameters](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/analysis-parameters/parameters-not-settable-in-ui#quality-gate)
確認：

- `sonar.qualitygate.wait=true` 會讓 analysis step 輪詢並等待該次分析的
  Quality Gate；Gate 失敗時 pipeline 失敗。
- `sonar.qualitygate.timeout` 是等待處理的秒數，預設為 `300`。

因此本案可以由同一個 pinned scan action 帶入
`-Dsonar.qualitygate.wait=true`，不需要再加入另一個 Quality Gate action。若本案
選擇 `sonar.qualitygate.timeout=600`，那是專案對等待上限的顯式決策，不是官方
預設值。Scanner step 不得使用 `continue-on-error` 或其他方式略過 Gate 失敗。

## 適用範圍

- 版本與 latest 判定是 2026-07-26 的快照；完整 SHA 可重現當時來源，但未來
  latest release 仍會改變。
- Token 結論適用於 GitHub.com、GitHub-hosted runner、當前 repository、同一個
  workflow run 的 artifact 傳遞，以及 SonarQube Cloud。
- Gitleaks 判定只適用於目前由 `Willseed` personal account 擁有的
  `Willseed/ThreadsDownloader`。
- 本紀錄核對 action metadata、官方使用文件與授權條款，沒有審計各 action
  打包後 `dist` 的每一行程式碼，也沒有執行 action。

## 尚未確認事項

1. Repository 實際設定的 Actions permissions、environment protection rules、
   `SONAR_TOKEN`、Cloudflare secrets 與 Gitleaks 執行時行為不在本次唯讀版本研究
   的證據範圍，必須由後續 CI 驗證。
2. Gitleaks v3 在停用 PR comments、SARIF artifact 與 job summary 後的絕對最小
   `GITHUB_TOKEN` permissions，官方 README 沒有提供完整矩陣；不得猜測。
3. Gitleaks organization free key 的期限、repository 數量與轉為付費 tier 的
   精確門檻，官方 README 與 EULA 沒有足夠數字；本案 personal owner 目前不受此
   未確認項目影響。
4. GHES 與各 self-hosted runner image 的完整相容性沒有納入；只確認 Node 24
   action 的最低 runner 版本為 `2.327.1`。
5. 六個 tag 未來是否被維護者移動無法保證；正式 workflow 必須用上表完整 SHA，
   不能退回浮動 tag。
