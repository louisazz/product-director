$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$ProjectDir = $PSScriptRoot
$RuntimeDir = Join-Path $ProjectDir ".lazy-runtime"
$NodeHome = Join-Path $RuntimeDir "node-win"
$DownloadDir = Join-Path $RuntimeDir "download-win"
$LogDir = Join-Path $RuntimeDir "logs"
$LogFile = Join-Path $LogDir "lazy-windows.log"
$NpmCache = Join-Path $RuntimeDir "npm-cache"
$DependencyMarker = Join-Path $RuntimeDir "dependencies.windows.version"
$BuildMarker = Join-Path $RuntimeDir "web-build.windows.version"
$Url = "http://127.0.0.1:7878"
$NodeReleaseLine = 24

function Write-Failure([string]$Message) {
    Write-Host ""
    Write-Host "START FAILED: $Message" -ForegroundColor Red
    Write-Host "Log: $LogFile"
    exit 1
}

function Test-CompatibleNode([string]$NodePath) {
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $false }
    & $NodePath -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)||(a===20&&b>=19)?0:1)" 2>$null
    return $LASTEXITCODE -eq 0
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Test-LazyHealth {
    try {
        $response = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 2
        $expectedWorkspace = [IO.Path]::GetFullPath((Join-Path $ProjectDir "workspace")).TrimEnd('\')
        $actualWorkspace = [IO.Path]::GetFullPath([string]$response.workspace).TrimEnd('\')
        return $response.ok -eq $true -and $actualWorkspace -eq $expectedWorkspace
    } catch {
        return $false
    }
}

function Test-LazyFrontend {
    try {
        $indexResponse = Invoke-WebRequest -UseBasicParsing -Uri "$Url/" -TimeoutSec 2
        $assetMatch = [regex]::Match([string]$indexResponse.Content, '/static/assets/[^" ]+\.(js|css)')
        if (-not $assetMatch.Success) { return $false }
        $assetResponse = Invoke-WebRequest -UseBasicParsing -Uri "$Url$($assetMatch.Value)" -TimeoutSec 2
        return $assetResponse.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Get-ListeningProcess {
    try {
        return Get-NetTCPConnection -LocalPort 7878 -State Listen -ErrorAction Stop |
            Select-Object -First 1
    } catch {
        return $null
    }
}

function Stop-LockingLazyProcesses {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "node_modules"))) { return }
    $moduleRoot = ([IO.Path]::GetFullPath((Join-Path $ProjectDir "node_modules"))).TrimEnd('\') + '\'
    $stopped = @()
    foreach ($process in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
        $usesProjectModule = $false
        try {
            foreach ($module in @($process.Modules)) {
                if ($module.FileName -and ([IO.Path]::GetFullPath($module.FileName)).StartsWith($moduleRoot, [StringComparison]::OrdinalIgnoreCase)) {
                    $usesProjectModule = $true
                    break
                }
            }
        } catch {}
        if (-not $usesProjectModule) { continue }
        try {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            $stopped += $process.Id
        } catch {
            Write-Failure "A previous Lazy process (PID $($process.Id)) is locking project dependencies. Close it and run start-web.bat again."
        }
    }
    if ($stopped.Count -gt 0) {
        Write-Host "Closed previous Lazy process: $($stopped -join ', ')"
        Start-Sleep -Milliseconds 500
    }
}

function Install-LocalNode {
    $architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
        "ARM64" { "arm64" }
        "AMD64" { "x64" }
        default { Write-Failure "Unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE" }
    }
    $baseUrl = "https://nodejs.org/dist/latest-v$NodeReleaseLine.x"
    $manifestPath = Join-Path $DownloadDir "SHASUMS256.txt"
    $stagingDir = Join-Path $RuntimeDir "node-win-staging"

    New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
    Write-Host "First run: downloading a private Node.js $NodeReleaseLine runtime..."
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -OutFile $manifestPath
    $manifestLine = Get-Content -LiteralPath $manifestPath |
        Where-Object { $_ -match "^([0-9a-f]{64})\s+(node-v24\.[0-9.]+-win-$architecture\.zip)$" } |
        Select-Object -First 1
    if (-not $manifestLine) { Write-Failure "No compatible Node.js package was found." }
    $match = [regex]::Match($manifestLine, "^([0-9a-f]{64})\s+(.+)$")
    $expectedHash = $match.Groups[1].Value
    $archiveName = $match.Groups[2].Value
    $archivePath = Join-Path $DownloadDir $archiveName

    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $archivePath
    $actualHash = Get-Sha256 $archivePath
    if ($actualHash -ne $expectedHash) { Write-Failure "The Node.js download failed its SHA-256 check." }

    if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDir -Force
    $extractedDir = Join-Path $stagingDir ([IO.Path]::GetFileNameWithoutExtension($archiveName))
    if (-not (Test-Path -LiteralPath (Join-Path $extractedDir "node.exe"))) {
        Write-Failure "The downloaded Node.js package is incomplete."
    }
    if (Test-Path -LiteralPath $NodeHome) { Remove-Item -LiteralPath $NodeHome -Recurse -Force }
    Move-Item -LiteralPath $extractedDir -Destination $NodeHome
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
}

try {
    New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir, $NpmCache | Out-Null
    Set-Location -LiteralPath $ProjectDir

    Write-Host "============================================================"
    Write-Host "  Lazy - local product partner"
    Write-Host "============================================================"

    if (Test-LazyHealth) {
        if (Test-LazyFrontend) {
            Write-Host "Lazy is already running. Opening it in your browser..."
            Start-Process $Url
            exit 0
        }
        Write-Failure "Lazy is running, but its web assets are incomplete. Run stop-web.bat, then start Lazy again."
    }

    $listener = Get-ListeningProcess
    if ($listener) {
        $processName = try { (Get-Process -Id $listener.OwningProcess -ErrorAction Stop).ProcessName } catch { "unknown" }
        Write-Failure "Port 7878 is used by PID $($listener.OwningProcess) ($processName). Close it or run stop-web.bat if it is an old Lazy process."
    }

    $nodePath = $null
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($systemNode -and (Test-CompatibleNode $systemNode.Source)) {
        $nodePath = $systemNode.Source
    } elseif (Test-CompatibleNode (Join-Path $NodeHome "node.exe")) {
        $nodePath = Join-Path $NodeHome "node.exe"
    } else {
        Install-LocalNode
        $nodePath = Join-Path $NodeHome "node.exe"
    }

    $nodeVersion = (& $nodePath --version).Trim()
    $npmCli = Join-Path (Split-Path -Parent $nodePath) "node_modules\npm\bin\npm-cli.js"
    if (-not (Test-Path -LiteralPath $npmCli)) { Write-Failure "npm was not found beside Node.js $nodeVersion." }

    $lockHash = Get-Sha256 (Join-Path $ProjectDir "package-lock.json")
    $dependencyVersion = "$lockHash|$nodeVersion"
    $installedVersion = if (Test-Path -LiteralPath $DependencyMarker) { (Get-Content -LiteralPath $DependencyMarker -First 1) } else { "" }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir "node_modules")) -or $installedVersion -ne $dependencyVersion) {
        Write-Host "Installing project dependencies (the first run may take a few minutes)..."
        Stop-LockingLazyProcesses
        & $nodePath $npmCli ci --no-audit --no-fund --cache $NpmCache
        if ($LASTEXITCODE -ne 0) { Write-Failure "Project dependency installation failed. If Windows reports EPERM, close any old Lazy window and run this file again." }
        Set-Content -LiteralPath $DependencyMarker -Value $dependencyVersion -Encoding ASCII
    }

    $viteConfig = Join-Path $ProjectDir "vite.config.ts"
    if (-not (Test-Path -LiteralPath $viteConfig -PathType Leaf)) {
        Write-Failure "vite.config.ts is missing, so the web build cannot be verified."
    }

    $needsBuild = -not (Test-Path -LiteralPath $BuildMarker) -or -not (Test-Path -LiteralPath (Join-Path $ProjectDir "src\web\static\index.html"))
    if (-not $needsBuild) {
        $markerTime = (Get-Item -LiteralPath $BuildMarker).LastWriteTimeUtc
        $buildInputs = @(
            Get-ChildItem -LiteralPath (Join-Path $ProjectDir "src\web\client") -File -Recurse
            Get-Item -LiteralPath (Join-Path $ProjectDir "vite.config.ts")
            Get-Item -LiteralPath (Join-Path $ProjectDir "package.json")
            Get-Item -LiteralPath (Join-Path $ProjectDir "package-lock.json")
        )
        $needsBuild = $null -ne ($buildInputs | Where-Object { $_.LastWriteTimeUtc -gt $markerTime } | Select-Object -First 1)
    }
    if ($needsBuild) {
        Write-Host "Building the web interface..."
        & $nodePath $npmCli run build:web
        if ($LASTEXITCODE -ne 0) { Write-Failure "Web interface build failed." }
        Set-Content -LiteralPath $BuildMarker -Value ([DateTime]::UtcNow.ToString("o")) -Encoding ASCII
    }

    $builtIndex = Join-Path $ProjectDir "src\web\static\index.html"
    if (-not (Select-String -LiteralPath $builtIndex -SimpleMatch '/static/assets/' -Quiet)) {
        Write-Failure 'Web asset paths do not match the local server. Make sure vite.config.ts contains base: "/static/".'
    }

    Add-Content -LiteralPath $LogFile -Value "`r`n[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting Lazy with Node $nodeVersion"
    Write-Host "Starting Lazy. The browser will open automatically."
    Write-Host "Keep this window open; press Ctrl+C here to stop."
    Write-Host "Log: $LogFile"
    Write-Host ""

    $browserJob = Start-Job -ArgumentList $Url, (Join-Path $ProjectDir "workspace") -ScriptBlock {
        param($HealthUrl, $ExpectedWorkspace)
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                $response = Invoke-RestMethod -Uri "$HealthUrl/api/health" -TimeoutSec 2
                $actualWorkspace = [IO.Path]::GetFullPath([string]$response.workspace).TrimEnd('\')
                $expectedFullPath = [IO.Path]::GetFullPath($ExpectedWorkspace).TrimEnd('\')
                if ($response.ok -eq $true -and $actualWorkspace -eq $expectedFullPath) {
                    Start-Process $HealthUrl
                    return
                }
            } catch {}
            Start-Sleep -Seconds 1
        }
    }

    & $nodePath (Join-Path $ProjectDir "node_modules\tsx\dist\cli.mjs") (Join-Path $ProjectDir "src\web\server.ts") 2>&1 |
        Tee-Object -FilePath $LogFile -Append
    $serverExit = $LASTEXITCODE
    Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    if ($serverExit -ne 0) { Write-Failure "The server exited with code $serverExit." }
    exit 0
} catch {
    Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $($_.Exception.ToString())" -ErrorAction SilentlyContinue
    Write-Failure $_.Exception.Message
}
