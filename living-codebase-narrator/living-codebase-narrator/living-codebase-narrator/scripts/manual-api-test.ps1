# Manual API checks for Living Codebase Narrator (Windows PowerShell)
# Prerequisites: backend running at $BaseUrl (default http://localhost:8787)

param(
  [string] $BaseUrl = "http://localhost:8787"
)

$ErrorActionPreference = "Stop"

function Invoke-Json($Method, $Path, $BodyObj = $null) {
  $uri = "$BaseUrl$Path"
  if ($null -eq $BodyObj) {
    return Invoke-RestMethod -Method $Method -Uri $uri
  }
  $json = $BodyObj | ConvertTo-Json -Depth 12 -Compress
  return Invoke-RestMethod -Method $Method -Uri $uri -ContentType "application/json" -Body $json
}

Write-Host "== Health ==" -ForegroundColor Cyan
Invoke-Json GET "/health" | ConvertTo-Json -Depth 8

Write-Host "`n== Debug integrations ==" -ForegroundColor Cyan
try {
  Invoke-Json GET "/debug/integrations" | ConvertTo-Json -Depth 8
} catch {
  Write-Host "(optional endpoint may be missing on older builds)" -ForegroundColor Yellow
}

Write-Host "`n== POST /debug/gemini (uses env key if set) ==" -ForegroundColor Cyan
$gemBody = @{
  filePath = "demo.ts"
  language = "typescript"
  diff     = "--- a/demo.ts`n+++ b/demo.ts`n@@ -0,0 +1,2 @@`n+export const x = 1`n"
  context  = "smoke test"
}
try {
  Invoke-Json POST "/debug/gemini" $gemBody | ConvertTo-Json -Depth 8
} catch {
  Write-Host "Gemini test failed (expected if no key or quota): $_" -ForegroundColor Yellow
}

Write-Host "`n== POST /debug/elevenlabs ==" -ForegroundColor Cyan
try {
  Invoke-Json POST "/debug/elevenlabs" @{ text = "Short heading narration test." } | ConvertTo-Json -Depth 6
} catch {
  Write-Host "ElevenLabs test failed: $_" -ForegroundColor Yellow
}

Write-Host "`n== POST /deltas ==" -ForegroundColor Cyan
$delta = @{
  sessionId    = "manual-script"
  author       = "manual"
  filePath     = "src/smoke.ts"
  language     = "typescript"
  diff         = "--- a/src/smoke.ts`n+++ b/src/smoke.ts`n@@ -1,1 +1,4 @@`n-a`n+b`n+c`n+d`n"
  context      = "manual API test"
  changedLines = 6
  source       = "vscode"
}
$deltaRes = Invoke-Json POST "/deltas" $delta
$deltaRes | ConvertTo-Json -Depth 8

$docId = $deltaRes.doc.id
Write-Host "`n== POST /docs/:id/vote (doc id: $docId) ==" -ForegroundColor Cyan
Invoke-Json POST "/docs/$docId/vote" @{ direction = "up" } | ConvertTo-Json -Depth 6

Write-Host "`n== GET /docs?limit=5 ==" -ForegroundColor Cyan
Invoke-Json GET "/docs?limit=5" | ConvertTo-Json -Depth 8

Write-Host "`nDone." -ForegroundColor Green
