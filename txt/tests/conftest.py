import pytest

from txt.leancrypto_wasm import LeancryptoEngine


@pytest.fixture(scope="session")
def engine() -> LeancryptoEngine:
    return LeancryptoEngine()
