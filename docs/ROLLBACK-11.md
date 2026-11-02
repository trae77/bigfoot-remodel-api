# Rollback for remodel-api PR #11 (recorded 2026-11-01 MT, before merge)
- main before merge: 2f30aba33cfea8b89fb5236f78e32ea04449fb33
- Render srv-dbekp9bncjis73eir3ng live deploy: dep-dbjbks3bc2fs73cbtdi0 (commit 2f30aba, finished 2026-10-31 10:05 PM MT)
- Rollback: Render dashboard/API rollback to dep-dbjbks3bc2fs73cbtdi0. No git history rewrite.
- Merged: 80d12267a9954ad89dc53a53f5adf686f6505f18 (merge commit of PR #11 head 33fada7). Deployed: dep-dbjp37ijnfac738lp040 live at 12:24 PM MT.
- D1 remodel-caps created: 3bf73d02-4881-4ed7-b72c-19a328e32b94 (table remodel_caps, 0 rows).

## Exact Render rollback steps (QA P3)
Service: srv-dbekp9bncjis73eir3ng. Target: deploy dep-dbjbks3bc2fs73cbtdi0 (commit 2f30aba).
Dashboard: Render > bigfoot-remodel-api service > Events (or Deploys) > find deploy dep-dbjbks3bc2fs73cbtdi0 / commit 2f30aba > "Rollback" > confirm. Note: Render turns off auto-deploy after a rollback; re-enable it under Settings > Build & Deploy once the fix is on main.
API: curl -X POST https://api.render.com/v1/services/srv-dbekp9bncjis73eir3ng/rollback \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" \
  -d '{"deployId":"dep-dbjbks3bc2fs73cbtdi0"}'
Verify: GET https://api.render.com/v1/services/srv-dbekp9bncjis73eir3ng/deploys?limit=1 shows status live, commit 2f30aba; then GET /api/health returns {"ok":true}.
After rollback the D1 caps code is gone (in-memory caps of 2f30aba apply); REMODEL_CAPS_D1_* env vars can stay. No git history rewrite.
