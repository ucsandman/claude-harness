[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Text,

    [string]$Voice,

    [ValidateRange(-10, 10)]
    [int]$Rate = 0,

    [switch]$List
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

    if ($List) {
        $synth.GetInstalledVoices() | ForEach-Object { Write-Output $_.VoiceInfo.Name }
        $synth.Dispose()
        exit 0
    }

    $trimmed = if ($Text) { $Text.Trim() } else { '' }
    if ([string]::IsNullOrEmpty($trimmed)) {
        Write-Error "mouth: text is required (positional argument) and cannot be empty." -ErrorAction Continue
        exit 1
    }
    if ($trimmed.Length -gt 800) {
        Write-Error "mouth: text is $($trimmed.Length) characters; this tool is for short status lines only (max 800 characters)." -ErrorAction Continue
        exit 1
    }

    if ($Voice) {
        $match = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -like "*$Voice*" } | Select-Object -First 1
        if (-not $match) {
            Write-Error "mouth: no installed voice matches '$Voice'. Use -List to see installed voices." -ErrorAction Continue
            exit 1
        }
        $synth.SelectVoice($match.VoiceInfo.Name)
    }

    $synth.Rate = $Rate
    $synth.Speak($trimmed)
    $synth.Dispose()
    exit 0
}
catch {
    Write-Error "mouth: $($_.Exception.Message)"
    exit 1
}
