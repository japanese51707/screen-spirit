# Screen Spirit 螢幕圈選 AI 小精靈

常駐在桌面的小精靈：按快捷鍵圈選畫面上的一塊區域、輸入問題，小精靈就把內容交給你選的 AI（ChatGPT、Claude 桌面 App、Claude Code、Codex、Gemini CLI、MixRoute、Ollama…），並在自己的視窗呈現完整問答。也可以建立多隻有不同角色的「精靈」，用「工作流」把它們和各種 AI 串成一條流程，最後自動做成 Word／PDF／PowerPoint／Excel 等檔案。

專案裡附了一隻範例精靈「造型博士」（幫精靈設計造型），第一次安裝時會自動放進「精靈博士」。它的 AI 跟著你在第一次設定選的預設 AI，資料庫預設放在「文件／Screen Spirit／精靈資料庫」。

## 支援的系統

| 功能 | macOS（Apple Silicon） | Windows（x64） |
| --- | --- | --- |
| 圈選螢幕、精靈博士、工作流、輸出檔案 | ✓ | ✓（初步支援，尚未完整實測） |
| 背景執行：Claude Code、Codex、Gemini CLI | ✓ | ✓ |
| 雲端 API：MixRoute | ✓ | ✓ |
| 本機模型：Ollama | ✓ | ✓ |
| 操作 Claude／ChatGPT 桌面版、Chrome 網頁 | ✓ | 目前只支援 macOS |

第一次打開時會有一步一步的「第一次使用設定」：macOS 會先帶你開啟系統權限，接著選要連接的 AI（沒安裝的可以直接點連結下載），最後選一個預設 AI。Windows 不需要權限那一步，只支援 macOS 的項目會反灰標示。

## 安裝（macOS）

### 方法一：下載打包好的 App

1. 到右邊的 **Releases** 下載 `Screen-Spirit-mac-arm64.zip`，解壓縮。
2. 把 `Screen Spirit.app` 拖到「應用程式」資料夾。
3. 第一次開啟：因為 App 沒有 Apple 開發者簽章，macOS 會擋下來。請在「應用程式」裡對 Screen Spirit **按右鍵 →「打開」→ 再按「打開」**。如果顯示「已損毀」，打開「終端機」執行一次：
   ```sh
   xattr -cr "/Applications/Screen Spirit.app"
   ```

### 方法二：從原始碼安裝（會自動打包成 App）

1. 先安裝 [Node.js](https://nodejs.org)（LTS 版）和 Xcode 命令列工具（終端機執行 `xcode-select --install`）。
2. 下載這個專案（Code → Download ZIP，或 `git clone`）。
3. 在 Finder 雙擊 **`安裝或更新 Screen Spirit.command`**（第一次被擋的話，按右鍵 →「打開」）。
   它會打包成 App、放進「應用程式」並打開。之後從 Launchpad 點兩下就能用，可以拖到 Dock 固定。
4. 程式更新後，再雙擊一次同一個檔案就會換成新版；你的精靈、工作流和設定都會保留。

### macOS 權限

第一次使用設定會帶你到「系統設定 → 隱私權與安全性」，允許 Screen Spirit 使用：

- **螢幕錄製**：圈選畫面時擷取選取的區域（開啟後要重新開啟小精靈）。
- **輔助使用**：把問題貼到 AI App、讀回 AI 的回覆。

安裝程式會在你的鑰匙圈建立一個自簽的「Screen Spirit Local Signing」憑證來簽名 App，這樣更新後權限不會失效。如果開關明明打開了、小精靈還是說沒有權限，在終端機執行下面兩行，再重新打開小精靈並重新允許一次：

```sh
tccutil reset ScreenCapture com.screenspirit.localpoc
tccutil reset Accessibility com.screenspirit.localpoc
```

## 安裝（Windows）

### 方法一：下載打包好的版本

1. 到 **Releases** 下載 `Screen-Spirit-windows-x64.zip`，解壓縮到任何資料夾（例如「文件」）。
2. 執行裡面的 `Screen Spirit.exe`。因為沒有程式碼簽章，Windows SmartScreen 可能會擋：按「其他資訊」→「仍要執行」。

### 方法二：從原始碼安裝

1. 先安裝 [Node.js](https://nodejs.org)（LTS 版）。
2. 下載這個專案（Code → Download ZIP，解壓縮）。
3. 雙擊 **`安裝或更新 Screen Spirit (Windows).cmd`**。它會打包、安裝到 `%LOCALAPPDATA%\Programs\Screen Spirit`，並在「開始」功能表和桌面建立捷徑。
4. 程式更新後再執行一次同一個檔案即可；精靈、工作流和設定都會保留。

Windows 的快捷鍵：圈選畫面 `Ctrl+Shift+1`、送出剪貼簿 `Ctrl+Shift+2`。

## 資料放在哪裡

- **精靈資料庫（長期記憶）**：預設在「文件／Screen Spirit／精靈資料庫／精靈名稱」，可以在精靈博士裡換到 Obsidian 筆記庫或雲端硬碟。
- **工作流做出來的檔案**：「文件／Screen Spirit 成品」。
- **設定、精靈、工作流**：macOS 在 `~/Library/Application Support/`，Windows 在 `%APPDATA%\`。API 金鑰用系統的加密儲存，不在專案檔案裡。

## 開發

```sh
npm install
npm run poc:chatgpt-plan            # 直接用開發模式執行
npm run package:screen-spirit       # 打包 macOS 版，結果在 out/
npm run package:screen-spirit:win   # 打包 Windows 版（請在 Windows 上執行）
```

推送 `v` 開頭的標籤（例如 `git tag v0.2.0 && git push --tags`），GitHub Actions 會自動打包 macOS 與 Windows 版，把 zip 放到 Releases（設定檔在 `.github/workflows/`）。

範例精靈放在 `experiments/chatgpt-plan-poc/seed-spirits/`：只有在還沒有任何精靈（第一次安裝）時才會放進去，已經在用的電腦不會受影響。

## 授權與注意事項

- 專案內附的 `experiments/chatgpt-plan-poc/vendor/siwc-local`（OpenAI Sign in with ChatGPT DevKit）有自己的授權條款（非商業使用），公開散佈或商業使用前請先確認該授權。
- API 金鑰、登入資訊存在系統的加密儲存，不在專案檔案裡。
