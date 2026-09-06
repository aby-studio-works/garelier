# Provider routing adapters (W-146)

## Decision

`model_routing.md` remains the canonical policy. Its precedence is unchanged:
explicit dispatch flag > blueprint hint > automatic judgment/risk rules > seat
default > inherit. Provider adapters may translate that decision to a provider's
model names and launch fields, but must not replace the policy with a role-fixed
table.

The Codex adapter is a translation table only:

| Canonical resolved tier/model | Codex translation |
| --- | --- |
| light / mid (`haiku` / `sonnet`) | `gpt-5.6-terra` |
| strong (`opus`) | `gpt-5.6-sol` |
| explicit Codex model | preserve verbatim |
| inherit / unknown provider model | BLOCK; no adapter default |

Effort is preserved verbatim and `ultra` is forbidden for ordinary dispatch.
Explicit model/effort and blueprint hints remain higher-precedence inputs. The
adapter never selects from seat or workload: an unresolved canonical decision is
an explicit BLOCK, not a hidden provider default. Mechanical work is kept out of
the adapter and routed to deterministic drivers before model routing.

## Evaluation

- Downstream detectability: the canonical resolver already accounts for gate
  terminality and rework; the adapter translates its resolved tier only.
- Hardest reasoning: systemic design, security, determinism, and repeated rework
  justify Sol high/xhigh. Ordinary implementation does not.
- Rework/escalation: canonical rules promote risk/rework before provider mapping;
  the adapter must not re-derive or erase that decision.
- Provider portability: context stores both canonical source and resolved provider
  launch fields. Claude and Codex launchers consume the same decision envelope.
- Cost/latency: mechanical work is a deterministic driver operation, not an LLM
  seat. The canonical tier determines Terra versus Sol.
- Codex constraint: every managed role uses the recorded `codex exec`
  `launch_cmd` emitted by `dispatch_prepare.ts`. The command pins the resolved
  model/effort and binding; raw provider invocation and model inheritance are
  forbidden. Claude launch behavior is unchanged.

This is an execution adapter, not a new model-selection constitution.
