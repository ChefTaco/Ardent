"""Independent a2a-sdk 0.3.26 JSON-RPC server fixture. Test-only process."""

import asyncio
import sys
from uuid import uuid4

import uvicorn
from a2a.server.agent_execution import AgentExecutor
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentSkill, Message, Part, Role, TextPart


class EchoExecutor(AgentExecutor):
    async def execute(self, context, event_queue) -> None:
        await event_queue.enqueue_event(
            Message(
                messageId=str(uuid4()), contextId=context.context_id or str(uuid4()),
                role=Role.agent, parts=[Part(TextPart(text="PYTHON_V03_OK"))],
            )
        )

    async def cancel(self, context, event_queue) -> None:
        raise AssertionError("Immediate fixture response cannot be canceled")


async def main() -> None:
    port = int(sys.argv[1])
    card = AgentCard(
        name="Python v0.3 reference", description="Independent compatibility fixture", version="0.3.26",
        url=f"http://127.0.0.1:{port}/a2a/jsonrpc", protocolVersion="0.3.0",
        capabilities=AgentCapabilities(streaming=True), defaultInputModes=["text/plain"],
        defaultOutputModes=["text/plain"],
        skills=[AgentSkill(id="echo", name="Echo", description="Return a fixture answer", tags=["test"])],
    )
    handler = DefaultRequestHandler(EchoExecutor(), InMemoryTaskStore())
    app = A2AStarletteApplication(card, handler).build(rpc_url="/a2a/jsonrpc")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            raise RuntimeError("v0.3 fixture did not start")
        await asyncio.sleep(0.01)
    print("READY", flush=True)
    await task


if __name__ == "__main__":
    asyncio.run(main())
