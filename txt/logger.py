from datetime import datetime
from pathlib import Path


class Logger:
    def __init__(self, verbose: bool = False, log_path: str | Path | None = None):
        self.verbose_enabled = verbose
        self.log_path = Path(log_path) if log_path is not None else None
        self._log_file = None

    def verbose(self, message: str) -> None:
        if self.verbose_enabled:
            self._log(message)

    def info(self, message: str) -> None:
        self._log(message)

    def _log(self, message: str) -> None:
        line = f"{self._timestamp()}  {message}"
        print(line)
        if self.log_path is not None:
            if self._log_file is None:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                self._log_file = self.log_path.open("a", encoding="utf-8", buffering=1)
            print(line, file=self._log_file, flush=True)

    def close(self) -> None:
        if self._log_file is not None:
            self._log_file.close()
            self._log_file = None

    def _timestamp(self) -> str:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
