"""Roda a suíte inteira. Sai com código 1 se algo falhar."""

import os
import sys
import unittest
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
sys.path.insert(0, str(AQUI.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
# Nunca a configuração real do usuário (registro): um .ini descartável.
import tempfile  # noqa: E402
os.environ["VALIDAURL_CONFIG"] = os.path.join(tempfile.mkdtemp(prefix="validaurl_teste_"), "config.ini")

if __name__ == "__main__":
    suite = unittest.defaultTestLoader.discover(str(AQUI), pattern="teste_*.py", top_level_dir=str(AQUI))
    resultado = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if resultado.wasSuccessful() else 1)
