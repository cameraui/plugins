from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

T = TypeVar("T")

_PREPARE_WORKERS = min(8, os.cpu_count() or 4)
_prepare_executor = ThreadPoolExecutor(max_workers=_PREPARE_WORKERS, thread_name_prefix="ml-prepare")


async def run_prepare(fn: Callable[[], T]) -> T:
    return await asyncio.get_event_loop().run_in_executor(_prepare_executor, fn)


def prepare_executor() -> ThreadPoolExecutor:
    return _prepare_executor
