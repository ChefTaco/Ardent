"""Run the pinned Hermes A2A adapter with a deterministic test-only reply handler."""

import asyncio
import os
import signal
import sys

from gateway.config import PlatformConfig
from plugins.platforms.a2a.adapter import A2AAdapter


async def main() -> None:
    port = int(sys.argv[1])
    os.environ["A2A_PORT"] = str(port)
    os.environ["A2A_HOST"] = "127.0.0.1"
    os.environ["A2A_PUBLIC_URL"] = f"http://127.0.0.1:{port}"
    os.environ["A2A_PEER_TOKENS"] = "ardent:hermes-fixture-token-1234567890"
    os.environ["A2A_TRUSTED_PEERS"] = "ardent"
    adapter = A2AAdapter(PlatformConfig(enabled=True, extra={"port": port}))
    adapter.set_message_handler(lambda _event: asyncio.sleep(0))

    async def deterministic_reply(event) -> None:
        await adapter.send(event.source.chat_id, "HERMES_PINNED_OK", metadata={"notify": True})

    adapter.handle_message = deterministic_reply
    if not await adapter.connect():
        raise RuntimeError("Pinned Hermes A2A adapter failed to bind")
    print("READY", flush=True)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    try:
        await stop.wait()
    finally:
        await adapter.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
