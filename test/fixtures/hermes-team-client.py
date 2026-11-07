"""Use the accepted Hermes team contract and pinned Hermes wire client against Ardent."""

import importlib.util
import json
import sys
import time
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

from plugins.platforms.a2a import protocol


def load_module(path: str, name: str):
    spec = importlib.util.spec_from_file_location("accepted_hermes_team_" + name, Path(path) / (name + ".py"))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    url, token, contract_path = sys.argv[1:4]
    mode = sys.argv[4] if len(sys.argv) > 4 else "result"
    golden = mode == "golden"
    lifecycle = mode == "lifecycle"
    contracts = load_module(contract_path, "contracts")
    capabilities = load_module(contract_path, "capabilities")
    card_request = Request(url.rstrip("/") + "/.well-known/hermes-team-card.json", headers={"Authorization": "Bearer " + token})
    with urlopen(card_request, timeout=10) as response:
        card = json.load(response)
    meta = card["metadata"]["hermesTeam"]
    capabilities.validate_ardent_card(card, authenticated=True, source_digest=meta["sourceDigest"], task_policy_digest=meta["taskPolicyDigest"])
    try:
        capabilities.validate_ardent_card(card, authenticated=True, source_digest="0" * 64, task_policy_digest=meta["taskPolicyDigest"])
    except ValueError:
        pass
    else:
        raise AssertionError("Ardent release pin was not enforced")
    message_id = "team-golden" if golden else "team-" + uuid.uuid4().hex
    objective = "Golden news brief: report the dated publisher update" if golden else "CANCEL_HOLD accepted team budget boundary" if lifecycle else "Research the accepted Hermes team fixture topic"
    mission = {
        "id": "mission-golden" if golden else "mission-" + uuid.uuid4().hex,
        "revision": 1,
        "parent_task": None,
        "constraints": ["Use only observed evidence"],
        "allowed_actions": ["observe", "analyze", "create_artifact"],
        "resources": ["public:news"],
        "deadline": int(time.time()) + 300,
        "acceptance_criteria": ["Cite a retrieved source"],
        "expected_artifacts": ["research-brief.json", "research-brief.md"] if golden else [],
    }
    envelope = contracts.build_envelope(mission, "coordinator", message_id, objective)
    body = {
        "jsonrpc": "2.0",
        "id": message_id,
        "method": "SendStreamingMessage" if lifecycle else "SendMessage",
        "params": {
            "message": {
                "messageId": message_id,
                "contextId": "ctx-" + uuid.uuid4().hex,
                "role": "ROLE_USER",
                "parts": [{"text": objective}],
                "metadata": {contracts.METADATA_KEY: envelope, contracts.CLARIFICATION_KEY: "1.0"},
            },
            **({"configuration": {"blocking": False}} if lifecycle else {}),
        },
    }
    def streaming_task(request_body):
        def first_task(value):
            if not isinstance(value, dict):
                return None
            if isinstance(value.get("id"), str) and isinstance(value.get("contextId"), str) and isinstance(value.get("status"), dict):
                return value
            for child in value.values():
                found = first_task(child)
                if found:
                    return found
            return None

        found_task = None
        stream_request = Request(url.rstrip("/") + "/", data=json.dumps(request_body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        with urlopen(stream_request, timeout=30) as wire:
            for line in wire:
                if not line.startswith(b"data:"):
                    continue
                event = json.loads(line[5:])
                if "error" in event:
                    raise RuntimeError(event["error"])
                found_task = first_task(event)
                if found_task:
                    break
        assert found_task, "Streaming send did not yield an accepted task before completion"
        assert found_task["status"]["state"] in {"TASK_STATE_SUBMITTED", "TASK_STATE_WORKING"}, found_task
        return found_task

    if lifecycle:
        task = streaming_task(body)
    else:
        request = Request(url.rstrip("/") + "/", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        with urlopen(request, timeout=30) as wire:
            response = json.load(wire)
        if "error" in response:
            raise RuntimeError(response["error"])
        task = protocol.unwrap_send_message_response(response["result"])
    if not lifecycle:
        text = next(part["text"] for artifact in task["artifacts"] for part in artifact["parts"] if "text" in part)
        result = contracts.validate_result(text, envelope)
    if golden:
        assert task["status"]["state"] == "TASK_STATE_INPUT_REQUIRED", task
        assert result["outcome"] == "input_required" and result["clarification"]["intended_respondent"] == "coordinator"
        followup_id = "followup-" + uuid.uuid4().hex
        followup = {"jsonrpc": "2.0", "id": followup_id, "method": "SendMessage", "params": {"message": {
            "messageId": followup_id, "taskId": task["id"], "contextId": task["contextId"],
            "role": "ROLE_USER", "parts": [{"text": "Use today as the time window; finish the sourced brief"}],
        }}}
        request = Request(url.rstrip("/") + "/", data=json.dumps(followup).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        with urlopen(request, timeout=30) as wire:
            continued = json.load(wire)
        if "error" in continued:
            raise RuntimeError(continued["error"])
        finished = protocol.unwrap_send_message_response(continued["result"])
        assert finished["id"] == task["id"] and finished["status"]["state"] == "TASK_STATE_COMPLETED", finished
        final_text = next(part["text"] for artifact in reversed(finished["artifacts"]) if artifact.get("name") == "Team result" for part in artifact["parts"] if "text" in part)
        final = contracts.validate_result(final_text, envelope)
        assert final["outcome"] == "completed" and final["checks"][0]["status"] == "pass", final
        assert {item["name"] for item in final["artifacts"]} >= set(mission["expected_artifacts"]), final
        assert all(item["reference"] == "ardent-artifact:" + item["sha256"] for item in final["artifacts"]), final
        assert any(part.get("data") for artifact in finished["artifacts"] for part in artifact["parts"]), finished
        print(json.dumps({"task_id": task["id"], "state": finished["status"]["state"], "outcome": final["outcome"], "clarified": True, "artifacts": len(final["artifacts"]), "attributed": True}))
        return
    package_spec = importlib.util.spec_from_file_location("ardent_team_under_test", Path(contract_path) / "__init__.py", submodule_search_locations=[contract_path])
    assert package_spec and package_spec.loader
    package = importlib.util.module_from_spec(package_spec)
    sys.modules[package_spec.name] = package
    package_spec.loader.exec_module(package)
    from ardent_team_under_test import capabilities as accepted_capabilities, coordination, team as accepted_team

    def request_local(_home, _peer, method, params):
        wire_request = Request(url.rstrip("/") + "/", data=json.dumps({"jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params}).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        with urlopen(wire_request, timeout=20) as wire:
            value = json.load(wire)
        if "error" in value:
            raise RuntimeError(value["error"])
        return protocol.unwrap_send_message_response(value["result"])

    original_config, original_request = accepted_team.config, accepted_team.request
    original_discover = accepted_capabilities.discover_peer
    try:
        accepted_team.config = lambda _home: {"peers": {"assistant": {"runtime_kind": "ardent"}}}
        accepted_team.request = request_local
        accepted_capabilities.discover_peer = lambda _home, _peer, **kwargs: card if kwargs.get("coordination_version") is None else (_ for _ in ()).throw(AssertionError("Ardent lifecycle used generic coordination"))
        events = coordination.call(None, "task_events", {"native_task_id": task["id"], "after_cursor": 0, "limit": 50}, key="events-" + task["id"], coordinator="assistant")
        assert events["native_task_id"] == task["id"] and events["task_id"] == message_id and events["events"]
        actions = ("pause", "resume", "cancel") if lifecycle else ("pause", "resume")
        for version, action in enumerate(actions, 1):
            payload = {"native_task_id": task["id"], "task_id": message_id, "mission_revision": 1, "control_id": action + "-" + task["id"], "control_version": version, "action": action}
            receipt = coordination.call(None, "task_control", payload, key=action + "-" + task["id"], coordinator="assistant")
            assert receipt["control_version"] == version and receipt["admission"] == {"pause": "paused", "resume": "open", "cancel": "cancel_requested"}[action]
            assert coordination.call(None, "task_control", payload, key=action + "-" + task["id"], coordinator="assistant") == receipt
            if action == "pause":
                assert coordination.call(None, "task_events", {"native_task_id": task["id"], "after_cursor": events["next_cursor"], "limit": 50}, key="events-after-pause-" + task["id"], coordinator="assistant")["events"]
        if lifecycle:
            assert receipt["admission"] == "cancel_requested" and receipt["delivery"] == "acknowledged"
            time.sleep(0.25)
            get = request_local(None, "assistant", "GetTask", {"id": task["id"]})
            assert get["status"]["state"] != "TASK_STATE_COMPLETED", get
            deadline_message_id = "team-deadline-" + uuid.uuid4().hex
            deadline_objective = "CANCEL_HOLD finite mission budget boundary"
            deadline_mission = {**mission, "id": "mission-deadline-" + uuid.uuid4().hex, "deadline": int(time.time()) + 2}
            deadline_envelope = contracts.build_envelope(deadline_mission, "coordinator", deadline_message_id, deadline_objective)
            deadline_body = {"jsonrpc": "2.0", "id": deadline_message_id, "method": "SendStreamingMessage", "params": {
                "message": {"messageId": deadline_message_id, "contextId": "ctx-" + uuid.uuid4().hex, "role": "ROLE_USER",
                            "parts": [{"text": deadline_objective}], "metadata": {contracts.METADATA_KEY: deadline_envelope, contracts.CLARIFICATION_KEY: "1.0"}},
                "configuration": {"blocking": False}}}
            expiring = streaming_task(deadline_body)
            time.sleep(2.5)
            expired = request_local(None, "assistant", "GetTask", {"id": expiring["id"]})
            assert expired["status"]["state"] in {"TASK_STATE_FAILED", "TASK_STATE_CANCELED"}, expired
    finally:
        accepted_team.config, accepted_team.request = original_config, original_request
        accepted_capabilities.discover_peer = original_discover
    print(json.dumps({"task_id": task["id"], "state": task["status"]["state"], "outcome": "cancelled" if lifecycle else result["outcome"], "lifecycle": True, "active_cancel": lifecycle}))


if __name__ == "__main__":
    main()
