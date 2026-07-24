"""--purge-bucket and --txt-clean-bucket: bulk R2 housekeeping, independent
of a single txt (see docs/data_model.md).
"""

import asyncio
import logging

from .creds import AdminCreds
from .owner import TxtOwner
from .r2 import R2Client

logger = logging.getLogger(__name__)


class BucketPurger:
    """Deletes every object in the R2 bucket, with no DB awareness at all --
    unlike --txt-delete/--txt-clean-bucket, this isn't scoped to any account's
    known txt_parts.
    """

    def __init__(self, creds: AdminCreds) -> None:
        self.r2 = R2Client(creds.r2_config)

    async def purge_all(self) -> int:
        keys = await self.r2.list_keys_async()
        logger.info("Found %d object(s) in the R2 bucket", len(keys))
        await asyncio.gather(*(self.r2.delete_async(key) for key in keys))
        logger.info("Purged %d object(s) from the R2 bucket", len(keys))
        return len(keys)


class TxtBucketCleaner(TxtOwner):
    """Deletes every R2 object not referenced by any of the owner's txt_parts.

    Unlike BucketPurger, this only ever deletes objects that this account's
    own txt_parts rows don't point to -- everything else in the bucket
    (including another account's objects, if the bucket is ever shared) is
    left alone.
    """

    def _known_raw_paths(self, user_id: int, umk: bytes) -> set[str]:
        txt_ids = self._txt_ids(user_id)
        known: set[str] = set()
        for i, txt_id in enumerate(txt_ids, start=1):
            txt_key = self._txt_key(txt_id, umk)
            raw_paths = self._part_raw_paths(txt_id, txt_key)
            known.update(raw_paths)
            logger.debug(
                "txt_id=%d (%d/%d): %d known part path(s)",
                txt_id,
                i,
                len(txt_ids),
                len(raw_paths),
            )
        # This account's single txt_metadata object (if it's been migrated to
        # the R2-backed format) -- otherwise still-live content would look
        # orphaned and get deleted below.
        metadata_raw_path = self._txt_metadata_raw_path(user_id, umk)
        if metadata_raw_path is not None:
            known.add(metadata_raw_path)
        return known

    async def clean_bucket(self) -> int:
        user_id = self._owner_user_id()
        umk = self._owner_umk(user_id)
        known = self._known_raw_paths(user_id, umk)
        logger.info(
            "Found %d known part path(s) in DB for user_id=%d", len(known), user_id
        )
        keys = await self.r2.list_keys_async()
        logger.info("Found %d object(s) in the R2 bucket", len(keys))
        orphaned = [key for key in keys if key not in known]
        logger.info("Found %d orphaned object(s) not present in DB", len(orphaned))
        await asyncio.gather(*(self.r2.delete_async(key) for key in orphaned))
        logger.info("Deleted %d orphaned object(s) from the R2 bucket", len(orphaned))
        return len(orphaned)
