# 專案協作原則

## 適用範圍

本文件適用於整個程式碼庫，以及參與工作的主代理與所有 SubAgents。

## 研究與證據

1. 遇到需要外部查證、且無法直接由現有程式碼、專案文件或測試確認的資訊時，優先使用 `ask-bridge` skill：
   - 對應 CLI 參數：`--provider chatgpt --model high --timeout 1500 --headless=true`
2. 非必要不得使用 Web Search。僅當上述來源與 `ask-bridge` 均無法回答時才可使用，並記錄問題、已查來源、使用原因及所得證據。
3. 研究後記錄結論、證據、適用範圍及未確認事項。已有充分證據的項目不得重複研究；僅實作時拆出的新細項且證據不足時，才可再次查證。
4. 細項查證後可直接依證據實作，除非結果會推翻既定需求、造成破壞性變更、需求衝突或明顯擴大範圍，才停止並回報。
5. 不得猜測富邦 API 的欄位、型別、事件、序號、訂閱結果、市場狀態或其他語意。只能依現有程式碼、可信文件或可重現測試；證據不足時標示「尚未確認」並停止相關實作。
6. 若 `ask-bridge` 不可用，記錄原因；不得假裝已完成查證。

## 實作與 SubAgents

1. 主代理不得直接實作，必須將所有實作委派給 implementation subagent。
2. Implementation subagent 可親自完成其獲授權範圍內的實作，無須再遞迴委派；本文件其餘適用於所有代理的規則仍須遵守。
3. 主代理負責協調原子任務、commit 後 Code Review、最終驗證與 push；implementation subagent 負責其獲授權範圍內的實作、驗證及本地原子 commit。

## 測試與量測

1. 每個 commit 必須可建置，且與該變更直接相關的測試必須通過。
2. 提交前必須檢查測試邊界是否過度臃腫。
3. 測試應保護高風險契約、資料完整性與重要狀態轉換，不得為追求覆蓋率而過度設計。

## 原子 Commit

1. 每完成一個可獨立驗證的原子功能，就必須建立一個 commit。
2. 不得把多個無關功能混在同一 commit。
3. 不得為了製造小 commit，而提交無法建置、測試失敗或只有半套行為的狀態。
4. 每個 commit message 必須符合 Conventional Commits，格式為 `<type>[optional scope]: <description>`；破壞性變更必須依規範使用 `!` 或 `BREAKING CHANGE:` footer 標示。

## Commit 後 Code Review

1. 每個原子 commit 建立後、下一個 commit 建立前，主代理必須使用來源為 `mattpocock/skills` 的全域 `code-review` skill（可指定 `--skill=code-review`）檢視該 commit。
2. Review 前先固定剛建立的 commit SHA 為 `COMMIT`，並以該 commit 的第一父 commit `BASE=$(git rev-parse "${COMMIT}^1")` 作為 fixed point。Review 必須固定比較 `git diff "$BASE"..."$COMMIT"`，不得改以浮動的 `HEAD` 代替 `COMMIT`。
3. Standards 與 Spec 兩個 review 軸必須平行執行並分開記錄，不得合併、互相抵銷或用其中一軸的結果掩蓋另一軸。
4. Atomic task brief、使用者需求或明確規格文件均可作為 Spec source；沒有 issue reference 時，不要求 issue tracker。
5. Documented hard violation 或 Spec finding 必須交回原 implementation subagent 修正，並 amend 至同一個原子 commit。Amend 後必須固定更新後的 commit SHA，仍以其第一父 commit 為 fixed point，重新執行 Standards 與 Spec 兩軸 review。
6. Standards 的 judgement-call smell 必須修正，或記錄接受理由；不得用 Spec 結果抵銷。
7. 兩軸的 blocking findings 全數清零後，才能建立下一個原子 commit。每次 review 均須保留兩軸結果、findings、修正或接受理由，以及重新 review 結果。

## Push 與輸出

1. Implementation subagent 只建立本地 commit，不得 push。
2. 每個原子 commit 的直接相關測試與建置（適用時）通過，且 commit 後 Standards 與 Spec 的 blocking findings 清零後，主代理必須在建立下一個 commit 前 push 到遠端。
3. 使用者指定 checkpoint 時，主代理仍須依指定時點 push；若使用者特別要求 `AGENTS.md` 生效後先 push，亦同。Checkpoint push 不取代每個原子 commit 通過 review 後、下一個 commit 前的同步，也不取代 task 結束時的最終同步。
4. Task 結束時，主代理必須再次確認本地與遠端倉庫一致，並 push 任何尚未同步的 commits。
5. 除非有失敗，否則不得輸出 log 或 print。
