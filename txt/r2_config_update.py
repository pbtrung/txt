"""--update-r2-config: persists read-write R2 keys into the admin's own
r2_config row (see docs/data_model.md).
"""

import json
import logging

from .crypto import Blob
from .owner import TxtOwner

logger = logging.getLogger(__name__)


class R2ConfigUpdater(TxtOwner):
    """Overwrites the admin's own r2_config row to include read-write R2 keys.

    txt/admin.py's _ensure_r2_config only ever persists the read-only key
    pair to Turso when first creating this row, regardless of role -- by
    design, so a leaked or misconfigured row can't carry write access it
    isn't supposed to. This is the explicit, admin-only opt-in that changes
    that for the admin's own account specifically: creds.r2_config already
    carries read-write keys locally (AdminCreds requires them), and this
    persists them into that same row, wrapped under the admin's own umk
    exactly like before -- just with a fuller payload. Every other
    account's r2_config row is untouched.
    """

    def run(self) -> int:
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        r2 = self.creds.r2_config
        config = json.dumps(
            {
                "endpoint": r2.endpoint,
                "region": r2.region,
                "bucket": r2.bucket,
                "read_only_access_key_id": r2.read_only_access_key_id,
                "read_only_secret_access_key": r2.read_only_secret_access_key,
                "read_write_access_key_id": r2.read_write_access_key_id,
                "read_write_secret_access_key": r2.read_write_secret_access_key,
            }
        ).encode()
        blob = Blob.encrypt(umk, config, compressed=True)
        self.db.conn.execute(
            "UPDATE r2_config SET config = ? WHERE user_id = ?", (blob, user_id)
        )
        self.db.conn.commit()
        logger.info(
            "Updated r2_config for user_id=%d to include read-write keys", user_id
        )
        return user_id
