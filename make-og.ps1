# Dev-only: generates og-image.png (1200x630) for social share cards.
Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap(1200, 630)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Background
$g.Clear([System.Drawing.ColorTranslator]::FromHtml('#060609'))

# Purple glow, top center
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddEllipse(100, -380, 1000, 760)
$pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
$pgb.CenterColor = [System.Drawing.Color]::FromArgb(80, 124, 92, 252)
$pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 6, 6, 9))
$g.FillEllipse($pgb, 100, -380, 1000, 760)

# Second faint glow bottom right
$path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
$path2.AddEllipse(700, 400, 700, 500)
$pgb2 = New-Object System.Drawing.Drawing2D.PathGradientBrush($path2)
$pgb2.CenterColor = [System.Drawing.Color]::FromArgb(36, 192, 132, 252)
$pgb2.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 6, 6, 9))
$g.FillEllipse($pgb2, 700, 400, 700, 500)

$white  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#f2f0ff'))
$purple = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#9d7bff'))
$muted  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#918dac'))
$red    = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#f87171'))
$green  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#4ade80'))

# Small mono-ish site tag, top left
$fontTag = New-Object System.Drawing.Font('Consolas', 17)
$g.DrawString('convertmind.ai', $fontTag, $muted, 92, 78)

# Wordmark
$fontBig = New-Object System.Drawing.Font('Segoe UI', 86, [System.Drawing.FontStyle]::Bold)
$convertSize = $g.MeasureString('Convert', $fontBig)
$g.DrawString('Convert', $fontBig, $white, 80, 180)
$g.DrawString('Mind', $fontBig, $purple, (80 + $convertSize.Width - 28), 180)

# Tagline
$fontTagline = New-Object System.Drawing.Font('Segoe UI', 34, [System.Drawing.FontStyle]::Bold)
$g.DrawString('Your website has a leak. We find it.', $fontTagline, $white, 92, 372)

# Sub line
$fontSub = New-Object System.Drawing.Font('Segoe UI', 22)
$g.DrawString('AI conversion audit - psychology-backed - results in ~30 seconds', $fontSub, $muted, 94, 448)

# Leak motif: dots draining bottom left -> green dot surviving
$g.FillEllipse($red,   94, 530, 14, 14)
$g.FillEllipse($red,  130, 540, 11, 11)
$g.FillEllipse($red,  162, 533, 12, 12)
$g.FillEllipse($red,  196, 542,  9,  9)
$g.FillEllipse($green, 230, 535, 14, 14)

$out = Join-Path (Get-Location) 'og-image.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved: $out"
