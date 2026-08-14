import argparse

from .admin_init import AdminInitializer
from .creds import load_creds
from .logger import Logger


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="txt.py")
    parser.add_argument("--init-admin", metavar="creds.json", help="Provision the administrator account")
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def run(argv: list | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    logger = Logger(args.verbose)
    if args.init_admin:
        AdminInitializer(load_creds(args.init_admin), logger).run()
    else:
        parser.print_help()
