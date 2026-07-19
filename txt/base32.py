"""Crockford's human-readable Base32: excludes i, l, o, u (visually ambiguous with 1/1/0/v), no padding."""

_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def encode(data: bytes) -> str:
    if not data:
        return ""
    total_bits = len(data) * 8
    num_symbols = -(-total_bits // 5)  # ceil(total_bits / 5)
    pad_bits = num_symbols * 5 - total_bits
    bits = int.from_bytes(data, "big") << pad_bits
    return "".join(
        _ALPHABET[(bits >> (5 * (num_symbols - 1 - i))) & 0x1F]
        for i in range(num_symbols)
    )
