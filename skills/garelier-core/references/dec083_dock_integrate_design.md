# DEC-083 — dock-lane comfort: deterministic mechanical tail (dock_integrate.ts) + one-shot status (dock_status.ts)

Status: **design確定 (workflow `wf_67481ac4-b25`、understand3 + design + adversarial-verify3、2026-06-24)。verify が当初案の correctness hole を捕捉、下記 refinement を fold 済。実装 risk-first。**

## 目的 — friction 1/3/4 の根治

jig dock-lane tick は DISPATCH → GATE → INTEGRATE → RECORD を `pipeline()` の各 stage = `agent()` で回す。Workflow DSL が bash を直接実行できないため、**判断ゼロの機械処理 (INTEGRATE merge-await / RECORD / CLEANUP) まで LLM agent 経由**になり、merge-await agent が StructuredOutput を落として item を drop する failure (friction 1、DEC-082 fix-5 で mitigate) が出る。state は複数 file に散在 (friction 3)。1 land に手数が多い (friction 4)。

→ **機械処理を決定論的 TS に出す**。ただし verify が示した通り「完全外出し」は不可 (下記)。

## ★ verify が捕捉した correctness hole (当初案の致命傷)

INTEGRATE を workflow から**完全に**外し dock_integrate.ts を workflow-return 後に走らせると、journal は workflow を COMPLETE 記録 → orchestrator が dock_integrate 完了前に crash すると **GATED item が再駆動されず無 merge 放置**。idempotency-on-re-run ≠ guaranteed-re-run。MERGE_UNTRACKED より悪い (どの bucket にも出ず消失)。

## 確定アーキテクチャ (refinement fold 済)

### 1. dock_integrate.ts (`driver/src/dispatch/dock_integrate.ts`、bun、ZERO agent)
INTEGRATE + RECORD + CLEANUP を決定論的に実行する非 LLM tail。
- **CLI**: `bun dock_integrate.ts run --pm-id <id> [--project <root>] --items <items.json> [--out <result.json>] [--poll-ms] [--ceiling-ms] [--no-cleanup]`。
- **merge_request は `--no-poll` で呼ぶ** (default path は `exec dock_merge poll` ゆえ stdout が poll JSON になり request_id が取れない)。request_id 取得後、`pollMergeGate` を**in-process import** して await loop を回す (別 `bun dock_merge await` subprocess を spawn しない = その crash で partial 窓が再発するため)。
- **per-item 直列** (single active.lock single-poller invariant 厳守、Promise.all 禁止)。
- **idempotency key = `workbench_branch` (verbatim、merge_request.sh L90)**。lossy な SAFE_TASK task_id は使わない (40 char 切詰で別 slug が衝突 cross-adopt する)。requests/ + archive/ + results/ を branch で走査し、in-flight 既存があれば adopt (二重 merge 防止)。
- **aborted/MERGE_FAILED 前に already-merged re-detect**: merge subprocess が studio commit 後 result 書込前に死ぬと pollMergeGate が synthetic `aborted` → 再 merge 危険。再 merge/rework 前に **branch tip が studio の ancestor か (or result.studio_commit 非 null)** を確認し、既 merge なら INTEGRATED 扱い。
- **status map**: success→INTEGRATED+cleanup、failed/conflict/aborted→mergeFailed(no cleanup、warm worktree 温存)、timeout/missing→ENQUEUED(in-flight、no cleanup、no failure)。
- **RECORD**: `dispatch_event.sh --kind` (INTEGRATED/ENQUEUED→complete、mergeFailed/INTEGRATE_ERROR→rework、else note) + 非 complete かつ dispatchId 有なら `_dispatch<id>/questions.md` を RECORD agent と**byte 同形** (DEC-067) で writeFileSync。
- **CLEANUP**: success のみ + `--force` 禁止 (premature guard = MERGE_HEAD==tip or active.lock が slug 参照 が唯一の mid-merge 保護)。**dispatchId==null (gate_held) は cleanup no-op (error でなく)**、branch 削除は `git branch -D` 別経路。`cleanup_status:deferred` (Windows handle lock) は success-with-defer 扱い。`no worktree` は already-cleaned 扱い。
- **out (stdout 1-line JSON + `--out` file)**: `{integrated[], enqueued[], mergeFailed[], integrateError[], warnings[]}`。mergeFailed は workflow が needsRework へ remap (hasWarmProducer=true は warm rework loop 再入、false=gate_held は PM escalate)。**warm-resume は TS でやらない** (LLM producer 要)。機械/判断境界 = MERGE_FAILED。
- **test** (dock_merge.test.ts 同形、injected pollMergeGate/spawnFn): success→INTEGRATED+cleanup / failed→mergeFailed+no-cleanup / timeout→enqueued / missing-guardian→integrateError / **re-run-on-terminal→adopt (二重 merge なし)** / **SAFE_TASK 衝突 2 item が cross-adopt しない** / **partial-success 3 item re-run** / questions.md byte parity (golden)。

### 2. thin journaled agent (★ guaranteed-re-run を守る要)
INTEGRATE を workflow から完全に外さず、**「`bun dock_integrate.ts run --items <file> --out <result>` を実行し result を返すだけ」の 1 agent** を pipeline 末尾に残す。
- journal anchor = crash 後 auto re-run (今と同じ保証)。dock_integrate は idempotent ゆえ re-run 安全 (adopt + already-merged re-detect + additive event + premature-guard cleanup)。
- agent が StructuredOutput を落としても **try/catch で `--out` result file を読み直す** = 損失ゼロ (dock_integrate は同期実行済で work は durable)。→ **friction 1 の失敗 class が消滅** (drop しても work 完了 + 結果回収可)。
- RECORD/CLEANUP は dock_integrate 内。GATE の warm rework loop (DEC-082 fix-2) は GATE stage に**残す** (LLM producer resume が要)。

