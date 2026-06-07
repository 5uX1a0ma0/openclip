param(
  [ValidateSet("setup", "build", "test", "verify")]
  [string] $Task = "verify"
)

$ErrorActionPreference = "Stop"

$repo = if ($env:CODEX_WORKTREE_PATH) {
  $env:CODEX_WORKTREE_PATH
} elseif ($env:CODEX_SOURCE_TREE_PATH) {
  $env:CODEX_SOURCE_TREE_PATH
} else {
  Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

$npm = "C:\Users\lpy007\AppData\Local\nvm\v24.15.0\npm.cmd"
if (-not (Test-Path -LiteralPath $npm)) {
  throw "npm was not found at $npm"
}

function Invoke-FrontendInstall {
  Set-Location -LiteralPath (Join-Path $repo "frontend")
  & $npm install --no-audit --no-fund
}

function Invoke-FrontendBuild {
  Set-Location -LiteralPath (Join-Path $repo "frontend")
  & $npm run build
}

function Invoke-BackendTest {
  Set-Location -LiteralPath $repo
  $env:GOCACHE = Join-Path $repo "tmp\go-build"
  New-Item -ItemType Directory -Force -Path $env:GOCACHE | Out-Null
  go test ./...
}

switch ($Task) {
  "setup" {
    Invoke-FrontendInstall
  }
  "build" {
    Invoke-FrontendBuild
  }
  "test" {
    Invoke-BackendTest
  }
  "verify" {
    Invoke-FrontendBuild
    Invoke-BackendTest
  }
}
