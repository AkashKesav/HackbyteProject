$env:HTTP_PROXY = "http://127.0.0.1:8877"
$env:HTTPS_PROXY = "http://127.0.0.1:8877"
$env:ALL_PROXY = "http://127.0.0.1:8877"

Write-Host "Launching VS Code with proxy variables pointed to 127.0.0.1:8877"
code
