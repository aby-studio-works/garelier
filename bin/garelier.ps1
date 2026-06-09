#!/usr/bin/env pwsh
#
# garelier.ps1 — self-locating dispatcher for bundled Garelier scripts (PowerShell
# parity with bin/garelier). Maps a subcommand to the bundled `.ps1` (or `.ts`)
# script and invokes it with the remaining args untouched.
#
# WHY: see bin/garelier. A plugin adds this `bin/` to PATH so `garelier <sub>`
# resolves from any cwd; relative `../garelier-<skill>/...` paths only resolve when
# READING a doc, not when a tool RUNS a script (cwd = the user's project).
#
# DEV (symlink) install: add `<checkout>\bin` to your PATH (plugin installs do this
# automatically):  $env:PATH = "<checkout>\bin;$env:PATH"

$ErrorActionPreference = 'Stop'

# self-locate the plugin/checkout root (this file is <root>\bin\garelier.ps1)
$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$skills = Join-Path $root 'skills'

function Show-Help {
    @'
garelier <subcommand> [args...] — run a bundled Garelier script from any cwd.

Setup / scaffolding:
  setup                 PM setup wizard
  control-init          init a control project
  control-split         split a control project
  control-consolidate   consolidate controls
  library-init          init a knowledge library
  install-hooks         install git hooks
  install-concierge-guards  install push guards

Run / operate:
  driver                start the driver
  stop-driver           stop the driver
  status                pipeline status
  status-web            start the status web
  stop-status           stop the status web
  doctor                health checks
  merge-gate            run the merge gate
  session-digest        emit a session digest
  scheduler-adapter     scheduled-jobs adapter
  request-intake        request intake handler

Import / export:
  control-export / control-import      control state
  knowledge-export / knowledge-import  knowledge

Graphs (bun):
  control-graph         control graph
  knowledge-graph       knowledge graph

Escape hatch:
  exec <relpath> [args] run any script by its path relative to the plugin root
  help                  show this help

All args after the subcommand are passed through unchanged.
'@ | Write-Output
}

if ($args.Count -eq 0) { Show-Help; exit 0 }

$sub  = $args[0]
$rest = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() })

function Invoke-Ps([string]$rel) { & (Join-Path $skills $rel) @rest; exit $LASTEXITCODE }
function Invoke-Bun([string]$rel) { & bun (Join-Path $skills $rel) @rest; exit $LASTEXITCODE }

switch ($sub) {
    # setup / scaffolding
    'setup'                    { Invoke-Ps 'garelier-pm/scripts/setup_wizard.ps1' }
    'control-init'             { Invoke-Ps 'garelier-control-project/scripts/init_control.ps1' }
    'control-split'            { Invoke-Ps 'garelier-control-project/scripts/split_control.ps1' }
    'control-consolidate'      { Invoke-Ps 'garelier-control-project/scripts/consolidate_controls.ps1' }
    'library-init'             { Invoke-Ps 'garelier-control-library/scripts/init_library.ps1' }
    'install-hooks'            { Invoke-Ps 'garelier-core/scripts/install_hooks.ps1' }
    'install-concierge-guards' { Invoke-Ps 'garelier-core/scripts/install_concierge_guards.ps1' }

    # run / operate
    'driver'                   { Invoke-Ps 'garelier-core/scripts/start_driver.ps1' }
    'start-driver'             { Invoke-Ps 'garelier-core/scripts/start_driver.ps1' }
    'stop-driver'              { Invoke-Ps 'garelier-core/scripts/stop_driver.ps1' }
    'status'                   { Invoke-Ps 'garelier-core/scripts/status.ps1' }
    'status-web'               { Invoke-Ps 'garelier-core/scripts/start_status.ps1' }
    'start-status'             { Invoke-Ps 'garelier-core/scripts/start_status.ps1' }
    'stop-status'              { Invoke-Ps 'garelier-core/scripts/stop_status.ps1' }
    'doctor'                   { Invoke-Ps 'garelier-core/scripts/doctor.ps1' }
    'merge-gate'               { Invoke-Ps 'garelier-core/scripts/merge-gate.ps1' }
    'session-digest'           { Invoke-Ps 'garelier-core/scripts/session_digest.ps1' }
    'scheduler-adapter'        { Invoke-Ps 'garelier-core/scripts/scheduler_adapter.ps1' }
    'request-intake'           { Invoke-Ps 'garelier-core/scripts/request_intake_handler.ps1' }

    # import / export
    'control-export'           { Invoke-Ps 'garelier-pm/scripts/control_export.ps1' }
    'control-import'           { Invoke-Ps 'garelier-pm/scripts/control_import.ps1' }
    'knowledge-export'         { Invoke-Ps 'garelier-librarian/scripts/knowledge_export.ps1' }
    'knowledge-import'         { Invoke-Ps 'garelier-librarian/scripts/knowledge_import.ps1' }

    # graphs (bun)
    'control-graph'            { Invoke-Bun 'garelier-core/scripts/control_graph.ts' }
    'knowledge-graph'          { Invoke-Bun 'garelier-core/scripts/knowledge_graph.ts' }

    # escape hatch + help
    'exec' {
        if ($rest.Count -lt 1) { Write-Error 'usage: garelier exec <relpath> [args]'; exit 2 }
        $rel  = $rest[0]
        $rest2 = @(if ($rest.Count -gt 1) { $rest[1..($rest.Count - 1)] } else { @() })
        if ($rel -like '*.ts') { & bun (Join-Path $root $rel) @rest2 }
        else                   { & (Join-Path $root $rel) @rest2 }
        exit $LASTEXITCODE
    }
    { $_ -in @('help', '-h', '--help') } { Show-Help; exit 0 }
    default {
        Write-Error "garelier: unknown subcommand '$sub'"
        Show-Help
        exit 2
    }
}
