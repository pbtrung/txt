from pathlib import Path

import click

from .account_init import AccountInitializer
from .creds import load_creds
from .logger import Logger
from .replace_images import ImageReplacer


@click.command()
@click.option(
    "--init-admin",
    "admin_creds_path",
    metavar="CREDS_JSON",
    help="Provision the administrator's row in ctl (users/key_store/cred_store)",
)
@click.option(
    "--init-user",
    "user_creds_path",
    metavar="CREDS_JSON",
    help="Provision an ordinary user's row in ctl (users/key_store/cred_store)",
)
@click.option(
    "--replace-images",
    "replace_images_dirs",
    nargs=2,
    type=click.Path(),
    metavar="SRC DST",
    help="Replace images in every *.epub under SRC into DST, and copy every *.opf",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable verbose progress logging")
@click.pass_context
def cli(
    ctx: click.Context,
    admin_creds_path: str | None,
    user_creds_path: str | None,
    replace_images_dirs: tuple[str, str],
    verbose: bool,
) -> None:
    logger = Logger(verbose)
    ran = _dispatch(admin_creds_path, user_creds_path, replace_images_dirs, logger)
    if not ran:
        click.echo(ctx.get_help())


def _dispatch(admin_creds_path, user_creds_path, replace_images_dirs, logger) -> bool:
    if admin_creds_path:
        _run_init(admin_creds_path, "admin", logger)
    elif user_creds_path:
        _run_init(user_creds_path, "user", logger)
    elif replace_images_dirs:
        _run_replace_images(replace_images_dirs, logger)
    else:
        return False
    return True


def _run_init(creds_path: str, account_type: str, logger: Logger) -> None:
    AccountInitializer(load_creds(creds_path), creds_path, logger, account_type).run()


def _run_replace_images(dirs: tuple[str, str], logger: Logger) -> None:
    src, dst = dirs
    ImageReplacer(Path(src), Path(dst), logger).run()


def run(argv: list | None = None) -> None:
    cli.main(args=argv)
