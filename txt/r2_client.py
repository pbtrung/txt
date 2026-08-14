import boto3

from .creds import R2Config


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

    def put_object(self, key: str, body: bytes) -> None:
        self._s3.put_object(Bucket=self.bucket, Key=key, Body=body)

    def list_keys(self, prefix: str) -> list[str]:
        keys, token = [], None
        while True:
            kwargs = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            resp = self._s3.list_objects_v2(**kwargs)
            keys.extend(obj["Key"] for obj in resp.get("Contents", []))
            if not resp.get("IsTruncated"):
                return keys
            token = resp["NextContinuationToken"]

    def delete_keys(self, keys: list[str]) -> None:
        for i in range(0, len(keys), 1000):
            batch = keys[i : i + 1000]
            self._s3.delete_objects(
                Bucket=self.bucket, Delete={"Objects": [{"Key": k} for k in batch]}
            )
