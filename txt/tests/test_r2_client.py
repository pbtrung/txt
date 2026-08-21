import io

import botocore.exceptions
import pytest

import txt.r2_client as r2_client_module
from txt.creds import R2Config
from txt.r2_client import R2Client, R2Object, R2PreconditionFailed

CONFIG = R2Config(
    endpoint="https://x.r2.cloudflarestorage.com",
    read_write_access_key_id="rw-id",
    read_write_secret_access_key="rw-secret",
    region="auto",
    bucket="my-bucket",
)


class FakeS3Client:
    def __init__(self, pages=None, objects=None, delete_responses=None):
        self.put_calls = []
        self.put_conditions = []
        self.delete_calls = []
        self._pages = pages or []
        self._objects = objects or {}
        self._delete_responses = list(delete_responses or [])

    def put_object(self, Bucket, Key, Body, IfMatch=None, IfNoneMatch=None):
        self.put_calls.append((Bucket, Key, Body))
        self.put_conditions.append((IfMatch, IfNoneMatch))
        return {"ETag": '"new-etag"'}

    def get_object(self, Bucket, Key):
        if Key not in self._objects:
            raise botocore.exceptions.ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "not found"}}, "GetObject"
            )
        return {"Body": io.BytesIO(self._objects[Key]), "ETag": '"etag"'}

    def list_objects_v2(
        self,
        Bucket,
        Prefix,
        ContinuationToken=None,
        Delimiter=None,
        MaxKeys=None,
    ):
        index = 0 if ContinuationToken is None else int(ContinuationToken)
        page = self._pages[index]
        resp = {"Contents": [{"Key": value} for value in page]}
        if index + 1 < len(self._pages):
            resp["IsTruncated"] = True
            resp["NextContinuationToken"] = str(index + 1)
        return resp

    def delete_objects(self, Bucket, Delete):
        self.delete_calls.append((Bucket, [o["Key"] for o in Delete["Objects"]]))
        return self._delete_responses.pop(0) if self._delete_responses else {}


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
    assert fake.put_conditions == [(None, None)]


def test_put_object_forwards_conditional_headers_and_returns_etag(monkeypatch):
    fake = FakeS3Client()
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)
    client = R2Client(CONFIG)

    assert client.put_object("db", b"one", if_match='"old"') == '"new-etag"'
    assert client.put_object("new-db", b"two", if_none_match=True) == '"new-etag"'

    assert fake.put_conditions == [('"old"', None), (None, "*")]


def test_put_object_maps_precondition_failure(monkeypatch):
    fake = FakeS3Client()

    def conflict(**kwargs):
        raise botocore.exceptions.ClientError(
            {
                "Error": {"Code": "PreconditionFailed", "Message": "conflict"},
                "ResponseMetadata": {"HTTPStatusCode": 412},
            },
            "PutObject",
        )

    fake.put_object = conflict
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    with pytest.raises(R2PreconditionFailed, match="newer object"):
        R2Client(CONFIG).put_object("db", b"one", if_match='"old"')


def test_get_object_returns_bytes_when_present(monkeypatch):
    fake = FakeS3Client(objects={"t/key": b"hello"})
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).get_object("t/key") == b"hello"


def test_get_object_with_etag_returns_both_values(monkeypatch):
    fake = FakeS3Client(objects={"t/key": b"hello"})
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).get_object_with_etag("t/key") == R2Object(
        b"hello", '"etag"'
    )


def test_etag_is_required_only_for_etag_reads(monkeypatch):
    fake = FakeS3Client(objects={"t/key": b"hello"})
    fake.get_object = lambda **kwargs: {"Body": io.BytesIO(b"hello")}
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)
    client = R2Client(CONFIG)

    assert client.get_object("t/key") == b"hello"
    with pytest.raises(ValueError, match="returned no ETag"):
        client.get_object_with_etag("t/key")


def test_get_object_returns_none_when_missing(monkeypatch):
    fake = FakeS3Client()
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).get_object("missing") is None


def test_list_keys_follows_pagination(monkeypatch):
    fake = FakeS3Client(pages=[["a", "b"], ["c"]])
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    assert R2Client(CONFIG).list_keys("t/") == ["a", "b", "c"]


def test_list_keys_reports_progress_after_each_page(monkeypatch):
    fake = FakeS3Client(pages=[[f"a{i}" for i in range(1000)], ["last"]])
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)
    progress = []

    R2Client(CONFIG).list_keys("", progress.append)

    assert progress == [1000, 1001]


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


def test_delete_keys_reports_progress_after_each_batch(monkeypatch):
    fake = FakeS3Client()
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)
    progress = []

    R2Client(CONFIG).delete_keys([f"k{i}" for i in range(1500)], progress.append)

    assert progress == [1000, 1500]


def test_delete_keys_noop_for_empty_list(monkeypatch):
    fake = FakeS3Client()
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    R2Client(CONFIG).delete_keys([])

    assert fake.delete_calls == []


def test_delete_keys_reports_partial_s3_failures(monkeypatch):
    fake = FakeS3Client(
        delete_responses=[{"Errors": [{"Key": "locked", "Code": "AccessDenied"}]}]
    )
    monkeypatch.setattr(r2_client_module.boto3, "client", lambda *a, **k: fake)

    with pytest.raises(RuntimeError, match=r"locked \(AccessDenied\)"):
        R2Client(CONFIG).delete_keys(["locked"])
