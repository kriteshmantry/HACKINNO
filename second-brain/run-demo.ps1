# Starts the Second Brain demo: FastAPI backend on :8000 and the frontend on :5173.
# Usage (from anywhere):  powershell -ExecutionPolicy Bypass -File second-brain\run-demo.ps1
$root = $PSScriptRoot
$py = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Host "Creating the backend virtualenv..."
    py -m venv (Join-Path $root ".venv")
    & $py -m pip install -q -r (Join-Path $root "requirements.txt")
}
if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) {
    Write-Host "Installing frontend dependencies..."
    npm --prefix (Join-Path $root "frontend") ci
}

Write-Host "Starting the backend on http://localhost:8000 (API docs at /docs)"
$backend = Start-Process -FilePath $py -ArgumentList "-m", "uvicorn", "backend.main:app", "--port", "8000" -WorkingDirectory $root -PassThru -NoNewWindow

try {
    Write-Host "Starting the frontend on http://localhost:5173"
    npm --prefix (Join-Path $root "frontend") run dev
}
finally {
    if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id }
}
