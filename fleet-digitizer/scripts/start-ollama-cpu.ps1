# Restart Ollama in CPU-only mode (workaround for CUDA crashes on this laptop).
$ErrorActionPreference = 'Stop'
$ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if (-not (Test-Path $ollama)) {
  Write-Error "Ollama not found at $ollama — install from https://ollama.com/download"
}

Get-Process ollama*, 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$env:OLLAMA_NUM_GPU = '0'
$env:CUDA_VISIBLE_DEVICES = ''
# Persist for future sessions of this Windows user
[System.Environment]::SetEnvironmentVariable('OLLAMA_NUM_GPU', '0', 'User')

Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
  $tags = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5
  Write-Host "Ollama OK — models: $(($tags.models | ForEach-Object { $_.name }) -join ', ')"
} catch {
  Write-Error "Ollama did not respond on :11434 — $($_.Exception.Message)"
}
