$ErrorActionPreference = "Stop"
# Native exit codes are inspected explicitly below; don't let them throw.
$PSNativeCommandUseErrorActionPreference = $false

$ContainerName = "finally"
$ImageName = "finally"
$Port = 8000
$Url = "http://localhost:$Port"
$Health = "/api/health"

Set-Location "$PSScriptRoot\.."

# Build if image doesn't exist or -Build flag passed
$needsBuild = $args -contains "--build"
if (-not $needsBuild) {
    docker image inspect $ImageName 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { $needsBuild = $true }
}

if ($needsBuild) {
    Write-Host "Building image..."
    docker build -t $ImageName .
}

# Stop existing container if running (idempotent)
docker rm -f $ContainerName 2>$null | Out-Null

$script:DockerError = ""

function Start-Container([string[]] $PortArgs) {
    # Native stderr must not become a terminating error here; the caller decides.
    $ErrorActionPreference = "Continue"
    $output = docker run -d --name $ContainerName @PortArgs `
        -v finally-data:/app/db `
        --env-file .env `
        $ImageName 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $script:DockerError += $output
        return $false
    }
    return $true
}

# Publish on both address families so the printed URL resolves either way:
# "localhost" is ::1 first on a dual-stack host and 127.0.0.1 elsewhere.
# A daemon without IPv6 rejects the [::] mapping, so fall back to IPv4 only.
if (-not (Start-Container @("-p", "0.0.0.0:${Port}:8000", "-p", "[::]:${Port}:8000"))) {
    docker rm -f $ContainerName 2>$null | Out-Null
    if (Start-Container @("-p", "0.0.0.0:${Port}:8000")) {
        Write-Host "IPv6 port publishing unavailable; publishing on IPv4 only."
    } else {
        docker rm -f $ContainerName 2>$null | Out-Null
        Write-Host $script:DockerError
        exit 1
    }
}

# Reachability probe: a bind that silently fails must surface as an address
# problem here instead of as a blank page that reads like a dead app.
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    Write-Host "curl.exe not found - skipping reachability probe."
    Write-Host "FinAlly running at $Url"
    Start-Process $Url
    exit 0
}

# Returns curl's exit status: 0 reachable, 6 no address of that family for
# "localhost" (nothing to fix), anything else a real connection failure.
function Probe([string] $Family) {
    $ErrorActionPreference = "Continue"
    curl.exe $Family -fs -m 3 -o NUL "$Url$Health" 2>$null | Out-Null
    return $LASTEXITCODE
}

Write-Host -NoNewline "Waiting for FinAlly at $Url"
$reachable = $false
foreach ($attempt in 1..30) {
    if ((Probe "-4") -eq 0 -or (Probe "-6") -eq 0) {
        $reachable = $true
        break
    }
    $running = docker inspect -f "{{.State.Running}}" $ContainerName 2>$null
    if ($running -ne "true") {
        Write-Host ""
        Write-Host "Container is not running. Recent logs:"
        docker logs --tail 30 $ContainerName
        exit 1
    }
    Write-Host -NoNewline "."
    Start-Sleep -Seconds 1
}
Write-Host ""

if (-not $reachable) {
    Write-Host "FinAlly never answered at $Url. Recent logs:"
    docker logs --tail 30 $ContainerName
    exit 1
}

# Both families must answer, or "localhost" works only by luck of resolution.
foreach ($family in @("-4", "-6")) {
    $status = Probe $family
    # 6 means "localhost" has no address of this family here - nothing to fix.
    if ($status -eq 0 -or $status -eq 6) { continue }
    Write-Host "FinAlly answers on $Url over one address family but not the other"
    Write-Host "  (curl $family failed with exit $status). 'localhost' can resolve to either,"
    Write-Host "  so the app will look dead to some clients. Check the published ports:"
    docker port $ContainerName
    exit 1
}

Write-Host "FinAlly running at $Url"
Start-Process $Url
