$ErrorActionPreference = 'Stop'
try {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $dataRoot = if ($env:DISCOVERY_DATA_ROOT) { $env:DISCOVERY_DATA_ROOT } else { 'D:\DrawingAI_runs\bid-master-source-access-2026-11-02' }
    if ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($dataRoot)) -ne 'D:\') {
        throw 'CAIgraph data must be stored on D:. Check DISCOVERY_DATA_ROOT.'
    }
    $candidates = @(
        (Join-Path $dataRoot 'venv\Scripts\pythonw.exe'),
        (Join-Path $repoRoot '.venv\Scripts\pythonw.exe')
    )
    if ($env:CAIGRAPH_PYTHON) { $candidates = @($env:CAIGRAPH_PYTHON) + $candidates }
    $pythonPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $pythonPath) { throw 'Python environment not found. See docs/autobid/COMMAND_CENTER.md.' }
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $env:DISCOVERY_DATA_ROOT = $dataRoot
    $env:TEMP = Join-Path $dataRoot 'tmp'
    $env:TMP = $env:TEMP
    $env:TMPDIR = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    Start-Process -FilePath $pythonPath -ArgumentList @('-B', '-m', 'autobid.command_center') -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'CAIgraph - startup error', 'OK', 'Error') | Out-Null
    exit 1
}

