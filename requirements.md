# HW2 Requirements — My Own ChatGPT v2

> 本文件是給 AI Agent 閱讀的作業需求說明。
> 讀完本文件後，Agent 應能完整理解：要交什麼、要做什麼、不能遺漏什麼。
> 實作細節請參閱 `AGENTS.md`；模型可用清單請參閱 `AGENTS.md` 第 0 節。

---

## 1. 作業基本資訊

- **課程**：Multimedia Information Systems（多媒體資訊系統）
- **作業編號**：HW2
- **學號**：112550051
- **繳交平台**：E3P（學校線上繳交系統）
- **前置條件**：本作業必須基於 HW1 的程式碼架構繼續開發，不能從頭重寫

---

## 2. HW1 現有架構（必須保留並擴充）

HW1 已實作的功能（**不可移除或破壞**）：

- Zero-Dependency Node.js 後端（`server.js`）：純用 Node.js built-in modules，無 Express / dotenv / axios
- Vanilla JS 前端（`public/app.js` + `public/index.html`）：無 React / Vue
- Google Gemini API 串接（`streamGenerateContent?alt=sse` SSE 串流）
- 打字機效果（SSE token-by-token 渲染）
- System Prompt 自訂
- 模型參數調整（Temperature、TopP、MaxTokens）
- 短暫記憶輪數控制（Memory Turns）
- localStorage 狀態持久化

---

## 3. HW2 必須新增的功能（評分項目）

以下五項是作業明確要求，**每一項都必須實作**：

### 3-1. Long-term Memory（長期記憶）
- 對話記憶必須能跨 session 持久保存（重開瀏覽器不消失）
- 需有自動摘要機制，避免 context 無限增長
- 需有 UI 讓使用者檢視、刪除記憶條目

### 3-2. Multimodal（多模態）
- 使用者能上傳圖片，連同文字一起送給模型
- 模型能分析圖片內容並回答
- UI 需顯示圖片預覽

### 3-3. Auto Routing Between Models（自動模型路由）
- 系統根據使用者訊息的內容/長度/意圖，自動選擇適合的模型
- 路由決策需對使用者透明（顯示選了哪個模型、原因）
- 需有開關讓使用者自行決定是否啟用自動路由

### 3-4. Tool Use / MCP（工具呼叫）
- AI 能呼叫外部工具（至少實作 2 種以上）
- 工具執行過程需在 UI 中呈現（顯示呼叫了什麼工具、結果是什麼）
- 建議工具：計算機、天氣查詢、網路搜尋

### 3-5. Any Other Useful Functions（其他自選功能）
- 至少實作 1 項以上的額外功能
- 功能必須對使用者有實際幫助
- 建議選項：對話匯出、訊息編輯與重新生成、多對話 session 管理、語音輸入

---

## 4. 必須繳交的檔案（缺一不可）

| 檔案 | 規格 | 內容要求 |
|---|---|---|
| `112550051.pdf` | 單一 PDF 檔，**檔名必須是學號** | 包含：一頁系統介紹 + 系統架構圖 |
| `112550051.mp4` | 影片，**檔名必須是學號** | Demo 影片，長度 **3 到 5 分鐘**，不可超過也不可不足 |
| GitHub Link | 貼在 E3P 或 PDF 中 | Repo 必須是 **public**，版本需升級為 **v2** |

### 4-1. PDF 內容細節（`112550051.pdf`）

必須包含以下兩個部分（共一頁）：

**A. One Page System Introduction（系統介紹）**
- 說明系統整體功能與設計理念
- 列出所有新增功能（對應 3-1 到 3-5）
- 技術棧說明（Zero-Dependency Node.js + Vanilla JS + Gemini API）

**B. System Architecture Diagram（系統架構圖）**
- 必須是圖（非純文字描述）
- 需呈現：前端 → 後端 → Gemini API 的資料流
- 需標示各主要元件（Memory Store、Tool Executor、Model Router 等）

### 4-2. Demo 影片細節（`112550051.mp4`）

