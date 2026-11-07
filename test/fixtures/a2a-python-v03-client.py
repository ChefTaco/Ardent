"""Independent a2a-sdk 0.3.26 JSON-RPC client probe. Test-only fixture."""

import asyncio
import json
import sys
from uuid import uuid4

import httpx
from a2a.client import A2AClient
from a2a.types import Message, MessageSendParams, Part, Role, SendMessageRequest, Task, TextPart


async def main() -> None:
    base, token = sys.argv[1:3]
    async with httpx.AsyncClient(timeout=15, trust_env=False) as http:
        card_response = await http.get(f"{base}/.well-known/agent-card.json", headers={"A2A-Version": "0.3"})
        card_response.raise_for_status()
        card = card_response.json()
        if not str(card.get("protocolVersion", "")).startswith("0.3"):
            raise AssertionError("Expected a separately advertised v0.3 card")
        client = A2AClient(http, url=f"{base}/a2a/jsonrpc")
        response = await client.send_message(
            SendMessageRequest(
                id=str(uuid4()),
                params=MessageSendParams(
                    message=Message(
                        messageId=str(uuid4()),
                        role=Role.user,
                        parts=[Part(TextPart(text="Return an independent v0.3 answer"))],
                    )
                ),
            ),
            http_kwargs={"headers": {"Authorization": f"Bearer {token}", "A2A-Version": "0.3"}},
        )
        result = response.root
        if not hasattr(result, "result") or not isinstance(result.result, Task):
            raise AssertionError(f"Expected v0.3 task result, got {result}")
        if result.result.status.state.value != "completed":
            raise AssertionError(f"v0.3 task did not complete: {result.result.status.state}")
        print(json.dumps({"protocol": "0.3", "task_id": result.result.id, "state": result.result.status.state.value}))


if __name__ == "__main__":
    asyncio.run(main())
