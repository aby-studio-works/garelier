# State Machine / 状態機械

> v2.7.0 — the canonical operational specification lives at
> `skills/garelier-core/state_machine.md`; this file is the human-readable
> explanation. Keep both in sync.

本ドキュメントは Worker、Smith、Scout、Librarian、Artisan、Observer、
Guardian、Concierge の状態遷移、およびエスカレーション時の状態を概説します
（正典は `skills/garelier-core/state_machine.md`）。`STATE.md` の `status`
フィールドはこの集合からのみ値を取ります。

すべてのブランチ参照は `<target-slug>` (`<target>` の `/` を `-` に置換した
もの) と `<pm_id>` を含む形式 `garelier/<target-slug>/<pm_id>/...` を使用します。

## Table of Contents

1. [Worker 状態](#worker-states)
2. [Smith 状態](#smith-states)
3. [Scout 状態](#scout-states)
4. [Worker 遷移図](#worker-diagram)
5. [Smith 遷移図](#smith-diagram)
6. [Scout 遷移図](#scout-diagram)
7. [エスカレーション](#escalation-states)
8. [Base 追従と conflict 解消](#base-tracking)

## <a id="worker-states"></a>1. Worker 状態

| State        | 意味                                              |
| ------------ | ------------------------------------------------- |
| `IDLE`       | タスク未割り当て、待機中                              |
| `ASSIGNED`   | `assignment.md` 受領済、未着手                        |
| `WORKING`    | 実装中                                             |
| `REPORTING`  | 完了、`report.md` 作成済、Dock 通知済          |
| `REVIEWING`  | Dock がレビュー中(Worker は介入しない)            |
| `MERGED`     | レビュー通過、studio へマージ完了 (`IDLE` へ戻る)     |
| `REWORK`     | レビューで差し戻し、修正中                            |
| `BLOCKED`    | 仕様不明・依存待ち等で停止、エスカレーション中           |
| `ABORTED`    | タスク打ち切り、worktree リセット予定                 |

## <a id="smith-states"></a>2. Smith 状態

Smith は Worker のマージ後に動く統合硬化ロールです。Dock が
Worker 作業を studio にマージした後、必要に応じて Anvil branch を
作成させ、統合テスト・結合テスト・システムテスト・リリース付属
ツール・プロジェクト仕様書整合・ライセンス/セキュリティ確認を行います。

| State        | 意味                                              |
| ------------ | ------------------------------------------------- |
| `IDLE`       | タスク未割り当て、待機中                              |
| `ASSIGNED`   | `assignment.md` 受領済、未着手                        |
| `WORKING`    | Anvil branch 上で統合硬化中                          |
| `REPORTING`  | 完了、`report.md` 作成済、Dock 通知済          |
| `REVIEWING`  | Dock がレビュー中(Smith は介入しない)            |
| `MERGED`     | レビュー通過、studio へマージ完了 (`IDLE` へ戻る)     |
| `REWORK`     | レビューで差し戻し、同じ Anvil branch で修正中        |
| `BLOCKED`    | 仕様・ライセンス判断・環境不備等で停止中              |
| `ABORTED`    | タスク打ち切り、worktree リセット予定                 |

## <a id="scout-states"></a>3. Scout 状態

| State        | 意味                                              |
| ------------ | ------------------------------------------------- |
| `IDLE`       | 調査依頼なし、待機中                                |
| `ASSIGNED`   | `assignment.md` 受領済                             |
| `WORKING`    | 調査中 (web 検索・読解・統合)                       |
| `REPORTING`  | Scout worktree に inspection draft 作成済、Dock 通知済、PM commit/確認待ち |
| `BLOCKED`    | 不明点・スコープ外で停止、エスカレーション中           |
| `ABORTED`    | 調査打ち切り                                       |

Scout には Worker のような `REVIEWING` / `MERGED` / `REWORK` がありません。
Inspection draft の修正が必要な場合は新規調査として再依頼します。
Scout は commit せず、受理された inspection は PM が primary checkout 側で
取り込み、commit または既存 commit 確認を行ってから完了扱いになります。

## <a id="worker-diagram"></a>4. Worker 遷移図

```
       (新規割り当て)
IDLE  ─────────────────►  ASSIGNED
                              │
                         (作業開始)
                              ▼
                          WORKING ◄──────┐
                              │           │
                       (完了報告)         │
                              ▼          │ (rework 指示)
                          REPORTING       │
                              │           │
                       (Dock 確認)  │
                              ▼          │
                          REVIEWING ─────┤
                              │           │
                       (レビュー通過)      │
                              ▼          │
                           MERGED         │
                              │           │
                            (戻る)         │
                              ▼          │
                            IDLE          │
                                          │
WORKING ─(疑問発生)─► BLOCKED ─(解決)─► WORKING
WORKING ─(打ち切り)─► ABORTED ─(リセット)─► IDLE
```

## <a id="smith-diagram"></a>5. Smith 遷移図

```
       (統合硬化依頼)
IDLE  ─────────────────►  ASSIGNED
                              │
                         (Anvil 作成)
                              ▼
                          WORKING ◄──────┐
                              │           │
                       (完了報告)         │
                              ▼          │ (rework 指示)
                          REPORTING       │
                              │           │
                       (Dock 確認)  │
                              ▼          │
                          REVIEWING ─────┤
                              │           │
                       (レビュー通過)      │
                              ▼          │
                           MERGED         │
                              │           │
                            (戻る)         │
                              ▼          │
                            IDLE          │

WORKING ─(不明点)─► BLOCKED ─(解決)─► WORKING
WORKING ─(打ち切り)─► ABORTED ─(リセット)─► IDLE
```

Smith の branch は `garelier/<target-slug>/<pm_id>/anvil/#<ID>/<slug>` です。
Smith 自身は merge せず、Dock が Anvil → studio をマージします。

## <a id="scout-diagram"></a>6. Scout 遷移図

```
       (調査依頼)
IDLE  ─────────────────►  ASSIGNED
                              │
                              ▼
                          WORKING
                              │
                       (draft 作成)
                              ▼
                          REPORTING
                              │
                    (PM commit/確認 + Dock ack)
                              ▼
                            IDLE

WORKING ─(不明点)─► BLOCKED ─(解決)─► WORKING
WORKING ─(打ち切り)─► ABORTED ─(クリア)─► IDLE
```

## <a id="escalation-states"></a>7. エスカレーション

エスカレーションは2段階です。

```
Worker / Scout / Smith (BLOCKED) → Dock
                            │
                  (Dock で解決可能?)
                  ┌─────────┴─────────┐
                  Yes                  No
                  │                    │
              即時応答          PM へエスカレート
              (Worker/Scout/Smith ↓
               WORKING へ)    PM がユーザーへ確認
                              ↓
                          回答が降りてきたら
                          Dock → Worker/Scout/Smith
                          に伝達、WORKING へ
```

`BLOCKED` 中の Worker / Scout / Smith は自走しません。Dock からの応答を
ファイル経由で受け取って初めて `WORKING` に戻ります。

## <a id="base-tracking"></a>8. Base 追従と conflict 解消

`garelier/<target-slug>/<pm_id>/studio` は `<target>` の更新を merge で取り込みます
(rebase は不採用 — detached HEAD worktree が壊れるため)。実行タイミング:

- 新規 workbench / Anvil branch 作成前(Dock)
- workbench / Anvil → studio マージ前(Dock)
- studio → target promote の承認・Concierge dispatch 前(PM)

merge で conflict が出た場合、**Dock と PM は自力解消**します(DEC
0001 §2.5)。これは「コードを書かない」原則への明文化された例外で、
base 追従は integration 作業であって workbench/Anvil 実装ではないという扱い。

blueprint + code context だけでは解消が真に曖昧な場合のみ、通常のエスカレー
ション経路でユーザに照会します。

Worker は target conflict を見ません — 衝突は studio 上で起きるため。

**forward-integration(studio → in-flight workbench、DEC-039)**: 上記は一方向
(`target → studio`)なので、長時間 worker は studio からドリフトします。これを
防ぐため Dock は**毎イテレーション系統的に**、in-flight な workbench/anvil が
studio tip より遅れていないか確認し、遅れていれば冪等な `track-target.md` を投下
します。**producer(Worker / Smith)が** 次のイテレーション境界で `studio` を
merge し、conflict も自力解消します(コードの所有者なので、Dock の
「コードを書かない」例外は広がりません — Dock は trigger と verify のみ)。
WORKING のまま状態遷移なし。merge、rebase 不可。(Worker SKILL §6.5 /
garelier-dock/references/review-and-merge.md §8.5・§8.6)
