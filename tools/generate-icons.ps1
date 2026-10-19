$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectDirectory = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $projectDirectory 'Zaichat_260911_new.png'
$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)
try {
  foreach ($size in @(16,20,32,48,96,128)) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $scale = [Math]::Min($size / $sourceImage.Width, $size / $sourceImage.Height)
      $width = [int]($sourceImage.Width * $scale)
      $height = [int]($sourceImage.Height * $scale)
      $graphics.DrawImage($sourceImage, [int](($size-$width)/2), [int](($size-$height)/2), $width, $height)
      $bitmap.Save((Join-Path $projectDirectory "addon/content/icons/icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
  }
} finally { $sourceImage.Dispose() }
