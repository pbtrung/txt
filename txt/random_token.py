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


def generate_db_path() -> str:
    return to_base32_crockford(secrets.token_bytes(32))


# Same recipe (docs/data_model.md §2), reused for db_prefix and any other
# 32-random-byte, base32-Crockford R2 prefix — not just ctl's db_path.
generate_random_prefix = generate_db_path
