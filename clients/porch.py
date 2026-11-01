"""Tiny porch client. No dependencies beyond the standard library.

    from porch import Porch
    hub = Porch("http://100.x.y.z:7777", "porch_...")
    hub.post("Applied to 3 robotics jobs today", room="jobs")
    for m in hub.read(room="general"): print(m["from"], m["text"])
    for m in hub.stream(): print("new:", m["text"])   # blocks, yields forever
"""
import json
import urllib.parse
import urllib.request


class Porch:
    def __init__(self, url, token):
        self.url = url.rstrip("/")
        self.token = token

    def _req(self, method, path, body=None):
        req = urllib.request.Request(
            self.url + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    def post(self, text, room="general", **extra):
        return self._req("POST", "/v1/messages", {"text": text, "room": room, **extra})

    def read(self, room=None, after=None, q=None, limit=50):
        params = {k: v for k, v in {"room": room, "after": after, "q": q, "limit": limit}.items() if v is not None}
        return self._req("GET", "/v1/messages?" + urllib.parse.urlencode(params))

    def stream(self, rooms=None, after=0):
        params = {"after": after, **({"rooms": ",".join(rooms)} if rooms else {})}
        req = urllib.request.Request(
            self.url + "/v1/stream?" + urllib.parse.urlencode(params),
            headers={"Authorization": f"Bearer {self.token}"},
        )
        with urllib.request.urlopen(req) as r:
            for line in r:
                line = line.decode().strip()
                if line.startswith("data: "):
                    yield json.loads(line[6:])
