Add-Type -AssemblyName System.Drawing

$blue = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
$gray = [System.Drawing.Color]::FromArgb(255, 154, 165, 179)

function Get-Points([object[]]$pairs, [float]$u) {
    $list = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
    foreach ($pr in $pairs) {
        $x = [float]($pr[0] * $u)
        $y = [float]($pr[1] * $u)
        $list.Add((New-Object System.Drawing.PointF($x, $y)))
    }
    return ,$list.ToArray()
}

function New-Glyph([string]$name, [int]$px, [System.Drawing.Color]$c) {
    $bmp = New-Object System.Drawing.Bitmap($px, $px)
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $u = $px / 48.0
    $brush = New-Object System.Drawing.SolidBrush($c)

    switch ($name) {
        'home' {
            $roof = Get-Points @(@(4,24), @(24,8), @(44,24)) $u
            $g.FillPolygon($brush, $roof)
            $g.FillRectangle($brush, [float](9*$u), [float](21*$u), [float](30*$u), [float](19*$u))
        }
        'files' {
            $body = Get-Points @(@(6,16), @(17,16), @(22,20), @(42,20), @(42,39), @(6,39)) $u
            $g.FillPolygon($brush, $body)
            $g.FillRectangle($brush, [float](6*$u), [float](16*$u), [float](13*$u), [float](5*$u))
        }
        'team' {
            $g.FillEllipse($brush, [float](10*$u), [float](11*$u), [float](13*$u), [float](13*$u))
            $g.FillEllipse($brush, [float](6*$u),  [float](25*$u), [float](21*$u), [float](16*$u))
            $g.FillEllipse($brush, [float](27*$u), [float](16*$u), [float](10*$u), [float](10*$u))
            $g.FillEllipse($brush, [float](23*$u), [float](26*$u), [float](18*$u), [float](15*$u))
        }
        'chat' {
            $g.FillEllipse($brush, [float](8*$u),  [float](8*$u),  [float](32*$u), [float](25*$u))
            $g.FillEllipse($brush, [float](15*$u), [float](14*$u), [float](3*$u),  [float](3*$u))
            $g.FillEllipse($brush, [float](22*$u), [float](14*$u), [float](3*$u),  [float](3*$u))
            $g.FillEllipse($brush, [float](29*$u), [float](14*$u), [float](3*$u),  [float](3*$u))
        }
        'me' {
            $g.FillEllipse($brush, [float](16*$u), [float](8*$u),  [float](16*$u), [float](16*$u))
            $g.FillEllipse($brush, [float](10*$u), [float](25*$u), [float](28*$u), [float](16*$u))
        }
        default {
            $g.FillEllipse($brush, [float](8*$u), [float](8*$u), [float](32*$u), [float](32*$u))
        }
    }
    $brush.Dispose()
    $g.Dispose()
    return $bmp
}

$base = Join-Path $PSScriptRoot "app\src\main\res"
$sizes = @{ 'drawable-mdpi' = 24; 'drawable-hdpi' = 36; 'drawable-xhdpi' = 48; 'drawable-xxhdpi' = 72; 'drawable-xxxhdpi' = 96 }
$glyphs = @('home','files','team','chat','me')
foreach ($dir in $sizes.Keys) {
    $px = $sizes[$dir]
    $outDir = Join-Path $base $dir
    if (!(Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    foreach ($gname in $glyphs) {
        $on = New-Glyph $gname $px $blue
        $on.Save((Join-Path $outDir ("ic_nav_" + $gname + "_on.png")), [System.Drawing.Imaging.ImageFormat]::Png)
        $on.Dispose()
        $off = New-Glyph $gname $px $gray
        $off.Save((Join-Path $outDir ("ic_nav_" + $gname + "_off.png")), [System.Drawing.Imaging.ImageFormat]::Png)
        $off.Dispose()
    }
    Write-Host ("wrote " + $dir)
}
Write-Host "done"
