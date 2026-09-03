# Minimal static file server for local testing. No dependencies - pure .NET.
# Serves this script's own folder at http://localhost:8000. Ctrl+C to stop.

$root = $PSScriptRoot
$port = 8000
$prefix = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "Could not start on port $port." -ForegroundColor Yellow
  Write-Host "Another server is probably already running there. Try opening" -ForegroundColor Yellow
  Write-Host "  $prefix" -ForegroundColor Cyan
  Write-Host "directly. If that also fails, close whatever uses port $port and retry."
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}

Write-Host "Serving $root"
Write-Host "Open  $prefix" -ForegroundColor Cyan
Write-Host "(Ctrl+C to stop)"

$mime = @{
  '.html' = 'text/html';   '.js'   = 'text/javascript'; '.mjs' = 'text/javascript'
  '.css'  = 'text/css';    '.json' = 'application/json'; '.md'  = 'text/plain'
  '.png'  = 'image/png';   '.jpg'  = 'image/jpeg';       '.svg' = 'image/svg+xml'
  '.wasm' = 'application/wasm'
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
    $path = Join-Path $root $rel

    if (Test-Path $path -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      if ($mime.ContainsKey($ext)) { $ctx.Response.ContentType = $mime[$ext] }
      $ctx.Response.StatusCode = 200
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes(("404: " + $rel))
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
    $ctx.Response.OutputStream.Close()
  }
} finally {
  $listener.Stop()
}
