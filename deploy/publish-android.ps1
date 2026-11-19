[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Apk,
    [Parameter(Mandatory)][ValidateCount(1, 4)][string[]]$Notes,
    [string]$BuildTools = '36.0.0'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$web = Join-Path $root 'apps/web'
$catalogPath = Join-Path $web 'cloudflare/android-releases.json'
$file = Get-Item -LiteralPath $Apk
$notes = @($Notes | ForEach-Object {
    $note = $_.Trim()
    if ($note.Length -lt 1 -or $note.Length -gt 180) {
        throw 'Each release note must have 1 to 180 characters.'
    }
    $note
})

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
if (!$sdk) { throw 'Set ANDROID_HOME or ANDROID_SDK_ROOT to the Android SDK.' }
$tools = Join-Path $sdk "build-tools/$BuildTools"
$aapt = Join-Path $tools 'aapt.exe'
$apksigner = Join-Path $tools 'apksigner.bat'
$links = @(Get-Content -LiteralPath (Join-Path $web 'public/.well-known/assetlinks.json') -Raw | ConvertFrom-Json)
$app = ($links | Where-Object { $_.target.package_name -eq 'ke.co.tiktokmwitu.mwitu' } | Select-Object -First 1).target
if (!$app) { throw 'The public Mwitu Android signing fingerprint is missing.' }

$certificates = & $apksigner verify --print-certs $file.FullName
$verified = @($certificates | ForEach-Object {
    if ($_ -match '^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})$') { $Matches[1] }
})
$expected = @($app.sha256_cert_fingerprints | ForEach-Object { $_ -replace ':', '' })
if ($LASTEXITCODE -ne 0 -or $verified.Count -ne 1 -or $expected -notcontains $verified[0]) {
    throw 'The APK must be signed by the published Mwitu release key.'
}
$badging = & $aapt dump badging $file.FullName
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the APK package and version.' }
$package = [regex]::Match(($badging -join "`n"), "(?m)^package: name='([^']+)' versionCode='([0-9]+)' versionName='([0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6})'")
$sdkVersion = [regex]::Match(($badging -join "`n"), "(?m)^sdkVersion:'([0-9]+)'")
if (!$package.Success -or !$sdkVersion.Success -or $package.Groups[1].Value -ne $app.package_name) {
    throw 'This is not a versioned Mwitu Android APK.'
}
$code = [int]$package.Groups[2].Value
$version = $package.Groups[3].Value
$minSdk = [int]$sdkVersion.Groups[1].Value
$name = "tiktok-mwitu-$version.apk"
$origin = 'https://tiktokmwitu.co.ke'
$manifest = "$origin/download/android/latest.json"
$download = "$origin/download/$name"
$checksum = (Get-FileHash -LiteralPath $file.FullName -Algorithm MD5).Hash.ToLowerInvariant()
$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
$live = Invoke-RestMethod -Uri $manifest -TimeoutSec 20
if ($version -eq $live.version -and $code -eq $live.versionCode) {
    $existing = Invoke-WebRequest -Method Head -Uri $download -TimeoutSec 20
    if (([string]$existing.Headers.ETag).Trim('"') -ne $checksum) {
        throw 'This version is already live with a different APK. Bump the version before publishing.'
    }
    Write-Output "Android $version is already live at $download"
    return
}
if ($code -le $live.versionCode -or
    $code -lt $catalog.latest.versionCode -or
    $code -gt 2100000000 -or
    $catalog.previous -contains $version -or
    ($version -eq $catalog.latest.version -and $code -ne $catalog.latest.versionCode)) {
    throw 'Use a new version name and a higher Android build number.'
}
if ($code -eq $catalog.latest.versionCode -and $version -ne $catalog.latest.version) {
    throw 'This Android build number is already assigned to another version.'
}

$wrangler = Join-Path $root 'node_modules/.bin/wrangler.cmd'
Push-Location -LiteralPath $web
try {
    & $wrangler r2 object put "tiktokmwitu-images/releases/$name" --remote --file $file.FullName --content-type 'application/vnd.android.package-archive'
    if ($LASTEXITCODE -ne 0) { throw 'R2 upload failed. The live release could not be advanced.' }

    $previous = @($catalog.latest.version, $live.version) + @($catalog.previous)
    $next = [ordered]@{
        latest = [ordered]@{ version = $version; versionCode = $code; minSdk = $minSdk; notes = $notes }
        previous = @($previous | Where-Object { $_ -ne $version } | Select-Object -Unique)
    }
    $json = ($next | ConvertTo-Json -Depth 4) + "`n"
    [System.IO.File]::WriteAllText($catalogPath, $json)
    & npm.cmd run deploy:cloudflare
    if ($LASTEXITCODE -ne 0) { throw 'Cloudflare deployment failed. The uploaded APK is ready for a retry.' }
} finally {
    Pop-Location
}

$published = Invoke-RestMethod -Uri $manifest -TimeoutSec 20
$response = Invoke-WebRequest -Method Head -Uri "$origin/download/android" -TimeoutSec 20
if ($published.version -ne $version -or $published.versionCode -ne $code -or
    $published.bytes -ne $file.Length -or
    ([string]$response.Headers.ETag).Trim('"') -ne $checksum) {
    throw 'The public release did not match the signed APK.'
}
Write-Output "Published Android $version at $download"
