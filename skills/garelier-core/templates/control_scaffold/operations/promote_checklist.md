# Promote Checklist

- [ ] Intended milestone and blueprint outcomes are satisfied.
- [ ] Required quality gates pass.
- [ ] Active risks are reviewed.
- [ ] Control graph validation has no blocking findings.
- [ ] Knowledge layers riding this promote are review-clean: per-pm
      `__garelier/<pm_id>/knowledge/` and shared `__garelier/__atmos/knowledge/`
      changes that will land in `<target>` are intended, Guardian-cleared
      (license/PII/provenance), and the derived knowledge graph validates. Note
      any shared-layer edits authored under another pm.
- [ ] Completed backlog rows are removed.
- [ ] User explicitly approved the promote/deploy when required.
- [ ] PM recorded the approval and dispatched Concierge; PM/Dock/Artisan do not
      execute the `studio` -> `target` merge.
