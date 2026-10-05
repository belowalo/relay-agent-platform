"""Dependency-free client for a published Relay application."""
import json
import time
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.parse import urlparse, quote


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Relay redirects are not permitted")


class RelayClient:
    def __init__(self, base_url, application_id, token, timeout=30):
        url = urlparse(base_url)
        if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password:
            raise ValueError("Use an HTTP(S) base URL without credentials")
        if not application_id or not token:
            raise ValueError("An application id and access token are required")
        self.base = base_url.rstrip("/") + "/api/apps/" + quote(application_id, safe="")
        self.token = token
        self.timeout = timeout
        self.opener = build_opener(_NoRedirect())

    def _request(self, path, body=None):
        request = Request(self.base + path,
                          data=None if body is None else json.dumps(body).encode(),
                          headers={"Authorization": "Bearer " + self.token,
                                   "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                detail = json.load(error).get("error", "Request failed")
            except (ValueError, AttributeError):
                detail = "Invalid response"
            raise RuntimeError(f"Relay HTTP {error.code}: {detail}") from None

    def invoke(self, input, conversation_id=None):
        return self._request("/invoke", {"input": input, "conversationId": conversation_id})

    def get_run(self, run_id):
        return self._request("/runs/" + quote(run_id, safe=""))

    def wait_run(self, run_id, timeout=120, poll_interval=0.3, return_on_waiting=True):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            run = self.get_run(run_id)
            if run["status"] in ("completed", "failed", "cancelled") or (return_on_waiting and run["status"] == "waiting"):
                return run
            time.sleep(max(0.05, poll_interval))
        raise TimeoutError("Timed out waiting for Relay; the run continues on the server")
