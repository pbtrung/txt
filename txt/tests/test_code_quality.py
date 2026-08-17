import ast
from pathlib import Path

PACKAGE_DIR = Path(__file__).parents[1]
MAX_FUNCTION_LINES = 15


def _production_functions():
    for path in sorted(PACKAGE_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                yield path, node


def test_production_functions_stay_focused():
    oversized = []
    for path, node in _production_functions():
        line_count = node.end_lineno - node.lineno + 1
        if line_count > MAX_FUNCTION_LINES:
            oversized.append(f"{path.name}:{node.lineno} {node.name} ({line_count})")
    assert not oversized, "Functions longer than 15 lines:\n" + "\n".join(oversized)
