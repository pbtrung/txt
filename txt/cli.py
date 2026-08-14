import argparse

from .creds import load_creds
from .init_user import InitUser
from .logger import Logger


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="txt.py")
    parser.add_argument("--init-user", metavar="creds.json", help="Provision a new user")
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser


def run(argv: list | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    logger = Logger(args.verbose)
    if args.init_user:
        InitUser(load_creds(args.init_user), logger).run()
    else:
        parser.print_help()
