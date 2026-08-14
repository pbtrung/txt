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
