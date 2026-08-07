# Configuration reference

Install the agent with `brew install marky-mcmarkface`, then point it at a cluster. The `--profile` flag
selects a stored connection, and `--json` switches the output to machine-readable form.

```bash
marky-mcmarkface connect --profile production
marky-mcmarkface review --repo owner/name --pull 482
```

## Properties

| Property | Replacement | Since | Notes |
| --- | --- | --- | --- |
| `cluster.endpoint` | `connection.address` | 8.4 | Renamed for consistency with the CLI. |
| `auth.tokenFile` | `auth.credentialSource` | 8.5 | Now accepts a keychain reference. |
| `retry.maxAttempts` | unchanged | — | Default raised from 3 to 5. |
| `log.format` | `log.encoding` | 8.6 | Values are `text` and `json`. |

## Timeouts

Every timeout is expressed as an ISO 8601 duration, so `PT30S` is thirty seconds and `PT5M` is
five minutes. A bare number is rejected rather than assumed to be milliseconds, because the
assumption was wrong often enough to be dangerous.

```yaml
timeouts:
  connect: PT10S
  request: PT30S
  shutdown: PT2M
```

The `shutdown` timeout is the one people get wrong. It bounds how long a worker waits for
in-flight jobs to finish, not how long the process lingers afterwards.
