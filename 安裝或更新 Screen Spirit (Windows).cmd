@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Screen Spirit 安裝或更新
echo ✦ Screen Spirit：安裝或更新（Windows）
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js。請先到 https://nodejs.org 安裝 LTS 版，再執行一次這個檔案。
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo [1/4] 第一次安裝：下載需要的套件，需要幾分鐘…
  call npm install
  if errorlevel 1 goto failed
) else (
  echo [1/4] 套件已安裝，略過
)

echo [2/4] 關閉正在執行的 Screen Spirit
taskkill /IM "Screen Spirit.exe" /F >nul 2>nul

echo [3/4] 打包…
call npm run package:screen-spirit:win
if errorlevel 1 goto failed

set "SRC=%~dp0out\Screen Spirit-win32-x64"
set "DEST=%LOCALAPPDATA%\Programs\Screen Spirit"
echo [4/4] 安裝到 %DEST%
robocopy "%SRC%" "%DEST%" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto failed

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = New-Object -ComObject WScript.Shell;" ^
  "foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {" ^
  "  $l = $s.CreateShortcut((Join-Path $dir 'Screen Spirit.lnk'));" ^
  "  $l.TargetPath = Join-Path $env:LOCALAPPDATA 'Programs\Screen Spirit\Screen Spirit.exe';" ^
  "  $l.WorkingDirectory = Join-Path $env:LOCALAPPDATA 'Programs\Screen Spirit';" ^
  "  $l.Save() }"

echo.
echo ✓ 完成！已在「開始」功能表和桌面建立捷徑，現在幫你打開 Screen Spirit。
start "" "%DEST%\Screen Spirit.exe"
pause
exit /b 0

:failed
echo.
echo ✗ 安裝沒有完成，請把上面的訊息截圖給開發者。
pause
exit /b 1
