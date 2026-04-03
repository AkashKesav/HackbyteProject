$proxyHost = "127.0.0.1:8877"

Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyEnable -Value 1
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -Name ProxyServer -Value $proxyHost

Write-Host "Windows proxy enabled: $proxyHost"
Write-Host "Chrome and Edge usually respect this setting."
