# Check installation health

doctor reports component health and a status the user can trust before the first tool call. status and version report the install state without changing it.

## Sub-features

- `doctor-json` returns one machine-readable report.
- `doctor-status` maps check results to `ok`, `ok_with_warnings`, or `degraded`.
- `doctor-exit` matches the process exit code to the status.
- `status-report` shows install state and connected agents.

## How to get to it (user POV)

- Run `wigolo doctor --json` in a terminal.
- Run `wigolo status` to see install state and connected agents.

## Driving it with the wigolo CLI

Preconditions:

- The baseline preconditions in `README.md` hold except the doctor step, which this feature performs.
- The data directory is writable.

- **Doctor from an empty directory.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- doctor --json 2>/dev/null`. Capture stdout to `artifacts/doctor/doctor.stdout.json` and the exit code to `artifacts/doctor/doctor.exit`. The JSON has `status`, `exitCode`, `version`, and a `checks` array. `exitCode` in the JSON matches the process exit code. A `data-dir` check has status `ok` and names this run's directory.
- **Fresh-directory warning.** In the captured report, an `embeddings` check with status `failed` and detail mentioning lazy download is expected. It does not make the overall status `degraded`.
- **Status.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- status 2>/dev/null`. Exit code is `0`. Capture stdout to `artifacts/doctor/status.stdout.txt`. The output includes `wigolo v0.3.4` or the current package version.
- **Proof.** The artifacts show the report shape, the exit-code contract, and the version string a user sees.

## Gotchas

- `doctor --json` writes logs to stderr. Redirect stderr away from stdout.
- `ok_with_warnings` exits `0`. Only `degraded` exits `1`.
- A fresh directory reports missing models as lazy downloads. Do not run `doctor --fix` during verification.
