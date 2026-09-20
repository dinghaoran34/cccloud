Add-Type -AssemblyName System.Drawing

function New-Icon([int]$size, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $r = [Math]::Round($size * 0.18)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($rect.X, $rect.Y, 2*$r, 2*$r, 180, 90)
    $path.AddArc($rect.X + $size - 2*$r, $rect.Y, 2*$r, 2*$r, 270, 90)
    $path.AddArc($rect.X + $size - 2*$r, $rect.Y + $size - 2*$r, 2*$r, 2*$r, 0, 90)
    $path.AddArc($rect.X, $rect.Y + $size - 2*$r, 2*$r, 2*$r, 90, 90)
    $path.CloseFigure()

    $c1 = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)
    $c2 = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45)
    $g.FillPath($brush, $path)

    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $u = $size / 192.0
    $g.FillEllipse($white, [float](52*$u), [float](58*$u), [float](56*$u), [float](56*$u))
    $g.FillEllipse($white, [float](88*$u), [float](42*$u), [float](64*$u), [float](64*$u))
    $g.FillEllipse($white, [float](126*$u), [float](66*$u), [float](44*$u), [float](44*$u))
    $g.FillRectangle($white, [float](52*$u), [float](92*$u), [float](118*$u), [float](24*$u))

    $g.Dispose()

    $dir = Split-Path $outPath -Parent
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host ("saved " + $outPath)
}

$base = Join-Path $PSScriptRoot "app\src\main\res"
New-Icon 48  ($base + "\mipmap-mdpi\ic_launcher.png")
New-Icon 72  ($base + "\mipmap-hdpi\ic_launcher.png")
New-Icon 96  ($base + "\mipmap-xhdpi\ic_launcher.png")
New-Icon 144 ($base + "\mipmap-xxhdpi\ic_launcher.png")
New-Icon 192 ($base + "\mipmap-xxxhdpi\ic_launcher.png")
