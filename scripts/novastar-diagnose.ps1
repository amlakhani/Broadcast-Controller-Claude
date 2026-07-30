<#
.SYNOPSIS
Standalone diagnostic for the NovaStar H Series OpenAPI connection.

Reimplements the exact same request-building logic the app uses
(novastar_protocol.js: buildSignedRequest + buildDeviceDetailBody), so this
isolates "is the request being built/sent wrong" from "is something on the
processor side rejecting valid credentials" — prints the raw outgoing body
and the raw response for inspection.

Tries deviceId 0 and deviceId 1 automatically, since NovaStar's own OpenAPI
docs are inconsistent about which one to use (most examples use 0, one
field description says "Pass 1").

.EXAMPLE
.\novastar-diagnose.ps1 -Address 192.168.1.50 -RequestorId myRequestorId -SecretKey myS3cretKey
#>

# NOTE: the parameter is named RequestorId, not PId — $PID is a read-only
# PowerShell automatic variable (the current process ID), and PowerShell
# variable names are case-insensitive, so a parameter/variable literally
# named $PId silently collides with it. Binding to -PId here would fail to
# assign (a non-terminating error) and every request would go out carrying
# this PowerShell session's own process ID instead of your real pId —
# exactly the bug that produced Open_Id_Illegal_Err the first time around.
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Address,
    [Parameter(Mandatory = $true, Position = 1)][string]$RequestorId,
    [Parameter(Position = 2)][string]$SecretKey = "",
    [Parameter(Position = 3)][int]$Port = 80,
    [Parameter(Position = 4)][int]$DeviceId = -1
)

# sign = Base64(MD5(timeStamp + pId)) — the documented "disable encryption"
# formula. Note: this takes the MD5 digest's HEX STRING and base64-encodes
# that string (not the raw digest bytes) — per the docs' "md5 should be
# processed in hexadecimal format" note.
function Get-NovaStarSign {
    param([string]$TimeStamp, [string]$RequestorIdValue)
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("$TimeStamp$RequestorIdValue")
        $hashBytes = $md5.ComputeHash($bytes)
        $hex = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
        return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($hex))
    } finally {
        $md5.Dispose()
    }
}

function Test-NovaStarDevice {
    param([int]$TargetDeviceId)

    $timeStamp = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $sign = Get-NovaStarSign -TimeStamp $timeStamp -RequestorIdValue $RequestorId

    $payload = [ordered]@{
        body      = [ordered]@{ deviceId = $TargetDeviceId }
        sign      = $sign
        pId       = $RequestorId
        timeStamp = $timeStamp
    }
    $json = $payload | ConvertTo-Json -Depth 5 -Compress
    $url = "http://${Address}:${Port}/open/api/device/readDetail"

    Write-Host ""
    Write-Host "--- deviceId=$TargetDeviceId ---"
    Write-Host "URL:   $url"
    Write-Host "Sent:  $json"

    try {
        $response = Invoke-WebRequest -Uri $url -Method Post -ContentType "application/json" -Body $json -TimeoutSec 8 -UseBasicParsing
        Write-Host "HTTP:  $([int]$response.StatusCode) $($response.StatusDescription)"
        Write-Host "Body:  $($response.Content)"
        try {
            $parsed = $response.Content | ConvertFrom-Json
            Write-Host "Parsed status: $($parsed.status)  msg: $($parsed.msg)"
        } catch {
            Write-Host "(response was not valid JSON)"
        }
    } catch {
        Write-Host "Request failed: $($_.Exception.Message)"
        $webResponse = $_.Exception.Response
        if ($webResponse) {
            try {
                $stream = $webResponse.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $errorBody = $reader.ReadToEnd()
                Write-Host "HTTP:  $([int]$webResponse.StatusCode)"
                Write-Host "Body:  $errorBody"
            } catch {
                Write-Host "(could not read error response body)"
            }
        }
    }
}

if ($DeviceId -ge 0) {
    Test-NovaStarDevice -TargetDeviceId $DeviceId
} else {
    Test-NovaStarDevice -TargetDeviceId 0
    Test-NovaStarDevice -TargetDeviceId 1
}
