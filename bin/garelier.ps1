#!/usr/bin/env pwsh
#
# garelier.ps1 — self-locating dispatcher for bundled Garelier scripts (PowerShell
# parity with bin/garelier). Maps a subcommand to the bundled `.ps1` (or `.ts`)
# script and invokes it with the remaining args. GNU-style long options
# (`--target-root`) are normalized for bundled PowerShell scripts
# (`-TargetRoot`) so docs can use the same option spelling across shells.
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
  crust-init            init Plant-Crust layout
  control-init          init a control project
  control-split         split a control project
  control-consolidate   consolidate controls
  library-init          init a knowledge library
  install-hooks         install git hooks
  install-concierge-guards  install push guards

Run / operate (dispatch-only, DEC-061/066):
  status                pipeline status
  status-web            start the status web
  stop-status           stop the status web
  doctor                health checks
  dispatch-prepare      cut a producer worktree
  dispatch-cleanup      remove a producer worktree
  dispatch-event        record event + regen view
  merge-request         one-command merge request
  merge-gate            run the merge gate
  retro-digest          lessons-learned digest
  session-digest        emit a session digest
  scheduler-adapter     scheduled-jobs adapter
  request-intake        request intake handler
  plant-resolve         show Plant mode/roots
  plant-validate        validate Plant resolution
  plant-containers      list Crust containers
  plant-workfolder-validate validate Crust registry
  plant-add-container   add a Crust container
  plant-write-lock      write a Crust lock
  plant-lock-validate   validate container lock
  plant-crust-validate  validate crust.toml
  lens-validate         validate Lens registry
  lens-defaults         show default Lens set
  lens-parse-blueprint  parse blueprint Lens refs

Import / export:
  control-export / control-import      control state
  knowledge-export / knowledge-import  knowledge

Graphs (bun):
  control-graph         control graph
  knowledge-graph       knowledge graph

Escape hatch:
  exec <relpath> [args] run any script by its path relative to the plugin root
  help                  show this help

PowerShell script subcommands accept both PowerShell-style `-TargetRoot` and
GNU-style `--target-root` long options.
'@ | Write-Output
}

if ($args.Count -eq 0) { Show-Help; exit 0 }

$sub  = $args[0]
$rest = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() })

function Convert-GnuLongOptions([object[]]$items) {
    $converted = @()
    foreach ($item in $items) {
        if ($item -is [string] -and $item -match '^--([A-Za-z0-9][A-Za-z0-9-]*)(=(.*))?$') {
            $name = ($matches[1] -split '-' | ForEach-Object {
                if ($_.Length -eq 0) { '' } else { $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1) }
            }) -join ''
            $converted += "-$name"
            if ($matches[2]) { $converted += $matches[3] }
        } else {
            $converted += $item
        }
    }
    return $converted
}

function Invoke-Ps([string]$rel) {
    $scriptPath = Join-Path $skills $rel
    $psArgs = @(Convert-GnuLongOptions $rest)
    $named = @{}
    $positionals = @()
    for ($i = 0; $i -lt $psArgs.Count; $i++) {
        $arg = [string]$psArgs[$i]
        if ($arg -match '^-[A-Za-z][A-Za-z0-9]*$') {
            $name = $arg.Substring(1)
            if (($i + 1) -lt $psArgs.Count -and -not ([string]$psArgs[$i + 1] -match '^-[A-Za-z][A-Za-z0-9]*$')) {
                $named[$name] = $psArgs[$i + 1]
                $i++
            } else {
                $named[$name] = $true
            }
        } else {
            $positionals += $psArgs[$i]
        }
    }
    if ($named.Count -gt 0) {
        & $scriptPath @named @positionals
    } else {
        & $scriptPath @positionals
    }
    exit $LASTEXITCODE
}
function Invoke-Bun([string]$rel) { & bun (Join-Path $skills $rel) @rest; exit $LASTEXITCODE }

