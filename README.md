# Screen Spirit

**English** | [繁體中文](#繁體中文)

A desktop companion that lives on your screen. Press a hotkey, draw a box around anything on your screen, type a question — Screen Spirit sends it to the AI you choose (ChatGPT, Claude desktop app, Claude Code, Codex, Gemini CLI, MixRoute, Ollama…) and shows the full conversation in its own window. You can also create multiple "spirits", each with its own role, and chain them together with AI tools in a **workflow** that ends by producing a Word / PDF / PowerPoint / Excel file automatically.

The project ships with an example spirit, **造型博士 (Dr. Design)**, which designs looks for spirits. It is added to the Spirit Lab on first install. It uses whichever default AI you pick during first-run setup, and its knowledge base defaults to `Documents/Screen Spirit/精靈資料庫`.

The interface is available in English and Traditional Chinese. On first launch you choose a language (Traditional Chinese is preselected in Taiwan, English everywhere else); you can change it later.

## Supported systems

| Feature | macOS (Apple Silicon) | Windows (x64) |
| --- | --- | --- |
| Screen selection, Spirit Lab, workflows, file output | ✓ | ✓ (early support, not fully tested) |
| Background CLI agents: Claude Code, Codex, Gemini CLI | ✓ | ✓ |
| Cloud API: MixRoute | ✓ | ✓ |
| Local models: Ollama | ✓ | ✓ |
| Driving the Claude / ChatGPT desktop apps and Chrome | ✓ | macOS only for now |

First launch walks you through a step-by-step setup: pick a language, grant system permissions (macOS only), choose which AIs to connect (with download links for anything not installed), and pick a default AI. On Windows the permissions step is skipped and macOS-only options are greyed out.

## How to use

### Hotkeys

| Action | macOS | Windows |
| --- | --- | --- |
| Select an area of the screen and ask about it | `⌘⇧1` | `Ctrl+Shift+1` |
| Ask about the text you highlighted | `⌘⇧2` | `Ctrl+Shift+2` |
| Show / hide the AI drawer (macOS only) | `⌘⇧9` | — |

You can also start everything from the main window, the ✦ menu in the menu bar, or the little spirit floating on your desktop.

### 1. Ask about anything on your screen

1. Press `⌘⇧1` and drag a box around what you want to ask about — an error message, a chart, a paragraph in a PDF.
2. A question window opens with the screenshot attached. Type your question.
3. Pick where it goes in **Send to**, then press **Send**.
   - **Background AIs** (Claude Code, Codex, Gemini CLI, MixRoute, Ollama, built-in ChatGPT): the reply streams into Screen Spirit's window, and you can keep asking follow-up questions in the same conversation.
   - **Desktop apps and Chrome** (Claude, ChatGPT, ChatGPT web, Google AI Mode — macOS): Screen Spirit opens a new chat, pastes your screenshot and question, and sends it. Depending on the layout you chose, the AI app then slides in as a **drawer** on the right third, sits **side by side** with your app (2/3 + 1/3), or is left where it is.

Good to know:

- Drag images or text files into the question box, or paste an image, to attach more.
- Screen Spirit also notes which app and window the selection came from (shown as chips you can remove).
- If the chosen model can't read images, the text in the image is sent instead (local OCR), and Screen Spirit tells you.

### 2. Ask about highlighted text

Highlight text in any app and press `⌘⇧2`. Screen Spirit takes the text and the name of the app it came from — no screenshot — and opens the same question window.

### 3. History

**History** in the main window lists your past conversations. You can search them, and filter to show only those kept on this computer, those also in the app / website, or all. Open one and type to continue where you left off. Conversations with background AIs exist only on this computer (they don't show up in any website or app history). Each entry shows how long it has before it's deleted automatically.

### 4. Spirits and the Spirit Lab

A **spirit** is a reusable AI helper with its own role, rules and knowledge, kept as a collectible card. Open **✦ Spirit Lab** to browse your card box or create a new spirit. Each card has six settings around it:

| Setting | What it controls |
| --- | --- |
| 📚 Knowledge base & memory | Background knowledge and reference folders the spirit always reads. Optional long-term memory: after each conversation, an AI you choose saves only the useful points as notes in the spirit's folder (default `Documents/Screen Spirit/精靈資料庫/<name>`, or an Obsidian vault / cloud drive). |
| 🚧 Limits | What it may and may not do, and how long its replies are. |
| 🎭 Role | Identity, expertise and tone of voice. |
| 🤖 AI | Main AI, a backup AI for when the main one fails, and an image model if the spirit should draw. Leave it empty to follow your default AI. |
| 🧭 SOP | The steps it follows when it gets a task. |
| 🎨 Look | Card image, emoji, color and rarity — or an animated look. |

For **Limits**, **Role** and **SOP** you can write a rough idea and press **✨ Let AI write it** (pick a short or detailed version). The AI drafts it and keeps what you've already written.

To put a spirit to work, press **Give a spirit a task** in the main window, or choose a spirit in the question window after a selection. Images a spirit draws can be saved, or set as its card image with 🃏.

**Animated looks:** in 🎨 Look → 🎬 Animated look, import a character design sheet. Screen Spirit finds the character and splits accessories into two groups: ones that float on their own layer (a keyboard, a monocle), and ones that belong to the body (a hat, headphones). It then redraws the body and expressions to match the default spirit's size, and adds the sparkle effects last. This needs an image model through MixRoute and takes about 2–4 minutes. The included example spirit, **造型博士 (Dr. Design)**, is built to help you design these looks.

### 5. Workflows

**⛓ Workflows** chain spirits and AI tools into a pipeline that turns one request into a finished file.

1. Drag cards from the left onto the board: **User input** (the start — only one), **Spirit**, **AI tool**, and **Output** (the end).
2. Drag from a card's output dot to the next card's input dot to connect them. On AI tool cards, write what the AI should do when it receives data. When several cards feed into one, set the merge order; when one feeds several, set the run order.
3. On the Output card, choose the file type: Word, Excel, PowerPoint, PDF, Markdown or HTML.
4. Type your request on the right, attach files or folders if needed, and press **▶ Run**.

Cards run one at a time and the log shows every step. The finished file is saved automatically to `Documents/Screen Spirit 成品/<workflow name>/`.

Handy tools:

- **Ignore:** skip a card for now without deleting it or its connections.
- **▶ Start from this step:** re-run from any card. Earlier steps reuse their last results, or you can paste a result yourself.
- **Finish this step:** if a card is waiting on an app, you can end the step with what has been read so far.
- **Run mode:** a desktop-app card (for example Claude) can run on the same account's background version instead (Claude Code), so it doesn't take over your screen.
- **Paste-only AIs:** AIs that can only paste into an app can't return results, so they can only be the last step.
- **While running:** the workflow is locked. Press **■ Stop** to interrupt it.

### 6. The desktop spirit and menu

The spirit floating on your desktop and the ✦ in the menu bar (system tray on Windows) open the same menu:

- select the screen
- ask about highlighted text
- open the chat window
- show, hide or pin the AI drawer
- restore side-by-side windows
- choose the layout
- quit

The spirit's expression changes while it's working, when it's done, and when something goes wrong.

### 7. Settings

- **AI connections:** choose which AIs to use and your default AI, sign in to CLI tools, and enter your MixRoute key.
- **🌐 Language:** switch between English and Traditional Chinese.
- **Built-in ChatGPT plan & display settings:** connect your ChatGPT plan, and choose where the chat window appears (next to the spirit or next to your selection).

## Install (macOS)

### Option 1: Download the packaged app

1. Download `Screen-Spirit-mac-arm64.zip` from **Releases** and unzip it.
2. Drag `Screen Spirit.app` into your Applications folder.
3. First launch: the app has no Apple Developer signature, so macOS will block it. In Applications, **right-click Screen Spirit → Open → Open**. If macOS says the app is "damaged", run this once in Terminal:
   ```sh
   xattr -cr "/Applications/Screen Spirit.app"
   ```

### Option 2: Install from source (builds the app for you)

1. Install [Node.js](https://nodejs.org) (LTS) and the Xcode command line tools (`xcode-select --install` in Terminal).
2. Download this project (Code → Download ZIP, or `git clone`).
3. In Finder, double-click **`安裝或更新 Screen Spirit.command`** (if it is blocked, right-click → Open).
   It builds the app, installs it into Applications and opens it. After that, launch it from Launchpad and pin it to the Dock if you like.
4. To update, double-click the same file again. Your spirits, workflows and settings are kept.

### macOS permissions

First-run setup takes you to **System Settings → Privacy & Security** to allow Screen Spirit to use:

- **Screen Recording** — to capture the area you select (restart Screen Spirit after turning it on).
- **Accessibility** — to paste your question into AI apps and read the reply back.

The installer creates a self-signed "Screen Spirit Local Signing" certificate in your keychain and signs the app with it, so permissions survive updates. If a permission is switched on but Screen Spirit still says it is missing, run these two lines in Terminal, then reopen Screen Spirit and allow it again:

```sh
tccutil reset ScreenCapture com.screenspirit.localpoc
tccutil reset Accessibility com.screenspirit.localpoc
```

## Install (Windows)

### Option 1: Download the packaged build

1. Download `Screen-Spirit-windows-x64.zip` from **Releases** and unzip it anywhere (for example, Documents).
2. Run `Screen Spirit.exe`. The app is not code-signed, so Windows SmartScreen may warn you: click **More info → Run anyway**.

### Option 2: Install from source

1. Install [Node.js](https://nodejs.org) (LTS).
2. Download this project (Code → Download ZIP, then unzip).
3. Double-click **`安裝或更新 Screen Spirit (Windows).cmd`**. It builds the app, installs it to `%LOCALAPPDATA%\Programs\Screen Spirit`, and adds Start menu and desktop shortcuts.
4. To update, run the same file again. Your spirits, workflows and settings are kept.

Windows hotkeys: select screen area `Ctrl+Shift+1`, send clipboard `Ctrl+Shift+2`.

## Where your data lives

- **Spirit knowledge base (long-term memory):** `Documents/Screen Spirit/精靈資料庫/<spirit name>` by default. You can move it to an Obsidian vault or a cloud drive in the Spirit Lab.
- **Files produced by workflows:** `Documents/Screen Spirit 成品`.
- **Settings, spirits, workflows:** `~/Library/Application Support/` on macOS, `%APPDATA%\` on Windows. API keys are stored with the system's encrypted storage, never in the project files.

## Development

```sh
npm install
npm run poc:chatgpt-plan            # run in development mode
npm run package:screen-spirit       # build the macOS app into out/
npm run package:screen-spirit:win   # build the Windows app (run this on Windows)
```

Push a tag that starts with `v` (for example `git tag v0.2.0 && git push --tags`) and GitHub Actions builds both the macOS and Windows versions and attaches the zip files to Releases (workflows live in `.github/workflows/`).

Example spirits live in `experiments/chatgpt-plan-poc/seed-spirits/`. They are only added on a fresh install (when there are no spirits yet); existing installs are never touched.

## License notes

- The bundled `experiments/chatgpt-plan-poc/vendor/siwc-local` (OpenAI Sign in with ChatGPT DevKit) has its own **noncommercial** license. Check it before redistributing or using this project commercially.
- API keys and sign-in data are stored in the system's encrypted storage, not in the project files.

---

## 繁體中文

[English](#screen-spirit) | **繁體中文**

**螢幕圈選 AI 小精靈**

常駐在桌面的小精靈：按快捷鍵圈選畫面上的一塊區域、輸入問題，小精靈就把內容交給你選的 AI（ChatGPT、Claude 桌面 App、Claude Code、Codex、Gemini CLI、MixRoute、Ollama…），並在自己的視窗呈現完整問答。也可以建立多隻有不同角色的「精靈」，用「工作流」把它們和各種 AI 串成一條流程，最後自動做成 Word／PDF／PowerPoint／Excel 等檔案。

介面支援英文與繁體中文：第一次打開時會請你選語言（台灣地區預設繁體中文，其他地區預設英文），之後可以隨時更改。

專案裡附了一隻範例精靈「造型博士」（幫精靈設計造型），第一次安裝時會自動放進「精靈博士」。它的 AI 跟著你在第一次設定選的預設 AI，資料庫預設放在「文件／Screen Spirit／精靈資料庫」。

### 支援的系統

| 功能 | macOS（Apple Silicon） | Windows（x64） |
| --- | --- | --- |
| 圈選螢幕、精靈博士、工作流、輸出檔案 | ✓ | ✓（初步支援，尚未完整實測） |
| 背景執行：Claude Code、Codex、Gemini CLI | ✓ | ✓ |
| 雲端 API：MixRoute | ✓ | ✓ |
| 本機模型：Ollama | ✓ | ✓ |
| 操作 Claude／ChatGPT 桌面版、Chrome 網頁 | ✓ | 目前只支援 macOS |

第一次打開時會有一步一步的「第一次使用設定」：先選語言，macOS 會再帶你開啟系統權限，接著選要連接的 AI（沒安裝的可以直接點連結下載），最後選一個預設 AI。Windows 不需要權限那一步，只支援 macOS 的項目會反灰標示。

### 使用方式

#### 快捷鍵

| 動作 | macOS | Windows |
| --- | --- | --- |
| 圈選畫面上的一塊區域來問 | `⌘⇧1` | `Ctrl+Shift+1` |
| 問反白的文字 | `⌘⇧2` | `Ctrl+Shift+2` |
| 打開／收起 AI 抽屜（只有 macOS） | `⌘⇧9` | — |

也可以從主視窗、選單列的 ✦ 選單，或桌面上漂浮的小精靈開始。

#### 1. 圈選畫面提問

1. 按 `⌘⇧1`，在想問的地方拉一個框，例如錯誤訊息、圖表、PDF 裡的一段話。
2. 會跳出提問視窗，截圖已經附上，直接輸入問題。
3. 在「送到」選要交給哪個 AI，按「送出」。
   - **背景執行的 AI**（Claude Code、Codex、Gemini CLI、MixRoute、Ollama、內建 ChatGPT）：回覆會直接顯示在小精靈的視窗裡，可以在同一段對話繼續追問。
   - **桌面 App 與 Chrome**（Claude、ChatGPT、ChatGPT 網頁、Google AI 模式，只有 macOS）：小精靈會開一個新對話，貼上截圖和問題並送出。之後依照你選的「畫面安排」，AI 視窗會：
     - 變成右側 1/3 的**抽屜**
     - 和原本的程式**固定並排**（左 2/3、右 1/3）
     - 或維持不動

小提醒：

- 可以把圖片或文字檔拖進提問框，也可以直接貼上圖片，附加更多內容。
- 小精靈會記下這塊畫面來自哪個程式、哪個視窗，顯示成可以移除的小標籤。
- 選的模型看不懂圖片時，會改送圖片裡辨識出的文字（本機 OCR），並在畫面上提醒你。

#### 2. 反白文字提問

在任何程式反白一段文字後按 `⌘⇧2`。小精靈只會帶上這段文字和來源程式的名稱，不截圖，接著打開同一個提問視窗。

#### 3. 歷史紀錄

主視窗的「歷史紀錄」會列出過去的對話，可以搜尋，也可以篩選「只存在這台電腦」、「App／網頁也找得到」或「全部」。打開任一筆直接輸入，就會接著問下去。背景執行的 AI 的對話只存在這台電腦，在網頁或 App 的歷史清單裡找不到。每一筆都會標示還有多久會被自動刪除。

#### 4. 精靈與精靈博士（卡片盒）

「精靈」是可以重複使用的 AI 小幫手，有自己的角色、規則和資料庫，用收藏卡片的方式管理。按「✦ 精靈博士」打開卡片盒，可以瀏覽或建立精靈。每張卡片周圍有六組設定：

| 設定 | 內容 |
| --- | --- |
| 📚 資料庫與記憶 | 每次都會帶給 AI 的背景知識和參考資料夾。也可以開啟「長期記憶」：每次對話結束，由你指定的 AI 把之後還用得到的重點整理成筆記，存到精靈的資料夾。預設在 `文件／Screen Spirit／精靈資料庫／精靈名稱`，也可以改到 Obsidian 筆記庫或雲端硬碟。 |
| 🚧 限制 | 可以做什麼、不可以做什麼、回覆多長。 |
| 🎭 角色身份與定位 | 身份、專長、說話的語氣。 |
| 🤖 指定 AI | 主要 AI、主要 AI 不能用時的備用 AI，以及要畫圖時用的生圖模型。不指定就跟著你的預設 AI。 |
| 🧭 工作拆解 SOP | 接到工作後依序要做哪些步驟。 |
| 🎨 造型設定 | 卡面圖片、代表符號、顏色、稀有度，或動態造型。 |

「限制」、「角色」、「SOP」都可以先隨意寫下想法，再按「✨ 讓 AI 幫我寫」，可以選精簡或詳細。AI 會保留你已經寫的內容，再幫你補強。

要派精靈工作：在主視窗按「派精靈工作」，或圈選之後在提問視窗選一隻精靈。精靈畫的圖可以存成檔案，也可以按 🃏 設成牠的卡面。

**動態造型：** 在「🎨 造型設定 → 🎬 動態造型」匯入角色設定圖。小精靈會先找出主角，再把配件分成兩類：
- **獨立漂浮的配件**（例如鍵盤、單眼鏡）：各自放在最上面一層。
- **和角色融為一體的配件**（例如帽子、耳機）：和身體一起重畫成「特製主體」，大小、位置對齊預設的小精靈。

之後補上表情，最後再加上閃光、星星等特效。這一步需要透過 MixRoute 用生圖模型，大約 2～4 分鐘。專案附的範例精靈「造型博士」就是專門幫你設計這種造型的。

#### 5. 工作流

「⛓ 工作流」可以把精靈和各種 AI 串成一條流程，把一個需求一路做成成品檔案。

1. 從左邊把卡片拖到畫布上：「使用者輸入」（開頭，只能一張）、「精靈」、「AI 工具」、「成品」（結尾）。
2. 從卡片的輸出點拉線到下一張卡片的輸入點，就接起來了。AI 工具卡片要寫「收到資料時要做什麼」。好幾張接到同一張時，可以設定合併的順序；一張接到好幾張時，可以設定執行的順序。
3. 在成品卡片選要做成哪種檔案：Word、Excel、PowerPoint、PDF、Markdown 或網頁（HTML）。
4. 在右邊輸入需求，需要的話附上檔案或資料夾，按「▶ 執行」。

卡片會一張一張依序執行，執行紀錄會顯示每一步的狀況。做好的檔案會自動存到 `文件／Screen Spirit 成品／工作流名稱／`。

好用的功能：

- **忽略：** 卡片和接線都留著，執行時先跳過它。
- **▶ 從這一步開始執行：** 前面的步驟沿用上一次的結果，不用重跑；也可以自己貼上某一步的結果。
- **用目前讀到的內容完成這一步：** 卡片在等 App 回覆時，可以直接結束這一步，往下繼續。
- **執行方式：** 桌面 App 的卡片（例如 Claude）可以改用同一個帳號的背景版本（Claude Code），執行時不會佔用你的畫面。
- **只能貼上的 AI：** 拿不回結果，只能放在最後一步。
- **執行中：** 工作流會鎖住不能修改，要中斷就按「■ 停止」。

#### 6. 桌面小精靈與選單

桌面上漂浮的小精靈和選單列（Windows 是系統匣）的 ✦ 會打開同一個選單，可以：

- 圈選畫面
- 用反白文字提問
- 開啟對話視窗
- 打開、收起或固定 AI 抽屜
- 還原並排的視窗
- 切換並排方式
- 結束程式

小精靈在工作中、完成和出錯時，表情會跟著變。

#### 7. 設定

- **管理 AI 連線：** 勾選要用的 AI、選預設 AI、登入指令列工具、輸入 MixRoute 金鑰。
- **🌐 語言：** 切換英文或繁體中文。
- **內建 ChatGPT 方案與顯示設定：** 連接 ChatGPT 方案，以及設定對話框出現的位置（小精靈旁或圈選處旁）。

### 安裝（macOS）

#### 方法一：下載打包好的 App

1. 到右邊的 **Releases** 下載 `Screen-Spirit-mac-arm64.zip`，解壓縮。
2. 把 `Screen Spirit.app` 拖到「應用程式」資料夾。
3. 第一次開啟：因為 App 沒有 Apple 開發者簽章，macOS 會擋下來。請在「應用程式」裡對 Screen Spirit **按右鍵 →「打開」→ 再按「打開」**。如果顯示「已損毀」，打開「終端機」執行一次：
   ```sh
   xattr -cr "/Applications/Screen Spirit.app"
   ```

#### 方法二：從原始碼安裝（會自動打包成 App）

1. 先安裝 [Node.js](https://nodejs.org)（LTS 版）和 Xcode 命令列工具（終端機執行 `xcode-select --install`）。
2. 下載這個專案（Code → Download ZIP，或 `git clone`）。
3. 在 Finder 雙擊 **`安裝或更新 Screen Spirit.command`**（第一次被擋的話，按右鍵 →「打開」）。
   它會打包成 App、放進「應用程式」並打開。之後從 Launchpad 點兩下就能用，可以拖到 Dock 固定。
4. 程式更新後，再雙擊一次同一個檔案就會換成新版；你的精靈、工作流和設定都會保留。

#### macOS 權限

第一次使用設定會帶你到「系統設定 → 隱私權與安全性」，允許 Screen Spirit 使用：

- **螢幕錄製**：圈選畫面時擷取選取的區域（開啟後要重新開啟小精靈）。
- **輔助使用**：把問題貼到 AI App、讀回 AI 的回覆。

安裝程式會在你的鑰匙圈建立一個自簽的「Screen Spirit Local Signing」憑證來簽名 App，這樣更新後權限不會失效。如果開關明明打開了、小精靈還是說沒有權限，在終端機執行下面兩行，再重新打開小精靈並重新允許一次：

```sh
tccutil reset ScreenCapture com.screenspirit.localpoc
tccutil reset Accessibility com.screenspirit.localpoc
```

### 安裝（Windows）

#### 方法一：下載打包好的版本

1. 到 **Releases** 下載 `Screen-Spirit-windows-x64.zip`，解壓縮到任何資料夾（例如「文件」）。
2. 執行裡面的 `Screen Spirit.exe`。因為沒有程式碼簽章，Windows SmartScreen 可能會擋：按「其他資訊」→「仍要執行」。

#### 方法二：從原始碼安裝

1. 先安裝 [Node.js](https://nodejs.org)（LTS 版）。
2. 下載這個專案（Code → Download ZIP，解壓縮）。
3. 雙擊 **`安裝或更新 Screen Spirit (Windows).cmd`**。它會打包、安裝到 `%LOCALAPPDATA%\Programs\Screen Spirit`，並在「開始」功能表和桌面建立捷徑。
4. 程式更新後再執行一次同一個檔案即可；精靈、工作流和設定都會保留。

Windows 的快捷鍵：圈選畫面 `Ctrl+Shift+1`、送出剪貼簿 `Ctrl+Shift+2`。

### 資料放在哪裡

- **精靈資料庫（長期記憶）**：預設在「文件／Screen Spirit／精靈資料庫／精靈名稱」，可以在精靈博士裡換到 Obsidian 筆記庫或雲端硬碟。
- **工作流做出來的檔案**：「文件／Screen Spirit 成品」。
- **設定、精靈、工作流**：macOS 在 `~/Library/Application Support/`，Windows 在 `%APPDATA%\`。API 金鑰用系統的加密儲存，不在專案檔案裡。

### 開發

```sh
npm install
npm run poc:chatgpt-plan            # 直接用開發模式執行
npm run package:screen-spirit       # 打包 macOS 版，結果在 out/
npm run package:screen-spirit:win   # 打包 Windows 版（請在 Windows 上執行）
```

推送 `v` 開頭的標籤（例如 `git tag v0.2.0 && git push --tags`），GitHub Actions 會自動打包 macOS 與 Windows 版，把 zip 放到 Releases（設定檔在 `.github/workflows/`）。

範例精靈放在 `experiments/chatgpt-plan-poc/seed-spirits/`：只有在還沒有任何精靈（第一次安裝）時才會放進去，已經在用的電腦不會受影響。

### 授權與注意事項

- 專案內附的 `experiments/chatgpt-plan-poc/vendor/siwc-local`（OpenAI Sign in with ChatGPT DevKit）有自己的授權條款（非商業使用），公開散佈或商業使用前請先確認該授權。
- API 金鑰、登入資訊存在系統的加密儲存，不在專案檔案裡。
