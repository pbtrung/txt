"""R2 (S3-compatible) object storage client (see docs/data_model.md's txt_parts)."""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor

import boto3

from . import constants as c
from .creds import R2Config

logger = logging.getLogger(__name__)

# Shared across every R2Client instance so --txt-ingest/--txt-download/--txt-delete
# never run more than R2_NUM_THREADS blocking S3 calls at once, no matter how
# many files or parts are in flight concurrently.
_executor = ThreadPoolExecutor(max_workers=c.R2_NUM_THREADS)

# put_async/get_async/delete_async/list_keys_async retry on failure with
# exponential backoff before giving up.
_RETRY_DELAYS = (2, 4, 8)
_MAX_ATTEMPTS = 1 + len(_RETRY_DELAYS)


def _require_read_write_keys(r2_config: R2Config) -> None:
    if not (
        r2_config.read_write_access_key_id and r2_config.read_write_secret_access_key
    ):
        raise ValueError("r2_config must have read_write keys to upload objects")


class R2Client:
    """Thin wrapper around boto3's S3 client, using an R2Config's read-write keys."""

    def __init__(self, r2_config: R2Config) -> None:
        _require_read_write_keys(r2_config)
        self._bucket = r2_config.bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=r2_config.endpoint,
            aws_access_key_id=r2_config.read_write_access_key_id,
            aws_secret_access_key=r2_config.read_write_secret_access_key,
            region_name=r2_config.region,
        )
        logger.debug(
            "R2 client ready for bucket=%r at %s", self._bucket, r2_config.endpoint
        )

    def put(self, key: str, body: bytes) -> None:
        logger.debug(
            "Uploading %s (%d bytes) to bucket=%r", key, len(body), self._bucket
        )
        self._client.put_object(Bucket=self._bucket, Key=key, Body=body)
        logger.debug("Uploaded %s", key)

    def get(self, key: str) -> bytes:
        logger.debug("Downloading %s from bucket=%r", key, self._bucket)
        body = self._client.get_object(Bucket=self._bucket, Key=key)["Body"].read()
        logger.debug("Downloaded %s (%d bytes)", key, len(body))
        return body

    def delete(self, key: str) -> None:
        logger.debug("Deleting %s from bucket=%r", key, self._bucket)
        self._client.delete_object(Bucket=self._bucket, Key=key)
        logger.debug("Deleted %s", key)

    def list_keys(self) -> list[str]:
        """Every object key in the bucket, across as many list_objects_v2
        pages as it takes.
        """
        keys = []
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._bucket):
            keys.extend(obj["Key"] for obj in page.get("Contents", []))
        logger.debug("Listed %d key(s) in bucket=%r", len(keys), self._bucket)
        return keys

    @staticmethod
    def _log_retry(what: str, attempt: int, delay: int, exc: Exception) -> None:
        logger.warning(
            "%s failed (attempt %d/%d): %s -- retrying in %ds",
            what,
            attempt,
            _MAX_ATTEMPTS,
            exc,
            delay,
        )

    @staticmethod
    async def _with_retries(what: str, fn, *args):
        """Runs fn(*args) in the shared executor, retrying with backoff."""
        last_exc: Exception | None = None
        for attempt in range(_MAX_ATTEMPTS):
            if attempt > 0:
                delay = _RETRY_DELAYS[attempt - 1]
                R2Client._log_retry(what, attempt, delay, last_exc)
                await asyncio.sleep(delay)
            try:
                loop = asyncio.get_running_loop()
                return await loop.run_in_executor(_executor, fn, *args)
            except Exception as exc:
                last_exc = exc
        logger.error("%s failed after %d attempt(s), giving up", what, _MAX_ATTEMPTS)
        raise last_exc

    async def put_async(self, key: str, body: bytes) -> None:
        await self._with_retries(f"put {key}", self.put, key, body)

    async def get_async(self, key: str) -> bytes:
        return await self._with_retries(f"get {key}", self.get, key)

    async def delete_async(self, key: str) -> None:
        await self._with_retries(f"delete {key}", self.delete, key)

    async def list_keys_async(self) -> list[str]:
        return await self._with_retries("list bucket keys", self.list_keys)
