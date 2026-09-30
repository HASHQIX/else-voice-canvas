# ELSE repair prompt v1

Repair the previous proposal to satisfy the supplied JSON Schema and domain validation errors. Use only the original user input and snapshot. Generate all user-facing text in English. Do not add new facts or broaden the proposed changes. If a target/source does not exist, remove that mutation and ask a concise clarification rather than inventing a source. Return one schema-valid object. Only one repair attempt is allowed by the orchestrator.
