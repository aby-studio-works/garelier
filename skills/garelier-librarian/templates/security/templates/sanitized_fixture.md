# Sanitized Fixture Guidance

Fixtures, samples, seeds, and logs must use **synthetic, clearly-fake** data —
never real customer/production records.

| Field | Use |
| --- | --- |
| emails | `user@example.com`, `alice@example.org` |
| names | `Alice`, `Bob`, `Acme Inc.` |
| phone | clearly-fake (`000-0000-0000`) |
| payment | synthetic Luhn-valid **test** numbers, labelled as test |
| ids / tokens | obvious placeholders: `TEST-...`, `0000-...`, `<token>` |
| addresses | fictional |

If a sanitized fixture still trips a Guardian pattern (e.g. a Luhn-valid test
card), record it in `registries/false_positive_exceptions.toml` with the path
and reason — after PM / security-owner approval.