- 時長：**3 分鐘以上，5 分鐘以下**（硬性規定）
- 必須 demo 的功能（每項都要出現在影片中）：
  1. Long-term Memory：展示記憶跨 session 保存、自動摘要、記憶管理 UI
  2. Multimodal：上傳圖片並讓 AI 分析
  3. Auto Routing：展示不同輸入觸發不同模型，且 UI 有顯示路由結果
  4. Tool Use：觸發至少一個工具呼叫，UI 顯示工具執行過程
  5. 其他自選功能：任一項
- 建議錄製順序：照上方 1→5 順序，畫面清晰，功能間有明確切換

### 4-3. GitHub 要求

- Repo 必須是 **public**
- `README.md` 必須更新，說明 v2 新增的功能
- 建議在 README 中加入 demo 影片連結或截圖
- Tag 或 Release 標示 `v2.0.0`

---

## 5. 評分邊界條件（容易失分的地方）

- **檔名錯誤**：PDF 和 MP4 的檔名必須是 `112550051.pdf` / `112550051.mp4`，大小寫敏感
- **影片時長**：不足 3 分鐘或超過 5 分鐘都可能扣分
- **GitHub 未公開**：Repo 是 private 的話助教看不到
- **功能未在影片中出現**：即使有實作，但 demo 沒展示到，不算得分
- **架構圖缺失**：PDF 中只有文字說明、沒有圖，不符合要求
- **破壞 HW1 功能**：新功能加入後，原本的串流/System Prompt/記憶輪數等功能不能壞掉

---

## 6. 技術限制（必須遵守）

- 後端維持 **Zero-Dependency**：`server.js` 只能用 Node.js built-in modules（`http`, `fs`, `path`, `crypto` 等）
- 前端維持 **Vanilla JS**：不能引入 React、Vue、jQuery 等框架
- LLM Provider 改為 **NVIDIA NIM**（`https://integrate.api.nvidia.com/v1`），API 格式相容 OpenAI Chat Completions
- API Key：`nvapi-` 開頭，從 build.nvidia.com 免費取得，不需信用卡，無試用期限
- 可用模型（免費，2026/04）：
  - `minimax/minimax-m2.7` ✅ 通用主力
  - `moonshotai/kimi-k2.5` ✅ 長文/程式碼
  - `meta/llama-3.3-70b-instruct` ✅ 工具呼叫/視覺
  - `microsoft/phi-4-reasoning-plus` ✅ 快速輕量
  - `deepseek-ai/deepseek-r1-0528` ✅ 強推理
  - `thudm/glm-5-plus` ✅ 中文友善
- 外部工具 API 必須免費且無需 API Key（推薦：Open-Meteo 天氣、DuckDuckGo Instant Answer）

---

## 7. 完成檢查清單

Agent 實作完畢後，請逐一確認：

**功能面**
- [ ] Long-term Memory：重開瀏覽器後記憶條目仍存在
- [ ] Long-term Memory：超過 20 則對話後自動產生摘要並壓縮
- [ ] Long-term Memory：UI 可以檢視和刪除記憶條目
- [ ] Multimodal：能上傳圖片並詢問「這張圖片有什麼？」獲得正確描述
- [ ] Multimodal：UI 顯示圖片縮圖預覽
- [ ] Auto Routing：開啟 Auto Route 後輸入程式碼自動切換模型
- [ ] Auto Routing：UI 顯示路由到哪個模型及原因
- [ ] Tool Use：輸入「台北現在幾度？」觸發天氣工具
- [ ] Tool Use：輸入「2^10 等於多少？」觸發計算工具
- [ ] Tool Use：UI 顯示工具呼叫卡片（呼叫中 → 結果）
- [ ] 其他自選功能：至少一項可正常運作

**HW1 回歸測試**
- [ ] SSE 串流打字機效果正常
- [ ] System Prompt 設定有效
- [ ] Memory Turns 控制正常
- [ ] localStorage 狀態持久化正常

**繳交面**
- [ ] `112550051.pdf` 存在，包含系統介紹文字 + 架構圖
- [ ] `112550051.mp4` 存在，時長在 3-5 分鐘內，五項功能全部出現
- [ ] GitHub Repo 是 public
- [ ] GitHub README.md 已更新為 v2 說明
- [ ] GitHub 有 v2.0.0 tag 或 Release