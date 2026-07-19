"""R2 (S3-compatible) object storage client (see docs/data_model.md's txt_parts)."""

import logging

import boto3

from .creds import R2Config

logger = logging.getLogger(__name__)


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
