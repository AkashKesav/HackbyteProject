$logsRoot = Join-Path $env:APPDATA "Code\logs"

if (-not (Test-Path $logsRoot)) {
  Write-Error "VS Code logs directory not found at $logsRoot"
  exit 1
}

$latestLog = Get-ChildItem $logsRoot -Recurse -Filter "*.log" |
  Where-Object { $_.FullName -match "copilot" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $latestLog) {
  Write-Error "No Copilot-related log file found under $logsRoot"
  exit 1
}

Write-Host "Watching Copilot log:"
Write-Host $latestLog.FullName
Write-Host ""

function Get-ModelHint {
  param(
    [string]$Line
  )

  $patterns = @(
    "claude[- ]?haiku[ -]?[0-9.]*",
    "claude[- ]?sonnet[ -]?[0-9.]*",
    "claude[- ]?opus[ -]?[0-9.]*",
    "gpt[- ]?[0-9a-z.]*",
    "gemini[- ]?[0-9a-z.]*",
    "o[0-9][ -]?[a-z0-9]*"
  )

  foreach ($pattern in $patterns) {
    $match = [regex]::Match($Line, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success) {
      return $match.Value
    }
  }

  return $null
}

Get-Content $latestLog.FullName -Wait -Tail 50 | ForEach-Object {
  $line = $_
  $modelHint = Get-ModelHint -Line $line

  if ($modelHint) {
    Write-Host "[copilot-model] $modelHint"
    Write-Host $line
  } else {
    Write-Host $line
  }
}
