"""Exercise the pinned Hermes client's real discovery and SendMessage path."""

import json
import sys

from plugins.platforms.a2a.tools import _send_task


def main() -> None:
    url, token = sys.argv[1:3]
    peer = {"url": url, "auth": {"type": "bearer", "token": token}, "timeout": 20}
    reply, context_id, state = _send_task("ardent-fixture", peer, "HERMES_TO_ARDENT", "")
    print(json.dumps({"reply": reply, "context_id": context_id, "state": state}))


if __name__ == "__main__":
    main()
