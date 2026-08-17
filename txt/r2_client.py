from collections.abc import Callable
from dataclasses import dataclass

import boto3
import botocore.exceptions

from .creds import R2Config


@dataclass(frozen=True)
class R2Object:
    body: bytes
    etag: str


class R2PreconditionFailed(RuntimeError):
    pass


class R2Client:
    def __init__(self, config: R2Config):
        self.bucket = config.bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=config.endpoint,
            aws_access_key_id=config.read_write_access_key_id,
            aws_secret_access_key=config.read_write_secret_access_key,
            region_name=config.region,
        )

    def get_object(self, key: str) -> bytes | None:
        resp = self._get_object_response(key)
        return resp["Body"].read() if resp is not None else None

    def get_object_with_etag(self, key: str) -> R2Object | None:
        resp = self._get_object_response(key)
        if resp is None:
            return None
        etag = resp.get("ETag")
        if not isinstance(etag, str) or not etag:
            raise ValueError(f"R2 GET {key} returned no ETag")
        return R2Object(resp["Body"].read(), etag)

    def _get_object_response(self, key: str) -> dict | None:
        try:
            return self._s3.get_object(Bucket=self.bucket, Key=key)
        except botocore.exceptions.ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
                return None
            raise

    def put_object(
        self,
        key: str,
        body: bytes,
        *,
        if_match: str | None = None,
        if_none_match: bool = False,
    ) -> str | None:
        kwargs = self._put_kwargs(key, body, if_match, if_none_match)
        response = self._put_response(key, kwargs)
        etag = response.get("ETag")
        return etag if isinstance(etag, str) else None

    def _put_kwargs(self, key, body, if_match, if_none_match) -> dict:
        if if_match is not None and if_none_match:
            raise ValueError("if_match and if_none_match are mutually exclusive")
        kwargs = {"Bucket": self.bucket, "Key": key, "Body": body}
        if if_match is not None:
            kwargs["IfMatch"] = if_match
        elif if_none_match:
            kwargs["IfNoneMatch"] = "*"
        return kwargs

    def _put_response(self, key: str, kwargs: dict) -> dict:
        try:
            return self._s3.put_object(**kwargs)
        except botocore.exceptions.ClientError as exc:
            if _is_precondition_failure(exc):
                raise R2PreconditionFailed(
                    f"R2 PUT {key} conflicted with a newer object"
                ) from exc
            raise

    def list_keys(
        self, prefix: str, on_progress: Callable[[int], None] | None = None
    ) -> list[str]:
        keys, token = [], None
        while True:
            kwargs = {"Bucket": self.bucket, "Prefix": prefix, "MaxKeys": 1000}
            if token:
                kwargs["ContinuationToken"] = token
            resp = self._s3.list_objects_v2(**kwargs)
            keys.extend(obj["Key"] for obj in resp.get("Contents", []))
            if on_progress is not None:
                on_progress(len(keys))
            if not resp.get("IsTruncated"):
                return keys
            token = resp["NextContinuationToken"]

    def list_common_prefixes(self, prefix: str = "", delimiter: str = "/") -> list[str]:
        # Cheap top-level enumeration (e.g. every {db_prefix}/ segment)
        # without listing every object underneath each one.
        prefixes, token = [], None
        while True:
            kwargs = {"Bucket": self.bucket, "Prefix": prefix, "Delimiter": delimiter}
            if token:
                kwargs["ContinuationToken"] = token
            resp = self._s3.list_objects_v2(**kwargs)
            prefixes.extend(p["Prefix"] for p in resp.get("CommonPrefixes", []))
            if not resp.get("IsTruncated"):
                return prefixes
            token = resp["NextContinuationToken"]

    def delete_keys(
        self, keys: list[str], on_progress: Callable[[int], None] | None = None
    ) -> None:
        for i in range(0, len(keys), 1000):
            batch = keys[i : i + 1000]
            self._s3.delete_objects(
                Bucket=self.bucket, Delete={"Objects": [{"Key": k} for k in batch]}
            )
            if on_progress is not None:
                on_progress(i + len(batch))


def _is_precondition_failure(error: botocore.exceptions.ClientError) -> bool:
    code = error.response.get("Error", {}).get("Code")
    status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return code in ("PreconditionFailed", "412") or status == 412
