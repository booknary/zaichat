# ZaiChat embedding worker

This directory contains the source and pinned runtime dependencies for the Windows
x64 ONNX sidecar. It is deliberately outside the XPI build inputs.

Protocol commands:

- `hello`
- `ping`
- `load_model`
- `embed_query`
- `embed_documents`
- `get_status`
- `shutdown`

The worker accepts NDJSON only on stdin/stdout and never opens a network port. A
model is loaded only when its plugin-generated `manifest.json` matches the model
fingerprint supplied by ZaiChat.

The validated Windows packaging target is a single-file PyInstaller executable.
This avoids publishing and recovering a 100+ file runtime tree. Before release,
the executable must still be built in a clean, locked Windows x64 environment,
signed, and rerun through the Zotero lifecycle and frozen embedding-correctness
tests. The source tree does not contain or download a runtime binary.

`runtime/tools/build_semantic_release.py` separates release preparation into
three explicit operations:

1. `stage` hashes and stages a runtime plus the minimal model snapshot without
   creating downloadable manifests;
2. `finalize` binds those immutable assets to a real HTTPS release location and
   rejects placeholder or local URLs;
3. `verify` rechecks every size, SHA-256 digest, model fingerprint, and manifest.

This means a local release candidate cannot accidentally be presented to the
plugin as a published download.
