import txt.r2_client as r2_client_module
from txt.creds import R2Config
from txt.r2_client import R2Client

CONFIG = R2Config(
    endpoint="https://x.r2.cloudflarestorage.com",
    read_only_access_key_id="ro-id",
    read_only_secret_access_key="ro-secret",
    read_write_access_key_id="rw-id",
    read_write_secret_access_key="rw-secret",
    region="auto",
    bucket="my-bucket",
)


class FakeS3Client:
    def __init__(self):
        self.put_calls = []

    def put_object(self, Bucket, Key, Body):
        self.put_calls.append((Bucket, Key, Body))


def test_client_built_with_read_write_creds_and_endpoint(monkeypatch):
    captured = {}

    def fake_boto3_client(service, **kwargs):
        captured["service"] = service
        captured["kwargs"] = kwargs
        return FakeS3Client()

    monkeypatch.setattr(r2_client_module.boto3, "client", fake_boto3_client)
    R2Client(CONFIG)

    assert captured["service"] == "s3"
    assert captured["kwargs"]["endpoint_url"] == CONFIG.endpoint
    assert captured["kwargs"]["aws_access_key_id"] == "rw-id"
    assert captured["kwargs"]["aws_secret_access_key"] == "rw-secret"
    assert captured["kwargs"]["region_name"] == "auto"


def test_put_object_forwards_bucket_key_and_body(monkeypatch):
    fake = FakeS3Client()
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    R2Client(CONFIG).put_object("t/prefix/key", b"hello")

    assert fake.put_calls == [("my-bucket", "t/prefix/key", b"hello")]
