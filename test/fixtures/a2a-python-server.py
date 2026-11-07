"""Independent a2a-sdk 1.0.3 server fixture. Run only from Ardent tests."""

import asyncio
import sys
from uuid import uuid4

import grpc
import uvicorn
from starlette.applications import Starlette

from a2a.server.agent_execution import AgentExecutor
from a2a.server.request_handlers.default_request_handler_v2 import DefaultRequestHandlerV2
from a2a.server.request_handlers.grpc_handler import GrpcHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes, create_rest_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill, Message, Part, Role
from a2a.types.a2a_pb2_grpc import add_A2AServiceServicer_to_server


class EchoExecutor(AgentExecutor):
    async def execute(self, context, event_queue) -> None:
        await event_queue.enqueue_event(
            Message(
                message_id=str(uuid4()),
                context_id=context.context_id or str(uuid4()),
                role=Role.ROLE_AGENT,
                parts=[Part(text="PYTHON_REFERENCE_OK")],
            )
        )

    async def cancel(self, context, event_queue) -> None:
        raise AssertionError("Immediate fixture response cannot be canceled")


async def main() -> None:
    http_port, grpc_port = map(int, sys.argv[1:3])
    card = AgentCard(
        name="Python reference",
        description="Independent A2A interoperability fixture",
        version="1.0.3",
        supported_interfaces=[
            AgentInterface(url=f"http://127.0.0.1:{http_port}/a2a/jsonrpc", protocol_binding="JSONRPC", protocol_version="1.0"),
            AgentInterface(url=f"http://127.0.0.1:{http_port}/a2a/rest", protocol_binding="HTTP+JSON", protocol_version="1.0"),
            AgentInterface(url=f"127.0.0.1:{grpc_port}", protocol_binding="GRPC", protocol_version="1.0"),
        ],
        capabilities=AgentCapabilities(streaming=True),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
        skills=[AgentSkill(id="echo", name="Echo", description="Return a fixture answer", tags=["test"])],
    )
    handler = DefaultRequestHandlerV2(EchoExecutor(), InMemoryTaskStore(), card)
    app = Starlette(routes=[
        *create_agent_card_routes(card),
        *create_jsonrpc_routes(handler, "/a2a/jsonrpc"),
        *create_rest_routes(handler, path_prefix="/a2a/rest"),
    ])
    grpc_server = grpc.aio.server()
    add_A2AServiceServicer_to_server(GrpcHandler(handler), grpc_server)
    grpc_server.add_insecure_port(f"127.0.0.1:{grpc_port}")
    await grpc_server.start()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=http_port, log_level="error"))
    http_task = asyncio.create_task(server.serve())
    while not server.started:
        if http_task.done():
            raise RuntimeError("HTTP fixture failed to start")
        await asyncio.sleep(0.01)
    print("READY", flush=True)
    try:
        await http_task
    finally:
        await grpc_server.stop(grace=0)


if __name__ == "__main__":
    asyncio.run(main())
