from txt.firebase_auth import FirebaseAuth


def test_sign_in_uses_a_bounded_network_timeout(monkeypatch):
    captured = {}

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"localId": "owner"}

    def post(*args, **kwargs):
        captured.update(kwargs)
        return Response()

    monkeypatch.setattr("txt.firebase_auth.requests.post", post)

    assert FirebaseAuth("api-key").sign_in("owner@example.com", "secret") == "owner"
    assert captured["timeout"] == (3.05, 10)
