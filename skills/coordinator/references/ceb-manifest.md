# CEB suite manifest

A suite of the Coordinator Engineering Benchmark is a fixed list of tasks. Its manifest names each task and pins the task's container image by digest, so every runner starts from the same bytes. The manifest is signed, so a runner knows the list is ours before it pulls anything.

Code: `scripts/lib/ceb/manifest.mjs` (pure, Node built-ins only). Trusted keys: `scripts/lib/ceb/keys.mjs`.

## Files

| File | Holds |
|---|---|
| `manifest.json` | The suite, as UTF-8 JSON with no byte-order mark, at most 1 MB |
| `manifest.json.sig` | The detached signature over the exact bytes of `manifest.json` |

## The manifest

```json
{
  "schema": 1,
  "suite": "CEB-2026.12",
  "canary": "3f6c1e0a-7b2d-4c58-9e41-0d5a8b7c6f12",
  "tasks": [
    {
      "id": "refund-crosses-month",
      "category": "bug-fix",
      "image": "ghcr.io/mindmakr/ceb-refund-crosses-month@sha256:<64 hex>",
      "created": "2026-11-20",
      "humanMinutes": 45
    }
  ]
}
```

| Field | Rule |
|---|---|
| `schema` | `1`. A higher number is refused with "update the coordinator" |
| `suite` | `CEB-` plus year and month: `CEB-2026.12` |
| `canary` | One lowercase GUID for the whole suite. Every file of every task carries it, so the tasks can be filtered out of training data and a model can be probed for having seen them |
| `tasks` | 1 to 200 tasks |
| `tasks[].id` | Lowercase letters, digits and hyphens, at most 63 characters, used once |
| `tasks[].category` | `bug-fix`, `feature`, `refactor`, `security-fix` or `ui` |
| `tasks[].image` | `registry/path@sha256:<64 lowercase hex>`, used by one task only |
| `tasks[].created` | The day the task was written, `YYYY-MM-DD` |
| `tasks[].humanMinutes` | The time a person should need, in whole minutes, 1 to 10080 |

Any other field is refused. A new field means a new `schema` number, so an older release never reads part of a manifest and skips the rest.

**An image is pinned by digest, never by tag.** A tag can be moved to other bytes after the manifest is signed; a digest cannot. `name:latest` is refused with a message that names the task, and so is `name:1.0@sha256:…`, because the tag in it says nothing the digest does not.

## The signature

```json
{
  "schema": 1,
  "algorithm": "ed25519",
  "keyId": "798c38a65d5837ad",
  "signature": "<64 bytes, base64>"
}
```

- The signature is Ed25519 over the line `coordinator-ceb-manifest-v1`, a newline, and then the bytes of `manifest.json` exactly as they are in the file. Nothing is reformatted first, so one changed byte, even a space, fails. The first line keeps a signature made for anything else from fitting a manifest.
- `keyId` is the first 16 hex characters of the SHA-256 of the public key (its SPKI DER bytes). It only picks the key to check with; the check itself is the signature.

## Opening a manifest

`openManifest(bytes, signature)` returns `{ manifest, keyId, sha256 }` or throws with the reason. In order:

1. The signature file is read, and its key is looked up in `SUITE_KEYS`. A key this release does not ship is refused.
2. The signature is checked against the bytes. Nothing in the manifest is read before this passes.
3. The manifest is parsed and every rule above is checked. All problems are listed, not only the first.

`parseManifest(bytes)` does step 3 alone, for writing a manifest. It says nothing about who made it: use `openManifest` before trusting one.

## Keys

`SUITE_KEYS` holds public keys only, each as base64 SPKI DER. To change the key, add the new one in a release, sign with it from the next suite on, and remove the old one once no supported suite uses it. Removing a key revokes it: releases from then on refuse what it signed.

## Signing (maintainers)

`tools/ceb-sign.mjs` is in the coordinator's repository, not in the skill. It reads the private key from a file you name and never prints or copies it.

```
node tools/ceb-sign.mjs keygen --out <file outside the repo>    once: prints the public key for keys.mjs
node tools/ceb-sign.mjs check manifest.json                     the format, every problem
node tools/ceb-sign.mjs sign manifest.json --key <file>         writes manifest.json.sig
node tools/ceb-sign.mjs verify manifest.json                    as a runner will check it
```

A manifest that breaks a rule is never signed. Sign last: any edit after it, including a formatter's, needs a new signature.
