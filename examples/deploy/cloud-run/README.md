# Archnemesis on Google Cloud Run

One way to host the container (the repo's `Dockerfile`) on a managed service. Nothing here is
needed to run Archnemesis elsewhere. The commands are a starting point built from what the
code says; **check every flag against the current gcloud docs** before relying on it.

What is specific to Cloud Run, and why:

- **One instance.** Archnemesis holds each design's live document in memory in one process
  and writes every edit to SQLite. Run exactly one instance (`--min-instances=1
--max-instances=1`), so it is always up and never two writers.
- **The disk does not last.** An instance's local disk goes when the instance does. Set
  `ARCHNM_LITESTREAM_URL=gs://<bucket>/<path>` and the container (`docker/start.sh`)
  restores the database from that replica when the disk is empty, then copies every change
  to it as it is written. Give the service account write access to the bucket. With it set,
  repos hosted on the server itself are not offered (Litestream keeps the database, not
  repos); designs can still follow a remote repo.
- **Designs as files.** `ARCHNM_ROOT` is a folder on that same disk, so it is lost with it.
  Follow a git repo (the branch icon in the app, see the main README) so the files live in
  git, or mount a bucket or a volume at `/architecture` (check the current Cloud Run
  volume options).
- **WebSockets.** Live sync is a WebSocket at `/sync`. Cloud Run supports WebSockets; they
  are cut when a request reaches the service's timeout (`--timeout`), and the app reconnects.
  The design notes suggest session affinity (`--session-affinity`); with one instance it
  does not matter.

## Deploy

```sh
PROJECT=my-project REGION=us-central1 SERVICE=archnm

# Build and push the image to Artifact Registry (create the repository first).
gcloud artifacts repositories create archnm --repository-format=docker \
  --location=$REGION --project=$PROJECT
docker build --platform linux/amd64 -t $REGION-docker.pkg.dev/$PROJECT/archnm/archnm:latest .
docker push $REGION-docker.pkg.dev/$PROJECT/archnm/archnm:latest

# A bucket for the database replica.
gcloud storage buckets create gs://$PROJECT-archnm --location=$REGION --project=$PROJECT

gcloud run deploy $SERVICE --project=$PROJECT --region=$REGION \
  --image=$REGION-docker.pkg.dev/$PROJECT/archnm/archnm:latest \
  --port=5190 --min-instances=1 --max-instances=1 \
  --set-env-vars=ARCHNM_LITESTREAM_URL=gs://$PROJECT-archnm/archnm \
  --set-env-vars=ARCHNM_PUBLIC_URL=https://<the service's address or your domain>
```

`ARCHNM_PUBLIC_URL` must be the address people use; requests for any other host are
refused. The service's address is printed by the deploy; set it, or a custom domain, and
deploy again.

The image's default sign-in is `tokens`, which needs a tokens file. On Cloud Run, mount it
from Secret Manager (`--set-secrets=/run/archnm/tokens.json=archnm-tokens:latest`, see
`examples/tokens.example.json` for the shape), or choose a sign-in below.

## Sign-in

| You want                                  | Set                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Google accounts, through IAP              | `ARCHNM_AUTH=iap`, `ARCHNM_IAP_AUDIENCE=/projects/<number>/locations/<region>/services/<name>` |
| Google Cloud Identity Platform / Firebase | `ARCHNM_AUTH=gcip` and the `ARCHNM_GCIP_*` settings (`examples/auth/gcip`)                     |
| Any other                                 | see `examples/auth/README.md`                                                                  |

**IAP.** Archnemesis checks the `x-goog-iap-jwt-assertion` header on every request (ES256
signature against Google's published keys, issuer, audience, expiry); a request without a
valid one is nobody. Let traffic reach the service only through IAP (ingress set to internal
and the load balancer, or IAP on Cloud Run itself: check the current gcloud docs for
`--iap` and `--ingress`), or the header could be sent by anyone. The audience is the one IAP
shows for the service; the code accepts `/projects/<number>/global/backendServices/<id>`
(behind a load balancer) and `/projects/<number>/locations/<region>/services/<name>` (IAP
on Cloud Run). Claude Code cannot get through IAP yet (Google only allows OAuth clients from
the same organisation), so agents on an IAP deployment need another way in, such as the
tokens file beside it (`ARCHNM_TOKENS`, sent in the `X-Archnm-Token` header because
`Authorization` is IAP's).

**GCIP.** `examples/auth/gcip/provider.js` is a full provider for Identity Platform. It is
copied into the image (`ARCHNM_AUTH=gcip` loads it). Because anyone on the internet can
finish a public identity provider's sign-in, the server refuses to start unless
`ARCHNM_EDITORS` / `ARCHNM_VIEWERS` / `ARCHNM_ADMINS` restrict who gets in, or
`ARCHNM_OPEN=yes` says everyone may.

Whatever signs people in, set who may do what with `ARCHNM_ADMINS`, `ARCHNM_EDITORS` and
`ARCHNM_VIEWERS`, and set `ARCHNM_TOKEN_KEY` from a secret so a restart keeps people signed
in (`--set-secrets=ARCHNM_TOKEN_KEY=archnm-token-key:latest`).

## The GitHub App, from secrets

A deployment can take its GitHub App from its environment instead of its database:
`ARCHNM_GITHUB_APP_ID`, `ARCHNM_GITHUB_APP_SLUG`, `ARCHNM_GITHUB_CLIENT_ID`,
`ARCHNM_GITHUB_CLIENT_SECRET` and `ARCHNM_GITHUB_PRIVATE_KEY` (or
`ARCHNM_GITHUB_PRIVATE_KEY_FILE`). Put the secret ones in Secret Manager and pass them with
`--set-secrets`.

`scripts/github-app.ts` creates the App once, ahead of time: it opens GitHub's filled-in
"create app" page, then adds the App's client secret and private key as new versions of two
existing Secret Manager secrets (`<prefix>-client-secret`, `<prefix>-private-key`, created
beforehand) and prints the id, slug and client id for the settings above:

```sh
node scripts/github-app.ts --name my-archnm --url https://<the service's address> \
  --project $PROJECT [--secrets archnm-github] [--org SomeOrg]
```

It needs `gcloud` on your machine. `ARCHNM_GITHUB_APP_PUBLIC=no` keeps the App installable
only by its owner.

## Not verified here

This page was written from the code and docs, not from a deployment. In particular the
`gcloud` flag spellings, the IAP-on-Cloud-Run setup and the Cloud Run volume options are
from memory of gcloud: check them against the current documentation.
