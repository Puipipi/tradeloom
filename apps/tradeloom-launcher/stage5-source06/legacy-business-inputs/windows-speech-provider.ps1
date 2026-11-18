$ErrorActionPreference = 'Stop'
$stage = 'assembly'
$synth = $null
$reader = $null
try {
  $reader = [System.IO.StreamReader]::new(
    [Console]::OpenStandardInput(),
    [System.Text.UTF8Encoding]::new($false),
    $true
  )
  $requestJson = $reader.ReadToEnd()
  $request = ConvertFrom-Json -InputObject $requestJson -ErrorAction Stop
  if ($null -eq $request -or $request.text -isnot [string] -or $request.outputPath -isnot [string]) {
    [Console]::Out.WriteLine('{"ok":false,"code":"session_speech_invalid_arguments"}')
    exit 2
  }
  $hasVoice = $request.PSObject.Properties.Name -contains 'voice'
  if ($hasVoice -and ($request.voice -isnot [string] -or [string]::IsNullOrWhiteSpace($request.voice))) {
    [Console]::Out.WriteLine('{"ok":false,"code":"session_speech_invalid_arguments"}')
    exit 2
  }

  Add-Type -AssemblyName System.Speech -ErrorAction Stop
  $synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
  $stage = 'voice'
  if ($hasVoice) { $synth.SelectVoice($request.voice) }
  $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
  )
  $stage = 'synthesis'
  $synth.SetOutputToWaveFile($request.outputPath, $format)
  $synth.Speak($request.text)
  $synth.SetOutputToNull()
  [Console]::Out.WriteLine('{"ok":true}')
  exit 0
} catch {
  $code = switch ($stage) {
    'assembly' { 'session_speech_provider_unavailable' }
    'voice' { 'session_speech_voice_unavailable' }
    default { 'session_speech_synthesis_failed' }
  }
  [Console]::Out.WriteLine('{"ok":false,"code":"' + $code + '"}')
  exit 1
} finally {
  if ($null -ne $reader) { $reader.Dispose() }
  if ($null -ne $synth) { $synth.Dispose() }
}