switch ($sub) {
    # setup / scaffolding
    'setup'                    { Invoke-Ps 'garelier-pm/scripts/setup_wizard.ps1' }
    'crust-init'               { Invoke-Ps 'garelier-pm/scripts/crust_init.ps1' }
    'control-init'             { Invoke-Ps 'garelier-control-project/scripts/init_control.ps1' }
    'control-split'            { Invoke-Ps 'garelier-control-project/scripts/split_control.ps1' }
    'control-consolidate'      { Invoke-Ps 'garelier-control-project/scripts/consolidate_controls.ps1' }
    'library-init'             { Invoke-Ps 'garelier-control-library/scripts/init_library.ps1' }
    'install-hooks'            { Invoke-Ps 'garelier-core/scripts/install_hooks.ps1' }
    'install-concierge-guards' { Invoke-Ps 'garelier-core/scripts/install_concierge_guards.ps1' }

    # run / operate (dispatch-only; the driver/stop-driver routes were removed
    # with the headless driver, DEC-066)
    'dispatch-prepare'         { Invoke-Ps 'garelier-core/scripts/dispatch_prepare.ps1' }
    'dispatch-cleanup'         { Invoke-Ps 'garelier-core/scripts/dispatch_cleanup.ps1' }
    'dispatch-event'           { Invoke-Ps 'garelier-core/scripts/dispatch_event.ps1' }
    'merge-request'            { Invoke-Ps 'garelier-core/scripts/merge_request.ps1' }
    'status'                   { & bun (Join-Path $skills 'garelier-core/driver/src/dispatch/dock_status.ts') @rest --format text; exit $LASTEXITCODE }
    'status-web'               { Invoke-Ps 'garelier-core/scripts/start_status.ps1' }
    'start-status'             { Invoke-Ps 'garelier-core/scripts/start_status.ps1' }
    'stop-status'              { Invoke-Ps 'garelier-core/scripts/stop_status.ps1' }
    'doctor'                   { Invoke-Ps 'garelier-core/scripts/doctor.ps1' }
    'merge-gate'               { Invoke-Ps 'garelier-core/scripts/merge-gate.ps1' }
    'retro-digest'             { Invoke-Bun 'garelier-core/scripts/retro_digest.ts' }
    'session-digest'           { Invoke-Ps 'garelier-core/scripts/session_digest.ps1' }
    'scheduler-adapter'        { Invoke-Ps 'garelier-core/scripts/scheduler_adapter.ps1' }
    'request-intake'           { Invoke-Ps 'garelier-core/scripts/request_intake_handler.ps1' }
    'plant-resolve'            { & bun (Join-Path $skills 'garelier-core/driver/src/plant.ts') resolve @rest; exit $LASTEXITCODE }
    'plant-validate'           { & bun (Join-Path $skills 'garelier-core/driver/src/plant.ts') resolve @rest; exit $LASTEXITCODE }
    'plant-containers'         { & bun (Join-Path $skills 'garelier-core/driver/src/plant.ts') list-containers @rest; exit $LASTEXITCODE }
    'plant-workfolder-validate' { & bun (Join-Path $skills 'garelier-core/driver/src/plant.ts') validate-workfolder @rest; exit $LASTEXITCODE }
    'plant-add-container'      { & bun (Join-Path $skills 'garelier-core/driver/src/plant.ts') add-container @rest; exit $LASTEXITCODE }
    'plant-write-lock'         { & bun (Join-Path $skills 'garelier-core/driver/src/plant.ts') write-lock @rest; exit $LASTEXITCODE }
    'plant-lock-validate'      { & bun (Join-Path $skills 'garelier-core/driver/src/plant.ts') validate-lock @rest; exit $LASTEXITCODE }
    'plant-crust-validate'     { & bun (Join-Path $skills 'garelier-core/driver/src/plant.ts') validate-crust @rest; exit $LASTEXITCODE }
    'lens-validate'            { & bun (Join-Path $skills 'garelier-core/driver/src/lenses.ts') validate-registry @rest; exit $LASTEXITCODE }
    'lens-defaults'            { & bun (Join-Path $skills 'garelier-core/driver/src/lenses.ts') defaults @rest; exit $LASTEXITCODE }
    'lens-parse-blueprint'     { & bun (Join-Path $skills 'garelier-core/driver/src/lenses.ts') parse-blueprint @rest; exit $LASTEXITCODE }

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
