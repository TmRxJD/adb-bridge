; ============================================================================
;  ADB Bridge - Windows installer (Inno Setup 6)
;
;  Build:  node installer/windows/build.mjs
;  Output: dist/AdbBridgeSetup.exe
;
;  Design notes:
;  - PrivilegesRequired=lowest -> per-user install under %LOCALAPPDATA%, so
;    there is no UAC prompt and no "why does a save reader need admin?".
;  - The bootstrap ships inside this exe, so it carries no Mark-of-the-Web and
;    is not blocked the way a downloaded .cmd would be.
;  - No VBS launcher and no Run-key write. Background start is the bridge's own
;    --daemon mode, registered through Task Scheduler by `adb-bridge
;    --boot-only`. Scripts that write autorun keys and launch hidden processes
;    are what Defender's ML model scores as a dropper; the per-game bridge this
;    replaces was flagged as Trojan:Script/Wacatac.C!ml for exactly that shape.
;  - --boot-only, not --boot: --boot registers and then goes on to serve, which
;    left the wizard waiting forever for the process to exit.
;  - Games are Tasks, and enabling one is idempotent, so re-running this to add
;    a game extends the install that is already here rather than duplicating it.
;  - Unsigned builds still show SmartScreen once: "More info -> Run anyway".
;    On machines with Smart App Control enforcing, an unsigned uninstaller is
;    blocked outright -- that needs a real certificate, not a workaround.
; ============================================================================

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif

#define MyAppName "ADB Bridge"
#define MyAppPublisher "TmRxJD"
#define MyAppURL "https://github.com/TmRxJD/adb-bridge"
#define MyLauncher "adb-bridge-launch.cmd"

[Setup]
AppId={{6E1C0A54-2B7D-4F19-9C33-1D8B2A7E4051}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\AdbBridge
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=AdbBridgeSetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Setup
VersionInfoProductName={#MyAppName}
LicenseFile=..\..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; One entry per built-in game. Selecting several installs ONE bridge that
; serves them all -- that is the point of this package.
Name: "game_thetower"; Description: "The Tower"; GroupDescription: "Which games should this bridge handle?"
Name: "game_cifi"; Description: "CIFI"; GroupDescription: "Which games should this bridge handle?"; Flags: unchecked

Name: "desktopicon"; Description: "Create a &Desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
; Registers a Scheduled Task (or a Startup-folder script when that needs rights
; this per-user install does not have). Off by default -- starting things at
; login should be a deliberate choice.
Name: "startup"; Description: "Start &ADB Bridge when I sign in to Windows"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "bootstrap.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#MyLauncher}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyLauncher}"; WorkingDir: "{app}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyLauncher}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; Install Node.js if needed, then the bridge itself.
Filename: "{cmd}"; Parameters: "/c ""{app}\bootstrap.cmd"" silent"; \
  StatusMsg: "Installing Node.js and ADB Bridge..."; WorkingDir: "{app}"; Flags: runhidden waituntilterminated

; Enable the chosen games. `games add` is idempotent and joins whatever bridge
; is already configured, so re-running setup to add a game is safe.
Filename: "{cmd}"; Parameters: "/c ""{app}\{#MyLauncher}"" games add thetower"; \
  StatusMsg: "Enabling The Tower..."; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; Tasks: game_thetower
Filename: "{cmd}"; Parameters: "/c ""{app}\{#MyLauncher}"" games add cifi"; \
  StatusMsg: "Enabling CIFI..."; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; Tasks: game_cifi

; Register the sign-in entry only when asked. --boot-only registers and exits;
; --boot would register and then serve, hanging the wizard.
Filename: "{cmd}"; Parameters: "/c ""{app}\{#MyLauncher}"" --boot-only --skip-intro"; \
  StatusMsg: "Registering start at sign-in..."; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; Tasks: startup

Filename: "{app}\{#MyLauncher}"; Description: "Start {#MyAppName} now"; \
  WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; Remove the autostart entry if one was registered. Ignores failure so an
; uninstall never blocks on an entry that was never created.
Filename: "{cmd}"; Parameters: "/c ""{app}\{#MyLauncher}"" --remove-boot --skip-intro"; \
  WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveBootEntry"
Filename: "{cmd}"; Parameters: "/c npm uninstall -g adb-bridge"; \
  Flags: runhidden waituntilterminated; RunOnceId: "UninstallGlobal"

[Code]
{ The per-game bridges this replaces. Leaving one installed means two programs
  starting at sign-in and racing for the same port, so say so up front rather
  than letting the user discover it as "the site cannot connect". }
function LegacyBridgeInstalled(const AppId: String; var DisplayName: String): Boolean;
var
  Key: String;
begin
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + AppId + '_is1';
  Result := RegQueryStringValue(HKCU, Key, 'DisplayName', DisplayName)
         or RegQueryStringValue(HKLM, Key, 'DisplayName', DisplayName);
end;

{ An installer entry is only one way a legacy bridge gets onto a machine -- most
  users ran `npx tracker-bridge` and have no uninstall key at all. What actually
  conflicts is the autostart entry, so look for those too. }
function LegacyStartupEntry(const FileName: String): Boolean;
begin
  Result := FileExists(ExpandConstant('{userstartup}\') + FileName);
end;

function InitializeSetup(): Boolean;
var
  Name: String;
  Found: String;
begin
  Found := '';
  if LegacyBridgeInstalled('{7FDAA26C-20A6-40AB-9D8C-CCE3037092A3}', Name) then
    Found := Found + '  - ' + Name + ' (installed)' + #13#10
  else if LegacyStartupEntry('CIFI Bridge.cmd') then
    Found := Found + '  - CIFI Bridge (starts at sign-in)' + #13#10;

  if LegacyBridgeInstalled('{8B5F2E14-7C3D-4A69-9E52-6C1A0D3F8B27}', Name) then
    Found := Found + '  - ' + Name + ' (installed)' + #13#10
  else if LegacyStartupEntry('Tracker Bridge.cmd') then
    Found := Found + '  - Tracker Bridge (starts at sign-in)' + #13#10;

  if Found <> '' then
  begin
    { /SUPPRESSMSGBOXES only covers Setup's own dialogs -- a MsgBox from [Code]
      still displays and blocks, so a "silent" install sits waiting for a click
      that no one is there to give. Silent means silent: log it and continue. }
    if WizardSilent() then
    begin
      Log('Older single-game bridges found:' + #13#10 + Found);
      Result := True;
      Exit;
    end;
    if MsgBox(
      'ADB Bridge replaces these older single-game bridges:' + #13#10#13#10 + Found + #13#10 +
      'It handles the same games, and more, from one install.' + #13#10#13#10 +
      'Leaving them installed means two bridges starting at sign-in and ' +
      'competing for the same port. Uninstall them afterwards.' + #13#10#13#10 +
      'Continue?', mbConfirmation, MB_YESNO) = IDNO then
    begin
      Result := False;
      Exit;
    end;
  end;
  Result := True;
end;

{ Choosing no games would install a bridge that serves nothing. }
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpSelectTasks then
  begin
    if not (WizardIsTaskSelected('game_thetower') or WizardIsTaskSelected('game_cifi')) then
    begin
      MsgBox('Pick at least one game, otherwise the bridge has nothing to do.' + #13#10#13#10 +
             'You can always add more later with:  adb-bridge games add <name>',
             mbError, MB_OK);
      Result := False;
    end;
  end;
end;
