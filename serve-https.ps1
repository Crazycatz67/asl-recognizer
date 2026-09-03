# HTTPS static server for phone testing over the local network.
#
# The camera only works in a "secure context": https:// (any cert) or
# localhost. A phone can't reach your PC's localhost, so we serve https://
# on the LAN using a self-signed certificate. The phone shows a one-time
# "not private" warning; tap through it and the camera works.
#
# No admin rights needed: TLS is terminated in-process with SslStream, and
# the cert lives in the CurrentUser store. Windows Firewall will prompt once
# to allow the port on your private network -- click Allow.
#
# Ctrl+C to stop.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 8443

# --- pick a LAN IPv4 address ------------------------------------------------
$lan = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -ne '127.0.0.1' -and
    $_.IPAddress -notlike '169.254.*' -and
    $_.PrefixOrigin -ne 'WellKnown'
  } | Select-Object -First 1).IPAddress
if (-not $lan) { $lan = '127.0.0.1' }

# --- reuse or create a self-signed cert -----------------------------------
$friendly = 'asl-fingerspelling-dev'
$cert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.FriendlyName -eq $friendly -and $_.NotAfter -gt (Get-Date) } |
  Select-Object -First 1

if (-not $cert) {
  Write-Host "Creating a self-signed certificate (one time)..."
  $cert = New-SelfSignedCertificate `
    -DnsName $lan, 'localhost' `
    -FriendlyName $friendly `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears(2)
}

# --- start listening ----------------------------------------------------
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)
try {
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "Could not bind port $port ($($_.Exception.Message))." -ForegroundColor Yellow
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host ""
Write-Host "  On your phone (same Wi-Fi), open:" -ForegroundColor Green
Write-Host "     https://$lan`:$port" -ForegroundColor Cyan
Write-Host ""
Write-Host "  You'll get a 'not private' warning -> tap Advanced / Show details -> proceed."
Write-Host "  If the page never loads, allow the Windows Firewall prompt for this port."
Write-Host "  (Ctrl+C to stop)"
Write-Host ""

$mime = @{
  '.html' = 'text/html';   '.js'   = 'text/javascript'; '.mjs' = 'text/javascript'
  '.css'  = 'text/css';    '.json' = 'application/json'; '.md'  = 'text/plain'
  '.png'  = 'image/png';   '.jpg'  = 'image/jpeg';       '.svg' = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

function Send-Bytes($ssl, $status, $type, $bytes) {
  $head = "HTTP/1.1 $status`r`n" +
          "Content-Type: $type`r`n" +
          "Content-Length: $($bytes.Length)`r`n" +
          "Cache-Control: no-store`r`n" +
          "Connection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $ssl.Write($hb, 0, $hb.Length)
  if ($bytes.Length -gt 0) { $ssl.Write($bytes, 0, $bytes.Length) }
  $ssl.Flush()
}

$rootFull = [System.IO.Path]::GetFullPath($root)

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $ssl = $null
    try {
      $ssl = [System.Net.Security.SslStream]::new($client.GetStream(), $false)
      $ssl.ReadTimeout = 5000
      $ssl.WriteTimeout = 15000
      $ssl.AuthenticateAsServer($cert, $false,
        [System.Security.Authentication.SslProtocols]::Tls12, $false)

      $reader = [System.IO.StreamReader]::new($ssl)
      $requestLine = $reader.ReadLine()
      while (($line = $reader.ReadLine())) { }  # drain headers

      if (-not $requestLine) { continue }
      $target = ($requestLine -split ' ')[1]
      $pathPart = ($target -split '\?')[0]
      $rel = [System.Uri]::UnescapeDataString($pathPart).TrimStart('/')
      if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }

      $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
      if (-not $full.StartsWith($rootFull) -or -not (Test-Path $full -PathType Leaf)) {
        Send-Bytes $ssl '404 Not Found' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes("Not found: $rel"))
      } else {
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        Send-Bytes $ssl '200 OK' $type ([System.IO.File]::ReadAllBytes($full))
      }
    } catch {
      # a dropped connection / TLS abort by the client is normal - ignore
    } finally {
      if ($ssl) { $ssl.Dispose() }
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
