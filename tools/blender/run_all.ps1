# run_all.ps1 — Generate all FBX test assets using Blender
# Usage: cd tools\blender && .\run_all.ps1 [path\to\blender.exe]

param(
    [string]$BlenderExe = ""
)

# Resolve Blender executable
if (-not $BlenderExe) {
    $candidates = @(
        "C:\Program Files\Blender Foundation\Blender 5.1\blender.exe",
        "C:\Program Files\Blender Foundation\Blender 5.0\blender.exe",
        "C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
        "C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
        "C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $BlenderExe = $c; break }
    }
}

if (-not $BlenderExe -or -not (Test-Path $BlenderExe)) {
    Write-Error "Blender not found. Pass the path as: .\run_all.ps1 'C:\...\blender.exe'"
    exit 1
}

Write-Host "Using Blender: $BlenderExe"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$scripts = @(
    "gen_anim_euler_jump.py",
    "gen_anim_skin_bend.py",
    "gen_anim_root_motion.py"
)

$ok = 0
$fail = 0
foreach ($script in $scripts) {
    $scriptPath = Join-Path $ScriptDir $script
    Write-Host "`n--- $script ---"
    & $BlenderExe --background --python $scriptPath
    if ($LASTEXITCODE -eq 0) { $ok++ } else { $fail++; Write-Warning "FAILED: $script" }
}

Write-Host "`n=== Done: $ok OK, $fail FAILED ==="
