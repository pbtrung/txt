"""R2 (S3-compatible) object storage client (see docs/data_model.md's txt_parts)."""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor

import boto3

from . import constants as c
from .creds import R2Config

logger = logging.getLogger(__name__)

# Shared across every R2Client instance so --add-txt/--download never run more
# than R2_NUM_THREADS blocking S3 calls at once, no matter how many files or
# parts are in flight concurrently.
_executor = ThreadPoolExecutor(max_workers=c.R2_NUM_THREADS)


class R2Client:
    """Thin wrapper around boto3's S3 client, using an R2Config's read-write keys."""

    def __init__(self, r2_config: R2Config) -> None:
        if not (
            r2_config.read_write_access_key_id
            and r2_config.read_write_secret_access_key
        ):
            raise ValueError("r2_config must have read_write keys to upload objects")
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

    async def put_async(self, key: str, body: bytes) -> None:
        await asyncio.get_running_loop().run_in_executor(
            _executor, self.put, key, body
        )

    async def get_async(self, key: str) -> bytes:
        return await asyncio.get_running_loop().run_in_executor(
            _executor, self.get, key
        )

    async def delete_async(self, key: str) -> None:
        await asyncio.get_running_loop().run_in_executor(
            _executor, self.delete, key
        )