### 3. dock_status.ts (`driver/src/dispatch/dock_status.ts`、bun)
既存 `buildSnapshot(projectRoot, pmId, config, opts)` (`driver/src/status_snapshot.ts`) の**薄い projection wrapper**。file scraping を再実装しない。
- **CLI**: `bun dock_status.ts --pm-id <id> [--project <root>] [--format json|text] [--all-pms]`。**default json** (agent 一発判断)、`--format text` は旧 status helper の `--- PM: ---` 体裁 parity。
- driver-liveness: dispatch-only (DEC-066) では driver pid 無 → `lane.state` が liveness。`driver:{mode:"dispatch", lane, active:lane!=="idle", note}` を derive。
- JSON shape: `{ok, pmId, project, generatedAt, driver, lane, branches, gate, inFlight[], parked[], backlog{pending,inFlight,done,nextId,planOpen,planHighCritical,oldestOpen,oldestAgeDays}, pmAction, dispatchHold, recentEvents[], statusWebUrl, warnings[]}`。
- **broken/missing config → `ok:false` + warning + exit 0** (status read が caller を殺さない)。
- test: status_snapshot.test.ts fixture 再利用、json contract key + text `--- PM:` + broken config→ok:false exit 0。

### 4. jig split
- **jig_tick.workflow.js**: INTEGRATE agent (293-337、fix-5 try/catch 含む) + RECORD agent (344-376) を **thin journaled dock_integrate agent 1 つ**に置換。pipeline は dispatch+gate+integrate(thin) の 3 stage。GATE の warm rework loop は不変。GATED item から items.json を組み (writeFileSync)、thin agent が dock_integrate 実行 → result を buckets に fold。非 GATED bucket (needsRework/agentDied/blockedOrParked/overCap/smith) は今と同一。
- **jig_gate_held.workflow.js**: 同形 shrink、全 item `hasWarmProducer:false` (held branch は producer 無)。
- **Smith window**: merge step も items.json 経由 (`role:smith, hasWarmProducer:false`)。Smith 判断は workflow に残す。

### 5. status helper retire → dock_status.ts
**(A) status shell snapshot CLI** を retire。**(B) status_web (start/stop/status_web + status_server.ts)=live HTTP server は UNCHANGED** (既に buildSnapshot 使用、status text を parse しない = 安全)。doctor.sh も安全 (status 参照は comment のみ、exec/source 無)。
- redirect: `bin/garelier` → `exec bun .../dock_status.ts --format text`。help text 更新。session digest の hint string → `garelier status`。docs (web_console*, operational_scenario_validation, mode_e_jig) の status helper 言及 → `garelier status`。
- **target-project CLAUDE.md / AGENTS.md は downstream file ゆえ framework から編集しない** — dock skill / setup_wizard の seed を `garelier status` へ更新、既存は各 PM が migrate (DEC-083 record + librarian runbook に明記)。
- deletion order: dock_status.ts land+test → dispatcher redirect → hint/comment/docs → **deprecation shim** → shim hit 0 確認後に shell file 削除 (ci.sh は status_web のみ参照ゆえ CI 影響なし、grep gate で確認)。

## implementation order (risk-first)
1. **dock_integrate.ts + test** (merge tail = 最高 risk、単独で証明)。in-process pollMergeGate、--no-poll capture、status map、dispatch_event+questions.md、success-only no-force cleanup。
2. **idempotency guard + crash-rerun test** (adopt by workbench_branch、already-merged re-detect、no-worktree=cleaned、deferred=success)。friction-1-moved risk を閉じる。
3. **jig_tick shrink** (INTEGRATE+RECORD→thin dock_integrate agent + items.json emit + try/catch result-file 読直し)。jig_render + 単一 GATED item dry-run。
4. **jig_gate_held shrink** (hasWarmProducer:false)。
5. **Smith window** を items.json emit に。
6. **dock_status.ts + test** (buildSnapshot wrapper、json default + text parity)。
7. **functional redirect** (`bin/garelier`)、Git Bash verify。
8. **非 functional redirect** (session_digest hint、doctor comment、docs) + deprecation shim。
9. **mode_e_jig.md + dock SKILL.md + CHANGELOG (DEC-083)** 更新。
10. shim hit 0 後に status shell helper 削除 (grep gate)。

## edge cases (verify 抽出、test 必須)
- crash-and-rerun: terminal result 既存→adopt、二重 merge なし。
- single-poller: 直列必須、dock_integrate と dock_merge poll 同時実行禁止。
- timeout(ceiling)=in-flight、cleanup 禁止 (遅い成功 compile を failed 誤判定しない)。
- merge_request --guardian 無は INTEGRATE_ERROR (swallow/loop 禁止)。
- questions.md + events/in_flight regen 両方再現 (Status Web/operator-comfort 退行禁止)。
- dispatch_cleanup に --force 渡さない、deferred=success、no-worktree=cleaned。
- 3 half-state (requested/not-merged、merged/not-recorded、recorded/not-cleaned) 全てで idempotent 必須 — でなければ friction-1 は消滅でなく移動。
