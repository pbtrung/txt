from datetime import datetime


class Logger:
    def __init__(self, verbose: bool = False):
        self.verbose_enabled = verbose

    def verbose(self, message: str) -> None:
        if self.verbose_enabled:
            print(f"{self._timestamp()}  {message}")

    def info(self, message: str) -> None:
        print(f"{self._timestamp()}  {message}")

    def _timestamp(self) -> str:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
