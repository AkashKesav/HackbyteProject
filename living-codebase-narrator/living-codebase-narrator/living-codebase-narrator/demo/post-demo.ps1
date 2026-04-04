$body = Get-Content -Raw ".\demo\sample-delta.json"

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:8787/deltas" `
  -ContentType "application/json" `
  -Body $body | ConvertTo-Json -Depth 8
