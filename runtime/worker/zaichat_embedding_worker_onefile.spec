import os
import sys

from PyInstaller.utils.hooks import collect_dynamic_libs


development_deps = os.environ.get("ZAICHAT_WORKER_DEPS")
if development_deps:
    sys.path.insert(0, development_deps)
binaries = collect_dynamic_libs("onnxruntime")

analysis = Analysis(
    ["zaichat_embedding_worker.py"],
    pathex=[development_deps] if development_deps else [],
    binaries=binaries,
    datas=[],
    hiddenimports=["numpy._core._exceptions", "onnxruntime.capi._pybind_state"],
    hookspath=[],
    runtime_hooks=[],
    excludes=["torch", "tensorflow", "transformers"],
    noarchive=False,
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="zaichat-embedding-worker",
    # Console subsystem is required for Zotero Subprocess stdin/stdout pipes.
    console=True,
    strip=False,
    upx=False,
)
