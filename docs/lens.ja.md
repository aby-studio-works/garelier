# Lens Pack

Lens Pack は、PM が各 role の判断フォーカスを選ぶための仕組みです。
role の権限は変えません。

Lens Group は persona でも permission profile でもありません。write path、
MUST BLOCK 条件、role contract、merge 権限、external write 権限、handoff
形式を変更できません。

## 保存場所

fresh setup は共有 Lens registry をここへ seed します:

```text
__garelier/__atmos/lens_registry.toml
__garelier/__atmos/lenses/*.toml
```

PM の既定値は `setup_config.toml` に入ります:

```toml
[lenses.defaults]
worker = "worker.implementation:reuse_first"
guardian = "guardian.risk_control:strict"
```

## Blueprint と Assignment の流れ

PM は blueprint に `## Lens selection` を追加できます。Dock の deterministic
assignment renderer は次の優先順で role の Lens を解決します:

1. CLI `--lens`
2. blueprint `## Lens selection`
3. `setup_config.toml` `[lenses.defaults]`
4. explicit Lens なし

生成された assignment には `## Equipped lens` が入り、producer は blueprint を
再解析せずに解決済み focus を読めます。

blueprint 記述例:

```markdown
## Lens selection

- Source: explicit PM choice
- PM: `pm.planning:specification_first`
- Worker: `worker.implementation:minimal_patch`
- Guardian: `guardian.risk_control:strict`
- Observer: `observer.review:architecture`
- Librarian: `librarian.source:strict`
- Concierge: `concierge.external_ops:explicit_only`
```

省略した role は `[lenses.defaults]` を使います。

## 検証

`lenses.ts validate-registry --garelier-root __garelier` は registry、Lens Pack
role、active group、`allow_promote` / `ignore_role_contract` /
`relax_must_block` などの権限風 forbidden field を検証します。

## 既存 registry への追補

fresh / `--mode migrate` は shipped pack を**無ければだけ** seed します(no-overwrite)。
そのため既に registry を持つ project は pack と `[lenses.defaults]` がそのまま保持され、
**壊れませんが、新しく出荷された focus group は自動追加されません**。取り込むには PM に
依頼します: 出荷 template の `templates/lenses/*.toml` から**不足している `[[groups]]` だけ**を
`__garelier/__atmos/lenses/*.toml` に追記し(additive — 既存 group は削除も上書きもしない)、
`validate-registry` を実行します。新 group を既定にしたい場合のみ `[lenses.defaults]` を更新します
(更新しなければ現在の選択が維持されます)。
