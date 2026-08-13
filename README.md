# fin

FinAlly — an AI-powered trading workstation that streams live market data, lets
you trade a simulated portfolio, and ships with an LLM chat assistant that can
analyze positions and place trades on your behalf.

## The plan document

[`planning/PLAN.md`](planning/PLAN.md) is the authoritative specification for
this project. It is the shared contract every agent works from — architecture,
directory layout, API surface, database schema, and testing strategy all live
there. There is no other copy; if the plan changes, it changes there.

## Quick start

Requires Docker and an `.env` file (copy `.env.example` and fill in
`OPENROUTER_API_KEY`).

```bash
./scripts/start_mac.sh          # macOS/Linux — add --build to force a rebuild
```

```powershell
.\scripts\start_windows.ps1     # Windows PowerShell
```

The app is then at <http://localhost:8000>. Stop it with
`./scripts/stop_mac.sh` (or `.\scripts\stop_windows.ps1`); the SQLite database
persists in the `finally-data` Docker volume.

See [`planning/PLAN.md` § 11](planning/PLAN.md#11-docker--deployment) for the
Docker and deployment details.
