# Deploying to DigitalOcean (DOKS + DOCR)

How `staging.yml` and `production.yml` deploy the backend, and the one-time setup they need.

## Flow

1. **Merge to `main`** → `staging.yml` builds the image **once**, pushes it to DigitalOcean
   Container Registry (DOCR) as `sha-<commit>` and `staging`, then deploys that digest to the
   staging DOKS cluster.
2. **Tag `vX.Y.Z`** (matching `package.json`) → `release.yml` runs lint, types and the full test
   suite (with PostGIS + Redis) and publishes a GitHub Release.
3. **Release published** → `production.yml` (after approval on the `production` environment) looks up
   `sha-<tagged commit>` in DOCR, runs the OTP job-browser check against that exact image, adds the
   `X.Y.Z` and `production` tags to the same digest, and deploys it. **Nothing is rebuilt.**
   If the tagged commit was never built by staging, the workflow stops.

Both deploys:

- mint a **short-lived kubeconfig** with `doctl kubernetes cluster kubeconfig save --expiry-seconds …`
  (no stored `KUBE_CONFIG` secret);
- run Prisma migrations as a **Helm pre-upgrade hook Job** (`templates/job-migrate.yaml`) that reads
  `MIGRATION_DATABASE_URL` from the `zaroorat-backend-migration` Secret. If the migration fails, no pod
  is replaced;
- run `scripts/release/post-deploy-check.sh`: `/health`, `/ready` and the Socket.IO handshake through the
  public URL. A failure rolls the Helm release back.

## One-time setup

### DigitalOcean

```bash
doctl registry create <registry-name> --region blr1
doctl kubernetes cluster registry add <staging-cluster> <production-cluster>
```

Registry integration creates a `registry-<registry-name>` pull secret in each namespace. The workflows
pass it to the chart (`imagePullSecrets`) because the chart uses its own ServiceAccount.

Create one **scoped API token per environment** (Registry: read/write, Kubernetes: read) and store it as
the environment secret `DIGITALOCEAN_ACCESS_TOKEN`.

### GitHub

| Where                          | Name                               | Value                                            |
| ------------------------------ | ---------------------------------- | ------------------------------------------------ |
| Repository variable            | `DOCR_REGISTRY`                    | registry name                                    |
| Repository variable            | `DEPLOY_STAGING`                   | `true` once staging exists                       |
| Repository variable (optional) | `IMAGE_PULL_SECRET`                | override if not `registry-<registry-name>`       |
| Repository variable (optional) | `REALTIME_PATH`                    | Socket.IO path, default `/socket.io`             |
| Environment `staging`          | secret `DIGITALOCEAN_ACCESS_TOKEN` | staging-scoped token                             |
| Environment `staging`          | variable `DOKS_CLUSTER`            | staging cluster name or ID                       |
| Environment `staging`          | variable `STAGING_URL`             | e.g. `https://api.staging.zaroorat.com`          |
| Environment `production`       | required reviewers                 | release approvers                                |
| Environment `production`       | secret `DIGITALOCEAN_ACCESS_TOKEN` | production-scoped token                          |
| Environment `production`       | variable `DOKS_CLUSTER`            | production cluster name or ID                    |
| Environment `production`       | variable `PRODUCTION_URL`          | e.g. `https://api.zaroorat.com`                  |
| Either environment (optional)  | secret `MIGRATION_DATABASE_URL`    | schema-owner URL, synced into the cluster Secret |

If `MIGRATION_DATABASE_URL` is not set in GitHub, the `zaroorat-backend-migration` Secret must already
exist in the namespace (for example managed by External Secrets).

The old `KUBE_CONFIG` secret is no longer used and can be deleted.

### Cluster secrets

- `zaroorat-backend-secrets`: runtime configuration (`DATABASE_URL` as the runtime login, `REDIS_URL`,
  JWT secrets, provider keys). Unchanged.
- `zaroorat-backend-migration`: key `MIGRATION_DATABASE_URL` (schema owner).

`DB_SSL_MODE=require` is set in `values-staging.yaml` and `values-production.yaml`. Remove any
`?sslmode=` from the connection strings, or it silently overrides this setting.

## Troubleshooting

| Symptom                                     | Check                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `No image found for commit …` in production | The tag points at a commit staging never built. Merge to `main`, wait for staging, re-tag.             |
| `ImagePullBackOff`                          | `kubectl -n <ns> get secret registry-<registry-name>`; re-run `doctl kubernetes cluster registry add`. |
| Release failed in `pre-upgrade hooks`       | `kubectl -n <ns> logs job/zaroorat-backend-migrate` (failed Jobs are kept).                            |
| Post-deploy check fails on Socket.IO        | Ingress/LB WebSocket and timeout settings; `REALTIME_PATH`.                                            |
