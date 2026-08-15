import io

import botocore.exceptions

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
    def __init__(self, pages=None, prefix_pages=None, objects=None):
        self.put_calls = []
        self.delete_calls = []
        self._pages = pages or []
        self._prefix_pages = prefix_pages or []
        self._objects = objects or {}

    def put_object(self, Bucket, Key, Body):
        self.put_calls.append((Bucket, Key, Body))

    def get_object(self, Bucket, Key):
        if Key not in self._objects:
            raise botocore.exceptions.ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "not found"}}, "GetObject"
            )
        return {"Body": io.BytesIO(self._objects[Key])}

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None, Delimiter=None):
        index = 0 if ContinuationToken is None else int(ContinuationToken)
        pages = self._prefix_pages if Delimiter else self._pages
        page = pages[index]
        key = "CommonPrefixes" if Delimiter else "Contents"
        item_key = "Prefix" if Delimiter else "Key"
        resp = {key: [{item_key: v} for v in page]}
        if index + 1 < len(pages):
            resp["IsTruncated"] = True
            resp["NextContinuationToken"] = str(index + 1)
        return resp

    def delete_objects(self, Bucket, Delete):
        self.delete_calls.append((Bucket, [o["Key"] for o in Delete["Objects"]]))


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


def test_get_object_returns_bytes_when_present(monkeypatch):
    fake = FakeS3Client(objects={"t/key": b"hello"})
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).get_object("t/key") == b"hello"


def test_get_object_returns_none_when_missing(monkeypatch):
    fake = FakeS3Client()
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).get_object("missing") is None


def test_list_keys_follows_pagination(monkeypatch):
    fake = FakeS3Client(pages=[["a", "b"], ["c"]])
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).list_keys("t/") == ["a", "b", "c"]


def test_list_keys_single_page(monkeypatch):
    fake = FakeS3Client(pages=[["only"]])
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).list_keys("b/") == ["only"]


def test_delete_keys_batches_at_1000(monkeypatch):
    fake = FakeS3Client()
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)
    keys = [f"k{i}" for i in range(1500)]

    R2Client(CONFIG).delete_keys(keys)

    assert len(fake.delete_calls) == 2
    assert len(fake.delete_calls[0][1]) == 1000
    assert len(fake.delete_calls[1][1]) == 500


def test_delete_keys_noop_for_empty_list(monkeypatch):
    fake = FakeS3Client()
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    R2Client(CONFIG).delete_keys([])

    assert fake.delete_calls == []


def test_list_common_prefixes_follows_pagination(monkeypatch):
    fake = FakeS3Client(prefix_pages=[["a/", "b/"], ["c/"]])
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).list_common_prefixes() == ["a/", "b/", "c/"]


def test_list_common_prefixes_single_page(monkeypatch):
    fake = FakeS3Client(prefix_pages=[["only/"]])
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).list_common_prefixes() == ["only/"]


def test_list_common_prefixes_does_not_enumerate_individual_keys(monkeypatch):
    fake = FakeS3Client(pages=[["should-not-appear"]], prefix_pages=[["real/"]])
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).list_common_prefixes() == ["real/"]
