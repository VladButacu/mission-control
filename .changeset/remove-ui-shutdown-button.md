---
"@vladbutacu/mission-control": minor
---

Mission Control no longer has a shutdown button in the app bar or on the Maintenance page. Stop it from the terminal with `mission-control stop` or Ctrl+C, and `mission-control stop` now sends SIGTERM to the running server instead of calling an HTTP endpoint.
