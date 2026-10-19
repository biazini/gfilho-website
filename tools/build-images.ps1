# Regenerates the raster images in site/ from tools/*.html with headless Chrome (Windows).
# Usage:  powershell -ExecutionPolicy Bypass -File tools\build-images.ps1
$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools'
$site  = Join-Path $root 'site'
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome not found.' }
$profileDir = Join-Path $env:TEMP 'gfilho-chrome-profile'

function Render([string]$page, [string]$out, [int]$w, [int]$h, [string]$query = '') {
  $url = ([Uri](Join-Path $tools $page)).AbsoluteUri + $query
  if (Test-Path $out) { Remove-Item $out }
  # separate throw-away profile so a running Chrome is never touched
  $chromeArgs = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--no-first-run', '--no-default-browser-check', "--user-data-dir=`"$profileDir`"",
    '--default-background-color=00000000', '--force-device-scale-factor=1',
    "--window-size=$w,$h", "--screenshot=`"$out`"", '--virtual-time-budget=3000', "`"$url`"")
  Start-Process -FilePath $chrome -ArgumentList $chromeArgs -Wait -NoNewWindow `
    -RedirectStandardError (Join-Path $env:TEMP 'gfilho-chrome.log') -RedirectStandardOutput (Join-Path $env:TEMP 'gfilho-chrome.out')
  if (-not (Test-Path $out)) { throw "render failed: $out" }
  Write-Host ("{0,-40} {1,8} bytes" -f (Resolve-Path -Relative $out), (Get-Item $out).Length)
}

Push-Location $root
try {
  Render 'og-image.html' (Join-Path $site 'og-image.png') 1200 630
  Render 'icon.html' (Join-Path $site 'assets\img\icon-192.png') 192 192 '?s=192'
  Render 'icon.html' (Join-Path $site 'assets\img\icon-512.png') 512 512 '?s=512'
  Render 'icon.html' (Join-Path $site 'apple-touch-icon.png') 180 180 '?s=180&bleed=1'

  # favicon.ico with 16, 32 and 48 px PNG entries (PNG-in-ICO, supported by all current browsers)
  # (headless Chrome cannot open windows this small, so downscale one 256 px render)
  Add-Type -AssemblyName System.Drawing
  $big = Join-Path $env:TEMP 'gfilho-ico-256.png'
  Render 'icon.html' $big 256 256 '?s=256'
  $src = [System.Drawing.Image]::FromFile($big)
  $sizes = 16, 32, 48
  $pngs = foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.SmoothingMode = 'HighQuality'
    $g.DrawImage($src, 0, 0, $s, $s)
    $m = New-Object IO.MemoryStream
    $bmp.Save($m, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    , $m.ToArray()
  }
  $src.Dispose()
  $ms = New-Object IO.MemoryStream
  $bw = New-Object IO.BinaryWriter $ms
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $len = $pngs[$i].Length
    $bw.Write([byte]$s); $bw.Write([byte]$s); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$len); $bw.Write([UInt32]$offset)
    $offset += $len
  }
  foreach ($b in $pngs) { $bw.Write($b) }
  $bw.Flush()
  [IO.File]::WriteAllBytes((Join-Path $site 'favicon.ico'), $ms.ToArray())
  Write-Host ("site\favicon.ico {0,8} bytes" -f (Get-Item (Join-Path $site 'favicon.ico')).Length)
} finally {
  Pop-Location
  Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
}
