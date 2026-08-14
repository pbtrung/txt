class Logger:
    def __init__(self, verbose: bool = False):
        self.verbose_enabled = verbose

    def verbose(self, message: str) -> None:
        if self.verbose_enabled:
            print(f"[verbose] {message}")

    def info(self, message: str) -> None:
        print(message)
