from txt.logger import Logger


def test_logger_mirrors_console_output_to_log_file(tmp_path, capsys):
    log_path = tmp_path / "logs" / "cleanup.log"
    logger = Logger(verbose=True, log_path=log_path)

    logger.info("Starting cleanup")
    logger.verbose("Listed 1,000 bucket objects")
    logger.close()

    assert log_path.read_text() == capsys.readouterr().out


def test_logger_does_not_write_disabled_verbose_messages(tmp_path, capsys):
    log_path = tmp_path / "run.log"
    logger = Logger(verbose=False, log_path=log_path)

    logger.verbose("hidden")
    logger.close()

    assert capsys.readouterr().out == ""
    assert not log_path.exists()
