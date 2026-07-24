# Deploying the web UI

## R2 bucket CORS policy (required)

Cloudflare R2 buckets ship with **no CORS policy at all** by default, which silently
blocks every part fetch: a signed GET carries an `Authorization`/`x-amz-date`/
`x-amz-content-sha256` header set, making it a "non-simple" cross-origin request, so the
browser sends a CORS preflight (`OPTIONS`) before it — and with no policy, that preflight
has nothing to grant it, failing with a `TypeError: Failed to fetch` that looks identical
to a plain network error (the browser deliberately doesn't distinguish the two). This only
affects the browser UI, not `txt.py` (boto3 runs server-side, unaffected by CORS).

Set a policy on the bucket (Cloudflare dashboard → R2 → your bucket → Settings → CORS
Policy, or `aws s3api put-bucket-cors --endpoint-url <r2 endpoint> ...`) allowing GET from
wherever the UI is served:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

Add every origin the UI is actually served from (e.g. a deployed origin, not just
`localhost`) as another entry in `AllowedOrigins`. `AllowedHeaders: ["*"]` is the safe
default — a narrower list has to include every header the SigV4 signature adds, or the
preflight still fails the same way.

If you're using [`local_index.html`](local_index.md): a `file://` page's `Origin` is
`null`, but R2 may not accept the literal string `"null"` as an `AllowedOrigins` entry.
`"AllowedOrigins": ["*"]` is the practical fix — these GETs carry no cookies/credentials,
so a wildcard origin is safe here.
