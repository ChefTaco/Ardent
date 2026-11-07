"""Independent a2a-sdk 1.0.3 client probe. Run only from Ardent tests."""

import asyncio
import json
import sys
from uuid import uuid4

import httpx
import grpc
from google.protobuf.struct_pb2 import Value

from a2a.client import ClientConfig, ClientCallContext
from a2a.client.transports.grpc import GrpcTransport
from a2a.client.transports.jsonrpc import JsonRpcTransport
from a2a.client.transports.rest import RestTransport
from a2a.types import (
    AgentCard,
    CancelTaskRequest,
    DeleteTaskPushNotificationConfigRequest,
    GetExtendedAgentCardRequest,
    GetTaskRequest,
    GetTaskPushNotificationConfigRequest,
    ListTasksRequest,
    ListTaskPushNotificationConfigsRequest,
    Message,
    Part,
    Role,
    SendMessageRequest,
    SendMessageConfiguration,
    SubscribeToTaskRequest,
    TaskPushNotificationConfig,
    TaskState,
)


async def main() -> None:
    http_url, grpc_url, binding, token = sys.argv[1:5]
    async with httpx.AsyncClient(timeout=15, trust_env=False) as http:
        card_response = await http.get(f"{http_url}/.well-known/agent-card.json", headers={"A2A-Version": "1.0"})
        if card_response.status_code != 200:
            raise AssertionError(f"Agent Card HTTP {card_response.status_code}: {card_response.text[:500]}")
        card = AgentCard()
        from google.protobuf.json_format import ParseDict

        ParseDict(card_response.json(), card)
        if binding == "jsonrpc":
            transport = JsonRpcTransport(http, card, f"{http_url}/a2a/jsonrpc")
        elif binding == "http-json":
            transport = RestTransport(http, card, f"{http_url}/a2a/rest")
        elif binding == "grpc":
            transport = GrpcTransport.create(card, grpc_url, ClientConfig(grpc_channel_factory=grpc.aio.insecure_channel))
        else:
            raise ValueError(binding)
        headers = {"Authorization": f"Bearer {token}"}
        if binding != "grpc":
            headers["A2A-Version"] = "1.0"
        context = ClientCallContext(timeout=15, service_parameters=headers)
        try:
            sent = await transport.send_message(
                SendMessageRequest(
                    message=Message(
                        message_id=str(uuid4()),
                        role=Role.ROLE_USER,
                        parts=[Part(text=f"Return PYTHON_{binding}_OK")],
                    )
                ),
                context=context,
            )
            if not sent.HasField("task"):
                raise AssertionError("Expected a task response")
            if sent.task.status.state != TaskState.TASK_STATE_COMPLETED:
                raise AssertionError(f"Task state was {sent.task.status.state}")
            task = await transport.get_task(GetTaskRequest(id=sent.task.id), context=context)
            if task.id != sent.task.id:
                raise AssertionError("GetTask returned a different task")
            listed = await transport.list_tasks(ListTasksRequest(page_size=10), context=context)
            if task.id not in {item.id for item in listed.tasks}:
                raise AssertionError("ListTasks omitted the task")
            config_id = f"reference-{binding}"
            created = await transport.create_task_push_notification_config(
                TaskPushNotificationConfig(task_id=task.id, id=config_id, url=f"{http_url}/reference-callback", token="notify-fixture"),
                context=context,
            )
            if created.id != config_id:
                raise AssertionError("Push config create returned the wrong ID")
            fetched = await transport.get_task_push_notification_config(GetTaskPushNotificationConfigRequest(task_id=task.id, id=config_id), context=context)
            if fetched.url != created.url:
                raise AssertionError("Push config get differed from create")
            configs = await transport.list_task_push_notification_configs(ListTaskPushNotificationConfigsRequest(task_id=task.id), context=context)
            if config_id not in {item.id for item in configs.configs}:
                raise AssertionError("Push config list omitted the created ID")
            if binding == "http-json":
                # a2a-sdk 1.0.3 tries JSON-decoding the normative 204 empty body.
                deleted = await http.delete(
                    f"{http_url}/a2a/rest/tasks/{task.id}/pushNotificationConfigs/{config_id}", headers=headers
                )
                if deleted.status_code != 204:
                    raise AssertionError(f"REST push config delete HTTP {deleted.status_code}")
            else:
                await transport.delete_task_push_notification_config(DeleteTaskPushNotificationConfigRequest(task_id=task.id, id=config_id), context=context)
            configs = await transport.list_task_push_notification_configs(ListTaskPushNotificationConfigsRequest(task_id=task.id), context=context)
            if any(item.id == config_id for item in configs.configs):
                raise AssertionError("Push config delete did not remove the ID")
            extended = await transport.get_extended_agent_card(GetExtendedAgentCardRequest(), context=context)
            if "assistant-team-result" not in {skill.id for skill in extended.skills}:
                raise AssertionError("Extended Agent Card omitted the authenticated team skill")
            stream_states = []
            async for event in transport.send_message_streaming(
                SendMessageRequest(
                    message=Message(
                        message_id=str(uuid4()),
                        role=Role.ROLE_USER,
                        parts=[Part(text="Stream independent client reply")],
                    )
                ),
                context=context,
            ):
                if event.HasField("status_update"):
                    stream_states.append(int(event.status_update.status.state))
            if int(TaskState.TASK_STATE_COMPLETED) not in stream_states:
                raise AssertionError(f"Streaming never completed: {stream_states}")
            reconnect = await transport.send_message(
                SendMessageRequest(
                    message=Message(message_id=str(uuid4()), role=Role.ROLE_USER, parts=[Part(text="PUSH_HOLD reconnect")]),
                    configuration=SendMessageConfiguration(return_immediately=True),
                ), context=context,
            )
            if not reconnect.HasField("task"):
                raise AssertionError("Reconnect task has no identity")
            first_subscription = transport.subscribe(SubscribeToTaskRequest(id=reconnect.task.id), context=context)
            try:
                await asyncio.wait_for(anext(first_subscription), timeout=3)
            finally:
                await first_subscription.aclose()
            reconnect_states = []
            async for event in transport.subscribe(SubscribeToTaskRequest(id=reconnect.task.id), context=context):
                if event.HasField("status_update"):
                    reconnect_states.append(int(event.status_update.status.state))
            if int(TaskState.TASK_STATE_COMPLETED) not in reconnect_states:
                raise AssertionError(f"Reconnect omitted terminal status: {reconnect_states}")
            settled = await transport.get_task(GetTaskRequest(id=reconnect.task.id), context=context)
            if settled.status.state != TaskState.TASK_STATE_COMPLETED:
                raise AssertionError("Disconnect changed durable task completion")
            multipart = await transport.send_message(
                SendMessageRequest(
                    message=Message(
                        message_id=str(uuid4()), role=Role.ROLE_USER,
                        parts=[
                            Part(text="Inspect these attached inputs"),
                            Part(data=Value(string_value="STRUCTURED_OK"), media_type="application/json"),
                            Part(raw=b"RAW_TEXT_OK", media_type="text/plain", filename="note.txt"),
                            Part(url="https://example.com/evidence.json", media_type="application/json", filename="evidence.json"),
                        ],
                    )
                ), context=context,
            )
            if not multipart.HasField("task") or multipart.task.status.state != TaskState.TASK_STATE_COMPLETED:
                raise AssertionError("Multipart task did not complete")
            history = multipart.task.history
            if not history or len(history[0].parts) != 4 or history[0].parts[1].data.string_value != "STRUCTURED_OK" or history[0].parts[2].raw != b"RAW_TEXT_OK":
                raise AssertionError("Multipart content did not round-trip in task history")
            unsupported = await transport.send_message(
                SendMessageRequest(message=Message(message_id=str(uuid4()), role=Role.ROLE_USER, parts=[Part(raw=b"fake-image", media_type="image/png", filename="image.png")])),
                context=context,
            )
            if not unsupported.HasField("task") or unsupported.task.status.state != TaskState.TASK_STATE_FAILED:
                raise AssertionError("Unsupported file content did not fail explicitly")
            first_page = await transport.list_tasks(ListTasksRequest(page_size=1), context=context)
            if len(first_page.tasks) != 1 or not first_page.next_page_token:
                raise AssertionError("Task pagination did not return a first-page cursor")
            second_page = await transport.list_tasks(ListTasksRequest(page_size=1, page_token=first_page.next_page_token), context=context)
            if len(second_page.tasks) != 1 or second_page.tasks[0].id == first_page.tasks[0].id:
                raise AssertionError("Task pagination repeated the first page")
            pending = await transport.send_message(
                SendMessageRequest(
                    message=Message(message_id=str(uuid4()), role=Role.ROLE_USER, parts=[Part(text="CANCEL_HOLD")]),
                    configuration=SendMessageConfiguration(return_immediately=True),
                ),
                context=context,
            )
            if not pending.HasField("task"):
                raise AssertionError("Expected a task for immediate return")
            if pending.task.status.state == TaskState.TASK_STATE_COMPLETED:
                raise AssertionError("Cancellation fixture task completed before cancel")
            if pending.task.status.state in (TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_CANCELED):
                raise AssertionError(f"Cancellation fixture task terminal before cancel: {pending.task.status.state} {pending.task.status.message}")
            before_cancel = await transport.get_task(GetTaskRequest(id=pending.task.id), context=context)
            if before_cancel.status.state in (TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_CANCELED):
                raise AssertionError(f"Cancellation fixture task became terminal before cancel: {before_cancel.status.state} {before_cancel.status.message}")
            subscription_states = []

            async def observe() -> None:
                async for event in transport.subscribe(SubscribeToTaskRequest(id=pending.task.id), context=context):
                    if event.HasField("status_update"):
                        subscription_states.append(int(event.status_update.status.state))

            observer = asyncio.create_task(observe())
            await asyncio.sleep(0.05)
            await transport.cancel_task(CancelTaskRequest(id=pending.task.id), context=context)
            cancelled = None
            for _ in range(20):
                cancelled = await transport.get_task(GetTaskRequest(id=pending.task.id), context=context)
                if cancelled.status.state == TaskState.TASK_STATE_CANCELED:
                    break
                await asyncio.sleep(0.05)
            if cancelled is None or cancelled.status.state != TaskState.TASK_STATE_CANCELED:
                raise AssertionError(f"Task cancellation did not settle: {cancelled.status.state if cancelled else 'missing'}")
            await asyncio.wait_for(observer, timeout=3)
            if int(TaskState.TASK_STATE_CANCELED) not in subscription_states:
                raise AssertionError(f"Subscription missed cancellation: {subscription_states}")
            pushed = await transport.send_message(
                SendMessageRequest(
                    message=Message(message_id=str(uuid4()), role=Role.ROLE_USER, parts=[Part(text="PUSH_HOLD")]),
                    configuration=SendMessageConfiguration(
                        return_immediately=True,
                        task_push_notification_config=TaskPushNotificationConfig(id=f"inline-{binding}", url=f"{http_url}/reference-callback", token="notify-fixture"),
                    ),
                ), context=context,
            )
            if not pushed.HasField("task"):
                raise AssertionError("Push task did not return a task ID")
            completed_push = None
            for _ in range(50):
                completed_push = await transport.get_task(GetTaskRequest(id=pushed.task.id), context=context)
                if completed_push.status.state == TaskState.TASK_STATE_COMPLETED:
                    break
                await asyncio.sleep(0.05)
            if completed_push is None or completed_push.status.state != TaskState.TASK_STATE_COMPLETED:
                raise AssertionError("Push task did not complete")
            print(json.dumps({"binding": binding, "task_id": task.id, "state": int(task.status.state), "stream_states": stream_states, "reconnect_states": reconnect_states, "extended_card": True, "pagination": True, "multipart": True, "unsupported_file_rejected": True, "cancelled": True, "subscription_states": subscription_states, "push_task_id": pushed.task.id, "push_config_crud": True}))
        finally:
            await transport.close()


if __name__ == "__main__":
    asyncio.run(main())
