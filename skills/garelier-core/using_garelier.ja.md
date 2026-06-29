# Using Garelier

Garelier は、AI ロールのチームを協調させ、依頼を「レビュー済みで merge された
成果」へと変えるファイルベースのフレームワークです。**何を出すか**はあなたが
握ったまま、ロールが設計・実装・レビュー・統合を行います。あなたが方向を与え、
ロールが手を動かし、あなたが本物のブランチに届くものを承認します。このページは
**運用者向けガイド**です。**Console** タブはこの read-only ビューワー自体を、
**Flow** は作業モデルの詳細を説明します。

## 全体像

- **あなた / user** が方向(依頼、または roadmap + backlog)を決め、2 つの
  go/no-go を握ります: non-trivial な設計の承認と、本物のブランチへの promote の
  承認です。
- **PM** は方向を *blueprint*(小さな仕様)に変え、lane を選び、promote を承認
  します。PM はソースを編集しません。
- **Producers** が手を動かします: *Worker*(実装)、*Smith*(merge 後の
  hardening)、*Librarian*(knowledge / registry)、*Scout*(調査、commit なし)、
  あるいは 1 つの *Artisan* が全スコープを 1 ブランチで担います。
- **Gates** が品質を守ります: *merge gate* は設定済みのチェックを走らせ、
  *Guardian* は security / license gate、*Observer* は独立レビュー、*Wanderer* は
  誰かが実装に入る前に設計をレビューする任意の外部 peer です。
- **Dock** は統合ブランチ(`studio`)を持ち、producer を dispatch し、受理した
  成果を merge gate に通します。**Concierge** は唯一の外部操作 —— 承認後に
  `studio` をあなたの本物のブランチへ merge する —— を実行します。

## 日々のループ

1. **仕事を渡す。** PM に次の backlog item を指すか、新しい依頼を渡します。
   autonomous mode では driver がループを回し続け、そうでなければあなたが PM に
   指示します。
2. **設計。** PM が blueprint を書きます。non-trivial な設計は、コードが書かれる
   *前に* レビュー(Wanderer、不在なら Observer)と sign-off を通ります。
3. **実装。** Dock が producer(または Artisan)を dispatch します。成果は専用
   ブランチに commit され、本物のブランチには載りません。
4. **Gate + 統合。** merge gate が設定チェックを走らせ、必要なら Guardian /
   Observer が走ります。通過した成果は `studio` に着地します。
5. **Promote はあなたの判断。** あなたが承認するまで本物のブランチには何も届き
   ません。承認すると Concierge が `studio` をそこへ merge します。

これらすべてをこの **read-only** コンソールで見られます: 健全性は **Dashboard**、
live queue と reports は **Work**、計画は **Control**、ロールが読むものは
**Knowledge** です。

## 操舵のしかた

- **driver の start / stop** は記載の helper script で行います。stop ファイルは、
  進行中の作業を殺さずに autonomous な自走を一時停止します。
- **queue を hold**(*dispatch hold*)すると新規 dispatch を意図的に止められます
  —— コンソールでは fault ではなく banner として表示されます。
- blueprint と promote を **承認 / 却下** します。これらの判断はあなたのもので、
  PM が独断で本物のブランチへ promote することはありません。
- **knowledge / policy を追加** するには Librarian に curate させます。以後ロールは
  自動でそれを読みます(**Knowledge → By role** 参照)。

このコンソールはこれらを *実行しません* —— 状態を見せるだけです。操作は、あなたの
指示に基づき PM と driver を通じて行われます。

## どこに何があるか

- **`control/`** — 永続的な計画: roadmap、backlog、blueprints、decisions、
  operations。*何を / なぜ* の正本です。**Control** で閲覧します。
- **`runtime/`** — 一時的な実行状態(queue、inbox、lock、log)。git で追跡せず、
  machine-local とみなしてください。
- **knowledge trees** — ロールが読む curated で再利用可能な知識。**Knowledge**
  参照。2 層あり得ます: project 全体で共有する層と、この PM 専用の層(**Layer**
  列が document の出所を示します)。
- **branches** — 各ロールは `garelier/<target-slug>/<pm_id>/…` の専用ローカル
  ブランチで作業します。あなたの本物のブランチに触れるのは承認済み promote だけ
  です。**Flow → Branches** 参照。

## 何かおかしいと感じたら

- queue は埋まっているのに何も始まらない → *held future* の item は milestone /
  dependency gate 待ちで、仕様どおりです(**Work → Queue**)。
- role が REPORTING なのに report が無い、lock が stale に見える → **Guide →
  Diagnostics** に確認順(lane → merge gate → role STATE)があります。
- merge が失敗した → **Dashboard** に `failed_quality_gate` が出ます。詳細は
  **Work → Reports** です。

全体を読み解く 2 つの目安:

- **commit か report かで role が決まる** —— commit するのは Worker / Smith /
  Librarian / Artisan だけ。PM / Scout / Observer / Guardian / Wanderer は
  commit しません。
- **境界はあなたが握る** —— Garelier は提案するだけで、あなたの promote 無しに
  本物のブランチへは何も届きません。
