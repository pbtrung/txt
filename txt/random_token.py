import secrets

CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def to_base32_crockford(data: bytes) -> str:
    bits, value, output = 0, 0, []
    for byte in data:
        value = (value << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            output.append(CROCKFORD_ALPHABET[(value >> bits) & 31])
    if bits > 0:
        output.append(CROCKFORD_ALPHABET[(value << (5 - bits)) & 31])
    return "".join(output)


# 32 random bytes rendered as base32-Crockford — the recipe docs/auth.md and
# docs/data_model.md use for db_path, db_prefix, and every object key.
def generate_random_prefix() -> str:
    return to_base32_crockford(secrets.token_bytes(32))
