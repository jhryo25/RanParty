param(
    [string]$Dotnet = $env:RANPARTY_DOTNET
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($env:TEMP -match '~' -and -not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $longTemp = Join-Path $env:USERPROFILE 'AppData\Local\Temp'
    if (Test-Path -LiteralPath $longTemp) { $env:TEMP = $longTemp; $env:TMP = $longTemp }
}
if ([string]::IsNullOrWhiteSpace($Dotnet)) {
    $bundled = Join-Path $root '.dotnet-sdk\dotnet.exe'
    $Dotnet = if (Test-Path -LiteralPath $bundled) { $bundled } else { 'dotnet' }
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $root) {
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$FilePath exited with code $LASTEXITCODE" }
    }
    finally { Pop-Location }
}

Invoke-Checked $Dotnet @('build', 'backend\RanParty.Backend.csproj', '--no-restore')
Invoke-Checked $Dotnet @('run', '--project', 'tests\CoreRuntimeSmoke\CoreRuntimeSmoke.csproj', '--no-restore')
Invoke-Checked $Dotnet @('run', '--project', 'tests\SkillRegistrySmoke\SkillRegistrySmoke.csproj', '--no-restore')
Invoke-Checked 'npm.cmd' @('test') (Join-Path $root 'electron')
Invoke-Checked 'npm.cmd' @('run', 'build') (Join-Path $root 'electron')

$smokes = @(
    'chat-idempotency-smoke.mjs',
    'context-auto-compaction-smoke.mjs',
    'context-compaction-smoke.mjs',
    'context-recompaction-smoke.mjs',
    'knowledge-growth-smoke.mjs',
    'profile-preview-persistence-smoke.mjs',
    'provider-model-list-smoke.mjs',
    'provider-protocol-smoke.mjs',
    'session-delete-race-smoke.mjs',
    'skill-capability-smoke.mjs',
    'skill-implicit-capability-smoke.mjs',
    'skill-marketplace-smoke.mjs',
    'subagent-approval-smoke.mjs',
    'subagent-delegation-smoke.mjs',
    'tool-output-approval-smoke.mjs',
    'tool-loop-guard-smoke.mjs',
    'tooling-model-switch-smoke.mjs',
    'vision-routing-smoke.mjs'
)

foreach ($smoke in $smokes) {
    Invoke-Checked 'node' @((Join-Path $PSScriptRoot $smoke))
}

Write-Host "Offline verification passed: backend + 2 core smokes + UI + $($smokes.Count) protocol smokes."
