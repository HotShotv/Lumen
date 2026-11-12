# Reads "what is playing" from Windows (the same media session the volume flyout
# and media keys use) and prints one JSON object per line when something changes.
# Lumen's main process runs this in the background and reads its output.
#
#   -Once            print the current state once and exit (for testing)
#   -Command <name>  send play | pause | toggle | next | previous to the player and exit
#   -Serve           stay open and run commands typed on standard input, one per line:
#                    play | pause | toggle | next | previous | seek <milliseconds>

param(
  [switch]$Once,
  [switch]$Serve,
  [ValidateSet("", "play", "pause", "toggle", "next", "previous")]
  [string]$Command = "",
  [string]$Prefer = "",
  [int]$IntervalMs = 350
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod(
  "AsStreamForRead", [Type[]]@([Windows.Storage.Streams.IInputStream]))

# WinRT async calls have no PowerShell syntax: turn IAsyncOperation<T> into a Task<T> and wait
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($operation, [Type]$resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $null = $task.Wait(4000)
  if ($task.IsCompleted -and -not $task.IsFaulted) { $task.Result } else { $null }
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$manager = Await ($managerType::RequestAsync()) $managerType
if (-not $manager) { throw "Windows media session manager is unavailable" }

# the preferred app's session when it has one, otherwise whatever Windows calls current
function Get-Session {
  if ($Prefer) {
    foreach ($candidate in $manager.GetSessions()) {
      if ($candidate.SourceAppUserModelId -match $Prefer) { return $candidate }
    }
  }
  $manager.GetCurrentSession()
}

function Send-PlayerCommand([string]$name, [string]$argument) {
  $session = Get-Session
  if (-not $session) { return $false }
  $operation = switch ($name) {
    "play" { $session.TryPlayAsync() }
    "pause" { $session.TryPauseAsync() }
    "toggle" { $session.TryTogglePlayPauseAsync() }
    "next" { $session.TrySkipNextAsync() }
    "previous" { $session.TrySkipPreviousAsync() }
    # positions are in 100-nanosecond ticks
    "seek" { $session.TryChangePlaybackPositionAsync([int64]$argument * 10000) }
    default { $null }
  }
  if (-not $operation) { return $false }
  [bool](Await $operation ([bool]))
}

if ($Command) {
  Write-Output (@{ ok = (Send-PlayerCommand $Command "") } | ConvertTo-Json -Compress)
  exit 0
}

# kept running by Lumen so a click acts at once instead of waiting for PowerShell to start
if ($Serve) {
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    $parts = $line.Trim() -split " +", 2
    if (-not $parts[0]) { continue }
    try { $null = Send-PlayerCommand $parts[0] $parts[1] } catch {}
  }
  exit 0
}

function Read-Thumbnail($reference) {
  if (-not $reference) { return $null }
  try {
    $stream = Await ($reference.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if (-not $stream) { return $null }
    # the stream arrives as a bare COM object; calling through reflection lets .NET
    # convert it to the interface the helper expects
    $reader = $asStreamForRead.Invoke($null, @($stream))
    $memory = New-Object System.IO.MemoryStream
    $reader.CopyTo($memory)
    $reader.Dispose()
    $bytes = $memory.ToArray()
    if ($bytes.Length -lt 16) { return $null }
    $type = if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { "image/png" } else { "image/jpeg" }
    "data:$type;base64," + [Convert]::ToBase64String($bytes)
  } catch { $null }
}

$propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$lastKey = $null
$lastLine = $null

while ($true) {
  $state = @{ type = "state"; active = $false }
  try {
    $session = Get-Session
    if ($session) {
      $properties = Await ($session.TryGetMediaPropertiesAsync()) $propertiesType
      $playback = $session.GetPlaybackInfo()
      $timeline = $session.GetTimelineProperties()
      if ($properties -and $properties.Title) {
        $key = "$($properties.Title)|$($properties.Artist)|$($properties.AlbumTitle)"
        $state = @{
          type       = "state"
          active     = $true
          key        = $key
          app        = $session.SourceAppUserModelId
          title      = $properties.Title
          artist     = $properties.Artist
          album      = $properties.AlbumTitle
          playing    = ($playback.PlaybackStatus.ToString() -eq "Playing")
          positionMs = [int64]$timeline.Position.TotalMilliseconds
          durationMs = [int64]($timeline.EndTime - $timeline.StartTime).TotalMilliseconds
          # when the player last reported that position (unix ms); 0 if it never has
          positionAt = if ($timeline.LastUpdatedTime.Year -gt 2000) { $timeline.LastUpdatedTime.ToUnixTimeMilliseconds() } else { 0 }
        }
        # cover art is big: only read and send it when the track changes
        if ($key -ne $lastKey) {
          $state.cover = Read-Thumbnail $properties.Thumbnail
          # some players publish the title first and the art a moment later
          if ($state.cover) { $lastKey = $key }
        }
      }
    }
  } catch {
    $state = @{ type = "state"; active = $false; error = $_.Exception.Message }
  }

  $line = $state | ConvertTo-Json -Compress
  if ($line -ne $lastLine) {
    Write-Output $line
    $lastLine = $line
  }
  if (-not $state.active) { $lastKey = $null }
  if ($Once) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
