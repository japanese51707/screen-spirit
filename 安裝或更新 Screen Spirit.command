#!/bin/bash
# 安裝或更新 Screen Spirit：在 Finder 雙擊這個檔案就好（第一次如果被擋，按右鍵 →「打開」）。
# 做的事：打包成 App → 簽名 → 放進「應用程式」→ 打開。之後從 Launchpad／應用程式點兩下就能用，不用再開終端機。
# 程式有更新時，再雙擊一次這個檔案就會換成新版（你的精靈、工作流、設定都會保留）。
set -e
trap 'echo ""; echo "✗ 中途出錯了，請把上面的訊息截圖。"; read -n 1 -s -r -p "按任意鍵關閉…"' ERR
cd "$(dirname "$0")"
APP_NAME="Screen Spirit"
echo "═══ ${APP_NAME}：安裝／更新 ═══"

# 從 Finder 開的終端機不一定有載入 nvm、Homebrew 的路徑
for dir in /opt/homebrew/bin /usr/local/bin; do [ -d "$dir" ] && PATH="$dir:$PATH"; done
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
if ! command -v npm >/dev/null 2>&1; then
  echo "找不到 Node.js。請先到 https://nodejs.org 安裝（選 LTS 版），再雙擊一次這個檔案。"
  read -n 1 -s -r -p "按任意鍵關閉…"; exit 1
fi

if [ ! -d node_modules ]; then
  echo "▶ 第一次安裝：下載需要的套件（幾分鐘）"
  npm install
fi

echo "▶ 關掉正在執行的 ${APP_NAME}（如果有開著）"
osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
pkill -f "experiments/chatgpt-plan-poc/main.mjs" >/dev/null 2>&1 || true

echo "▶ 打包成 App（約 1 分鐘）"
npm run package:screen-spirit

ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH="x64"
BUILT="out/${APP_NAME}-darwin-${ARCH}/${APP_NAME}.app"
[ -d "$BUILT" ] || BUILT="$(ls -d out/"${APP_NAME}"-darwin-*/"${APP_NAME}.app" 2>/dev/null | head -1)"
if [ ! -d "$BUILT" ]; then echo "打包失敗：找不到打包好的 App，請把上面的訊息截圖。"; read -n 1 -s -r -p "按任意鍵關閉…"; exit 1; fi

# ── 簽名 ──
# macOS 的「輔助使用／螢幕錄製」權限是跟著 App 的簽名走的。臨時簽名每次打包都不一樣，
# 系統設定裡開關看起來是開的，其實是給舊版的 → 程式還是說沒有權限。
# 所以第一次安裝時自動建立一個本機專用的簽署憑證（存在你的鑰匙圈），之後每次更新都用同一個簽名，權限就不會掉。
CERT_NAME="Screen Spirit Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
find_identity() { security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep "\"${CERT_NAME}\"" | head -1 | awk '{print $2}'; }
IDENTITY="$(find_identity)"
if [ -z "$IDENTITY" ]; then
  echo "▶ 第一次安裝：建立本機簽署憑證「${CERT_NAME}」（只做這一次；macOS 可能會請你輸入登入密碼）"
  TMP="$(mktemp -d)"
  if /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=${CERT_NAME}" \
       -addext "basicConstraints=critical,CA:false" -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
       -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1 \
     && /usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$CERT_NAME" -out "$TMP/id.p12" -passout pass:screenspirit >/dev/null 2>&1 \
     && security import "$TMP/id.p12" -k "$KEYCHAIN" -P screenspirit -T /usr/bin/codesign >/dev/null 2>&1; then
    security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem" >/dev/null 2>&1 || true
    IDENTITY="$(find_identity)"
  fi
  rm -rf "$TMP"
  [ -z "$IDENTITY" ] && echo "  （建立憑證沒有成功，這次先用臨時簽名）"
fi
if [ -n "$IDENTITY" ]; then
  echo "▶ 簽名（${CERT_NAME}）"
  codesign --force --deep --sign "$IDENTITY" "$BUILT" || { echo "  用憑證簽名失敗，改用臨時簽名"; IDENTITY=""; codesign --force --deep --sign - "$BUILT"; }
else
  echo "▶ 簽名（臨時簽名）"
  codesign --force --deep --sign - "$BUILT"
fi

# 簽名換了（第一次改用憑證、或用臨時簽名）：把系統裡舊的權限紀錄清掉，開啟後重新允許一次就好
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$BUILT/Contents/Info.plist" 2>/dev/null || echo com.screenspirit.localpoc)"
STATE_DIR="$HOME/Library/Application Support/Screen Spirit ChatGPT Plan PoC"
mkdir -p "$STATE_DIR"
LAST_SIGN="$(cat "$STATE_DIR/.signing-identity" 2>/dev/null || true)"
NEED_PERMISSIONS=""
if [ -z "$IDENTITY" ] || [ "$IDENTITY" != "$LAST_SIGN" ]; then
  echo "▶ 清掉舊的權限紀錄（簽名換了，舊紀錄會讓程式以為沒有權限）"
  tccutil reset ScreenCapture "$BUNDLE_ID" >/dev/null 2>&1 || true
  tccutil reset Accessibility "$BUNDLE_ID" >/dev/null 2>&1 || true
  NEED_PERMISSIONS=1
fi
echo "${IDENTITY}" > "$STATE_DIR/.signing-identity"

DEST="/Applications"; [ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
echo "▶ 放進 ${DEST}"
rm -rf "${DEST}/${APP_NAME}.app"
ditto "$BUILT" "${DEST}/${APP_NAME}.app"
xattr -dr com.apple.quarantine "${DEST}/${APP_NAME}.app" 2>/dev/null || true

# 順便做一份可以上傳到 GitHub Releases 的壓縮檔
mkdir -p out/release
ZIP="out/release/Screen-Spirit-mac-${ARCH}.zip"
rm -f "$ZIP"; ditto -c -k --keepParent "$BUILT" "$ZIP"

echo ""
echo "✓ 完成！之後從 Launchpad 或「${DEST}」點兩下「${APP_NAME}」就能開啟（可以拖到 Dock 固定）。"
echo "  上傳 GitHub 用的壓縮檔：$(pwd)/${ZIP}"
if [ -n "$NEED_PERMISSIONS" ]; then
  echo ""
  echo "★ 請重新允許一次權限（舊的已清掉）："
  echo "  1. 「系統設定 → 隱私權與安全性 → 輔助使用」：打開 ${APP_NAME}"
  echo "  2. 「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」：打開 ${APP_NAME}"
  echo "  3. 完全結束 ${APP_NAME}（選單列圖示 → 結束，或 ⌘Q），再重新打開一次（螢幕錄製要重開才生效）"
  [ -n "$IDENTITY" ] && echo "  之後更新都用同一個簽名，就不用再重新允許了。"
  [ -z "$IDENTITY" ] && echo "  （這次用的是臨時簽名：每次更新後都要重新允許一次。）"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
fi
open "${DEST}/${APP_NAME}.app"
sleep 2
