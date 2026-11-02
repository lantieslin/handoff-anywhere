# handoff-anywhere

跨 agent 的專案進度層：撞到 rate limit、context 被壓縮、或換一個 harness 接手，都不用重讀整個專案。

Agent 撞到 rate limit 中斷時，下一個 agent 通常只看到檔案，看不到你的意圖：做過什麼、什麼失敗、下一步是什麼。`handoff-anywhere` 在專案裡留兩個小檔案，讓任何 agent 讀一次就能接手。

- **不需要 git**，不會動 target 專案的版本狀態。
- **不額外呼叫 LLM**，journal 由 harness 寫。
- **沒有常駐程序、MCP server、資料庫或雲端**，只有檔案。
- 第一版支援 **OpenCode**（原生 plugin）與 **DSH**（Claude Code 格式 hooks）。

[English README](README.md) · [DSH 安裝細節](adapters/dsh/README.md)

---

## 為什麼

Agent 的計畫存在 context 裡。Rate limit、crash、compaction、或從 OpenCode 換到 DSH，context 一消失，計畫也消失。下一個 agent 只會重讀檔案、重問使用者、重做一次。

`handoff-anywhere` 把兩種狀態分開：

| 檔案 | 誰寫 | 內容 | 成本 |
|---|---|---|---|
| `.agent/journal.jsonl` | harness（plugin/hook） | 發生過什麼，每個 tool call 一行 | 幾乎為零，不呼叫模型 |
| `.agent/HANDOFF.md` | agent，在任務邊界 | 目標、決策、下一步 | 一次小寫入 |

新 session 會自動注入一張 resume card（≤ 12 行）。完整細節留在磁碟上，需要時才讀。

## 運作方式

```text
target project/
  .agent/
    HANDOFF.md       # agent 寫的意圖，上限 80 行
    journal.jsonl    # harness 寫的 append-only 記錄
    OFF              # 可選：停用這個專案
    .seen/           # 內部：card 只注入一次的標記
```

Journal 範例：

```json
{"ts":"2026-11-02T14:01:40+08:00","session":"opencode:abc123","agent":"opencode","type":"tool","tool":"bash","cmd":"npm test","status":"failed","err":"2 tests failed: token refresh"}
```

Resume card 範例：

```text
[handoff-anywhere] Last session 2026-11-02 14:02 (3h ago, opencode, interrupted)
Goal: 完成 token refresh 修正
Last: bash `npm test` (failed: 2 tests failed: token refresh)
Next: 修正 test/auth.test.ts 的 refresh 斷言
Note: HANDOFF.md 比 journal 舊，細節以 journal 尾巴為準。
Details: .agent/HANDOFF.md
```

`interrupted` 代表最後一筆事件不是正常的 idle/stop，這正是被 rate limit 砍掉的樣子。

## 安裝

需要 Node >= 20。

### 從 clone 安裝（npm 尚未發佈時可用）

```bash
git clone <this-repo> handoff-anywhere
cd handoff-anywhere
node bin/handoff-anywhere.mjs install --local
```

`--local` 會把 plugin 複製到 `~/.config/opencode/plugin/`，不需要等 npm 發佈。

### 從 npm 安裝（發佈後）

```bash
npx handoff-anywhere install
```

兩種方式都可重複執行，且只會動到下面列出的路徑。修改 `opencode.json` 前會先備份。

| 路徑 | 內容 |
|---|---|
| `~/.config/opencode/skills/handoff-anywhere/` | skill |
| `~/.config/opencode/command/` | `/checkpoint`、`/resume` |
| `~/.config/opencode/opencode.json` | plugin 設定（npm 安裝） |
| `~/.config/opencode/plugin/` | 本機 plugin 複本（`--local`） |
| `~/.config/opencode/AGENTS.md` | 帶標記的規則區塊 |
| `~/.handoff-anywhere/dsh/` | `hook.mjs`、`core.mjs`、`hooks.json` |
| `~/.dsh/skills/handoff-anywhere/` | skill |
| `~/.dsh/AGENTS.md` | 帶標記的規則區塊 |

安裝器只會印出 DSH profile 片段，不會自動改你的 profile。

### DSH profile

把印出的片段貼進 DSH profile 的 plugin 清單：

```yaml
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: C:/Users/<you>/.handoff-anywhere/dsh/hooks.json
    projectDir: .
```

貼完要重啟 DSH：bridge 只在 process 啟動時讀一次 `configPath`。

Hook payload 與限制詳見 [adapters/dsh/README.md](adapters/dsh/README.md)。

## 日常使用

- **正常開 session**：什麼都不用做，plugin/hook 自動寫 journal。
- **任務完成**：agent 依 AGENTS.md 規則與 skill 更新 `.agent/HANDOFF.md`。
- **撞到 rate limit 或換 agent**：用另一個 harness 開同一個專案，第一個 prompt 就會看到 card。
- **手動**：`/checkpoint`、`/resume`，或 `npx handoff-anywhere status`。
- **停用單一專案**：`npx handoff-anywhere off`（建立 `.agent/OFF`，停止所有寫入）；`on` 移除。

家目錄根、系統 temp、磁碟根目錄不會自動建立狀態。Target 專案不需要是 git repo。

## 隱私

- 不寫工具輸出全文、檔案內容、prompt 全文、模型回覆。
- 只寫工具名、專案相對路徑、指令（截到 300 字）、狀態、截斷的錯誤摘要。
- 敏感路徑直接跳過：`.env*`、`*.pem`、`*.key`、`id_rsa*`、`.ssh/`、`.aws/`、`credentials*` 等。
- 常見 token 樣式（`sk-…`、`ghp_…`、`github_pat_…`、`AKIA…`、`Bearer …`、`api_key=…`）會遮罩。
- 所有資料都留在這台機器、這個專案裡。

`.agent/` 可能包含專案名稱與錯誤訊息。如果 target 專案有版控，建議加進全域 gitignore。

## 限制

- 只支援同機使用，沒有同步、沒有多人協作。
- 目前支援兩個 harness；其他 adapter 歡迎社群貢獻，但 v1 不承諾。
- DSH 依賴 experimental 的 `@deepseek-ai/dsh-hooks-claude-code` bridge。bridge 壞掉時，skill 與 AGENTS.md 規則仍可手動使用。
- OpenCode plugin 使用 `experimental.chat.system.transform` 與 `experimental.session.compacting`。若 API 變動，card 注入會失效，但 journal 仍會運作。
- 同一專案多個 session 會共用 journal；事件有 session 欄位可區分，但 `HANDOFF.md` 是 last-writer-wins。
- 沒有 uninstall 指令，移除方式就是刪掉上面列出的檔案與 plugin 設定。

## 開發

```bash
npm test          # node --test，零依賴
npm pack --dry-run
```

結構：

```text
src/core.mjs              journal、card、redaction、路徑守衛
src/install.mjs           安裝邏輯
adapters/opencode/        OpenCode plugin
adapters/dsh/             DSH hook 與文件
skills/handoff-anywhere/  agent 用的 skill
commands/                 /checkpoint、/resume
test/                     單元與驗收測試
```

## 授權

MIT，見 [LICENSE](LICENSE)。
