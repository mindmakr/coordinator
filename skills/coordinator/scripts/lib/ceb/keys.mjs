// The public keys a CEB suite manifest may be signed with (references/ceb-manifest.md).
// Each entry is an Ed25519 public key as base64 SPKI DER: the body of its PEM file,
// which `node tools/ceb-sign.mjs keygen` prints. Public keys only; a private key never
// belongs in this repository.
//
// To rotate: add the new key in one release, sign with it from the next suite on, and
// remove the old key once no supported suite is signed with it. Removing a key here
// is how it is revoked.
export const SUITE_KEYS = [
  'MCowBQYDK2VwAyEAtJzIaimpKDntLWiG315ntJLJko+iYcc9mQ8Cd51HBDU=', // id 798c38a65d5837ad, added 2026-11-12
];
