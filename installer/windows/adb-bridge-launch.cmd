@echo off
rem ===========================================================================
rem  Launcher installed to the user's app folder. Started by the Start Menu or
rem  Desktop shortcut, and by the installer for `games add` / boot commands.
rem
rem  Three things here are deliberate, all learned from real failures:
rem
rem  1. Node is looked for in a lot more places than "%ProgramFiles%\nodejs",
rem     and %ProgramW6432% is checked first. Setup is a 32-bit process, so in
rem     the hidden cmd it spawns %ProgramFiles% means "Program Files (x86)" --
rem     a machine with Node at "C:\Program Files\Volta" was told it had none.
rem
rem  2. The CLI is run through node.exe against the package's own entry script,
rem     never through an "adb-bridge" shim on PATH. Version managers (Volta,
rem     fnm) install shims that need a console, and under `runhidden` there is
rem     no console: every install step returned 126 ("cannot execute") and the
rem     installer silently enabled nothing while reporting success.
rem
rem  3. `pause` only ever runs in the interactive case. Under `runhidden` there
rem     is no console to read a keypress from, so pausing strands an invisible
rem     process forever -- that is what hung a silent uninstall.
rem ===========================================================================
setlocal enabledelayedexpansion
title ADB Bridge

rem Called with arguments? Then the installer or uninstaller is driving us, and
rem nothing may block on input.
set "NONINTERACTIVE="
if not "%~1"=="" set "NONINTERACTIVE=1"

for %%D in (
  "%ProgramW6432%\nodejs"
  "%ProgramFiles%\nodejs"
  "%ProgramFiles(x86)%\nodejs"
  "%LOCALAPPDATA%\Programs\nodejs"
  "%ProgramW6432%\Volta"
  "%ProgramFiles%\Volta"
  "%LOCALAPPDATA%\Volta\bin"
  "%USERPROFILE%\.volta\bin"
  "%APPDATA%\fnm"
  "%LOCALAPPDATA%\fnm"
  "%APPDATA%\nvm"
  "%USERPROFILE%\scoop\shims"
  "%ChocolateyInstall%\bin"
) do (
  if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
)

rem Anything already on PATH wins over the guesses above.
for /f "delims=" %%P in ('where node 2^>nul') do set "NODE_EXE=%%P"

if not defined NODE_EXE (
  echo Node.js was not found.
  echo.
  echo If you installed Node through a version manager, open a normal terminal
  echo and run:  npx adb-bridge
  echo Otherwise install it from https://nodejs.org and re-run this.
  if defined NONINTERACTIVE exit /b 1
  pause
  exit /b 1
)

rem --skip-intro serves immediately with no prompts: the installer already
rem handled Node.js. --no-boot because registering autostart belongs to the
rem installer's "start at sign-in" task, not to a manual start.
set "BRIDGE_ARGS=%*"
if "%BRIDGE_ARGS%"=="" set "BRIDGE_ARGS=--skip-intro --no-boot"

rem Locate the globally installed package and run its entry script directly.
set "BRIDGE_JS="
for /f "delims=" %%R in ('"%NODE_EXE%" -e "try{console.log(require('child_process').execSync('npm root -g',{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim())}catch(e){}" 2^>nul') do set "NPM_ROOT=%%R"
if defined NPM_ROOT (
  if exist "!NPM_ROOT!\adb-bridge\bin\adb-bridge.js" set "BRIDGE_JS=!NPM_ROOT!\adb-bridge\bin\adb-bridge.js"
)

rem Version managers keep globally-installed packages in their own tree, which
rem `npm root -g` does not point at -- Volta, for one, puts them under
rem tools\image\packages. Falling through to npx would still work, but only
rem after a network round trip for a package that is already on disk.
if not defined BRIDGE_JS (
  for %%C in (
    "%LOCALAPPDATA%\Volta\tools\image\packages\adb-bridge\node_modules\adb-bridge\bin\adb-bridge.js"
    "%USERPROFILE%\.volta\tools\image\packages\adb-bridge\node_modules\adb-bridge\bin\adb-bridge.js"
    "%APPDATA%\npm\node_modules\adb-bridge\bin\adb-bridge.js"
    "%ProgramW6432%\nodejs\node_modules\adb-bridge\bin\adb-bridge.js"
  ) do (
    if not defined BRIDGE_JS if exist "%%~C" set "BRIDGE_JS=%%~C"
  )
)

if defined BRIDGE_JS (
  "%NODE_EXE%" "!BRIDGE_JS!" %BRIDGE_ARGS%
) else (
  rem Not installed globally -- let npx fetch it.
  call npx -y adb-bridge@latest %BRIDGE_ARGS%
)
set "EXITCODE=%errorlevel%"

if defined NONINTERACTIVE exit /b %EXITCODE%

echo.
echo ADB Bridge has stopped. You can close this window.
pause
exit /b %EXITCODE%
