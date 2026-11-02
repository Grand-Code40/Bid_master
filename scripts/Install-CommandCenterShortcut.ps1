param([string]$ProjectFolder = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $PSScriptRoot 'Start-CommandCenter.ps1'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$folders = @($ProjectFolder, $desktopPath) | Select-Object -Unique
foreach ($folder in $folders) {
    if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw "Shortcut destination missing: $folder" }
    $shortcutPath = Join-Path $folder 'CAIgraph - Командный центр.lnk'
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $targetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ((Test-Path -LiteralPath $shortcutPath) -and ($shortcut.TargetPath -ne $targetPath -or $shortcut.Arguments -notlike '*Start-CommandCenter.ps1*')) {
        throw "An unrelated shortcut already exists: $shortcutPath"
    }
    $shortcut.TargetPath = $targetPath
    $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.WindowStyle = 7
    $shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',21'
    $shortcut.Description = 'CAIgraph - CAD command center'
    $shortcut.Save()
    Write-Output $shortcutPath
}
